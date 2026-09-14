use crate::{AppState, error::ApiError};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgConnection, Row};

mod catalog;
mod jobs;
mod operations;
mod provider;
mod routes;
#[cfg(test)]
mod tests;
mod webhook;

pub use operations::Billing;
pub use routes::routes;

fn unconfigured() -> ApiError {
    ApiError::new(
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        "billing_unconfigured",
        "Billing is not configured.",
    )
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entitlement {
    pub name: String,
    pub event_limit: Option<i64>,
    pub website_limit: Option<i64>,
    pub used: i64,
    pub remaining: Option<i64>,
    pub local_baseline: i64,
    pub pending: i64,
    pub period_start: DateTime<Utc>,
    pub period_end: DateTime<Utc>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Subscription {
    status: String,
    current_period_end: DateTime<Utc>,
    trial_end: Option<DateTime<Utc>>,
    ends_at: Option<DateTime<Utc>>,
    entitlements: Entitlement,
}

pub struct Allowance {
    pub entitlement: Entitlement,
    pub trial: bool,
}

pub async fn allowance(
    connection: &mut PgConnection,
    owner: &str,
    organization: uuid::Uuid,
    external_effects: bool,
) -> Result<Option<Allowance>, ApiError> {
    let subscriptions:Vec<Value>=sqlx::query_scalar("SELECT subscriptions FROM billing_customers WHERE owner_id=$1 AND deleted=false AND provider='polar' AND organization_id=$2::uuid AND (NOT $3 OR updated_at>now()-interval '5 minutes')")
        .bind(owner).bind(organization).bind(external_effects).fetch_all(connection).await?;
    let mut active = Vec::new();
    for subscription in subscriptions.iter().filter_map(Value::as_array).flatten() {
        let Some(entitlements) = subscription.get("entitlements").and_then(Value::as_object) else {
            continue;
        };
        if [
            "name",
            "eventLimit",
            "websiteLimit",
            "used",
            "remaining",
            "localBaseline",
            "pending",
            "periodStart",
            "periodEnd",
        ]
        .iter()
        .any(|key| !entitlements.contains_key(*key))
        {
            continue;
        }
        let Ok(mut subscription) = serde_json::from_value::<Subscription>(subscription.clone())
        else {
            continue;
        };
        let e = &subscription.entitlements;
        let valid_units = [
            Some(e.used),
            e.event_limit,
            e.website_limit,
            e.remaining,
            Some(e.local_baseline),
            Some(e.pending),
        ]
        .into_iter()
        .flatten()
        .all(|n| (0..=9_007_199_254_740_991).contains(&n));
        let end = subscription
            .current_period_end
            .min(e.period_end)
            .min(subscription.ends_at.unwrap_or(DateTime::<Utc>::MAX_UTC))
            .min(if subscription.status == "trialing" {
                subscription.trial_end.unwrap_or(DateTime::<Utc>::MAX_UTC)
            } else {
                DateTime::<Utc>::MAX_UTC
            });
        if !valid_units
            || e.name.is_empty()
            || !matches!(subscription.status.as_str(), "active" | "trialing")
            || Utc::now() < e.period_start
            || Utc::now() >= end
            || e.remaining.is_none() != e.event_limit.is_none()
        {
            continue;
        }
        subscription.entitlements.period_end = end;
        active.push(Allowance {
            entitlement: subscription.entitlements,
            trial: subscription.status == "trialing",
        });
    }
    active.sort_by_key(|a| {
        (
            std::cmp::Reverse(a.entitlement.event_limit.unwrap_or(i64::MAX)),
            std::cmp::Reverse(a.entitlement.period_start),
        )
    });
    Ok(active.into_iter().next())
}

pub async fn require_subscription(state: &AppState, owner: &str) -> Result<Allowance, ApiError> {
    let mut connection = state.pool.acquire().await?;
    allowance(
        &mut connection,
        owner,
        state.billing.organization_id(),
        state.config.external_effects,
    )
    .await?
    .ok_or_else(ApiError::subscription_required)
}

pub async fn usage(state: &AppState, owner: &str) -> Result<Value, ApiError> {
    let mut connection = state.pool.acquire().await?;
    let active = allowance(
        &mut connection,
        owner,
        state.billing.organization_id(),
        state.config.external_effects,
    )
    .await?;
    let sites=sqlx::query("SELECT s.id,s.name,s.domain,(s.credit_budget*100)::bigint AS budget_units,EXISTS(SELECT 1 FROM environments e WHERE e.site_id=s.id AND e.enabled) AS enabled,EXISTS(SELECT 1 FROM site_suspensions ss WHERE ss.site_id=s.id) AS suspended FROM sites s WHERE owner_id=$1 ORDER BY created_at,id")
        .bind(owner).fetch_all(&mut *connection).await?;
    let rows: Vec<(uuid::Uuid, i64)> = if let Some(active) = &active {
        sqlx::query_as("SELECT site_id,(events*100)::bigint FROM billing_organization_usage WHERE owner_id=$1 AND period_start=$2 AND organization_id=$3::uuid")
            .bind(owner).bind(active.entitlement.period_start).bind(state.billing.organization_id()).fetch_all(&mut *connection).await?
    } else {
        Vec::new()
    };
    let local = rows
        .iter()
        .try_fold(0_i64, |sum, (_, units)| {
            if *units < 0 {
                None
            } else {
                sum.checked_add(*units)
            }
        })
        .ok_or_else(ApiError::unavailable)?;
    let reserved = active
        .as_ref()
        .map_or(Some(0), |a| {
            a.entitlement
                .pending
                .checked_add((local - a.entitlement.local_baseline).max(0))
        })
        .ok_or_else(ApiError::unavailable)?;
    let used = active
        .as_ref()
        .map_or(Some(0), |a| a.entitlement.used.checked_add(reserved))
        .ok_or_else(ApiError::unavailable)?;
    let remaining = active.as_ref().map_or(Some(0), |a| {
        a.entitlement.remaining.map(|r| (r - reserved).max(0))
    });
    let reason = if active.is_none() {
        Some("subscription_required")
    } else if remaining.is_some_and(|r| r < 15) {
        Some("event_limit")
    } else {
        None
    };
    let completed: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM account_onboarding WHERE owner_id=$1)")
            .bind(owner)
            .fetch_one(&mut *connection)
            .await?;
    let since = (Utc::now() - Duration::days(29)).date_naive();
    let reasons=sqlx::query("SELECT reason,sum(blocked)::bigint AS blocked,max(last_blocked_at) AS last FROM abuse_daily a JOIN environments e ON e.id=a.environment_id JOIN sites s ON s.id=e.site_id WHERE s.owner_id=$1 AND a.day>=$2 GROUP BY reason")
        .bind(owner).bind(since).fetch_all(&mut *connection).await?;
    let days:Vec<i32>=sqlx::query_scalar("SELECT coalesce((a.baseline->>'days')::int,0) FROM environments e JOIN sites s ON s.id=e.site_id LEFT JOIN abuse_environment a ON a.environment_id=e.id WHERE s.owner_id=$1")
        .bind(owner).fetch_all(&mut *connection).await?;
    let websites=sites.iter().enumerate().map(|(i,s)| {
        let id:uuid::Uuid=s.get("id");
        let units=rows.iter().find(|(site,_)|site==&id).map_or(0,|(_,n)|*n);
        let budget:Option<i64>=s.get("budget_units");
        let pause=if s.get::<bool,_>("suspended") {Some("admin_suspended")} else if !s.get::<bool,_>("enabled") {Some("disabled")} else {reason.or_else(||if active.as_ref().and_then(|a|a.entitlement.website_limit).is_some_and(|limit|i as i64>=limit) {Some("website_limit")} else if budget.is_some_and(|b|b.saturating_sub(units)<15) {Some("website_budget")} else {None})};
        json!({"id":id,"name":s.get::<String,_>("name"),"domain":s.get::<String,_>("domain"),"creditBudget":budget.map(|n|n as f64/100.0),"events":units as f64/100.0,"paused":pause.is_some(),"pauseReason":pause})
    }).collect::<Vec<_>>();
    Ok(json!({
        "onboardingCompleted":completed,
        "protection":{"since":since,"blocked":reasons.iter().map(|r|r.get::<i64,_>("blocked")).sum::<i64>(),"reasons":reasons.iter().map(|r|json!({"reason":r.get::<String,_>("reason"),"blocked":r.get::<i64,_>("blocked")})).collect::<Vec<_>>(),"lastBlockedAt":reasons.iter().map(|r|r.get::<DateTime<Utc>,_>("last")).max(),"learning":days.iter().filter(|d|**d<3).count(),"learned":days.iter().filter(|d|**d>=3).count()},
        "plan":active.as_ref().map(|a|json!({"name":a.entitlement.name,"trial":a.trial,"eventLimit":a.entitlement.event_limit.map(|n|n as f64/100.0),"websiteLimit":a.entitlement.website_limit})),
        "period":active.as_ref().map(|a|json!({"start":a.entitlement.period_start,"end":a.entitlement.period_end})),
        "events":{"used":used as f64/100.0,"remaining":remaining.map(|r|r as f64/100.0)},
        "paused":reason.is_some(),"pauseReason":reason,"websites":websites
    }))
}

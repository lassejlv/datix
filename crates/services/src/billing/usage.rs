use super::allowance::{self, Allowance, Subscription};
use analytics_core::{Result, State};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;
#[derive(Clone, sqlx::FromRow)]
pub struct Website {
    pub id: Uuid,
    pub name: String,
    pub domain: String,
    pub credit_budget: Option<String>,
    pub enabled: bool,
}
#[derive(sqlx::FromRow)]
pub struct Count {
    pub site_id: Uuid,
    pub units: i64,
}
pub async fn account_allowance(
    conn: &mut PgConnection,
    owner: &str,
    now: DateTime<Utc>,
) -> Result<(Option<Allowance>, Vec<Website>)> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT subscriptions FROM billing_customers WHERE owner_id=$1 AND deleted=false AND provider='autumn' AND updated_at>now()-interval '5 minutes'",
    )
    .bind(owner)
    .fetch_all(&mut *conn)
    .await?;
    let subscriptions: Vec<Subscription> = rows
        .into_iter()
        .flat_map(|row| serde_json::from_value::<Vec<Subscription>>(row).unwrap_or_default())
        .collect();
    let sites=sqlx::query_as::<_,Website>("SELECT id,name,domain,credit_budget::text,EXISTS(SELECT 1 FROM environments WHERE site_id=sites.id AND enabled=true) AS enabled FROM sites WHERE owner_id=$1 ORDER BY created_at,id").bind(owner).fetch_all(conn).await?;
    Ok((allowance::active(subscriptions, now), sites))
}
pub async fn period_usage(
    conn: &mut PgConnection,
    owner: &str,
    start: DateTime<Utc>,
) -> Result<Vec<Count>> {
    Ok(sqlx::query_as::<_,Count>("SELECT site_id,(events*100)::bigint AS units FROM billing_usage WHERE owner_id=$1 AND period_start=$2").bind(owner).bind(start).fetch_all(conn).await?)
}
pub fn budget_units(value: &Option<String>) -> Option<i64> {
    value
        .as_ref()
        .and_then(|v| v.parse::<f64>().ok())
        .map(|n| (n * 100.0).round() as i64)
}
pub async fn account_usage(state: &State, owner: &str) -> Result<Value> {
    super::provider::refresh_if_due(state, owner).await?;
    let mut conn = state.db.acquire().await?;
    usage(&mut conn, owner, Utc::now()).await
}
pub async fn usage(conn: &mut PgConnection, owner: &str, now: DateTime<Utc>) -> Result<Value> {
    let (allowance, websites) = account_allowance(conn, owner, now).await?;
    let rows = if let Some(a) = &allowance {
        period_usage(conn, owner, a.period.start).await?
    } else {
        vec![]
    };
    let local: i64 = rows.iter().map(|r| r.units).sum();
    let used = allowance.as_ref().map_or(0, |a| a.used(local));
    let remaining = allowance.as_ref().map_or(Some(0), |a| a.remaining(local));
    let pause = if allowance.is_none() {
        Some("subscription_required")
    } else if remaining.is_some_and(|r| r < 15) {
        Some("event_limit")
    } else {
        None
    };
    let websites:Vec<Value>=websites.iter().enumerate().map(|(index,s)|{
  let units=rows.iter().find(|r|r.site_id==s.id).map_or(0,|r|r.units);
  let reason=if !s.enabled{Some("disabled")}else{pause.or_else(||if allowance.as_ref().is_some_and(|a| !a.permits_website(index as i64)) {Some("website_limit")}else if budget_units(&s.credit_budget).is_some_and(|b|b-units<15){Some("website_budget")}else{None})};
  json!({"id":s.id,"name":s.name,"domain":s.domain,"events":units as f64/100.0,"creditBudget":s.credit_budget.as_ref().and_then(|v|v.parse::<f64>().ok()),"paused":reason.is_some(),"pauseReason":reason})
 }).collect();
    Ok(
        json!({"plan":allowance.as_ref().map(|a|json!({"name":a.subscription.entitlements.as_ref().map(|e| &e.name),"trial":a.trial,"eventLimit":a.event_limit.map(|v|v as f64/100.0),"websiteLimit":a.website_limit})),"period":allowance.as_ref().map(|a|&a.period),"events":{"used":used as f64/100.0,"remaining":remaining.map(|v| v as f64/100.0)},"paused":pause.is_some(),"pauseReason":pause,"websites":websites}),
    )
}

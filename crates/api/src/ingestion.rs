use crate::{
    AppState, abuse, billing,
    error::ApiError,
    http::{Country, json_body},
    sites::identifier,
    tracking::{self, Event, Input},
};
use axum::{
    Extension, Json, Router,
    extract::{Query, Request, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::Row;
use std::collections::HashMap;
use uuid::Uuid;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/tracker-config", get(tracker_config))
        .route("/api/collect", post(collect_route))
}

async fn tracker_config(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let site = identifier(query.get("siteId").map_or("", String::as_str))?;
    let environment = identifier(
        query
            .get("environmentId")
            .or_else(|| query.get("siteId"))
            .map_or("", String::as_str),
    )?;
    let row=sqlx::query("SELECT e.enabled,e.tracking_settings,e.feature_settings,NOT EXISTS(SELECT 1 FROM site_suspensions WHERE site_id=s.id) AND NOT EXISTS(SELECT 1 FROM user_suspensions WHERE user_id=s.owner_id) AS permitted FROM environments e JOIN sites s ON s.id=e.site_id WHERE e.site_id=$1 AND e.id=$2")
        .bind(site).bind(environment).fetch_optional(&state.pool).await?.ok_or_else(missing)?;
    let mut features = json!({"goals":false,"errors":false,"webVitals":true});
    if let Some(configured) = row.get::<Value, _>("feature_settings").as_object() {
        features
            .as_object_mut()
            .expect("object")
            .extend(configured.clone());
    }
    Ok(Json(
        json!({"enabled":row.get::<bool,_>("enabled") && row.get::<bool,_>("permitted"),"settings":tracking::settings(&row.get::<Value,_>("tracking_settings")),"features":features}),
    ))
}

fn missing() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "environment_not_found",
        "Environment not found.",
    )
}

async fn collect_route(
    State(state): State<AppState>,
    Extension(country): Extension<Country>,
    request: Request,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let headers = request.headers().clone();
    Ok((
        StatusCode::ACCEPTED,
        Json(collect(&state, json_body(request).await?, &headers, &country.0).await?),
    ))
}

pub async fn collect(
    state: &AppState,
    input: Input,
    headers: &HeaderMap,
    country: &str,
) -> Result<Value, ApiError> {
    input.validate()?;
    if tracking::excluded(headers) {
        return Ok(json!({"accepted":false,"reason":"excluded"}));
    }
    let site = identifier(&input.site_id)?;
    let environment = identifier(input.environment())?;
    let event_id = identifier(&input.id)?;
    let ip = tracking::client_ip(headers);
    tracking::rate_limit(state, "collect", ip, 120).await?;
    let mut tx = state.pool.begin().await?;
    let owner:Option<String>=sqlx::query_scalar("SELECT s.owner_id FROM environments e JOIN sites s ON s.id=e.site_id WHERE e.id=$1 AND s.id=$2")
        .bind(environment).bind(site).fetch_optional(&mut *tx).await?;
    let owner = owner.ok_or_else(missing)?;
    sqlx::query("SELECT id FROM public.\"user\" WHERE id=$1 FOR UPDATE")
        .bind(&owner)
        .execute(&mut *tx)
        .await?;
    let current=sqlx::query("SELECT e.*,CASE WHEN s.credit_budget IS NULL THEN NULL ELSE (s.credit_budget*100)::bigint END AS budget_units,EXISTS(SELECT 1 FROM user_suspensions WHERE user_id=s.owner_id) OR EXISTS(SELECT 1 FROM site_suspensions WHERE site_id=s.id) AS suspended FROM environments e JOIN sites s ON s.id=e.site_id WHERE e.id=$1 AND s.id=$2 FOR KEY SHARE OF s,e")
        .bind(environment).bind(site).fetch_optional(&mut *tx).await?;
    let Some(current) = current else {
        return Ok(json!({"accepted":false,"reason":"disabled"}));
    };
    if !current.get::<bool, _>("enabled") || current.get::<bool, _>("suspended") {
        return Ok(
            json!({"accepted":false,"reason":if current.get::<bool,_>("suspended") {"admin_suspended"} else {"disabled"}}),
        );
    }
    let event = tracking::normalize(
        input,
        headers,
        country,
        &state.config.visitor_secret,
        tracking::Environment {
            domain: current.get("domain"),
            allow_localhost: current.get("allow_localhost"),
            tracking_mode: current.get("tracking_mode"),
            tracking_settings: &current.get::<Value, _>("tracking_settings"),
        },
        Utc::now(),
    )?;
    let Some(event) = event else {
        return Ok(json!({"accepted":false,"reason":"event_disabled"}));
    };
    let active = billing::allowance(
        &mut tx,
        &owner,
        state.billing.organization_id(),
        state.config.external_effects,
    )
    .await?;
    let Some(active) = active else {
        return Ok(json!({"accepted":false,"reason":"subscription_required"}));
    };
    let entitlement = active.entitlement;
    let sites: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM sites WHERE owner_id=$1 ORDER BY created_at,id")
            .bind(&owner)
            .fetch_all(&mut *tx)
            .await?;
    if entitlement.website_limit.is_some_and(|limit| {
        sites
            .iter()
            .position(|id| *id == site)
            .is_none_or(|i| i as i64 >= limit)
    }) {
        return Ok(json!({"accepted":false,"reason":"website_limit"}));
    }
    let duplicate: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM ingestion_receipts WHERE environment_id=$1 AND event_id=$2)",
    )
    .bind(environment)
    .bind(event_id)
    .fetch_one(&mut *tx)
    .await?;
    if duplicate {
        return Ok(json!({"accepted":true}));
    }
    if abuse::guard(&mut tx, &event, ip, &state.config.visitor_secret).await? {
        tx.commit().await?;
        return Ok(json!({"accepted":false,"reason":"spam_detected"}));
    }
    let usage:Vec<(Uuid,i64)>=sqlx::query_as("SELECT site_id,(events*100)::bigint FROM billing_organization_usage WHERE owner_id=$1 AND organization_id=$2 AND period_start=$3")
        .bind(&owner).bind(state.billing.organization_id()).bind(entitlement.period_start).fetch_all(&mut *tx).await?;
    let used = usage
        .iter()
        .try_fold(0_i64, |sum, (_, units)| sum.checked_add(*units))
        .ok_or_else(ApiError::unavailable)?;
    let reserved = entitlement
        .pending
        .checked_add(used.saturating_sub(entitlement.local_baseline).max(0))
        .ok_or_else(ApiError::unavailable)?;
    let cost = tracking::units(&event);
    if entitlement
        .remaining
        .is_some_and(|r| r.saturating_sub(reserved) < cost || r == reserved)
    {
        tx.commit().await?;
        return Ok(json!({"accepted":false,"reason":"event_limit"}));
    }
    let site_used = usage
        .iter()
        .find(|(id, _)| *id == site)
        .map_or(0, |(_, n)| *n);
    if current
        .get::<Option<i64>, _>("budget_units")
        .is_some_and(|budget| budget.saturating_sub(site_used) < cost.max(15))
    {
        tx.commit().await?;
        return Ok(json!({"accepted":false,"reason":"website_budget"}));
    }
    sqlx::query("INSERT INTO ingestion_receipts(environment_id,event_id,owner_id,site_id,period_start,period_end,units,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
        .bind(environment).bind(event_id).bind(&owner).bind(site).bind(entitlement.period_start).bind(entitlement.period_end).bind(cost).bind(json!(event)).execute(&mut *tx).await?;
    if cost > 0 {
        sqlx::query("INSERT INTO billing_organization_usage(owner_id,site_id,organization_id,period_start,period_end,events) VALUES($1,$2,$3,$4,$5,$6::bigint::numeric/100) ON CONFLICT(owner_id,period_start,site_id,organization_id) DO UPDATE SET events=billing_organization_usage.events+excluded.events")
            .bind(&owner).bind(site).bind(state.billing.organization_id()).bind(entitlement.period_start).bind(entitlement.period_end).bind(cost).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    // The committed receipt itself is the durable queue. Polling recovery is independent
    // of Redis notifications, and retries are serialized by the same owner lock.
    Ok(json!({"accepted":true}))
}

pub async fn deliver(state: &AppState, owner: &str, batch_size: i64) -> Result<(), ApiError> {
    let mut tx = state.pool.begin().await?;
    let present: Option<String> =
        sqlx::query_scalar("SELECT id FROM public.\"user\" WHERE id=$1 FOR UPDATE")
            .bind(owner)
            .fetch_optional(&mut *tx)
            .await?;
    if present.is_none() {
        return Ok(());
    }
    let receipts=sqlx::query("SELECT * FROM ingestion_receipts WHERE owner_id=$1 AND state='pending' ORDER BY created_at,environment_id,event_id LIMIT $2 FOR UPDATE")
        .bind(owner).bind(batch_size).fetch_all(&mut *tx).await?;
    if receipts.is_empty() {
        return Ok(());
    }
    let environments=sqlx::query("SELECT e.*,NOT EXISTS(SELECT 1 FROM site_suspensions WHERE site_id=s.id) AND NOT EXISTS(SELECT 1 FROM user_suspensions WHERE user_id=s.owner_id) AS permitted FROM environments e JOIN sites s ON s.id=e.site_id WHERE s.owner_id=$1 ORDER BY s.id,e.id FOR KEY SHARE OF s,e")
        .bind(owner).fetch_all(&mut *tx).await?;
    for receipt in receipts {
        let environment: Uuid = receipt.get("environment_id");
        let id: Uuid = receipt.get("event_id");
        let site: Uuid = receipt.get("site_id");
        let units = i64::from(receipt.get::<i32, _>("units"));
        let raw: Event =
            serde_json::from_value(receipt.get("payload")).map_err(|_| ApiError::unavailable())?;
        if identifier(&raw.id)? != id
            || identifier(&raw.site_id)? != site
            || identifier(&raw.environment_id)? != environment
            || tracking::units(&raw) != units
        {
            return Err(ApiError::unavailable());
        }
        let env = environments
            .iter()
            .find(|row| row.get::<Uuid, _>("id") == environment);
        let event = env
            .filter(|row| {
                row.get::<bool, _>("enabled")
                    && row.get::<bool, _>("permitted")
                    && (!raw.localhost || row.get("allow_localhost"))
            })
            .and_then(|row| tracking::apply_policy(raw, &row.get("tracking_settings")));
        if let Some(event) = &event {
            if !event
                .activity
                .as_ref()
                .is_some_and(|a| a.kind == "engagement")
            {
                sqlx::query("INSERT INTO events(site_id,id,received_at,day,type,name,path,referrer,country,device,visitor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING")
                    .bind(environment).bind(id).bind(event.received_at).bind(event.day).bind(&event.kind).bind(&event.name).bind(&event.path).bind(&event.referrer).bind(&event.country).bind(&event.device).bind(&event.visitor).execute(&mut *tx).await?;
            }
            if let Some(a) = &event.activity {
                sqlx::query("INSERT INTO activity_events(environment_id,id,session_key,visitor_key,received_at,kind,name,path,referrer,country,device,browser,os,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING")
                    .bind(environment).bind(id).bind(&a.session_key).bind(&a.visitor_key).bind(event.received_at).bind(&a.kind).bind(&event.name).bind(&event.path).bind(&event.referrer).bind(&event.country).bind(&event.device).bind(&a.browser).bind(&a.os).bind(json!(a.details)).execute(&mut *tx).await?;
            }
            if env.is_some_and(|e| e.get::<Value, _>("feature_settings")["goals"] == true)
                && !event
                    .activity
                    .as_ref()
                    .is_some_and(|a| a.kind == "engagement")
            {
                sqlx::query("INSERT INTO goal_conversions(goal_id,environment_id,event_id,received_at,day,visitor,path) SELECT id,$1,$2,$3,$4,$5,$6 FROM conversion_goals WHERE environment_id=$1 AND created_at<=$3 AND ((match_type='page' AND $7='pageview' AND match_value=$6) OR (match_type='event' AND $7='event' AND match_value=$8)) ON CONFLICT DO NOTHING")
                    .bind(environment).bind(id).bind(event.received_at).bind(event.day).bind(&event.visitor).bind(&event.path).bind(&event.kind).bind(&event.name).execute(&mut *tx).await?;
            }
            if units > 0 {
                sqlx::query("INSERT INTO billing_outbox(owner_id,event_type,event_count,occurred_at,provider,organization_id) VALUES($1,$2,$3::bigint::numeric/100,$4,'polar',$5)")
                    .bind(owner).bind(&event.kind).bind(units).bind(event.received_at).bind(state.billing.organization_id()).execute(&mut *tx).await?;
            }
        } else {
            for (table, column, key) in [
                ("events", "site_id", "id"),
                ("activity_events", "environment_id", "id"),
                ("goal_conversions", "environment_id", "event_id"),
            ] {
                sqlx::query(&format!(
                    "DELETE FROM {table} WHERE {column}=$1 AND {key}=$2"
                ))
                .bind(environment)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            }
            if units > 0 {
                sqlx::query("UPDATE billing_organization_usage SET events=greatest(0,events-$1::bigint::numeric/100) WHERE owner_id=$2 AND site_id=$3 AND period_start=$4 AND organization_id=$5")
                    .bind(units).bind(owner).bind(site).bind(receipt.get::<DateTime<Utc>,_>("period_start")).bind(state.billing.organization_id()).execute(&mut *tx).await?;
            }
        }
        sqlx::query("UPDATE ingestion_receipts SET state=$1,payload=NULL WHERE environment_id=$2 AND event_id=$3 AND state='pending'")
            .bind(if event.is_some() {"delivered"} else {"cancelled"}).bind(environment).bind(id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

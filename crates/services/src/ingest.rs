//! One transaction owns deduplication, allowance admission, analytics, and the billing outbox.
use crate::{
    billing::{allowance, usage},
    tracking::Event,
};
use analytics_core::{Result, State};
use chrono::{DateTime, Duration, Utc};
use sqlx::PgConnection;
use uuid::Uuid;
#[derive(sqlx::FromRow)]
struct Parent {
    owner_id: String,
    site_id: Uuid,
}
#[derive(sqlx::FromRow)]
struct Environment {
    site_id: Uuid,
    tracking_settings: serde_json::Value,
    allow_localhost: bool,
    enabled: bool,
}
pub async fn ingest(state: &State, event: &Event, now: DateTime<Utc>) -> Result<bool> {
    event.validate()?;
    if event.received_at < now - Duration::days(30)
        || event.received_at > now + Duration::seconds(60)
    {
        return Ok(false);
    }
    let environment_id = event.environment();
    let mut tx = state.db.begin().await?;
    let Some(parent)=sqlx::query_as::<_,Parent>("SELECT s.owner_id,s.id AS site_id FROM sites s JOIN environments e ON e.site_id=s.id WHERE e.id=$1 AND s.id=$2").bind(environment_id).bind(event.site_id).fetch_optional(&mut *tx).await? else{return Ok(false)};
    // The same lock order as site creation/settings prevents quota races and deadlocks.
    if sqlx::query("SELECT id FROM \"user\" WHERE id=$1 FOR UPDATE")
        .bind(&parent.owner_id)
        .fetch_optional(&mut *tx)
        .await?
        .is_none()
    {
        return Ok(false);
    }
    if sqlx::query("SELECT id FROM sites WHERE id=$1 FOR KEY SHARE")
        .bind(parent.site_id)
        .fetch_optional(&mut *tx)
        .await?
        .is_none()
    {
        return Ok(false);
    }
    let Some(environment)=sqlx::query_as::<_,Environment>("SELECT site_id,tracking_settings,allow_localhost,enabled FROM environments WHERE id=$1 FOR KEY SHARE").bind(environment_id).fetch_optional(&mut *tx).await? else{return Ok(false)};
    if !environment.enabled
        || environment.site_id != event.site_id
        || (event.localhost && !environment.allow_localhost)
    {
        return Ok(false);
    }
    let Some(event) = event.apply_policy(&environment.tracking_settings) else {
        return Ok(false);
    };
    let duplicate: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM events WHERE site_id=$1 AND id=$2)")
            .bind(environment_id)
            .bind(event.id)
            .fetch_one(&mut *tx)
            .await?;
    if duplicate {
        return Ok(false);
    }
    let (allowance, websites) = usage::account_allowance(&mut tx, &parent.owner_id, now).await?;
    let Some(allowance) = allowance else {
        return Ok(false);
    };
    let Some(website) = websites.iter().take(10).find(|s| s.id == event.site_id) else {
        return Ok(false);
    };
    let Some(period) = allowance::period(&allowance.subscription, event.received_at) else {
        return Ok(false);
    };
    let usage = usage::period_usage(&mut tx, &parent.owner_id, period.start).await?;
    let used: i64 = usage.iter().map(|r| r.units).sum();
    let remaining = (allowance.event_limit * 100 - used).max(0);
    let site_used = usage
        .iter()
        .find(|r| r.site_id == event.site_id)
        .map_or(0, |r| r.units);
    let budget =
        usage::budget_units(&website.credit_budget).map_or(i64::MAX, |n| (n - site_used).max(0));
    let units = event.units();
    if remaining == 0 || budget < 15 || units > budget || units > remaining {
        return Ok(false);
    }
    let inserted=sqlx::query("INSERT INTO events(site_id,id,received_at,day,type,name,path,referrer,country,device,visitor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING")
 .bind(environment_id).bind(event.id).bind(event.received_at).bind(event.day).bind(&event.event_type).bind(&event.name).bind(&event.path).bind(&event.referrer).bind(&event.country).bind(&event.device).bind(&event.visitor).execute(&mut *tx).await?.rows_affected();
    if inserted == 0 {
        return Ok(false);
    }
    if units > 0 {
        sqlx::query("INSERT INTO billing_usage(owner_id,site_id,period_start,period_end,events) VALUES($1,$2,$3,$4,$5::bigint::numeric/100) ON CONFLICT(owner_id,period_start,site_id) DO UPDATE SET events=billing_usage.events+excluded.events,period_end=excluded.period_end")
  .bind(&parent.owner_id).bind(event.site_id).bind(period.start).bind(period.end).bind(units).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO billing_outbox(owner_id,event_type,event_count,occurred_at) VALUES($1,$2,$3::bigint::numeric/100,$4)")
  .bind(&parent.owner_id).bind(&event.event_type).bind(units).bind(event.received_at).execute(&mut *tx).await?;
    }
    if let Some(activity) = &event.activity {
        sqlx::query("INSERT INTO activity_events(environment_id,id,session_key,visitor_key,received_at,kind,name,path,referrer,country,device,browser,os,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING")
  .bind(environment_id).bind(event.id).bind(&activity.session_key).bind(&activity.visitor_key).bind(event.received_at).bind(&activity.kind).bind(&event.name).bind(&event.path).bind(&event.referrer).bind(&event.country).bind(&event.device).bind(&activity.browser).bind(&activity.os).bind(serde_json::to_value(&activity.details).expect("serializable details")).execute(&mut *tx).await?;
    }
    let pageview = event.event_type == "pageview";
    if event
        .activity
        .as_ref()
        .is_none_or(|a| a.kind != "engagement")
    {
        increment(
            &mut tx,
            &event,
            "total",
            "",
            pageview as i64,
            (!pageview) as i64,
            0,
        )
        .await?;
        if pageview {
            for (dimension, value) in [
                ("path", &event.path),
                ("referrer", &event.referrer),
                ("country", &event.country),
                ("device", &event.device),
            ] {
                increment(&mut tx, &event, dimension, value, 1, 0, 0).await?;
            }
        } else {
            increment(&mut tx, &event, "event", &event.name, 0, 1, 0).await?;
        }
    }
    if pageview {
        let new=sqlx::query("INSERT INTO daily_visitors(site_id,day,visitor) VALUES($1,$2,$3) ON CONFLICT DO NOTHING").bind(environment_id).bind(event.day).bind(&event.visitor).execute(&mut *tx).await?.rows_affected();
        if new > 0 {
            increment(&mut tx, &event, "total", "", 0, 0, 1).await?;
        }
    }
    tx.commit().await?;
    Ok(true)
}
async fn increment(
    conn: &mut PgConnection,
    event: &Event,
    dimension: &str,
    value: &str,
    pageviews: i64,
    custom_events: i64,
    visitors: i64,
) -> Result<()> {
    sqlx::query("INSERT INTO daily_stats(site_id,day,dimension,value,pageviews,custom_events,visitors) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(site_id,day,dimension,value) DO UPDATE SET pageviews=daily_stats.pageviews+excluded.pageviews,custom_events=daily_stats.custom_events+excluded.custom_events,visitors=daily_stats.visitors+excluded.visitors")
 .bind(event.environment()).bind(event.day).bind(dimension).bind(value).bind(pageviews).bind(custom_events).bind(visitors).execute(conn).await?;
    Ok(())
}

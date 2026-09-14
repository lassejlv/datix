use crate::{
    error::ApiError,
    tracking::{Event, hash},
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgConnection, Row};

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Baseline {
    days: u32,
    daily_events: f64,
    events_per_visitor: f64,
    custom_share: f64,
}
#[derive(Default, Deserialize, Serialize)]
struct Traffic {
    start: i64,
    events: i64,
    custom: i64,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    minute: i64,
    minute_events: i64,
    minute_pageviews: i64,
    hour: i64,
    hour_events: i64,
    day: i64,
    day_events: i64,
    signature: String,
    repeats: i64,
}
impl Default for Source {
    fn default() -> Self {
        Self {
            minute: -1,
            minute_events: 0,
            minute_pageviews: 0,
            hour: -1,
            hour_events: 0,
            day: -1,
            day_events: 0,
            signature: String::new(),
            repeats: 0,
        }
    }
}

fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(f64::total_cmp);
    if values.is_empty() {
        0.0
    } else if values.len() % 2 == 1 {
        values[values.len() / 2]
    } else {
        (values[values.len() / 2 - 1] + values[values.len() / 2]) / 2.0
    }
}

fn detect(
    now: i64,
    pageview: bool,
    signature: String,
    previous: Source,
    traffic: Traffic,
    baseline: &Baseline,
) -> (Source, Traffic, Option<&'static str>) {
    let minute = (now / 60_000).max(previous.minute);
    let hour = (now / 3_600_000).max(previous.hour);
    let day = (now / 86_400_000).max(previous.day);
    let same = minute == previous.minute;
    let source = Source {
        minute,
        minute_events: if same {
            previous.minute_events.saturating_add(1)
        } else {
            1
        },
        minute_pageviews: (if same { previous.minute_pageviews } else { 0 })
            .saturating_add(i64::from(pageview)),
        hour,
        hour_events: if hour == previous.hour {
            previous.hour_events.saturating_add(1)
        } else {
            1
        },
        day,
        day_events: if day == previous.day {
            previous.day_events.saturating_add(1)
        } else {
            1
        },
        repeats: if same && previous.signature == signature {
            previous.repeats.saturating_add(1)
        } else {
            1
        },
        signature,
    };
    let start = now / 300_000;
    let next = Traffic {
        start,
        events: if start == traffic.start {
            traffic.events.saturating_add(1)
        } else {
            1
        },
        custom: (if start == traffic.start {
            traffic.custom
        } else {
            0
        })
        .saturating_add(i64::from(!pageview)),
    };
    let learned = baseline.days >= 3;
    let typical = if learned {
        baseline.events_per_visitor
    } else {
        0.0
    };
    let reason = if source.minute_events > 180
        || source.minute_pageviews > 90
        || source.hour_events as f64 > (typical * 40.0).ceil().clamp(1200.0, 6000.0)
        || source.day_events as f64 > (typical * 200.0).ceil().clamp(6000.0, 30000.0)
    {
        Some("source_limit")
    } else if source.repeats > if pageview { 20 } else { 60 } {
        Some("repeated_activity")
    } else if learned
        && next.events as f64 > 300.0_f64.max(baseline.daily_events / 288.0 * 12.0)
        && ((pageview && source.repeats > 10)
            || (!pageview
                && baseline.custom_share < 0.5
                && next.custom as f64 / next.events as f64 > 0.95
                && source.minute_events > 30))
    {
        Some("unusual_activity")
    } else {
        None
    };
    (
        source,
        if next.start < traffic.start {
            traffic
        } else {
            next
        },
        reason,
    )
}

/// Must run under the owner's row lock before a receipt reserves billable units.
/// Only daily HMACs, never raw IP addresses, are persisted.
pub async fn guard(
    tx: &mut PgConnection,
    event: &Event,
    ip: &str,
    secret: &str,
) -> Result<bool, ApiError> {
    let environment = &event.environment_id;
    let source = hash(secret, &json!(["abuse-source", environment, event.day, ip]));
    let signature = hash(
        secret,
        &json!([
            "abuse-pattern",
            environment,
            event.kind,
            event.activity.as_ref().map(|a| &a.kind),
            event.name,
            event.path
        ]),
    );
    sqlx::query("INSERT INTO abuse_environment(environment_id,baseline,learned_at,traffic) VALUES($1::uuid,$2,to_timestamp(0),$3) ON CONFLICT DO NOTHING")
        .bind(environment).bind(json!(Baseline::default())).bind(json!(Traffic::default())).execute(&mut *tx).await?;
    let previous:Value=sqlx::query_scalar("INSERT INTO abuse_sources(environment_id,source,activity,updated_at) VALUES($1::uuid,$2,$3,$4) ON CONFLICT(environment_id,source) DO UPDATE SET updated_at=abuse_sources.updated_at RETURNING activity")
        .bind(environment).bind(&source).bind(json!(Source::default())).bind(event.received_at).fetch_one(&mut *tx).await?;
    let state=sqlx::query("SELECT baseline,learned_at,traffic FROM abuse_environment WHERE environment_id=$1::uuid FOR UPDATE").bind(environment).fetch_one(&mut *tx).await?;
    let mut baseline: Baseline =
        serde_json::from_value(state.get("baseline")).map_err(|_| ApiError::unavailable())?;
    let mut learned_at: DateTime<Utc> = state.get("learned_at");
    if event.received_at.signed_duration_since(learned_at) >= Duration::hours(1) {
        let since = (event.received_at - Duration::days(14)).date_naive();
        let until = (event.received_at - Duration::days(1)).date_naive();
        let query = format!(
            "{} SELECT n.day,n.pageviews,n.custom_events,n.visitors,coalesce((SELECT sum(blocked)::bigint FROM abuse_daily a WHERE a.environment_id=$1 AND a.day=n.day),0) AS blocked FROM native n",
            include_str!("analytics/sql/native.sql")
        );
        let days = sqlx::query(&query)
            .bind(crate::sites::identifier(environment)?)
            .bind(since)
            .bind(until)
            .fetch_all(&mut *tx)
            .await?;
        let clean =
            days.iter()
                .filter_map(|d| {
                    let events =
                        (d.get::<i64, _>("pageviews") + d.get::<i64, _>("custom_events")) as f64;
                    let visitors = d.get::<i64, _>("visitors") as f64;
                    (events >= 20.0 && visitors > 0.0 && d.get::<i64, _>("blocked") < 50)
                        .then_some((events, visitors, d.get::<i64, _>("custom_events") as f64))
                })
                .collect::<Vec<_>>();
        baseline = Baseline {
            days: clean.len() as u32,
            daily_events: median(clean.iter().map(|d| d.0).collect()),
            events_per_visitor: median(clean.iter().map(|d| d.0 / d.1).collect()),
            custom_share: median(clean.iter().map(|d| d.2 / d.0).collect()),
        };
        learned_at = event.received_at;
    }
    let (activity, traffic, reason) = detect(
        event.received_at.timestamp_millis(),
        event.kind == "pageview",
        signature,
        serde_json::from_value(previous).map_err(|_| ApiError::unavailable())?,
        serde_json::from_value(state.get("traffic")).map_err(|_| ApiError::unavailable())?,
        &baseline,
    );
    sqlx::query("UPDATE abuse_sources SET activity=$1,updated_at=$2 WHERE environment_id=$3::uuid AND source=$4")
        .bind(json!(activity)).bind(event.received_at).bind(environment).bind(source).execute(&mut *tx).await?;
    sqlx::query("UPDATE abuse_environment SET baseline=$1,learned_at=$2,traffic=$3 WHERE environment_id=$4::uuid")
        .bind(json!(baseline)).bind(learned_at).bind(json!(traffic)).bind(environment).execute(&mut *tx).await?;
    if let Some(reason) = reason {
        sqlx::query("INSERT INTO abuse_daily(environment_id,day,reason,blocked,last_blocked_at) VALUES($1::uuid,$2,$3,1,$4) ON CONFLICT(environment_id,day,reason) DO UPDATE SET blocked=abuse_daily.blocked+1,last_blocked_at=excluded.last_blocked_at")
            .bind(environment).bind(event.day).bind(reason).bind(event.received_at).execute(&mut *tx).await?;
    }
    Ok(reason.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_patterns_and_source_limits_preserve_thresholds_and_clock_rollback() {
        let mut source = Source::default();
        let mut traffic = Traffic::default();
        for i in 1..=21 {
            let reason;
            (source, traffic, reason) = detect(
                600_000,
                true,
                "page".into(),
                source,
                traffic,
                &Baseline::default(),
            );
            assert_eq!(
                reason,
                if i > 20 {
                    Some("repeated_activity")
                } else {
                    None
                }
            );
        }
        let (source, traffic, _) = detect(
            599_999,
            true,
            "other".into(),
            source,
            traffic,
            &Baseline::default(),
        );
        assert_eq!(
            (source.minute, source.minute_events, traffic.start),
            (10, 22, 2)
        );
        let (source, _, reason) = detect(
            660_000,
            true,
            "page".into(),
            source,
            traffic,
            &Baseline::default(),
        );
        assert_eq!(source.minute_events, 1);
        assert!(reason.is_none());
    }
}

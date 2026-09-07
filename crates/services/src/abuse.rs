use analytics_core::{Result, State};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Baseline {
    pub days: usize,
    pub daily_events: f64,
    pub events_per_visitor: f64,
    pub custom_share: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub minute: i64,
    pub minute_events: i64,
    pub minute_pageviews: i64,
    pub hour: i64,
    pub hour_events: i64,
    pub day: i64,
    pub day_events: i64,
    pub signature: String,
    pub repeats: i64,
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
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Traffic {
    pub start: i64,
    pub events: i64,
    pub custom: i64,
}
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Day {
    pub pageviews: i64,
    pub custom_events: i64,
    pub visitors: i64,
    pub blocked: i64,
}
fn median(mut values: Vec<f64>) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(f64::total_cmp);
    let middle = values.len() / 2;
    if values.len().is_multiple_of(2) {
        (values[middle] + values[middle - 1]) / 2.0
    } else {
        values[middle]
    }
}
pub fn learn(days: &[Day]) -> Baseline {
    let clean: Vec<_> = days
        .iter()
        .filter(|d| d.visitors > 0 && d.pageviews + d.custom_events >= 20 && d.blocked < 50)
        .collect();
    Baseline {
        days: clean.len(),
        daily_events: median(
            clean
                .iter()
                .map(|d| (d.pageviews + d.custom_events) as f64)
                .collect(),
        ),
        events_per_visitor: median(
            clean
                .iter()
                .map(|d| (d.pageviews + d.custom_events) as f64 / d.visitors as f64)
                .collect(),
        ),
        custom_share: median(
            clean
                .iter()
                .map(|d| d.custom_events as f64 / (d.pageviews + d.custom_events) as f64)
                .collect(),
        ),
    }
}
pub fn detect(
    now: i64,
    pageview: bool,
    signature: &str,
    previous: &Source,
    traffic: &Traffic,
    baseline: &Baseline,
) -> (Source, Traffic, Option<&'static str>) {
    let minute = (now / 60000).max(previous.minute);
    let hour = (now / 3600000).max(previous.hour);
    let day = (now / 86400000).max(previous.day);
    let same = previous.minute == minute;
    let source = Source {
        minute,
        minute_events: if same { previous.minute_events + 1 } else { 1 },
        minute_pageviews: if same {
            previous.minute_pageviews + pageview as i64
        } else {
            pageview as i64
        },
        hour,
        hour_events: if previous.hour == hour {
            previous.hour_events + 1
        } else {
            1
        },
        day,
        day_events: if previous.day == day {
            previous.day_events + 1
        } else {
            1
        },
        signature: signature.into(),
        repeats: if same && previous.signature == signature {
            previous.repeats + 1
        } else {
            1
        },
    };
    let start = now / 300000;
    let traffic = Traffic {
        start,
        events: if traffic.start == start {
            traffic.events + 1
        } else {
            1
        },
        custom: if traffic.start == start {
            traffic.custom + (!pageview) as i64
        } else {
            (!pageview) as i64
        },
    };
    let learned = baseline.days >= 3;
    let typical = if learned {
        baseline.events_per_visitor
    } else {
        0.0
    };
    let hour_limit = (typical * 40.0).ceil().clamp(1200.0, 6000.0) as i64;
    let day_limit = (typical * 200.0).ceil().clamp(6000.0, 30000.0) as i64;
    let mut reason = None;
    if source.minute_events > 180
        || source.minute_pageviews > 90
        || source.hour_events > hour_limit
        || source.day_events > day_limit
    {
        reason = Some("source_limit")
    } else if source.repeats > if pageview { 20 } else { 60 } {
        reason = Some("repeated_activity")
    } else if learned && traffic.events as f64 > (baseline.daily_events / 288.0 * 12.0).max(300.0) {
        let reload = pageview && source.repeats > 10;
        let mix = !pageview
            && baseline.custom_share < 0.5
            && traffic.custom as f64 / traffic.events as f64 > 0.95
            && source.minute_events > 30;
        if reload || mix {
            reason = Some("unusual_activity")
        }
    }
    (source, traffic, reason)
}
pub async fn guard(
    state: &State,
    environment: Uuid,
    source: &str,
    signature: &str,
    pageview: bool,
    now: DateTime<Utc>,
) -> Result<Option<&'static str>> {
    let mut conn = state.acquire().await?;
    let reason: Option<String> = sqlx::query_scalar("SELECT analytics_guard($1,$2,$3,$4,$5)")
        .bind(environment)
        .bind(source)
        .bind(signature)
        .bind(pageview)
        .bind(now)
        .fetch_one(&mut *conn)
        .await?;
    match reason.as_deref() {
        None => Ok(None),
        Some("source_limit") => Ok(Some("source_limit")),
        Some("repeated_activity") => Ok(Some("repeated_activity")),
        Some("unusual_activity") => Ok(Some("unusual_activity")),
        _ => Err(analytics_core::Error::unavailable()),
    }
}
pub async fn summary(state: &State, owner: &str) -> Result<Value> {
    let since = (Utc::now() - Duration::days(29)).date_naive();
    let reasons:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('reason',reason,'blocked',sum(blocked),'lastBlockedAt',max(last_blocked_at)) FROM abuse_daily a JOIN environments e ON e.id=a.environment_id JOIN sites s ON s.id=e.site_id WHERE s.owner_id=$1 AND a.day>=$2 GROUP BY reason").bind(owner).bind(since).fetch_all(&state.db).await?;
    let days:Vec<i32>=sqlx::query_scalar("SELECT coalesce((a.baseline->>'days')::int,0) FROM environments e JOIN sites s ON s.id=e.site_id LEFT JOIN abuse_environment a ON a.environment_id=e.id WHERE s.owner_id=$1").bind(owner).fetch_all(&state.db).await?;
    let last = reasons
        .iter()
        .filter_map(|r| r["lastBlockedAt"].as_str())
        .filter_map(|s| s.parse::<DateTime<Utc>>().ok())
        .max();
    let total: i64 = reasons
        .iter()
        .map(|r| r["blocked"].as_i64().unwrap_or(0))
        .sum();
    Ok(
        json!({"since":since,"blocked":total,"reasons":reasons.iter().map(|r|json!({"reason":r["reason"],"blocked":r["blocked"]})).collect::<Vec<_>>(),"lastBlockedAt":last,"learning":days.iter().filter(|&&d|d<3).count(),"learned":days.iter().filter(|&&d|d>=3).count()}),
    )
}

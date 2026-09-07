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
#[derive(sqlx::FromRow)]
struct Environment {
    baseline: Value,
    learned_at: DateTime<Utc>,
    traffic: Value,
}
pub async fn guard(
    state: &State,
    environment: Uuid,
    source: &str,
    signature: &str,
    pageview: bool,
    now: DateTime<Utc>,
) -> Result<Option<&'static str>> {
    let mut cached = sqlx::query_as::<_, Environment>(
        "SELECT baseline,learned_at,traffic FROM abuse_environment WHERE environment_id=$1",
    )
    .bind(environment)
    .fetch_optional(&state.db)
    .await?;
    if cached
        .as_ref()
        .is_none_or(|s| now - s.learned_at >= Duration::hours(1))
    {
        let days=sqlx::query_as::<_,Day>("SELECT pageviews,custom_events,visitors,coalesce((SELECT sum(blocked) FROM abuse_daily WHERE environment_id=$1 AND day=daily_stats.day),0)::bigint AS blocked FROM daily_stats WHERE site_id=$1 AND dimension='total' AND value='' AND day >= $2 AND day < $3")
  .bind(environment).bind((now-Duration::days(14)).date_naive()).bind(now.date_naive()).fetch_all(&state.db).await?;
        let baseline = json!(learn(&days));
        cached=Some(sqlx::query_as::<_,Environment>("INSERT INTO abuse_environment(environment_id,baseline,learned_at,traffic) VALUES($1,$2,$3,'{\"start\":0,\"events\":0,\"custom\":0}'::jsonb) ON CONFLICT(environment_id) DO UPDATE SET baseline=excluded.baseline,learned_at=excluded.learned_at RETURNING baseline,learned_at,traffic").bind(environment).bind(baseline).bind(now).fetch_one(&state.db).await?);
    }
    let cached = cached.expect("loaded baseline");
    let baseline = serde_json::from_value(cached.baseline)
        .map_err(|_| analytics_core::Error::unavailable())?;
    let traffic =
        serde_json::from_value(cached.traffic).map_err(|_| analytics_core::Error::unavailable())?;
    let mut tx = state.db.begin().await?;
    let previous:Value=sqlx::query_scalar("INSERT INTO abuse_sources(environment_id,source,activity,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(environment_id,source) DO UPDATE SET updated_at=abuse_sources.updated_at RETURNING activity").bind(environment).bind(source).bind(json!(Source::default())).bind(now).fetch_one(&mut *tx).await?;
    let previous =
        serde_json::from_value(previous).map_err(|_| analytics_core::Error::unavailable())?;
    let (activity, _, reason) = detect(
        now.timestamp_millis(),
        pageview,
        signature,
        &previous,
        &traffic,
        &baseline,
    );
    sqlx::query(
        "UPDATE abuse_sources SET activity=$1,updated_at=$2 WHERE environment_id=$3 AND source=$4",
    )
    .bind(json!(activity))
    .bind(now)
    .bind(environment)
    .bind(source)
    .execute(&mut *tx)
    .await?;
    if let Some(reason) = reason {
        sqlx::query("INSERT INTO abuse_daily(environment_id,day,reason,blocked,last_blocked_at) VALUES($1,$2,$3,1,$4) ON CONFLICT(environment_id,day,reason) DO UPDATE SET blocked=abuse_daily.blocked+1,last_blocked_at=excluded.last_blocked_at").bind(environment).bind(now.date_naive()).bind(reason).bind(now).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE abuse_environment SET traffic=jsonb_build_object('start',greatest((traffic->>'start')::bigint,$2),'events',CASE WHEN (traffic->>'start')::bigint=$2 THEN (traffic->>'events')::bigint+1 WHEN (traffic->>'start')::bigint>$2 THEN (traffic->>'events')::bigint ELSE 1 END,'custom',CASE WHEN (traffic->>'start')::bigint=$2 THEN (traffic->>'custom')::bigint+$3 WHEN (traffic->>'start')::bigint>$2 THEN (traffic->>'custom')::bigint ELSE $3 END) WHERE environment_id=$1")
 .bind(environment).bind(now.timestamp_millis()/300000).bind((!pageview) as i64).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(reason)
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

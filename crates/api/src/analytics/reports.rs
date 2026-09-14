use super::{Parameters, read_transaction};
use crate::{AppState, error::ApiError};
use axum::http::StatusCode;
use chrono::{Duration, NaiveDate, Utc};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

pub(super) const NATIVE: &str = include_str!("sql/native.sql");

#[derive(Clone, Copy, Serialize)]
pub(super) struct DateRange {
    pub from: NaiveDate,
    pub to: NaiveDate,
    pub days: i64,
}

impl DateRange {
    pub fn parse(query: &Parameters) -> Result<Self, ApiError> {
        Self::at(query, Utc::now().date_naive())
    }

    fn at(query: &Parameters, today: NaiveDate) -> Result<Self, ApiError> {
        let invalid = || {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "Choose 1–366 days within the last 730 days, ending no later than today.",
            )
        };
        let date = |key: &str, default| -> Result<NaiveDate, ApiError> {
            let Some(value) = query.get(key) else {
                return Ok(default);
            };
            let parsed = NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| invalid())?;
            if parsed.to_string() != *value {
                return Err(invalid());
            }
            Ok(parsed)
        };
        let from = date("from", today - Duration::days(29))?;
        let to = date("to", today)?;
        let days = (to - from).num_days() + 1;
        if !(1..=366).contains(&days) || to > today || from < today - Duration::days(729) {
            return Err(invalid());
        }
        Ok(Self { from, to, days })
    }

    pub fn parameters(&self) -> Parameters {
        [
            ("from".into(), self.from.to_string()),
            ("to".into(), self.to.to_string()),
        ]
        .into()
    }
}

pub(super) fn bounded_integer(
    value: Option<&String>,
    default: i64,
    min: i64,
    max: i64,
) -> Result<i64, ApiError> {
    let n = value
        .map(|s| {
            if s.trim().is_empty() {
                Ok(0.0)
            } else {
                s.parse::<f64>()
            }
        })
        .transpose()
        .map_err(|_| ApiError::invalid())?
        .unwrap_or(default as f64);
    if !n.is_finite() || n.fract() != 0.0 || n < min as f64 || n > max as f64 {
        return Err(ApiError::invalid());
    }
    Ok(n as i64)
}

async fn rows(
    tx: &mut PgConnection,
    env: Uuid,
    range: DateRange,
    statement: &str,
) -> Result<Vec<Value>, ApiError> {
    let result: Value = sqlx::query_scalar(&format!(
        "{NATIVE} SELECT coalesce(jsonb_agg(row_to_json(q)),'[]') FROM ({statement}) q"
    ))
    .bind(env)
    .bind(range.from)
    .bind(range.to)
    .fetch_one(tx)
    .await?;
    result.as_array().cloned().ok_or_else(ApiError::unavailable)
}

pub(super) async fn report(
    state: &AppState,
    env: Uuid,
    kind: &str,
    query: &Parameters,
) -> Result<Value, ApiError> {
    let range = DateRange::parse(query)?;
    let mut tx = read_transaction(state).await?;
    if kind == "installation" {
        let latest: Option<chrono::DateTime<Utc>> = sqlx::query_scalar(
            "SELECT max(received_at) FROM events WHERE site_id=$1 AND type='pageview'",
        )
        .bind(env)
        .fetch_one(&mut *tx)
        .await?;
        return Ok(json!({"receiving":latest.is_some(), "lastReceivedAt":latest}));
    }
    if kind == "timeseries" {
        let items = rows(&mut tx, env, range, "SELECT day::text,sum(pageviews)::bigint AS pageviews,sum(custom_events)::bigint AS custom,sum(visitors)::bigint AS visitors FROM (SELECT day,pageviews,custom_events,visitors FROM native UNION ALL SELECT day,pageviews,custom_events,visitors FROM imported) combined GROUP BY day ORDER BY day").await?;
        let data: Vec<_> = (0..range.days).map(|i| {
            let day = (range.from + Duration::days(i)).to_string();
            let row = items.iter().find(|r| r["day"]==day);
            let count = |key| row.and_then(|r|r[key].as_i64()).unwrap_or(0);
            json!({"day":day,"pageviews":count("pageviews"),"customEvents":count("custom"),"dailyUniqueVisitors":count("visitors")})
        }).collect();
        return Ok(json!({"range":range,"data":data}));
    }
    if kind == "breakdown" {
        let dimension = query.get("dimension").map(String::as_str).unwrap_or("path");
        if !["path", "referrer", "country", "device", "event"].contains(&dimension) {
            return Err(ApiError::invalid());
        }
        let limit = bounded_integer(query.get("limit"), 10, 1, 100)?;
        let data: Value = sqlx::query_scalar(&format!("{NATIVE}, combined AS (
            SELECT value,CASE WHEN dimension='event' THEN custom_events ELSE pageviews END AS count FROM daily_stats WHERE site_id=$1 AND dimension=$4 AND day BETWEEN $2 AND $3
            UNION ALL SELECT CASE $4 WHEN 'path' THEN path WHEN 'referrer' THEN referrer WHEN 'country' THEN country WHEN 'device' THEN device WHEN 'event' THEN name END AS value,count(*)::bigint FROM raw WHERE type=CASE WHEN $4='event' THEN 'event' ELSE 'pageview' END GROUP BY 1
            UNION ALL SELECT b.value,b.count FROM imported_breakdowns b JOIN imported d ON d.environment_id=b.environment_id AND d.day=b.day WHERE b.dimension=$4
        ) SELECT coalesce(jsonb_agg(row_to_json(q)),'[]') FROM (SELECT value,sum(count)::bigint AS count FROM combined GROUP BY value ORDER BY count DESC,value ASC LIMIT $5) q"))
            .bind(env).bind(range.from).bind(range.to).bind(dimension).bind(limit).fetch_one(&mut *tx).await?;
        return Ok(
            json!({"range":range,"dimension":dimension,"metric":if dimension=="event" {"customEvents"} else {"pageviews"},"data":data}),
        );
    }
    let totals = rows(&mut tx, env, range, "SELECT coalesce(sum(pageviews),0)::bigint AS pageviews,coalesce(sum(custom_events),0)::bigint AS custom,coalesce(sum(visitors),0)::bigint AS visitors FROM native").await?;
    let totals = totals.first().ok_or_else(ApiError::unavailable)?;
    let imported = rows(&mut tx, env, range, "SELECT import_id,provider,source_timezone,summary,pageviews,custom_events,visitors FROM imported").await?;
    let dimensions = rows(&mut tx, env, range, "SELECT DISTINCT b.dimension FROM imported_breakdowns b JOIN imported d ON d.environment_id=b.environment_id AND d.day=b.day ORDER BY b.dimension").await?;
    let mut sources: Vec<Value> = Vec::new();
    let mut pageviews = 0i64;
    let mut visitors = 0i64;
    let mut custom = 0i64;
    for row in &imported {
        pageviews += row["pageviews"].as_i64().unwrap_or(0);
        visitors += row["visitors"].as_i64().unwrap_or(0);
        custom += row["custom_events"].as_i64().unwrap_or(0);
        let summary = &row["summary"];
        let source = json!({"id":row["import_id"],"provider":row["provider"],"sourceName":summary["sourceName"],"timeZone":row["source_timezone"],"visitorMetric":summary["visitorMetric"],"from":summary["from"],"to":summary["to"],"metrics":summary["metrics"],"breakdowns":summary["breakdowns"]});
        if let Some(existing) = sources.iter_mut().find(|s| s["id"] == row["import_id"]) {
            *existing = source;
        } else {
            sources.push(source);
        }
    }
    Ok(
        json!({"range":range,"pageviews":totals["pageviews"].as_i64().unwrap_or(0)+pageviews,
        "customEvents":totals["custom"].as_i64().unwrap_or(0)+custom,"dailyUniqueVisitors":totals["visitors"].as_i64().unwrap_or(0)+visitors,
        "visitorMetric":"sum_of_daily_unique_visitors","imports":{
            "importedDays":imported.len(),"pageviews":pageviews,"dailyVisitors":visitors,"customEvents":custom,
            "calendarDayWarning":imported.iter().any(|r| !matches!(r["source_timezone"].as_str(),Some("UTC"|"Etc/UTC"|"GMT"|"Etc/GMT"))),
            "dateBasis":"provider_calendar_day","sources":sources,"breakdowns":dimensions.iter().map(|d|&d["dimension"]).collect::<Vec<_>>()
        }}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn date_windows_preserve_utc_calendar_and_retention_bounds() {
        let today = NaiveDate::from_ymd_opt(2026, 9, 14).unwrap();
        assert_eq!(DateRange::at(&Parameters::new(), today).unwrap().days, 30);
        for (from, to) in [
            ("2026-02-30", "2026-03-01"),
            ("2026-9-01", "2026-09-02"),
            ("2026-09-14", "2026-09-15"),
            ("2026-09-14", "2026-09-13"),
            ("2024-01-01", "2024-01-02"),
        ] {
            assert!(
                DateRange::at(
                    &[("from".into(), from.into()), ("to".into(), to.into())].into(),
                    today
                )
                .is_err()
            );
        }
    }
}

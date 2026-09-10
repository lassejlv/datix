use analytics_core::{Error, Result, State, validation::DateRange};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde_json::{Value, json};
use std::collections::HashMap;
use uuid::Uuid;
mod cursor;
pub mod overview_page;

// Late native queue deliveries can move the live boundary back after an import.
// Store source intervals at import time and prefer native history on every read.
const IMPORTED: &str = "WITH live_start AS (
    SELECT min(day)::timestamp AT TIME ZONE 'UTC' AS starts_at FROM daily_stats WHERE site_id=$1 AND dimension='total'
), imported AS (
    SELECT d.*,i.provider,i.source_timezone,i.summary FROM imported_daily_stats d
    JOIN analytics_imports i ON i.id=d.import_id AND i.environment_id=d.environment_id
    CROSS JOIN live_start l WHERE d.environment_id=$1 AND d.day BETWEEN $2 AND $3
      AND (l.starts_at IS NULL OR d.ends_at<=l.starts_at)
)";

/// The HTTP layer verifies ownership and environment existence before consulting this cache.
pub async fn cached(
    state: &State,
    environment: Uuid,
    import_revision: i64,
    kind: &str,
    range: &DateRange,
    params: &HashMap<String, String>,
    work: impl std::future::Future<Output = Result<Value>>,
) -> Result<Value> {
    if state.config.runtime.report_cache_seconds == 0 {
        return work.await;
    }
    let ordered: std::collections::BTreeMap<_, _> = params.iter().collect();
    let key = format!(
        "{environment}:{import_revision}:{}",
        analytics_core::crypto::hash(
            &state.config.auth_secret,
            &json!([kind, range, ordered]).to_string()
        )
    );
    if let Some(value) = state.report_cache.get(&key) {
        state
            .metrics
            .report_cache_hits
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        return Ok(value);
    }
    state
        .metrics
        .report_cache_misses
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let value = work.await?;
    state
        .report_cache
        .put(key, &value, state.config.runtime.report_cache_seconds);
    Ok(value)
}
pub async fn installation(state: &State, id: Uuid) -> Result<Value> {
    let latest:Option<DateTime<Utc>>=sqlx::query_scalar("SELECT received_at FROM events WHERE site_id=$1 AND type='pageview' ORDER BY received_at DESC LIMIT 1").bind(id).fetch_optional(&state.db).await?;
    Ok(json!({"receiving":latest.is_some(),"lastReceivedAt":latest}))
}
pub async fn overview(state: &State, id: Uuid, range: DateRange) -> Result<Value> {
    let statement = format!("{IMPORTED}, native AS (
        SELECT coalesce(sum(pageviews),0)::bigint AS pageviews,coalesce(sum(custom_events),0)::bigint AS custom_events,coalesce(sum(visitors),0)::bigint AS visitors
        FROM daily_stats WHERE site_id=$1 AND dimension='total' AND day BETWEEN $2 AND $3
    ), historical AS (
        SELECT count(*) AS days,coalesce(sum(pageviews),0)::bigint AS pageviews,coalesce(sum(custom_events),0)::bigint AS custom_events,coalesce(sum(visitors),0)::bigint AS visitors,
        coalesce(bool_or(source_timezone NOT IN('UTC','Etc/UTC','GMT','Etc/GMT')),false) AS calendar_warning FROM imported
    ) SELECT jsonb_build_object(
        'pageviews',n.pageviews+h.pageviews,'customEvents',n.custom_events+h.custom_events,'dailyUniqueVisitors',n.visitors+h.visitors,
        'visitorMetric','sum_of_daily_unique_visitors',
        'imports',jsonb_build_object('importedDays',h.days,'pageviews',h.pageviews,'dailyVisitors',h.visitors,'customEvents',h.custom_events,
            'calendarDayWarning',h.calendar_warning,'dateBasis','provider_calendar_day',
            'sources',coalesce((SELECT jsonb_agg(source ORDER BY source->>'id') FROM (
                SELECT DISTINCT jsonb_build_object('id',import_id,'provider',provider,'sourceName',summary->'sourceName','timeZone',source_timezone,
                    'visitorMetric',summary->'visitorMetric','from',summary->'from','to',summary->'to','metrics',summary->'metrics','breakdowns',summary->'breakdowns') AS source FROM imported
            ) s),'[]'::jsonb),
            'breakdowns',coalesce((SELECT jsonb_agg(DISTINCT b.dimension ORDER BY b.dimension) FROM imported_breakdowns b JOIN imported d ON d.environment_id=b.environment_id AND d.day=b.day),'[]'::jsonb)
        )) FROM native n CROSS JOIN historical h");
    let mut report: Value = sqlx::query_scalar(&statement)
        .bind(id)
        .bind(range.from)
        .bind(range.to)
        .fetch_one(&state.db)
        .await?;
    report["range"] = json!(range);
    Ok(report)
}
pub async fn timeseries(state: &State, id: Uuid, range: DateRange) -> Result<Value> {
    let statement = format!("{IMPORTED}, combined AS (
        SELECT day,pageviews,custom_events,visitors FROM daily_stats WHERE site_id=$1 AND dimension='total' AND day BETWEEN $2 AND $3
        UNION ALL SELECT day,pageviews,custom_events,visitors FROM imported
    ) SELECT day,sum(pageviews)::bigint,sum(custom_events)::bigint,sum(visitors)::bigint FROM combined GROUP BY day ORDER BY day");
    let rows: Vec<(NaiveDate, i64, i64, i64)> = sqlx::query_as(&statement)
        .bind(id)
        .bind(range.from)
        .bind(range.to)
        .fetch_all(&state.db)
        .await?;
    let data:Vec<_>=(0..range.days).map(|i|{let day=range.from+Duration::days(i);let row=rows.iter().find(|r|r.0==day);json!({"day":day,"pageviews":row.map_or(0,|r|r.1),"customEvents":row.map_or(0,|r|r.2),"dailyUniqueVisitors":row.map_or(0,|r|r.3)})}).collect();
    Ok(json!({"range":range,"data":data}))
}
pub fn number(
    params: &HashMap<String, String>,
    key: &str,
    default: i64,
    min: i64,
    max: i64,
) -> Result<i64> {
    let n = match params.get(key) {
        Some(s) => s
            .parse::<i64>()
            .map_err(|_| Error::invalid(format!("Invalid {key}.")))?,
        None => default,
    };
    if n < min || n > max {
        return Err(Error::invalid(format!("Invalid {key}.")));
    }
    Ok(n)
}
pub async fn breakdown(
    state: &State,
    id: Uuid,
    range: DateRange,
    params: &HashMap<String, String>,
) -> Result<Value> {
    let dimension = params
        .get("dimension")
        .map(String::as_str)
        .unwrap_or("path");
    if !["path", "referrer", "country", "device", "event"].contains(&dimension) {
        return Err(Error::invalid("Invalid breakdown dimension."));
    }
    let limit = number(params, "limit", 10, 1, 100)?;
    let statement = format!("{IMPORTED}, combined AS (
        SELECT value,CASE WHEN dimension='event' THEN custom_events ELSE pageviews END AS count FROM daily_stats
            WHERE site_id=$1 AND dimension=$4 AND day BETWEEN $2 AND $3
        UNION ALL SELECT b.value,b.count FROM imported_breakdowns b JOIN imported d ON d.environment_id=b.environment_id AND d.day=b.day WHERE b.dimension=$4
    ) SELECT value,sum(count)::bigint AS count FROM combined GROUP BY value ORDER BY count DESC,value ASC LIMIT $5");
    let rows: Vec<(String, i64)> = sqlx::query_as(&statement)
        .bind(id)
        .bind(range.from)
        .bind(range.to)
        .bind(dimension)
        .bind(limit)
        .fetch_all(&state.db)
        .await?;
    Ok(
        json!({"range":range,"dimension":dimension,"metric":if dimension=="event"{"customEvents"}else{"pageviews"},"data":rows.iter().map(|r|json!({"value":r.0,"count":r.1})).collect::<Vec<_>>()}),
    )
}
pub async fn sessions(
    state: &State,
    id: Uuid,
    range: DateRange,
    params: &HashMap<String, String>,
) -> Result<Value> {
    let offset = number(params, "offset", 0, 0, 100000)?;
    if offset != 0 && params.contains_key("cursor") {
        return Err(Error::invalid("Use a cursor or an offset, not both."));
    }
    let visitor = params.get("visitor");
    let session = params.get("session");
    for key in [visitor, session].into_iter().flatten() {
        if !crate::tracking::is_hash(key) {
            return Err(Error::invalid("Invalid visitor or session identifier."));
        }
    }
    let scope = cursor::scope(state, id, &range, visitor, session);
    let cursor = cursor::decode(state, params.get("cursor"), &scope)?;
    if let Some(key) = session {
        let source = include_str!("sql/activity.sql");
        let statement = format!(
            "{source} SELECT jsonb_build_object('id',id,'receivedAt',received_at,'occurredAt',occurred_at,'kind',kind,'name',name,'path',path,'referrer',referrer,'country',country,'device',device,'browser',browser,'os',os,'details',details) FROM activity WHERE session_key=$5 AND kind<>'engagement' AND ($6::timestamptz IS NULL OR (occurred_at,coalesce((details->>'sequence')::int,0),id)>($6,$7,$8::uuid)) ORDER BY occurred_at,coalesce((details->>'sequence')::int,0),id LIMIT 201 OFFSET $9"
        );
        let event_id: Option<Uuid> = cursor
            .as_ref()
            .map(|c| c.key.parse())
            .transpose()
            .map_err(|_| Error::invalid("Invalid event cursor."))?;
        let mut conn = state.acquire().await?;
        let mut rows: Vec<Value> = sqlx::query_scalar(&statement)
            .bind(id)
            .bind(range.from)
            .bind(range.to)
            .bind(visitor)
            .bind(key)
            .bind(cursor.as_ref().map(|c| c.at))
            .bind(cursor.as_ref().map_or(0, |c| c.sequence))
            .bind(event_id)
            .bind(offset)
            .fetch_all(&mut *conn)
            .await?;
        if rows.is_empty() && offset == 0 && cursor.is_none() {
            return Err(Error::new(
                404,
                "session_not_found",
                "Session not found in this environment and date range.",
            ));
        }
        let more = rows.len() > 200;
        rows.truncate(200);
        let next = if more {
            cursor::next(state, &scope, rows.last(), true)?
        } else {
            None
        };
        return Ok(json!({"events":rows,"hasMore":more,"nextOffset":offset+200,"nextCursor":next}));
    }
    let mut conn = state.acquire().await?;
    let mut report: Value = sqlx::query_scalar(include_str!("sql/session_summaries.sql"))
        .bind(id)
        .bind(range.from)
        .bind(range.to)
        .bind(visitor)
        .bind(cursor.as_ref().map(|c| c.at))
        .bind(cursor.as_ref().map(|c| &c.key))
        .bind(cursor.as_ref().map(|c| &c.tie))
        .bind(offset)
        .fetch_one(&mut *conn)
        .await?;
    let rows = report["sessions"]
        .as_array_mut()
        .ok_or_else(Error::unavailable)?;
    let more = rows.len() > 50;
    rows.truncate(50);
    let next = if more {
        cursor::next(state, &scope, rows.last(), false)?
    } else {
        None
    };
    report["range"] = json!(range);
    report["retentionDays"] = json!(30);
    report["hasMore"] = json!(more);
    report["nextOffset"] = json!(offset + 50);
    report["nextCursor"] = json!(next);
    Ok(report)
}

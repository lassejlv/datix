use analytics_core::{Error, Result, State, validation::DateRange};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde_json::{Value, json};
use std::collections::HashMap;
use uuid::Uuid;
pub async fn installation(state: &State, id: Uuid) -> Result<Value> {
    let latest:Option<DateTime<Utc>>=sqlx::query_scalar("SELECT received_at FROM events WHERE site_id=$1 AND type='pageview' ORDER BY received_at DESC LIMIT 1").bind(id).fetch_optional(&state.db).await?;
    Ok(json!({"receiving":latest.is_some(),"lastReceivedAt":latest}))
}
pub async fn overview(state: &State, id: Uuid, range: DateRange) -> Result<Value> {
    let (pageviews,events,visitors):(i64,i64,i64)=sqlx::query_as("SELECT coalesce(sum(pageviews),0)::bigint,coalesce(sum(custom_events),0)::bigint,coalesce(sum(visitors),0)::bigint FROM daily_stats WHERE site_id=$1 AND dimension='total' AND day BETWEEN $2 AND $3")
 .bind(id).bind(range.from).bind(range.to).fetch_one(&state.db).await?;
    Ok(
        json!({"range":range,"pageviews":pageviews,"customEvents":events,"dailyUniqueVisitors":visitors,"visitorMetric":"sum_of_daily_unique_visitors"}),
    )
}
pub async fn timeseries(state: &State, id: Uuid, range: DateRange) -> Result<Value> {
    let rows:Vec<(NaiveDate,i64,i64,i64)>=sqlx::query_as("SELECT day,pageviews,custom_events,visitors FROM daily_stats WHERE site_id=$1 AND dimension='total' AND day BETWEEN $2 AND $3 ORDER BY day").bind(id).bind(range.from).bind(range.to).fetch_all(&state.db).await?;
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
    let rows:Vec<(String,i64)>=sqlx::query_as("SELECT value,sum(CASE WHEN dimension='event' THEN custom_events ELSE pageviews END)::bigint AS count FROM daily_stats WHERE site_id=$1 AND dimension=$2 AND day BETWEEN $3 AND $4 GROUP BY value ORDER BY count DESC,value ASC LIMIT $5")
 .bind(id).bind(dimension).bind(range.from).bind(range.to).bind(limit).fetch_all(&state.db).await?;
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
    let visitor = params.get("visitor");
    let session = params.get("session");
    for key in [visitor, session].into_iter().flatten() {
        if !crate::tracking::is_hash(key) {
            return Err(Error::invalid("Invalid visitor or session identifier."));
        }
    }
    let source = include_str!("sql/activity.sql");
    if let Some(key) = session {
        let statement = format!(
            "{source} SELECT jsonb_build_object('id',id,'receivedAt',received_at,'occurredAt',occurred_at,'kind',kind,'name',name,'path',path,'referrer',referrer,'country',country,'device',device,'browser',browser,'os',os,'details',details) FROM activity WHERE session_key=$5 AND kind<>'engagement' ORDER BY occurred_at,coalesce((details->>'sequence')::int,0),id LIMIT 201 OFFSET $6"
        );
        let mut rows: Vec<Value> = sqlx::query_scalar(&statement)
            .bind(id)
            .bind(range.from)
            .bind(range.to)
            .bind(visitor)
            .bind(key)
            .bind(offset)
            .fetch_all(&state.db)
            .await?;
        if rows.is_empty() && offset == 0 {
            return Err(Error::new(
                404,
                "session_not_found",
                "Session not found in this environment and date range.",
            ));
        }
        let more = rows.len() > 200;
        rows.truncate(200);
        return Ok(json!({"events":rows,"hasMore":more,"nextOffset":offset+200}));
    }
    let grouped = include_str!("sql/grouped.sql");
    let statement = format!(
        "{source}, grouped AS ({grouped}) SELECT to_jsonb(s) FROM grouped s ORDER BY \"lastSeenAt\" DESC,id LIMIT 51 OFFSET $5"
    );
    let mut rows: Vec<Value> = sqlx::query_scalar(&statement)
        .bind(id)
        .bind(range.from)
        .bind(range.to)
        .bind(visitor)
        .bind(offset)
        .fetch_all(&state.db)
        .await?;
    let totals = format!(
        "{source}, grouped AS ({grouped}) SELECT jsonb_build_object('sessions',count(*),'visitors',count(DISTINCT \"visitorKey\"),'averageActiveSeconds',coalesce(round(avg(\"activeSeconds\")),0),'clicks',coalesce(sum(clicks),0)) FROM grouped"
    );
    let summary: Value = sqlx::query_scalar(&totals)
        .bind(id)
        .bind(range.from)
        .bind(range.to)
        .bind(visitor)
        .fetch_one(&state.db)
        .await?;
    let more = rows.len() > 50;
    rows.truncate(50);
    Ok(
        json!({"range":range,"retentionDays":30,"summary":summary,"sessions":rows,"hasMore":more,"nextOffset":offset+50}),
    )
}

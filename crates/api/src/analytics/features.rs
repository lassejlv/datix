use super::{
    Parameters, overview, read_transaction,
    reports::{DateRange, NATIVE},
};
use crate::{AppState, error::ApiError, sites};
use axum::http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

fn missing() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "not_found", "Feature not found.")
}

fn invalid(message: &'static str) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "invalid_request", message)
}

fn fields(input: &Value, allowed: &[&str]) -> Result<(), ApiError> {
    if input
        .as_object()
        .is_none_or(|o| o.keys().any(|k| !allowed.contains(&k.as_str())))
    {
        return Err(ApiError::invalid());
    }
    Ok(())
}

pub(super) fn event_name(value: &str) -> bool {
    let mut chars = value.bytes();
    value.len() <= 64
        && chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-'))
}

pub(super) async fn configure(
    state: &AppState,
    env: Uuid,
    feature: &str,
    input: Value,
) -> Result<Value, ApiError> {
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT id FROM environments WHERE id=$1 FOR UPDATE")
        .bind(env)
        .execute(&mut *tx)
        .await?;
    let result = match feature {
        "goals" => {
            fields(&input, &["name", "matchType", "matchValue"])?;
            if !sites::valid_name(&input["name"]) {
                return Err(ApiError::invalid());
            }
            let name = input["name"].as_str().ok_or_else(ApiError::invalid)?.trim();
            let kind = input["matchType"].as_str().ok_or_else(ApiError::invalid)?;
            let value = input["matchValue"].as_str().ok_or_else(ApiError::invalid)?;
            if value.is_empty()
                || value.encode_utf16().count() > 2048
                || !matches!(kind, "page" | "event")
            {
                return Err(ApiError::invalid());
            }
            if if kind == "event" {
                !event_name(value)
            } else {
                !value.starts_with('/') || value.contains(['?', '#'])
            } {
                return Err(invalid(
                    "Use an event name or a page path without a query string.",
                ));
            }
            let count: i64 =
                sqlx::query_scalar("SELECT count(*) FROM conversion_goals WHERE environment_id=$1")
                    .bind(env)
                    .fetch_one(&mut *tx)
                    .await?;
            if count >= 20 {
                return Err(invalid("An environment can have up to 20 goals."));
            }
            let goal:Option<Value>=sqlx::query_scalar("INSERT INTO conversion_goals(environment_id,name,match_type,match_value) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING jsonb_build_object('id',id,'name',name,'matchType',match_type,'matchValue',match_value)")
                .bind(env).bind(name).bind(kind).bind(value).fetch_optional(&mut *tx).await?;
            json!({"goal":goal.ok_or_else(||invalid("A goal already tracks this conversion."))?})
        }
        "annotations" => match input["action"].as_str() {
            Some("delete") => {
                fields(&input, &["action", "id"])?;
                let id = sites::identifier(input["id"].as_str().ok_or_else(ApiError::invalid)?)?;
                let result = sqlx::query(
                    "DELETE FROM overview_annotations WHERE environment_id=$1 AND id=$2",
                )
                .bind(env)
                .bind(id)
                .execute(&mut *tx)
                .await?;
                if result.rows_affected() == 0 {
                    return Err(missing());
                }
                json!({"deleted":true})
            }
            Some("create") => {
                fields(&input, &["action", "day", "label"])?;
                let day = input["day"].as_str().ok_or_else(ApiError::invalid)?;
                let range = DateRange::parse(
                    &[("from".into(), day.into()), ("to".into(), day.into())].into(),
                )?;
                let label = input["label"]
                    .as_str()
                    .filter(|l| !l.is_empty() && l.encode_utf16().count() <= 120)
                    .ok_or_else(ApiError::invalid)?;
                let count: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM overview_annotations WHERE environment_id=$1",
                )
                .bind(env)
                .fetch_one(&mut *tx)
                .await?;
                if count >= 500 {
                    return Err(invalid("An environment can have up to 500 annotations."));
                }
                let row:Value=sqlx::query_scalar("INSERT INTO overview_annotations(environment_id,day,label) VALUES($1,$2,$3) RETURNING jsonb_build_object('id',id,'day',day::text,'label',label)")
                        .bind(env).bind(range.from).bind(label.trim()).fetch_one(&mut *tx).await?;
                json!({"annotation":row})
            }
            _ => return Err(ApiError::invalid()),
        },
        "errors" => {
            fields(&input, &["fingerprint"])?;
            let fingerprint = input["fingerprint"]
                .as_str()
                .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                .ok_or_else(ApiError::invalid)?;
            sqlx::query("INSERT INTO error_resolutions(environment_id,fingerprint) SELECT $1,$2 WHERE EXISTS(SELECT 1 FROM diagnostic_events WHERE environment_id=$1 AND fingerprint=$2 AND kind='error') ON CONFLICT(environment_id,fingerprint) DO UPDATE SET resolved_at=now()")
                .bind(env).bind(fingerprint).execute(&mut *tx).await?;
            json!({"resolved":true})
        }
        _ => return Err(missing()),
    };
    tx.commit().await?;
    Ok(result)
}

pub(super) async fn delete_goal(
    state: &AppState,
    env: Uuid,
    goal: Uuid,
) -> Result<Value, ApiError> {
    if sqlx::query("DELETE FROM conversion_goals WHERE environment_id=$1 AND id=$2")
        .bind(env)
        .bind(goal)
        .execute(&state.pool)
        .await?
        .rows_affected()
        == 0
    {
        return Err(missing());
    }
    Ok(json!({"deleted":true}))
}

pub(super) async fn goals(
    connection: &mut PgConnection,
    env: Uuid,
    counts: Vec<Value>,
    visitors: i64,
) -> Result<Value, ApiError> {
    let mut definitions:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'name',name,'matchType',match_type,'matchValue',match_value,'createdAt',created_at) FROM conversion_goals WHERE environment_id=$1 ORDER BY created_at,id")
        .bind(env).fetch_all(connection).await?;
    for goal in &mut definitions {
        let row = counts.iter().find(|c| c["goal_id"] == goal["id"]);
        goal["conversions"] = json!(row.and_then(|r| r["conversions"].as_i64()).unwrap_or(0));
        goal["visitors"] = json!(row.and_then(|r| r["visitors"].as_i64()).unwrap_or(0));
    }
    Ok(json!({"goals":definitions,"visitors":visitors}))
}

pub(super) async fn read(
    state: &AppState,
    env: Uuid,
    feature: &str,
    query: &Parameters,
) -> Result<Value, ApiError> {
    let range = DateRange::parse(query)?;
    if feature == "overview" {
        return overview::read(state, env, query).await;
    }
    let mut tx = read_transaction(state).await?;
    if feature == "live" {
        return Ok(sqlx::query_scalar("WITH recent AS MATERIALIZED (SELECT * FROM events WHERE site_id=$1 AND day>=current_date-1 AND received_at>now()-interval '5 minutes') SELECT jsonb_build_object('active',(SELECT count(DISTINCT(day,visitor)) FROM recent),'recent',coalesce((SELECT jsonb_agg(jsonb_build_object('path',path,'country',country,'at',received_at) ORDER BY received_at DESC) FROM (SELECT * FROM recent ORDER BY received_at DESC,id LIMIT 10) r),'[]'::jsonb))")
            .bind(env).fetch_one(&mut *tx).await?);
    }
    if feature == "goals" {
        let counts:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('goal_id',goal_id,'conversions',count(*),'visitors',count(DISTINCT(day,visitor))) FROM goal_conversions WHERE environment_id=$1 AND day BETWEEN $2 AND $3 GROUP BY goal_id")
            .bind(env).bind(range.from).bind(range.to).fetch_all(&mut *tx).await?;
        let visitors: i64 = sqlx::query_scalar(&format!(
            "{NATIVE} SELECT coalesce(sum(visitors),0)::bigint FROM native"
        ))
        .bind(env)
        .bind(range.from)
        .bind(range.to)
        .fetch_one(&mut *tx)
        .await?;
        return goals(&mut tx, env, counts, visitors).await;
    }
    let statement = match feature {
        "web-vitals" => {
            "SELECT jsonb_build_object('name',payload->>'name','device',device,'samples',count(*),'p75',percentile_cont(0.75) WITHIN GROUP(ORDER BY (payload->>'value')::double precision)) FROM diagnostic_events WHERE environment_id=$1 AND kind='vital' AND received_at>=$2::date AND received_at<$3::date+interval '1 day' GROUP BY payload->>'name',device ORDER BY payload->>'name',device"
        }
        "errors" => {
            "SELECT jsonb_build_object('fingerprint',fingerprint,'message',(array_agg(payload->>'message' ORDER BY received_at DESC))[1],'source',(array_agg(payload->>'source' ORDER BY received_at DESC))[1],'stack',(array_agg(payload->>'stack' ORDER BY received_at DESC))[1],'path',(array_agg(path ORDER BY received_at DESC))[1],'occurrences',count(*),'visitors',count(DISTINCT(received_at::date,visitor)),'lastSeen',max(received_at),'resolved',false) FROM diagnostic_events WHERE environment_id=$1 AND kind='error' AND received_at>=$2::date AND received_at<$3::date+interval '1 day' GROUP BY fingerprint ORDER BY max(received_at) DESC LIMIT 100"
        }
        _ => return Err(missing()),
    };
    let mut items: Vec<Value> = sqlx::query_scalar(statement)
        .bind(env)
        .bind(range.from)
        .bind(range.to)
        .fetch_all(&mut *tx)
        .await?;
    if feature == "errors" {
        let resolved: Vec<(String, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
            "SELECT fingerprint,resolved_at FROM error_resolutions WHERE environment_id=$1",
        )
        .bind(env)
        .fetch_all(&mut *tx)
        .await?;
        for item in &mut items {
            let last_seen = item["lastSeen"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok());
            item["resolved"] = json!(
                resolved
                    .iter()
                    .any(|(fingerprint, at)| item["fingerprint"] == *fingerprint
                        && last_seen.is_some_and(|seen| *at >= seen))
            );
        }
    }
    Ok(json!({"items":items}))
}

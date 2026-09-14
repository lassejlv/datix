use super::{
    Parameters, read_transaction,
    reports::{DateRange, bounded_integer},
};
use crate::{AppState, error::ApiError, sites};
use axum::http::StatusCode;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use uuid::Uuid;

const ACTIVITY: &str = include_str!("sql/activity.sql");
const GROUPED: &str = include_str!("sql/grouped.sql");
const SUMMARIES: &str = include_str!("sql/session_summaries.sql");

#[derive(Serialize, Deserialize)]
struct Cursor {
    version: u8,
    scope: String,
    at: String,
    key: String,
    tie: String,
    sequence: i64,
}

fn mac(secret: &str, message: &str) -> Result<Vec<u8>, ApiError> {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| ApiError::unavailable())?;
    mac.update(message.as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}

fn signature(secret: &str, payload: &str) -> Result<Vec<u8>, ApiError> {
    mac(secret, &format!("session-cursor-v1:{payload}"))
}

fn decode(secret: &str, token: &str, scope: &str) -> Result<Cursor, ApiError> {
    if token.len() > 2048 {
        return Err(ApiError::invalid());
    }
    let (payload, sig) = token.split_once('.').ok_or_else(ApiError::invalid)?;
    let actual = URL_SAFE_NO_PAD
        .decode(sig)
        .map_err(|_| ApiError::invalid())?;
    if !bool::from(actual.ct_eq(&signature(secret, payload)?)) {
        return Err(ApiError::invalid());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| ApiError::invalid())?;
    let cursor: Cursor = serde_json::from_slice(&bytes).map_err(|_| ApiError::invalid())?;
    if cursor.version != 1
        || cursor.scope != scope
        || DateTime::parse_from_rfc3339(&cursor.at).is_err()
    {
        return Err(ApiError::invalid());
    }
    Ok(cursor)
}

fn encode(secret: &str, scope: &str, row: Option<&Value>, detail: bool) -> Result<Value, ApiError> {
    let Some(row) = row else {
        return Ok(Value::Null);
    };
    let cursor = Cursor {
        version: 1,
        scope: scope.into(),
        at: row[if detail { "occurredAt" } else { "lastSeenAt" }]
            .as_str()
            .ok_or_else(ApiError::unavailable)?
            .into(),
        key: row["id"].as_str().ok_or_else(ApiError::unavailable)?.into(),
        tie: row["visitorKey"].as_str().unwrap_or("").into(),
        sequence: row["details"]["sequence"].as_i64().unwrap_or(0),
    };
    let payload =
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&cursor).map_err(|_| ApiError::unavailable())?);
    Ok(json!(format!(
        "{payload}.{}",
        URL_SAFE_NO_PAD.encode(signature(secret, &payload)?)
    )))
}

pub(super) async fn read(
    state: &AppState,
    env: Uuid,
    query: &Parameters,
) -> Result<Value, ApiError> {
    let range = DateRange::parse(query)?;
    let offset = bounded_integer(query.get("offset"), 0, 0, 100_000)?;
    let hash = |key| -> Result<Option<&str>, ApiError> {
        let value = query.get(key).map(String::as_str).filter(|s| !s.is_empty());
        if value.is_some_and(|s| {
            s.len() != 64
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }) {
            return Err(ApiError::invalid());
        }
        Ok(value)
    };
    let visitor = hash("visitor")?;
    let session = hash("session")?;
    let raw_cursor = query.get("cursor").filter(|s| !s.is_empty());
    if offset != 0 && raw_cursor.is_some() {
        return Err(ApiError::invalid());
    }
    let secret = &state.config.auth_secret;
    let scope = hex::encode(mac(
        secret,
        &json!([
            "session-cursor-v1",
            env,
            range.from,
            range.to,
            visitor,
            session
        ])
        .to_string(),
    )?);
    let cursor = raw_cursor.map(|c| decode(secret, c, &scope)).transpose()?;
    let cursor_at = cursor
        .as_ref()
        .map(|c| DateTime::parse_from_rfc3339(&c.at).map(|d| d.with_timezone(&Utc)))
        .transpose()
        .map_err(|_| ApiError::invalid())?;
    let mut tx = read_transaction(state).await?;
    if let Some(session) = session {
        let cursor_key = cursor
            .as_ref()
            .map(|c| sites::identifier(&c.key))
            .transpose()?;
        let statement = format!(
            "{ACTIVITY} SELECT jsonb_build_object('id',id,'receivedAt',received_at,'occurredAt',occurred_at,'kind',kind,'name',name,'path',path,'referrer',referrer,'country',country,'device',device,'browser',browser,'os',os,'details',details) FROM activity WHERE session_key=$5 AND kind<>'engagement' AND ($6::timestamptz IS NULL OR (occurred_at,coalesce((details->>'sequence')::int,0),id)>($6,$7,$8::uuid)) ORDER BY occurred_at,coalesce((details->>'sequence')::int,0),id LIMIT 201 OFFSET $9"
        );
        let mut events: Vec<Value> = sqlx::query_scalar(&statement)
            .bind(env)
            .bind(range.from)
            .bind(range.to)
            .bind(visitor)
            .bind(session)
            .bind(cursor_at)
            .bind(cursor.as_ref().map(|c| c.sequence).unwrap_or(0))
            .bind(cursor_key)
            .bind(offset)
            .fetch_all(&mut *tx)
            .await?;
        if events.is_empty() && offset == 0 && cursor.is_none() {
            return Err(ApiError::new(
                StatusCode::NOT_FOUND,
                "session_not_found",
                "Session not found in this environment and date range.",
            ));
        }
        let has_more = events.len() > 200;
        events.truncate(200);
        let next = if has_more {
            encode(secret, &scope, events.last(), true)?
        } else {
            Value::Null
        };
        return Ok(
            json!({"events":events,"hasMore":has_more,"nextOffset":offset+200,"nextCursor":next}),
        );
    }
    let raw: String = sqlx::query_scalar(&format!(
        "{ACTIVITY}, grouped AS MATERIALIZED ({GROUPED}) {SUMMARIES}"
    ))
    .bind(env)
    .bind(range.from)
    .bind(range.to)
    .bind(visitor)
    .bind(cursor_at)
    .bind(cursor.as_ref().map(|c| c.key.as_str()))
    .bind(cursor.as_ref().map(|c| c.tie.as_str()))
    .bind(offset)
    .fetch_one(&mut *tx)
    .await?;
    let mut result: Value = serde_json::from_str(&raw).map_err(|_| ApiError::unavailable())?;
    let items = result["sessions"]
        .as_array_mut()
        .ok_or_else(ApiError::unavailable)?;
    let has_more = items.len() > 50;
    items.truncate(50);
    let next = if has_more {
        encode(secret, &scope, items.last(), false)?
    } else {
        Value::Null
    };
    result["range"] = json!(range);
    result["retentionDays"] = json!(30);
    result["hasMore"] = json!(has_more);
    result["nextOffset"] = json!(offset + 50);
    result["nextCursor"] = next;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cursor_signatures_bind_report_scope_and_reject_tampering() {
        // Produced by the original Node createHmac + JSON.stringify implementation.
        let legacy = "eyJ2ZXJzaW9uIjoxLCJzY29wZSI6ImFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWEiLCJhdCI6IjIwMjYtMDktMTRUMTA6MDA6MDAuMDAwWiIsImtleSI6ImZpeHR1cmUtc2Vzc2lvbiIsInRpZSI6ImZpeHR1cmUtdmlzaXRvciIsInNlcXVlbmNlIjowfQ.fyf_Vj9lnXc-o6JLxDB4avcZoGTQ7PoL6Rkcp1j9tIQ";
        let decoded = decode("fixture-secret", legacy, &"a".repeat(64)).unwrap();
        assert_eq!(decoded.key, "fixture-session");
        let row = json!({"id":"a","lastSeenAt":"2026-09-14T10:00:00.000Z","visitorKey":"b"});
        let token = encode("fixture-secret", "scope", Some(&row), false).unwrap();
        let token = token.as_str().unwrap();
        assert!(decode("fixture-secret", token, "scope").is_ok());
        assert!(decode("fixture-secret", token, "other-environment").is_err());
        assert!(decode("other-secret", token, "scope").is_err());
    }
}

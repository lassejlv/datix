use analytics_core::{Error, Result, State, crypto, validation::DateRange};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cursor {
    version: u8,
    scope: String,
    pub at: DateTime<Utc>,
    pub key: String,
    pub tie: String,
    pub sequence: i32,
}
pub fn scope(
    state: &State,
    environment: Uuid,
    range: &DateRange,
    visitor: Option<&String>,
    session: Option<&String>,
) -> String {
    crypto::hash(
        &state.config.auth_secret,
        &json!([
            "session-cursor-v1",
            environment,
            range.from,
            range.to,
            visitor,
            session
        ])
        .to_string(),
    )
}
pub fn decode(state: &State, value: Option<&String>, scope: &str) -> Result<Option<Cursor>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let invalid = || Error::invalid("Invalid pagination cursor for this report.");
    if value.len() > 2048 {
        return Err(invalid());
    }
    let (payload, signature) = value.split_once('.').ok_or_else(invalid)?;
    let received = URL_SAFE_NO_PAD.decode(signature).map_err(|_| invalid())?;
    let expected = crypto::signature(
        state.config.auth_secret.as_bytes(),
        format!("session-cursor-v1:{payload}").as_bytes(),
    );
    if !crypto::equal(&expected, &received) {
        return Err(invalid());
    }
    let bytes = URL_SAFE_NO_PAD.decode(payload).map_err(|_| invalid())?;
    let cursor: Cursor = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if cursor.version != 1 || cursor.scope != scope {
        return Err(invalid());
    }
    Ok(Some(cursor))
}
pub fn next(
    state: &State,
    scope: &str,
    row: Option<&Value>,
    detail: bool,
) -> Result<Option<String>> {
    let Some(row) = row else {
        return Ok(None);
    };
    let at = row[if detail { "occurredAt" } else { "lastSeenAt" }]
        .as_str()
        .and_then(|v| v.parse().ok())
        .ok_or_else(Error::unavailable)?;
    let cursor = Cursor {
        version: 1,
        scope: scope.into(),
        at,
        key: row["id"].as_str().ok_or_else(Error::unavailable)?.into(),
        tie: row["visitorKey"].as_str().unwrap_or("").into(),
        sequence: row["details"]["sequence"].as_i64().unwrap_or(0) as i32,
    };
    let payload =
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&cursor).map_err(|_| Error::unavailable())?);
    let signature = URL_SAFE_NO_PAD.encode(crypto::signature(
        state.config.auth_secret.as_bytes(),
        format!("session-cursor-v1:{payload}").as_bytes(),
    ));
    Ok(Some(format!("{payload}.{signature}")))
}

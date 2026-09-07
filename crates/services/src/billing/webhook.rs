use super::{ORGANIZATION_ID, provider};
use analytics_core::{Error, Result, State, crypto};
use axum::http::HeaderMap;
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
fn invalid_signature() -> Error {
    Error::new(403, "invalid_signature", "Invalid webhook signature.")
}
pub fn verify(headers: &HeaderMap, body: &[u8], secret: &str, now: i64) -> Result<()> {
    let get = |name| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(invalid_signature)
    };
    let id = get("webhook-id")?;
    let timestamp = get("webhook-timestamp")?;
    let seconds = timestamp.parse::<i64>().map_err(|_| invalid_signature())?;
    if seconds.abs_diff(now) > 300 {
        return Err(invalid_signature());
    }
    let mut content = format!("{id}.{timestamp}.").into_bytes();
    content.extend_from_slice(body);
    // Polar uses the raw configured secret as the Standard Webhooks HMAC key.
    let expected = crypto::signature(secret.as_bytes(), &content);
    let valid = get("webhook-signature")?.split_whitespace().any(|item| {
        item.strip_prefix("v1,")
            .and_then(|s| STANDARD.decode(s).ok())
            .is_some_and(|sig| crypto::equal(&expected, &sig))
    });
    if !valid {
        return Err(invalid_signature());
    }
    Ok(())
}
pub async fn handle(state: &State, headers: &HeaderMap, body: &[u8]) -> Result<Value> {
    let secret = state
        .config
        .polar_webhook_secret
        .as_deref()
        .ok_or_else(|| Error::new(503, "webhook_unconfigured", "Webhook is not configured."))?;
    verify(headers, body, secret, Utc::now().timestamp())?;
    let invalid = || Error::new(400, "invalid_webhook", "Invalid webhook payload.");
    let event: Value = serde_json::from_slice(body).map_err(|_| invalid())?;
    let kind = event["type"].as_str().ok_or_else(invalid)?;
    if !["customer.state_changed", "customer.deleted"].contains(&kind) {
        return Ok(json!({"received":true,"ignored":true}));
    }
    let data = &event["data"];
    if data["organization_id"] != ORGANIZATION_ID {
        return Err(Error::new(
            403,
            "invalid_organization",
            "Unexpected webhook organization.",
        ));
    }
    let id = headers
        .get("webhook-id")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(invalid)?;
    if id.is_empty() || id.len() > 255 {
        return Err(invalid());
    }
    let occurred: DateTime<Utc> = event["timestamp"]
        .as_str()
        .ok_or_else(invalid)?
        .parse()
        .map_err(|_| invalid())?;
    let deleted = kind == "customer.deleted" || !data["deleted_at"].is_null();
    let customer = data["id"].as_str().ok_or_else(invalid)?;
    let subscriptions = if deleted {
        json!([])
    } else {
        provider::subscriptions(data)?
    };
    let mut tx = state.db.begin().await?;
    let inserted=sqlx::query("INSERT INTO billing_webhook_events(id,type,occurred_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING").bind(id).bind(kind).bind(occurred).execute(&mut *tx).await?.rows_affected();
    if inserted == 0 {
        tx.commit().await?;
        return Ok(json!({"received":true,"duplicate":true}));
    }
    let owner: Option<String> = if !deleted {
        sqlx::query_scalar("SELECT id FROM \"user\" WHERE id=$1")
            .bind(data["external_id"].as_str())
            .fetch_optional(&mut *tx)
            .await?
    } else {
        None
    };
    let applied = provider::save_snapshot(
        &mut tx,
        customer,
        owner.as_deref(),
        subscriptions,
        deleted,
        occurred,
    )
    .await?;
    tx.commit().await?;
    Ok(json!({"received":true,"duplicate":false,"applied":applied}))
}

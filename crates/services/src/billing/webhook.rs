use super::{catalog::CATALOG, provider};
use analytics_core::{Error, Result, State, crypto};
use axum::http::HeaderMap;
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use uuid::Uuid;

fn invalid_signature() -> Error {
    Error::new(
        400,
        "invalid_webhook_signature",
        "Invalid webhook signature.",
    )
}
/// Standard Webhooks: HMAC-SHA256 over the ID, delivery timestamp and exact body.
/// Datix uses a new endpoint, whose whsec_ suffix is a base64-encoded signing key.
fn verify(secret: &str, headers: &HeaderMap, body: &[u8], now: DateTime<Utc>) -> Result<String> {
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let id = header("webhook-id")
        .filter(|v| !v.is_empty() && v.len() <= 200)
        .ok_or_else(invalid_signature)?;
    let timestamp = header("webhook-timestamp").ok_or_else(invalid_signature)?;
    let seconds = timestamp.parse::<i64>().map_err(|_| invalid_signature())?;
    if now.timestamp().abs_diff(seconds) > 300 {
        return Err(invalid_signature());
    }
    let key = STANDARD
        .decode(secret.strip_prefix("whsec_").unwrap_or(secret))
        .ok()
        .filter(|v| v.len() >= 32)
        .ok_or_else(|| {
            Error::new(
                503,
                "webhook_unconfigured",
                "Billing webhook is temporarily unavailable.",
            )
        })?;
    let mut signed = format!("{id}.{timestamp}.").into_bytes();
    signed.extend_from_slice(body);
    let expected = crypto::signature(&key, &signed);
    let valid = header("webhook-signature").is_some_and(|signatures| {
        signatures.split_whitespace().any(|signature| {
            signature
                .strip_prefix("v1,")
                .and_then(|s| STANDARD.decode(s).ok())
                .is_some_and(|received| crypto::equal(&expected, &received))
        })
    });
    if !valid {
        return Err(invalid_signature());
    }
    Ok(id.to_owned())
}

pub async fn receive(state: &State, headers: &HeaderMap, body: &[u8]) -> Result<Value> {
    let secret = state
        .config
        .polar_webhook_secret
        .as_deref()
        .ok_or_else(|| {
            Error::new(
                503,
                "webhook_unconfigured",
                "Billing webhook is temporarily unavailable.",
            )
        })?;
    let now = Utc::now();
    let id = verify(secret, headers, body, now)?;
    let value: Value =
        serde_json::from_slice(body).map_err(|_| Error::invalid("Invalid webhook payload."))?;
    let kind = value["type"]
        .as_str()
        .ok_or_else(|| Error::invalid("Invalid webhook event type."))?;
    if !matches!(kind, "customer.state_changed" | "customer.deleted") {
        return Ok(json!({"received":true,"handled":false}));
    }
    let occurred = provider::date(&value, "timestamp")
        .filter(|t| *t <= now + chrono::Duration::minutes(5))
        .ok_or_else(|| Error::invalid("Invalid webhook event timestamp."))?;
    let customer = &value["data"];
    if customer["organization_id"]
        .as_str()
        .and_then(|s| Uuid::parse_str(s).ok())
        != Some(CATALOG.organization_id)
    {
        return Err(Error::new(
            400,
            "invalid_billing_organization",
            "Webhook organization does not match.",
        ));
    }
    let Some(owner) = customer["external_id"].as_str().filter(|v| !v.is_empty()) else {
        // Unlinked provider customers cannot acquire an app account through email matching.
        return Ok(json!({"received":true,"handled":false}));
    };
    provider::verify_customer(customer, owner)?;
    let deleted = kind == "customer.deleted" || !customer["deleted_at"].is_null();
    let subscriptions = if deleted {
        json!([])
    } else {
        provider::subscriptions(customer, now)?
    };
    let mut tx = state.db.begin().await?;
    let inserted = sqlx::query("INSERT INTO billing_webhook_events(id,type,occurred_at) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING")
        .bind(format!("polar:{}:{id}", CATALOG.organization_id)).bind(kind).bind(occurred)
        .execute(&mut *tx).await?.rows_affected();
    if inserted == 0 {
        return Ok(json!({"received":true,"duplicate":true}));
    }
    let exists: Option<String> =
        sqlx::query_scalar("SELECT id FROM \"user\" WHERE id=$1 FOR UPDATE")
            .bind(owner)
            .fetch_optional(&mut *tx)
            .await?;
    let changed = if exists.is_some() {
        provider::save_snapshot(&mut tx, owner, subscriptions, deleted, occurred).await?
    } else {
        false
    };
    tx.commit().await?;
    Ok(json!({"received":true,"updated":changed}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn signed(secret: &str, body: &[u8], now: DateTime<Utc>) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("webhook-id", "test-webhook".parse().unwrap());
        h.insert(
            "webhook-timestamp",
            now.timestamp().to_string().parse().unwrap(),
        );
        let mut input = format!("test-webhook.{}.", now.timestamp()).into_bytes();
        input.extend_from_slice(body);
        let key = STANDARD
            .decode(secret.strip_prefix("whsec_").unwrap())
            .unwrap();
        h.insert(
            "webhook-signature",
            format!("v1,{}", STANDARD.encode(crypto::signature(&key, &input)))
                .parse()
                .unwrap(),
        );
        h
    }
    #[test]
    fn validates_exact_bytes_timestamp_and_rotated_signatures() {
        let secret = format!("whsec_{}", STANDARD.encode([7u8; 32]));
        let body = r#"{"type":"customer.state_changed","data":{"name":"Æ"}}"#.as_bytes();
        let now = Utc::now();
        let mut headers = signed(&secret, body, now);
        assert!(verify(&secret, &headers, body, now).is_ok());
        assert!(verify(&secret, &headers, b"{}", now).is_err());
        assert!(
            verify(
                &secret,
                &headers,
                body,
                now + chrono::Duration::seconds(301)
            )
            .is_err()
        );
        assert!(
            verify(
                &secret,
                &headers,
                body,
                now - chrono::Duration::seconds(301)
            )
            .is_err()
        );
        let valid = headers["webhook-signature"].to_str().unwrap();
        headers.insert(
            "webhook-signature",
            format!("v1,invalid v2,ignored {valid}").parse().unwrap(),
        );
        assert!(verify(&secret, &headers, body, now).is_ok());
        headers.insert("webhook-id", "other".parse().unwrap());
        assert!(verify(&secret, &headers, body, now).is_err());
        headers.remove("webhook-signature");
        assert!(verify(&secret, &headers, body, now).is_err());
    }
}

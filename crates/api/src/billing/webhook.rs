use super::{
    Billing,
    provider::{Customer, verify_customer},
    unconfigured,
};
use crate::error::ApiError;
use axum::http::{HeaderMap, StatusCode};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use standardwebhooks::Webhook;

#[derive(Deserialize)]
struct Event {
    #[serde(rename = "type")]
    kind: String,
    timestamp: DateTime<Utc>,
    data: Value,
}

fn verify(secret: &str, headers: &HeaderMap, body: &[u8]) -> Result<Event, ApiError> {
    let invalid_signature = || {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_webhook_signature",
            "Invalid webhook signature.",
        )
    };
    // Check the range before calling the verifier: its signed timestamp subtraction
    // can overflow for hostile i64 values. Still verify the original, unmodified bytes.
    let timestamp = headers
        .get("webhook-timestamp")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<i64>().ok())
        .ok_or_else(invalid_signature)?;
    if timestamp.abs_diff(Utc::now().timestamp()) > 300 {
        return Err(invalid_signature());
    }
    // Older Polar secrets sign with the complete UTF-8 string. Secrets generated
    // from 2026-09-08 use the Standard Webhooks base64-encoded 32-byte key.
    // The generation date is not in delivery headers, so support both schemes.
    let verifier =
        Webhook::from_bytes(secret.as_bytes().to_vec()).map_err(|_| invalid_signature())?;
    if verifier.verify(body, headers).is_err() {
        let key = secret
            .strip_prefix("whsec_")
            .and_then(|encoded| STANDARD.decode(encoded).ok())
            .filter(|key| key.len() == 32)
            .ok_or_else(invalid_signature)?;
        Webhook::from_bytes(key)
            .and_then(|verifier| verifier.verify(body, headers))
            .map_err(|_| invalid_signature())?;
    }
    serde_json::from_slice(body).map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Invalid webhook payload.",
        )
    })
}

impl Billing {
    pub(crate) async fn webhook(
        &self,
        headers: &HeaderMap,
        body: &[u8],
    ) -> Result<Value, ApiError> {
        self.webhook_inner(headers, body)
            .await
            .inspect_err(|error| {
                tracing::warn!(
                    category = "webhook_failed",
                    code = error.code,
                    reason = error.message,
                    http_status = error.status.as_u16(),
                    "Polar webhook rejected"
                );
            })
    }

    async fn webhook_inner(&self, headers: &HeaderMap, body: &[u8]) -> Result<Value, ApiError> {
        if !self.enabled {
            return Err(unconfigured());
        }
        let event = verify(
            self.webhook_secret.as_deref().ok_or_else(unconfigured)?,
            headers,
            body,
        )?;
        if !matches!(
            event.kind.as_str(),
            "customer.state_changed" | "customer.deleted"
        ) {
            return Ok(json!({"received":true,"handled":false}));
        }
        if event
            .timestamp
            .signed_duration_since(Utc::now())
            .num_milliseconds()
            > 300_000
        {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "Invalid webhook event timestamp.",
            ));
        }
        let customer: Customer = serde_json::from_value(event.data).map_err(|_| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "Invalid webhook payload.",
            )
        })?;
        let Some(owner) = customer.external_id.as_deref() else {
            return Ok(json!({"received":true,"handled":false}));
        };
        verify_customer(&customer, owner, &self.catalog)?;
        let id = headers
            .get("webhook-id")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(ApiError::invalid)?;
        let mut tx = self.pool.begin().await?;
        let inserted=sqlx::query("INSERT INTO billing_webhook_events(id,type,occurred_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING")
            .bind(format!("polar:{}:{id}",self.organization_id())).bind(&event.kind).bind(event.timestamp).execute(&mut *tx).await?.rows_affected()>0;
        let result = if !inserted {
            json!({"received":true,"duplicate":true})
        } else {
            let user: Option<String> =
                sqlx::query_scalar("SELECT id FROM public.\"user\" WHERE id=$1 FOR UPDATE")
                    .bind(owner)
                    .fetch_optional(&mut *tx)
                    .await?;
            let updated = if user.is_none() {
                false
            } else {
                self.save(
                    &mut tx,
                    owner,
                    if event.kind == "customer.deleted" {
                        None
                    } else {
                        Some(&customer)
                    },
                    event.timestamp,
                )
                .await?
            };
            json!({"received":true,"updated":updated})
        };
        tx.commit().await?;
        Ok(result)
    }
}

#[cfg(test)]
mod signature_tests {
    use super::*;
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    #[test]
    fn supports_both_polar_signing_generations_and_rejects_tampering() {
        let key = [42_u8; 32];
        let secret = format!("whsec_{}", STANDARD.encode(key));
        let timestamp = Utc::now().timestamp();
        let body = serde_json::to_vec(&json!({
            "type":"customer.state_changed", "timestamp":Utc::now(), "data":{}
        }))
        .unwrap();
        for signing_key in [key.as_slice(), secret.as_bytes()] {
            let mut mac = Hmac::<Sha256>::new_from_slice(signing_key).unwrap();
            mac.update(format!("fixture.{timestamp}.").as_bytes());
            mac.update(&body);
            let mut headers = HeaderMap::new();
            headers.insert("webhook-id", "fixture".parse().unwrap());
            headers.insert("webhook-timestamp", timestamp.to_string().parse().unwrap());
            headers.insert(
                "webhook-signature",
                format!("v1,{}", STANDARD.encode(mac.finalize().into_bytes()))
                    .parse()
                    .unwrap(),
            );
            assert!(verify(&secret, &headers, &body).is_ok());
            assert!(verify("wrong-secret", &headers, &body).is_err());
            let mut changed = body.clone();
            changed.push(b' ');
            assert!(verify(&secret, &headers, &changed).is_err());
            headers.insert(
                "webhook-timestamp",
                (timestamp - 600).to_string().parse().unwrap(),
            );
            assert!(verify(&secret, &headers, &body).is_err());
        }
    }
}

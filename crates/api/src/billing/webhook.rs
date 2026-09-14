use super::{
    Billing,
    provider::{Customer, verify_customer},
    unconfigured,
};
use crate::error::ApiError;
use axum::http::{HeaderMap, StatusCode};
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
    // Polar's official SDK treats its secret as raw UTF-8, including any whsec_ prefix.
    let verifier =
        Webhook::from_bytes(secret.as_bytes().to_vec()).map_err(|_| invalid_signature())?;
    verifier
        .verify(body, headers)
        .map_err(|_| invalid_signature())?;
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

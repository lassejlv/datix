// Generated from the inspected database schema. Numeric columns use explicit ::text projections.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AbuseDaily {
    pub environment_id: uuid::Uuid,
    pub day: chrono::NaiveDate,
    pub reason: String,
    pub blocked: i64,
    pub last_blocked_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AbuseEnvironment {
    pub environment_id: uuid::Uuid,
    pub baseline: serde_json::Value,
    pub learned_at: chrono::DateTime<chrono::Utc>,
    pub traffic: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AbuseSources {
    pub environment_id: uuid::Uuid,
    pub source: String,
    pub activity: serde_json::Value,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub account_id: String,
    pub provider_id: String,
    pub user_id: String,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub id_token: Option<String>,
    pub access_token_expires_at: Option<chrono::NaiveDateTime>,
    pub refresh_token_expires_at: Option<chrono::NaiveDateTime>,
    pub scope: Option<String>,
    pub password: Option<String>,
    pub created_at: chrono::NaiveDateTime,
    pub updated_at: chrono::NaiveDateTime,
}

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEvents {
    pub environment_id: uuid::Uuid,
    pub id: uuid::Uuid,
    pub session_key: String,
    pub visitor_key: String,
    pub received_at: chrono::DateTime<chrono::Utc>,
    pub kind: String,
    pub name: String,
    pub path: String,
    pub referrer: String,
    pub country: String,
    pub device: String,
    pub browser: String,
    pub os: String,
    pub details: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BillingCheckouts {
    pub owner_id: String,
    pub checkout_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BillingCustomers {
    pub customer_id: String,
    pub owner_id: Option<String>,
    pub subscriptions: serde_json::Value,
    pub deleted: bool,
    pub occurred_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BillingOutbox {
    pub id: uuid::Uuid,
    pub owner_id: String,
    pub event_type: String,
    pub event_count: String,
    pub occurred_at: chrono::DateTime<chrono::Utc>,
    pub available_at: chrono::DateTime<chrono::Utc>,
    pub attempts: i64,
    pub lease_id: Option<uuid::Uuid>,
}

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BillingUsage {
    pub owner_id: String,
    pub site_id: uuid::Uuid,
    pub period_start: chrono::DateTime<chrono::Utc>,
    pub period_end: chrono::DateTime<chrono::Utc>,
    pub events: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BillingWebhookEvents {
    pub id: String,
    pub r#type: String,
    pub occurred_at: chrono::DateTime<chrono::Utc>,
    pub received_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct DailyStats {
    pub site_id: uuid::Uuid,
    pub day: chrono::NaiveDate,
    pub dimension: String,
    pub value: String,
    pub pageviews: i64,
    pub custom_events: i64,
    pub visitors: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct DailyVisitors {
    pub site_id: uuid::Uuid,
    pub day: chrono::NaiveDate,
    pub visitor: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Environments {
    pub id: uuid::Uuid,
    pub site_id: uuid::Uuid,
    pub name: String,
    pub domain: String,
    pub enabled: bool,
    pub allow_localhost: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub tracking_mode: String,
    pub tracking_settings: serde_json::Value,
    pub feature_settings: serde_json::Value,
    pub import_revision: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Events {
    pub site_id: uuid::Uuid,
    pub id: uuid::Uuid,
    pub received_at: chrono::DateTime<chrono::Utc>,
    pub day: chrono::NaiveDate,
    pub r#type: String,
    pub name: String,
    pub path: String,
    pub referrer: String,
    pub country: String,
    pub device: String,
    pub visitor: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct FreeUsage {
    pub owner_id: String,
    pub site_id: uuid::Uuid,
    pub period_start: chrono::DateTime<chrono::Utc>,
    pub period_end: chrono::DateTime<chrono::Utc>,
    pub events: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct RateLimit {
    pub id: String,
    pub key: String,
    pub count: i32,
    pub last_request: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub expires_at: chrono::NaiveDateTime,
    pub token: String,
    pub created_at: chrono::NaiveDateTime,
    pub updated_at: chrono::NaiveDateTime,
    pub ip_address: Option<String>,
    pub user_agent: Option<String>,
    pub user_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Sites {
    pub id: uuid::Uuid,
    pub owner_id: String,
    pub name: String,
    pub domain: String,
    pub enabled: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub allow_localhost: bool,
    pub credit_budget: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub name: String,
    pub email: String,
    pub email_verified: bool,
    pub image: Option<String>,
    pub created_at: chrono::NaiveDateTime,
    pub updated_at: chrono::NaiveDateTime,
}

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Verification {
    pub id: String,
    pub identifier: String,
    pub value: String,
    pub expires_at: chrono::NaiveDateTime,
    pub created_at: chrono::NaiveDateTime,
    pub updated_at: chrono::NaiveDateTime,
}

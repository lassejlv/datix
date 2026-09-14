use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub name: String,
    pub email: String,
    pub email_verified: bool,
    pub image: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub user_id: String,
    pub token: String,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub ip_address: Option<String>,
    pub user_agent: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct SessionData {
    pub session: Session,
    pub user: User,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailCredentials {
    pub email: String,
    pub password: String,
    pub name: Option<String>,
    #[serde(rename = "callbackURL", alias = "callbackUrl")]
    pub callback_url: Option<String>,
    pub remember_me: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationRequest {
    pub email: String,
    #[serde(rename = "callbackURL", alias = "callbackUrl")]
    pub callback_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordChange {
    pub current_password: String,
    pub new_password: String,
    #[serde(default)]
    pub revoke_other_sessions: bool,
}

pub(crate) const USER_COLUMNS: &str = "id,name,email,email_verified,image,created_at AT TIME ZONE 'UTC' AS created_at,updated_at AT TIME ZONE 'UTC' AS updated_at";
pub(crate) const SESSION_COLUMNS: &str = "id,user_id,token,expires_at AT TIME ZONE 'UTC' AS expires_at,created_at AT TIME ZONE 'UTC' AS created_at,updated_at AT TIME ZONE 'UTC' AS updated_at,ip_address,user_agent";

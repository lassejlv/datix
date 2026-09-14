use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};

#[derive(Debug, thiserror::Error)]
#[error("{code}: {message}")]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: &'static str,
}

#[derive(Clone, Copy)]
pub(crate) struct ApiErrorContext {
    pub code: &'static str,
}

impl ApiError {
    pub const fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            code,
            message,
        }
    }
    pub const fn invalid() -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Invalid request.",
        )
    }
    pub const fn unavailable() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "Service temporarily unavailable.",
        )
    }
    pub const fn missing_site() -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            "site_not_found",
            "Website not found.",
        )
    }
    pub const fn subscription_required() -> Self {
        Self::new(
            StatusCode::PAYMENT_REQUIRED,
            "subscription_required",
            "An active subscription is required.",
        )
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        // Driver messages can contain SQL values, account data, and connection URLs.
        // Report only a fixed category and the PostgreSQL SQLSTATE.
        let category = match &error {
            sqlx::Error::Database(_) => "database",
            sqlx::Error::PoolTimedOut => "pool_timeout",
            sqlx::Error::PoolClosed => "pool_closed",
            sqlx::Error::RowNotFound => "row_not_found",
            sqlx::Error::ColumnDecode { .. } | sqlx::Error::Decode(_) => "decode",
            sqlx::Error::Io(_) | sqlx::Error::Tls(_) => "connection",
            _ => "other",
        };
        let code = error.as_database_error().and_then(|error| error.code());
        let sqlstate = code.as_deref().filter(|code| {
            code.len() == 5
                && code
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        });
        tracing::warn!(category, sqlstate, "Database operation failed");
        Self::unavailable()
    }
}
impl From<redis::RedisError> for ApiError {
    fn from(error: redis::RedisError) -> Self {
        tracing::warn!(kind = ?error.kind(), "Redis operation failed");
        Self::unavailable()
    }
}
impl From<datix_auth::AuthError> for ApiError {
    fn from(error: datix_auth::AuthError) -> Self {
        Self::new(
            error.status,
            if error.code == "UNAUTHORIZED" {
                "unauthorized"
            } else {
                error.code
            },
            error.message,
        )
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (
            self.status,
            Json(serde_json::json!({"error":{"code":self.code,"message":self.message}})),
        )
            .into_response();
        response
            .extensions_mut()
            .insert(ApiErrorContext { code: self.code });
        response
    }
}

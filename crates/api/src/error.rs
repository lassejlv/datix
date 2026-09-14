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
    fn from(_: sqlx::Error) -> Self {
        Self::unavailable()
    }
}
impl From<redis::RedisError> for ApiError {
    fn from(_: redis::RedisError) -> Self {
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
        (
            self.status,
            Json(serde_json::json!({"error":{"code":self.code,"message":self.message}})),
        )
            .into_response()
    }
}

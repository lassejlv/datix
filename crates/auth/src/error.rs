use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};

/// Stable Better Auth error envelope. Internal causes never reach HTTP responses or logs.
#[derive(Debug, thiserror::Error)]
#[error("{code}: {message}")]
pub struct AuthError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: &'static str,
}

impl AuthError {
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
            "VALIDATION_ERROR",
            "Invalid request body.",
        )
    }
    pub const fn unavailable() -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "UNAVAILABLE",
            "Service temporarily unavailable.",
        )
    }
    pub const fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "Sign in to continue.",
        )
    }
    pub const fn credentials() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "INVALID_EMAIL_OR_PASSWORD",
            "Invalid email or password.",
        )
    }
    pub const fn token() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "INVALID_TOKEN",
            "Invalid verification token.",
        )
    }
    pub const fn terms_not_accepted() -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "TERMS_NOT_ACCEPTED",
            "Accept the Terms of Service and acknowledge the Privacy Policy to create an account.",
        )
    }
}

impl From<sqlx::Error> for AuthError {
    fn from(_: sqlx::Error) -> Self {
        Self::unavailable()
    }
}

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({"code":self.code,"message":self.message})),
        )
            .into_response()
    }
}

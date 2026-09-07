use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;
#[derive(Debug, thiserror::Error)]
#[error("{code}")]
pub struct Error {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}
pub type Result<T> = std::result::Result<T, Error>;
impl Error {
    pub fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            code,
            message: message.into(),
        }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(400, "invalid_input", message)
    }
    pub fn unavailable() -> Self {
        Self::new(503, "service_unavailable", "Please retry shortly.")
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"error":{"code":self.code,"message":self.message}})),
        )
            .into_response()
    }
}
impl From<sqlx::Error> for Error {
    fn from(error: sqlx::Error) -> Self {
        tracing::error!(
            database_code = error
                .as_database_error()
                .and_then(|e| e.code())
                .as_deref()
                .unwrap_or("none"),
            kind = match error {
                sqlx::Error::Database(_) => "database",
                sqlx::Error::PoolTimedOut => "pool_timeout",
                _ => "query",
            },
            "database operation failed"
        );
        Self::unavailable()
    }
}
impl From<redis::RedisError> for Error {
    fn from(_: redis::RedisError) -> Self {
        Self::unavailable()
    }
}
impl From<reqwest::Error> for Error {
    fn from(_: reqwest::Error) -> Self {
        Self::unavailable()
    }
}

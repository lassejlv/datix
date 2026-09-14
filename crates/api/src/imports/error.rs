use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use std::borrow::Cow;

/// Import validation includes safe, user-facing column names and calendar dates.
/// Infrastructure failures still use the shared redacted API error.
pub struct Error {
    status: StatusCode,
    code: &'static str,
    message: Cow<'static, str>,
}

impl Error {
    pub fn new(
        status: StatusCode,
        code: &'static str,
        message: impl Into<Cow<'static, str>>,
    ) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
    pub fn invalid(message: impl Into<Cow<'static, str>>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_request", message)
    }
    pub fn conflict(code: &'static str, message: impl Into<Cow<'static, str>>) -> Self {
        Self::new(StatusCode::CONFLICT, code, message)
    }
}
impl From<crate::error::ApiError> for Error {
    fn from(error: crate::error::ApiError) -> Self {
        Self::new(error.status, error.code, error.message)
    }
}
impl From<sqlx::Error> for Error {
    fn from(error: sqlx::Error) -> Self {
        crate::error::ApiError::from(error).into()
    }
}
impl From<redis::RedisError> for Error {
    fn from(error: redis::RedisError) -> Self {
        crate::error::ApiError::from(error).into()
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({"error":{"code":self.code,"message":self.message}})),
        )
            .into_response()
    }
}

#[cfg(test)]
impl std::fmt::Debug for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple(self.code).field(&self.message).finish()
    }
}

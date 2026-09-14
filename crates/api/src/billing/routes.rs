use crate::{
    AppState,
    error::ApiError,
    http::{Owner, json_body},
};
use axum::{
    Extension, Json, Router,
    extract::{Path, Request, State},
    http::StatusCode,
    routing::{get, post},
};
use serde_json::{Value, json};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/billing", get(status).post(not_found))
        .route(
            "/api/billing/{operation}",
            post(operation).get(|| async {
                ApiError::new(
                    StatusCode::METHOD_NOT_ALLOWED,
                    "method_not_allowed",
                    "Use POST.",
                )
            }),
        )
        .route("/api/webhooks/polar", post(webhook))
}

async fn status(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        json!({"hasCustomer":state.billing.has_customer(&owner.id).await?}),
    ))
}

async fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "not_found", "Not found.")
}

async fn operation(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path(operation): Path<String>,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(match operation.as_str() {
        "sync" => {
            state.billing.sync_if_enabled(&owner.id).await?;
            super::usage(&state, &owner.id).await?
        }
        "portal" => state.billing.portal(&owner.id).await?,
        "checkout" => {
            state
                .billing
                .checkout(&owner.id, json_body(request).await?)
                .await?
        }
        _ => return Err(not_found().await),
    }))
}

async fn webhook(State(state): State<AppState>, request: Request) -> Result<Json<Value>, ApiError> {
    let (parts, body) = request.into_parts();
    let body = axum::body::to_bytes(body, 256 * 1024).await.map_err(|_| {
        ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "body_too_large",
            "Request body is too large.",
        )
    })?;
    Ok(Json(state.billing.webhook(&parts.headers, &body).await?))
}

mod features;
mod overview;
mod reports;
mod sessions;

use axum::{
    Extension, Json, Router,
    extract::{Path, Query, Request, State},
    routing::{delete, get},
};
use serde_json::Value;
use sqlx::{Postgres, Transaction};
use std::collections::HashMap;

use crate::{
    AppState,
    error::ApiError,
    http::{Owner, json_body},
    sites,
};

pub type Parameters = HashMap<String, String>;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/sites/{site}/overview", get(report_overview))
        .route("/api/sites/{site}/timeseries", get(timeseries))
        .route("/api/sites/{site}/breakdown", get(breakdown))
        .route("/api/sites/{site}/installation", get(installation))
        .route("/api/sites/{site}/sessions", get(read_sessions))
        .route(
            "/api/sites/{site}/environments/{environment}/features/{feature}",
            get(read_feature).post(configure_feature),
        )
        .route(
            "/api/sites/{site}/environments/{environment}/features/goals/{goal}",
            delete(delete_goal),
        )
}

pub(super) async fn read_transaction(
    state: &AppState,
) -> Result<Transaction<'static, Postgres>, ApiError> {
    let mut tx = state.pool.begin().await?;
    sqlx::query("SET TRANSACTION READ ONLY")
        .execute(&mut *tx)
        .await?;
    Ok(tx)
}

async fn report(
    state: AppState,
    owner: Owner,
    site: String,
    query: Parameters,
    kind: &str,
) -> Result<Json<Value>, ApiError> {
    let env = sites::environment(
        &state,
        &owner.id,
        &site,
        query.get("environment").unwrap_or(&site),
    )
    .await?;
    Ok(Json(reports::report(&state, env.id, kind, &query).await?))
}

async fn report_overview(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path(site): Path<String>,
    Query(query): Query<Parameters>,
) -> Result<Json<Value>, ApiError> {
    report(state, owner, site, query, "overview").await
}
async fn timeseries(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path(site): Path<String>,
    Query(query): Query<Parameters>,
) -> Result<Json<Value>, ApiError> {
    report(state, owner, site, query, "timeseries").await
}
async fn breakdown(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path(site): Path<String>,
    Query(query): Query<Parameters>,
) -> Result<Json<Value>, ApiError> {
    report(state, owner, site, query, "breakdown").await
}
async fn installation(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path(site): Path<String>,
    Query(query): Query<Parameters>,
) -> Result<Json<Value>, ApiError> {
    report(state, owner, site, query, "installation").await
}
async fn read_sessions(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path(site): Path<String>,
    Query(query): Query<Parameters>,
) -> Result<Json<Value>, ApiError> {
    let env = sites::environment(
        &state,
        &owner.id,
        &site,
        query.get("environment").unwrap_or(&site),
    )
    .await?;
    Ok(Json(sessions::read(&state, env.id, &query).await?))
}
async fn read_feature(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path((site, environment, feature)): Path<(String, String, String)>,
    Query(query): Query<Parameters>,
) -> Result<Json<Value>, ApiError> {
    let env = sites::environment(&state, &owner.id, &site, &environment).await?;
    Ok(Json(
        features::read(&state, env.id, &feature, &query).await?,
    ))
}
async fn configure_feature(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path((site, environment, feature)): Path<(String, String, String)>,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    let env = sites::environment(&state, &owner.id, &site, &environment).await?;
    Ok(Json(
        features::configure(&state, env.id, &feature, json_body(request).await?).await?,
    ))
}
async fn delete_goal(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path((site, environment, goal)): Path<(String, String, String)>,
) -> Result<Json<Value>, ApiError> {
    let env = sites::environment(&state, &owner.id, &site, &environment).await?;
    Ok(Json(
        features::delete_goal(&state, env.id, sites::identifier(&goal)?).await?,
    ))
}

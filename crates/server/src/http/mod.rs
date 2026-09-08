use crate::middleware::Context;
use analytics_core::{Error, Result, State, validation::DateRange};
use analytics_services::{abuse, auth, billing, collect, reports, sites, tracking};
use axum::{
    Extension, Json, Router,
    body::{Body, to_bytes},
    extract::{Path, Query, Request, State as AppState},
    http::{HeaderValue, Method, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{any, get, post},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tower::ServiceExt;
use uuid::Uuid;

mod auth_routes;
use auth_routes::authentication;
mod account_routes;
use account_routes::{billing_operation, billing_root, me, usage};
mod site_routes;
use site_routes::{
    create_environment, create_site, delete_environment, delete_site, get_environment, get_site,
    list_environments, list_sites, load_site, update_environment, update_site,
};
mod report_routes;
use report_routes::{breakdown, installation, overview, sessions, timeseries};
mod assets;
use assets::fallback;
mod import_routes;
use import_routes::{create_import, delete_import, list_imports, preview_import};

pub fn router(state: State, jobs_ready: Arc<AtomicBool>) -> Router {
    let operational = Router::new()
        .route(
            "/health/ready",
            get(move |AppState(state): AppState<State>| health(state, jobs_ready)),
        )
        .route("/internal/metrics", get(metrics));
    if state.config.runtime.role == analytics_core::config::Role::Worker {
        return operational.with_state(state);
    }
    operational
        .route(
            "/api/health",
            get(|| async { Json(json!({"status":"ok","service":"analytics","version":1})) }),
        )
        .route(
            "/api/openapi.json",
            get(|| async {
                (
                    [("content-type", "application/json")],
                    include_str!("../../../../config/openapi.json"),
                )
            }),
        )
        .route("/api/preferences", get(preferences))
        .route(
            "/api/tracker-config",
            get(tracker_config).options(|| async { StatusCode::NO_CONTENT }),
        )
        .route(
            "/api/collect",
            post(collect_event).options(|| async { StatusCode::NO_CONTENT }),
        )
        .route("/api/webhooks/polar", post(webhook))
        .route("/api/auth/{*path}", any(authentication))
        .route("/api/me", get(me))
        .route("/api/usage", get(usage))
        .route("/api/billing", any(billing_root))
        .route("/api/billing/{*path}", any(billing_operation))
        .route("/api/sites", get(list_sites).post(create_site))
        .route(
            "/api/sites/{site}",
            get(get_site).patch(update_site).delete(delete_site),
        )
        .route(
            "/api/sites/{site}/environments",
            get(list_environments).post(create_environment),
        )
        .route(
            "/api/sites/{site}/environments/{environment}",
            get(get_environment)
                .patch(update_environment)
                .delete(delete_environment),
        )
        .route("/api/sites/{site}/installation", get(installation))
        .route("/api/sites/{site}/overview", get(overview))
        .route("/api/sites/{site}/timeseries", get(timeseries))
        .route("/api/sites/{site}/breakdown", get(breakdown))
        .route("/api/sites/{site}/sessions", get(sessions))
        .route(
            "/api/sites/{site}/environments/{environment}/imports",
            get(list_imports).post(create_import),
        )
        .route(
            "/api/sites/{site}/environments/{environment}/imports/preview",
            post(preview_import),
        )
        .route(
            "/api/sites/{site}/environments/{environment}/imports/{import}",
            axum::routing::delete(delete_import),
        )
        .fallback(fallback)
        .method_not_allowed_fallback(|| async {
            Error::new(
                405,
                "method_not_allowed",
                "Use a supported method for this endpoint.",
            )
        })
        .layer(middleware::from_fn_with_state(
            state.clone(),
            crate::middleware::perimeter,
        ))
        .with_state(state)
}
async fn health(state: State, ready: Arc<AtomicBool>) -> Response {
    let check = async {
        if !ready.load(Ordering::Acquire) {
            return Err(Error::unavailable());
        }
        sqlx::query("SELECT 1").execute(&state.db).await?;
        let mut conn = state.redis.clone();
        let _: String = redis::cmd("PING").query_async(&mut conn).await?;
        Ok::<_, Error>(())
    };
    if check.await.is_ok() {
        (
            StatusCode::OK,
            Json(json!({"status":"ok","runtime":"rust","service":"app","role":state.config.runtime.role.name()})),
        )
            .into_response()
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"status":"unavailable"})),
        )
            .into_response()
    }
}
async fn metrics(AppState(state): AppState<State>, request: Request) -> Result<Response> {
    let supplied = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    if !state.config.metrics_token.as_ref().is_some_and(|token| {
        supplied
            .is_some_and(|value| analytics_core::crypto::equal(token.as_bytes(), value.as_bytes()))
    }) {
        return Err(Error::new(404, "not_found", "Not found."));
    }
    Ok((
        [
            ("content-type", "text/plain; version=0.0.4; charset=utf-8"),
            ("cache-control", "no-store"),
        ],
        state.metrics.render(&state.db),
    )
        .into_response())
}
fn id(value: &str) -> Result<Uuid> {
    Uuid::parse_str(value).map_err(|_| Error::invalid("Invalid identifier."))
}
fn owner(context: &Context) -> Result<&analytics_core::models::User> {
    context
        .identity
        .as_ref()
        .map(|i| &i.user)
        .ok_or_else(|| Error::new(401, "unauthorized", "Sign in to continue."))
}
async fn read_json(request: Request) -> Result<Value> {
    let media = request
        .headers()
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim();
    if !["application/json", "text/plain"].contains(&media) {
        return Err(Error::new(
            415,
            "unsupported_media_type",
            "Send JSON with application/json or text/plain.",
        ));
    }
    let bytes = read_body(request, 8192).await?;
    serde_json::from_slice(&bytes)
        .map_err(|_| Error::new(400, "invalid_json", "Request body must be valid JSON."))
}
async fn read_body(request: Request, max: usize) -> Result<Vec<u8>> {
    if request
        .headers()
        .get("content-length")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.parse::<usize>().ok())
        .is_some_and(|n| n > max)
    {
        return Err(Error::new(
            413,
            "body_too_large",
            "Request body is too large.",
        ));
    }
    to_bytes(request.into_body(), max)
        .await
        .map(|b| b.to_vec())
        .map_err(|_| Error::new(413, "body_too_large", "Request body is too large."))
}
async fn preferences(Extension(context): Extension<Context>, request: Request) -> Json<Value> {
    let raw = request
        .headers()
        .get("cookie")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let cookies: HashMap<_, _> = raw
        .split(';')
        .filter_map(|s| s.trim().split_once('='))
        .collect();
    let locale = match cookies.get("ab-language").copied() {
        Some(s @ ("en" | "da" | "de")) => s,
        _ => match context.country.as_str() {
            "DK" => "da",
            "DE" | "AT" => "de",
            _ => "en",
        },
    };
    let theme = cookies.get("ab-theme").copied().unwrap_or("system");
    Json(json!({"locale":locale,"theme":theme}))
}
async fn tracker_config(
    AppState(state): AppState<State>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    let site = id(params.get("siteId").map(String::as_str).unwrap_or(""))?;
    let environment = params
        .get("environmentId")
        .map(|v| id(v))
        .transpose()?
        .unwrap_or(site);
    let e = sites::environment(&state, site, environment).await?;
    Ok(Json(
        json!({"enabled":e.enabled,"settings":tracking::settings(&e.tracking_settings)}),
    ))
}
async fn collect_event(
    AppState(state): AppState<State>,
    Extension(context): Extension<Context>,
    request: Request,
) -> Result<(StatusCode, Json<Value>)> {
    let headers = request.headers().clone();
    let body = read_json(request).await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(collect::collect(&state, &headers, body, &context.ip, &context.country).await?),
    ))
}
async fn webhook(AppState(state): AppState<State>, request: Request) -> Result<Json<Value>> {
    let headers = request.headers().clone();
    let body = read_body(request, 256 * 1024).await?;
    Ok(Json(
        billing::webhook::handle(&state, &headers, &body).await?,
    ))
}

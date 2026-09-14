use axum::{
    Extension, Json, Router,
    extract::{ConnectInfo, Request, State},
    http::{HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use hmac::{Hmac, Mac};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::Sha256;
use std::net::SocketAddr;
use subtle::ConstantTimeEq;
use tower_http::services::{ServeDir, ServeFile};

use crate::{AppState, billing, error::ApiError, sites};

#[derive(Clone, Serialize)]
pub struct Owner {
    pub id: String,
    pub name: String,
    pub email: String,
    pub admin: bool,
}

pub fn router(state: AppState) -> Router {
    if state.config.role == crate::config::Role::Worker {
        return Router::new()
            .route(
                "/api/health",
                get(|| async { Json(json!({"status":"ok","service":"analytics","version":1})) }),
            )
            .route("/health/ready", get(ready))
            .route("/internal/metrics", get(metrics))
            .fallback(|| async { ApiError::new(StatusCode::NOT_FOUND, "not_found", "Not found.") })
            .layer(middleware::from_fn_with_state(state.clone(), security))
            .with_state(state);
    }
    Router::new()
        .route(
            "/api/health",
            get(|| async { Json(json!({"status":"ok","service":"analytics","version":1})) }),
        )
        .route("/health/ready", get(ready))
        .route("/internal/metrics", get(metrics))
        .route("/api/preferences", get(preferences))
        .route(
            "/api/openapi.json",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "application/json")],
                    include_str!("../../../config/openapi.json"),
                )
            }),
        )
        .route("/api/me", get(me))
        .route("/api/usage", get(usage))
        .route("/api/onboarding/complete", post(complete_onboarding))
        .nest("/api/auth", state.auth.router().with_state(()))
        .merge(sites::routes())
        .merge(crate::analytics::routes())
        .merge(billing::routes())
        .merge(crate::ingestion::routes())
        .merge(crate::diagnostics::routes())
        .merge(crate::admin::routes())
        .merge(crate::imports::routes())
        .fallback_service(frontend(std::path::Path::new("web/dist/client")))
        .layer(middleware::from_fn_with_state(state.clone(), security))
        .with_state(state)
}

fn frontend(root: &std::path::Path) -> ServeDir<ServeFile> {
    // SPA routes must retain the index file's 200 status. API misses
    // are rejected by security before reaching this fallback.
    ServeDir::new(root).fallback(ServeFile::new(root.join("index.html")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;

    #[tokio::test]
    async fn frontend_fallback_returns_success_without_losing_javascript_mime() {
        let root = std::env::temp_dir().join(format!("datix-static-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(
            root.join("index.html"),
            "<!doctype html><title>Fixture</title>",
        )
        .unwrap();
        std::fs::write(root.join("tracker.js"), "/* fixture */").unwrap();
        let mut results = Vec::new();
        for path in ["/dashboard", "/tracker.js"] {
            let response = frontend(&root)
                .oneshot(
                    Request::builder()
                        .uri(path)
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            results.push((
                response.status(),
                response.headers()[header::CONTENT_TYPE]
                    .to_str()
                    .unwrap()
                    .to_owned(),
            ));
        }
        std::fs::remove_file(root.join("index.html")).unwrap();
        std::fs::remove_file(root.join("tracker.js")).unwrap();
        std::fs::remove_dir(root).unwrap();
        assert_eq!(results[0], (StatusCode::OK, "text/html".into()));
        assert_eq!(results[1], (StatusCode::OK, "text/javascript".into()));
    }
}

pub async fn json_body<T: serde::de::DeserializeOwned>(request: Request) -> Result<T, ApiError> {
    let content_type = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("");
    if !matches!(content_type, "application/json" | "text/plain") {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Send JSON with application/json or text/plain.",
        ));
    }
    let body = axum::body::to_bytes(request.into_body(), 16 * 1024)
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "body_too_large",
                "Request body is too large.",
            )
        })?;
    serde_json::from_slice(&body).map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Request body must be valid JSON.",
        )
    })
}

fn matches_secret(expected: &str, supplied: &str) -> bool {
    bool::from(expected.as_bytes().ct_eq(supplied.as_bytes()))
}

async fn security(State(state): State<AppState>, mut request: Request, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    let api = path.starts_with("/api/");
    let tracker = matches!(
        path.as_str(),
        "/api/collect" | "/api/telemetry" | "/api/tracker-config"
    );
    let trusted = state
        .config
        .cloudflare_origin_secret
        .as_deref()
        .zip(
            request
                .headers()
                .get("x-analytics-origin-key")
                .and_then(|v| v.to_str().ok()),
        )
        .is_some_and(|(a, b)| matches_secret(a, b));
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ip| ip.0.ip().to_string())
        .unwrap_or_else(|| "unknown".into());
    let ip = if trusted {
        request
            .headers()
            .get("cf-connecting-ip")
            .and_then(|v| v.to_str().ok())
            .unwrap_or(&peer)
            .to_owned()
    } else {
        peer
    };
    let country = if trusted {
        request
            .headers()
            .get("cf-ipcountry")
            .and_then(|v| v.to_str().ok())
            .filter(|v| v.len() == 2 && v.bytes().all(|b| b.is_ascii_uppercase()))
            .unwrap_or("")
            .to_owned()
    } else {
        String::new()
    };
    request.extensions_mut().insert(Country(country));
    // Replace client-supplied internal headers before the auth crate sees them.
    request.headers_mut().remove("x-datix-client-ip");
    if let Ok(ip_header) = HeaderValue::from_str(&ip) {
        request.headers_mut().insert("x-datix-client-ip", ip_header);
    }
    let result=async {
        if tracker && request.method()==Method::OPTIONS {return Ok(StatusCode::NO_CONTENT.into_response());}
        if api && request.method()==Method::HEAD {return Err(ApiError::new(StatusCode::METHOD_NOT_ALLOWED,"method_not_allowed","Use GET."));}
        let account=path.strip_prefix("/api/").and_then(|v|v.split('/').next()).is_some_and(|v|matches!(v,"auth"|"sites"|"me"|"usage"|"billing"|"admin"|"onboarding"));
        if account {
            if request.method()!=Method::GET && request.headers().get(header::ORIGIN).and_then(|v|v.to_str().ok())!=Some(&state.config.app_url) {
                return Err(ApiError::new(StatusCode::FORBIDDEN,"invalid_origin","Use the application origin for account mutations."));
            }
            if !path.starts_with("/api/auth/") {
                let data=state.auth.api().require_session(request.headers()).await?;
                let owner=Owner {admin:state.config.admin_emails.contains(&data.user.email.to_lowercase()),id:data.user.id,name:data.user.name,email:data.user.email};
                let mut mac=Hmac::<Sha256>::new_from_slice(state.config.auth_secret.as_bytes()).map_err(|_|ApiError::unavailable())?;
                // The old hash helper HMACs JSON, including quotes around a string.
                mac.update(json!(owner.id).to_string().as_bytes());
                let key=format!("{}:account:{}",state.config.queue_prefix,hex::encode(mac.finalize().into_bytes()));
                let count:i64=redis::cmd("EVAL").arg("local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],60) end;return n").arg(1).arg(key).query_async(&mut state.redis.clone()).await?;
                if count>600 {return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS,"rate_limited","Too many requests. Try again in a minute."));}
                let completed=if path=="/api/sites" && request.method()==Method::GET {sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM account_onboarding WHERE owner_id=$1)").bind(&owner.id).fetch_one(&state.pool).await?} else {false};
                if path.starts_with("/api/sites/") || completed {billing::require_subscription(&state,&owner.id).await?;}
                request.extensions_mut().insert(owner);
            }
        }
        // API misses cannot fall through to the SPA's HTML document.
        if api && request.extensions().get::<axum::extract::MatchedPath>().is_none() {
            return Err(ApiError::new(StatusCode::NOT_FOUND,"not_found","Not found."));
        }
        Ok(next.run(request).await)
    }.await;
    let mut response = match result {
        Ok(response) => response,
        Err(error) => error.into_response(),
    };
    let headers = response.headers_mut();
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("x-frame-options", HeaderValue::from_static("SAMEORIGIN"));
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("cross-origin"),
    );
    headers.insert("content-security-policy",HeaderValue::from_static("default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"));
    if !state.config.external_effects {
        headers.insert(
            "x-robots-tag",
            HeaderValue::from_static("noindex, nofollow"),
        );
    }
    if api {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        if let Ok(id) = HeaderValue::from_str(&uuid::Uuid::new_v4().to_string()) {
            headers.insert("x-request-id", id);
        }
    }
    if tracker {
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_static("*"),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST, OPTIONS"),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("Content-Type"),
        );
    }
    response
}

#[derive(Clone)]
pub(crate) struct Country(pub String);

async fn preferences(
    State(state): State<AppState>,
    Extension(country): Extension<Country>,
    headers: axum::http::HeaderMap,
) -> Json<Value> {
    let cookie = headers
        .get(header::COOKIE)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let cookies: std::collections::HashMap<_, _> = cookie
        .split(';')
        .filter_map(|v| v.trim().split_once('='))
        .collect();
    let locale = cookies
        .get("ab-language")
        .filter(|v| matches!(**v, "en" | "da" | "de"))
        .copied()
        .unwrap_or(match country.0.as_str() {
            "DK" => "da",
            "DE" | "AT" => "de",
            _ => "en",
        });
    let theme = cookies
        .get("ab-theme")
        .filter(|v| matches!(**v, "light" | "dark" | "system"))
        .copied()
        .unwrap_or("system");
    let oauth = state.auth.social_provider_ids();
    Json(json!({"locale":locale,"theme":theme,"oauth":oauth}))
}

async fn ready(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    if !state.health.ready(state.config.role) {
        return Err(ApiError::unavailable());
    }
    let check = async {
        sqlx::query("SELECT 1").execute(&state.pool).await?;
        let pong: String = redis::cmd("PING")
            .query_async(&mut state.redis.clone())
            .await?;
        if pong != "PONG" {
            return Err(ApiError::unavailable());
        }
        Ok::<_, ApiError>(())
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), check)
        .await
        .map_err(|_| ApiError::unavailable())??;
    Ok(Json(
        json!({"status":"ok","runtime":"rust","service":"app","role":state.config.role}),
    ))
}

async fn metrics(State(state): State<AppState>, request: Request) -> Result<Response, ApiError> {
    let authorized = state
        .config
        .metrics_token
        .as_ref()
        .zip(
            request
                .headers()
                .get(header::AUTHORIZATION)
                .and_then(|h| h.to_str().ok()),
        )
        .is_some_and(|(expected, supplied)| {
            matches_secret(&format!("Bearer {expected}"), supplied)
        });
    if !authorized {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "Not found.",
        ));
    }
    let (waiting, active, failed) = state.queue.counts().await?;
    let pending: i64 =
        sqlx::query_scalar("SELECT count(*) FROM ingestion_receipts WHERE state='pending'")
            .fetch_one(&state.pool)
            .await?;
    Ok(([(header::CONTENT_TYPE,"text/plain; version=0.0.4")],format!("datix_queue_jobs{{state=\"active\"}} {active}\ndatix_queue_jobs{{state=\"waiting\"}} {}\ndatix_queue_jobs{{state=\"failed\"}} {failed}\ndatix_queue_jobs{{state=\"delayed\"}} 0\n",waiting+pending)).into_response())
}
async fn me(Extension(owner): Extension<Owner>) -> Json<Value> {
    Json(json!({"user":owner}))
}
async fn usage(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(billing::usage(&state, &owner.id).await?))
}
async fn complete_onboarding(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
) -> Result<Json<Value>, ApiError> {
    sqlx::query("INSERT INTO account_onboarding(owner_id) VALUES($1) ON CONFLICT DO NOTHING")
        .bind(&owner.id)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({"onboardingCompleted":true})))
}

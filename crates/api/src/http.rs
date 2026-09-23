use axum::{
    Extension, Json, Router,
    extract::{ConnectInfo, MatchedPath, Request, State},
    http::{HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use hmac::{Hmac, Mac};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::Sha256;
use std::net::{IpAddr, SocketAddr};
use subtle::ConstantTimeEq;
use tower_http::services::{ServeDir, ServeFile};

use crate::{
    AppState, billing,
    error::{ApiError, ApiErrorContext},
    monitoring, sites,
};

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
            .layer(sentry::integrations::tower::NewSentryLayer::<Request>::new_from_top())
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
                    include_str!("../../../web/public/openapi.json"),
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
        .merge(crate::legal::routes())
        .fallback_service(frontend(std::path::Path::new("web/dist/client")))
        .layer(middleware::from_fn_with_state(state.clone(), security))
        .layer(sentry::integrations::tower::NewSentryLayer::<Request>::new_from_top())
        .with_state(state)
}

fn frontend(root: &std::path::Path) -> Router {
    let index = root.join("index.html");
    let fallback = get(move |request: Request| {
        let index = index.clone();
        async move {
            let path = request.uri().path();
            // Never disguise a missing asset as a successful HTML response.
            if path.starts_with("/assets/")
                || path
                    .rsplit('/')
                    .next()
                    .is_some_and(|name| name.contains('.'))
            {
                return StatusCode::NOT_FOUND.into_response();
            }
            match ServeFile::new(index).try_call(request).await {
                Ok(response) => response.into_response(),
                Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
            }
        }
    });
    Router::new()
        .fallback_service(ServeDir::new(root).fallback(fallback))
        .layer(middleware::from_fn(frontend_cache))
}

async fn frontend_cache(request: Request, next: Next) -> Response {
    let hashed_asset = request.uri().path().starts_with("/assets/");
    let mut response = next.run(request).await;
    let cache = if response.status().is_client_error() || response.status().is_server_error() {
        "no-store"
    } else if hashed_asset
        && response
            .headers()
            .get(header::CONTENT_TYPE)
            .is_some_and(|value| !value.as_bytes().starts_with(b"text/html"))
    {
        "public, max-age=31536000, immutable"
    } else {
        // HTML and unhashed files must revalidate across deployments.
        "no-cache"
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;

    #[test]
    fn client_ip_trusts_forwarding_headers_only_from_known_proxies() {
        let headers = |pairs: &[(&'static str, &str)]| {
            let mut map = axum::http::HeaderMap::new();
            for (name, value) in pairs {
                map.insert(*name, value.parse().unwrap());
            }
            map
        };
        let railway = Some("100.64.0.2".parse().unwrap());
        let direct = Some("203.0.113.9".parse().unwrap());
        let forwarded = headers(&[
            ("cf-connecting-ip", "198.51.100.1"),
            ("x-real-ip", "198.51.100.2"),
        ]);
        assert_eq!(client_ip(&forwarded, railway, true), "198.51.100.1");
        assert_eq!(client_ip(&forwarded, railway, false), "198.51.100.2");
        assert_eq!(client_ip(&forwarded, direct, false), "203.0.113.9");
        assert_eq!(client_ip(&forwarded, direct, true), "198.51.100.1");
        let invalid = headers(&[("cf-connecting-ip", "nope"), ("x-real-ip", "2001:db8::1")]);
        assert_eq!(client_ip(&invalid, railway, true), "2001:db8::1");
        assert_eq!(client_ip(&invalid, direct, true), "203.0.113.9");
        assert_eq!(
            client_ip(
                &headers(&[]),
                Some("::ffff:100.64.0.2".parse().unwrap()),
                false
            ),
            "100.64.0.2"
        );
        assert_eq!(client_ip(&headers(&[]), None, false), "unknown");
    }

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
        std::fs::create_dir(root.join("assets")).unwrap();
        std::fs::write(root.join("assets/app-hash.js"), "/* fixture */").unwrap();
        let mut results = Vec::new();
        for path in [
            "/dashboard",
            "/tracker.js",
            "/assets/missing.js",
            "/missing.css",
            "/assets/missing",
            "/site/site-id/environment-id/overview",
            "/",
            "/assets/app-hash.js",
        ] {
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
                response
                    .headers()
                    .get(header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or("")
                    .to_owned(),
                response
                    .headers()
                    .get(header::CACHE_CONTROL)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or("")
                    .to_owned(),
            ));
        }
        std::fs::remove_file(root.join("index.html")).unwrap();
        std::fs::remove_file(root.join("tracker.js")).unwrap();
        std::fs::remove_file(root.join("assets/app-hash.js")).unwrap();
        std::fs::remove_dir(root.join("assets")).unwrap();
        std::fs::remove_dir(root).unwrap();
        assert_eq!(
            results[0],
            (StatusCode::OK, "text/html".into(), "no-cache".into())
        );
        assert_eq!(
            results[1],
            (StatusCode::OK, "text/javascript".into(), "no-cache".into())
        );
        assert_eq!(results[2].0, StatusCode::NOT_FOUND);
        assert_eq!(results[3].0, StatusCode::NOT_FOUND);
        for result in &results[2..5] {
            assert_eq!(result.0, StatusCode::NOT_FOUND);
            assert_eq!(result.2, "no-store");
        }
        for result in &results[5..7] {
            assert_eq!(result.0, StatusCode::OK);
            assert_eq!(result.2, "no-cache");
        }
        assert_eq!(
            results[7],
            (
                StatusCode::OK,
                "text/javascript".into(),
                "public, max-age=31536000, immutable".into()
            )
        );
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

/// Visitor address for rate limits, abuse detection, and country lookup.
/// `cf-connecting-ip` is trusted only with the Cloudflare origin key. Otherwise
/// Railway's edge, which connects from 100.0.0.0/8 and overwrites `x-real-ip`,
/// supplies the address; any other peer is used directly.
fn client_ip(headers: &axum::http::HeaderMap, peer: Option<IpAddr>, trusted: bool) -> String {
    let header = |name| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<IpAddr>().ok())
    };
    let railway = peer.is_some_and(|ip| match ip.to_canonical() {
        IpAddr::V4(ip) => ip.octets()[0] == 100,
        IpAddr::V6(_) => false,
    });
    trusted
        .then(|| header("cf-connecting-ip"))
        .flatten()
        .or_else(|| railway.then(|| header("x-real-ip")).flatten())
        .or(peer)
        .map_or_else(|| "unknown".into(), |ip| ip.to_canonical().to_string())
}

async fn security(State(state): State<AppState>, mut request: Request, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    let api = path.starts_with("/api/");
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(MatchedPath::as_str)
        .unwrap_or(if api {
            "/api/*unmatched"
        } else if path == "/health/ready" {
            "/health/ready"
        } else if path == "/internal/metrics" {
            "/internal/metrics"
        } else {
            "frontend-static"
        })
        .to_owned();
    let method = request.method().as_str().to_owned();
    let request_id = uuid::Uuid::new_v4().to_string();
    monitoring::configure_request(&route, &method);
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
        .map(|ip| ip.0.ip());
    let ip = client_ip(request.headers(), peer, trusted);
    let country = state.geo.country(&ip);
    request.extensions_mut().insert(Country(country));
    // Replace client-supplied internal headers before the auth crate sees them.
    request.headers_mut().remove("x-datix-client-ip");
    if let Ok(ip_header) = HeaderValue::from_str(&ip) {
        request.headers_mut().insert("x-datix-client-ip", ip_header);
    }
    let result=async {
        if tracker && request.method()==Method::OPTIONS {return Ok(StatusCode::NO_CONTENT.into_response());}
        if api && request.method()==Method::HEAD {return Err(ApiError::new(StatusCode::METHOD_NOT_ALLOWED,"method_not_allowed","Use GET."));}
        let account=path.strip_prefix("/api/").and_then(|v|v.split('/').next()).is_some_and(|v|matches!(v,"auth"|"sites"|"me"|"usage"|"billing"|"admin"|"onboarding"|"legal"));
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
                if (path.starts_with("/api/sites") && !matches!(*request.method(),Method::GET|Method::DELETE)) || path=="/api/onboarding/complete" || path=="/api/billing/checkout" {crate::legal::require(&state,&owner.id).await?;}
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
    if response.status().is_server_error()
        && ((api && path != "/api/health") || path == "/internal/metrics")
    {
        let code = response
            .extensions()
            .get::<ApiErrorContext>()
            .map_or("backend_failure", |context| context.code);
        monitoring::report_http_failure(
            &route,
            &method,
            response.status().as_u16(),
            code,
            &request_id,
        );
    }
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
        if let Ok(id) = HeaderValue::from_str(&request_id) {
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

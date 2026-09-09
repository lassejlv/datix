use analytics_core::{Error, State, crypto};
use analytics_services::auth::{self, Identity};
use axum::{
    body::{Body, to_bytes},
    extract::{ConnectInfo, Request, State as AxumState},
    http::{HeaderMap, HeaderValue, Method},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::net::{IpAddr, SocketAddr};
use uuid::Uuid;
#[derive(Clone)]
pub struct Context {
    pub request_id: String,
    pub ip: String,
    pub country: String,
    pub identity: Option<Identity>,
}
fn value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}
pub fn normalized(state: &State, headers: &HeaderMap, peer: &str) -> (String, String) {
    let remote = if state.config.railway {
        value(headers, "x-real-ip").unwrap_or(peer)
    } else {
        peer
    };
    let trusted = state.config.railway
        && state.config.origin_secret.as_ref().is_some_and(|secret| {
            value(headers, "x-analytics-origin-key")
                .is_some_and(|received| crypto::equal(secret.as_bytes(), received.as_bytes()))
        });
    let ip = if trusted {
        value(headers, "cf-connecting-ip")
            .filter(|v| v.parse::<IpAddr>().is_ok())
            .unwrap_or(remote)
    } else {
        remote
    };
    let country = if trusted {
        value(headers, "cf-ipcountry").unwrap_or("")
    } else {
        ""
    };
    (
        if ip.parse::<IpAddr>().is_ok() {
            ip.into()
        } else {
            "unknown".into()
        },
        if country.len() == 2
            && country.bytes().all(|c| c.is_ascii_uppercase())
            && !["XX", "T1"].contains(&country)
        {
            country.into()
        } else {
            String::new()
        },
    )
}
fn account_path(path: &str) -> bool {
    path == "/api/me"
        || path == "/api/usage"
        || path == "/api/billing"
        || path.starts_with("/api/billing/")
        || path == "/api/sites"
        || path.starts_with("/api/sites/")
}
async fn authorize(
    state: &State,
    path: &str,
    method: &Method,
    headers: &HeaderMap,
    context: &mut Context,
) -> analytics_core::Result<()> {
    if account_path(path) || path.starts_with("/api/auth/") {
        if method != Method::GET
            && method != Method::HEAD
            && !state.config.allows_origin(value(headers, "origin"))
        {
            return Err(Error::new(
                403,
                "invalid_origin",
                "Use the application origin for account mutations.",
            ));
        }
        let ip_key = crypto::hash(&state.config.visitor_secret, &context.ip);
        if path.starts_with("/api/auth/") {
            state.limit("auth", &ip_key, 20).await?;
        } else {
            state.limit("api", &format!("ip:{ip_key}"), 120).await?;
            let identity = auth::require(state, headers).await?;
            state
                .limit("api", &format!("user:{}", identity.user.id), 120)
                .await?;
            context.identity = Some(identity);
        }
    }
    if path.starts_with("/api/") && method == Method::HEAD {
        return Err(Error::new(405, "method_not_allowed", "Use GET."));
    }
    Ok(())
}
pub async fn perimeter(
    AxumState(state): AxumState<State>,
    mut request: Request,
    next: Next,
) -> Response {
    let started = std::time::Instant::now();
    let path = request.uri().path().to_string();
    let api = path == "/api" || path.starts_with("/api/");
    let request_id = Uuid::new_v4().to_string();
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|p| p.0.ip().to_string())
        .unwrap_or_else(|| "unknown".into());
    let (ip, country) = normalized(&state, request.headers(), &peer);
    let mut context = Context {
        request_id: request_id.clone(),
        ip,
        country,
        identity: None,
    };
    let result = authorize(
        &state,
        &path,
        request.method(),
        request.headers(),
        &mut context,
    )
    .await;
    for key in [
        "x-analytics-origin-key",
        "x-analytics-country",
        "cf-ipcountry",
        "cf-connecting-ip",
    ] {
        request.headers_mut().remove(key);
    }
    let mut response = match result {
        Err(error) => error.into_response(),
        Ok(()) => {
            request.extensions_mut().insert(context);
            next.run(request).await
        }
    };
    if api {
        if response.status().is_client_error() || response.status().is_server_error() {
            let (mut parts, body) = response.into_parts();
            let bytes = to_bytes(body, 32768).await.unwrap_or_default();
            let mut value:Value=serde_json::from_slice(&bytes).unwrap_or_else(|_|json!({"error":{"code":if parts.status.as_u16()==405{"method_not_allowed"}else{"invalid_input"},"message":"Request could not be processed."}}));
            if value.get("error").is_some_and(Value::is_object) {
                value["error"]["requestId"] = json!(request_id);
            }
            parts
                .headers
                .insert("content-type", HeaderValue::from_static("application/json"));
            parts.headers.remove("content-length");
            response = Response::from_parts(parts, Body::from(value.to_string()));
        }
        let h = response.headers_mut();
        h.insert(
            "x-request-id",
            HeaderValue::from_str(&request_id).expect("uuid header"),
        );
        h.insert("cache-control", HeaderValue::from_static("no-store"));
        if path == "/api/collect" || path == "/api/telemetry" || path == "/api/tracker-config" {
            h.insert("access-control-allow-origin", HeaderValue::from_static("*"));
            h.insert(
                "access-control-allow-methods",
                HeaderValue::from_static(if path == "/api/collect" || path == "/api/telemetry" {
                    "POST, OPTIONS"
                } else {
                    "GET, OPTIONS"
                }),
            );
            h.insert(
                "access-control-allow-headers",
                HeaderValue::from_static("Content-Type"),
            );
            h.insert("access-control-max-age", HeaderValue::from_static("86400"));
        }
        if [429, 503].contains(&response.status().as_u16()) {
            response
                .headers_mut()
                .insert("retry-after", HeaderValue::from_static("60"));
        }
    }
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    if api {
        state.metrics.http[analytics_core::metrics::Metrics::http_group(&path)]
            .observe(started.elapsed().as_secs_f64());
        if response.status().is_server_error() {
            state
                .metrics
                .http_errors
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }
    response
}

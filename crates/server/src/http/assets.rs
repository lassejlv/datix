use super::*;

pub(super) async fn fallback(AppState(state): AppState<State>, request: Request) -> Response {
    let path = request.uri().path().to_owned();
    if path == "/api" || path.starts_with("/api/") {
        return Error::new(404, "not_found", "Endpoint not found.").into_response();
    }
    let decoded = match percent_encoding::percent_decode_str(&path).decode_utf8() {
        Ok(s) => s,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    if decoded.contains(['\\', '\0']) || decoded.split('/').any(|p| p.starts_with('.')) {
        return StatusCode::NOT_FOUND.into_response();
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return Error::new(405, "method_not_allowed", "Use GET or HEAD.").into_response();
    }
    let head = request.method() == Method::HEAD;
    let static_service = tower_http::services::ServeDir::new(&state.config.static_dir);
    match static_service.oneshot(request).await {
        Ok(response) if response.status() != StatusCode::NOT_FOUND => {
            let mut response = response.map(Body::new);
            if path == "/web-vitals.js" {
                response
                    .headers_mut()
                    .insert("access-control-allow-origin", HeaderValue::from_static("*"));
            }
            let cache = if path == "/" || path.ends_with("/index.html") {
                "no-cache"
            } else if path.starts_with("/assets/") {
                "public, max-age=31536000, immutable"
            } else {
                "public, max-age=300"
            };
            response
                .headers_mut()
                .insert("cache-control", HeaderValue::from_static(cache));
            return response;
        }
        _ => {}
    }
    if path.rsplit('/').next().is_some_and(|s| s.contains('.'))
        || path.starts_with("/assets/")
        || path.starts_with("/media/")
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let known = ["", "/pricing", "/signin", "/signup", "/dashboard", "/usage"]
        .contains(&path.trim_end_matches('/'))
        || regex::Regex::new(r"^/site/[^/]+(?:/[^/]+(?:/[^/]+)?)?/?$")
            .unwrap()
            .is_match(&path);
    let shell =
        match tokio::fs::read(std::path::Path::new(&state.config.static_dir).join("index.html"))
            .await
        {
            Ok(bytes) => bytes,
            Err(_) => {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Frontend build unavailable",
                )
                    .into_response();
            }
        };
    (
        if known {
            StatusCode::OK
        } else {
            StatusCode::NOT_FOUND
        },
        [
            ("content-type", "text/html; charset=UTF-8"),
            ("cache-control", "no-cache"),
        ],
        if head { vec![] } else { shell },
    )
        .into_response()
}

use super::*;

pub(super) async fn authentication(
    AppState(state): AppState<State>,
    Extension(context): Extension<Context>,
    Path(path): Path<String>,
    request: Request,
) -> Result<Response> {
    let method = request.method().to_string();
    let headers = request.headers().clone();
    if !["GET", "POST"].contains(&method.as_str()) {
        return Err(Error::new(405, "method_not_allowed", "Use GET or POST."));
    }
    let query = request.uri().query().unwrap_or("").to_string();
    let body = if method == "POST" {
        read_json(request).await?
    } else {
        Value::Null
    };
    if path == "delete-user" && method == "POST" {
        if body
            .as_object()
            .is_none_or(|v| v.len() != 1 || !v.contains_key("password"))
            || body["password"]
                .as_str()
                .is_none_or(|p| p.encode_utf16().count() > 128)
        {
            return Err(Error::invalid("Provide only the current password."));
        }
        let identity = auth::require(&state, &headers).await?;
        billing::provider::ensure_deletable(&state, &identity.user.id).await?;
    }
    let reply = auth::handle(&state, &path, &method, &headers, body, &context.ip, &query).await?;
    let mut response = match reply.redirect {
        Some(url) => (
            StatusCode::SEE_OTHER,
            [(
                axum::http::header::LOCATION,
                HeaderValue::from_str(&url).map_err(|_| Error::unavailable())?,
            )],
        )
            .into_response(),
        None => Json(reply.body).into_response(),
    };
    for cookie in reply.cookies {
        response.headers_mut().append(
            "set-cookie",
            HeaderValue::from_str(&cookie).map_err(|_| Error::unavailable())?,
        );
    }
    Ok(response)
}

use axum::{
    Json, Router,
    extract::{Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    Auth, AuthError, EmailCredentials, PasswordChange, SessionData, VerificationRequest, crypto,
};

pub fn router(auth: Auth) -> Router {
    Router::new()
        .route("/get-session", get(get_session))
        .route("/sign-up/email", post(sign_up))
        .route("/sign-in/email", post(sign_in))
        .route("/sign-in/social", post(sign_in_social))
        .route("/callback/{provider}", get(social_callback))
        .route("/sign-out", post(sign_out))
        .route("/send-verification-email", post(send_verification))
        .route("/verify-email", get(verify_email))
        .route("/update-user", post(update_user))
        .route("/change-password", post(change_password))
        .route("/delete-user", post(delete_user))
        .layer(middleware::from_fn_with_state(auth.clone(), guard))
        .with_state(auth)
}

async fn guard(
    State(auth): State<Auth>,
    request: Request,
    next: Next,
) -> Result<Response, AuthError> {
    if request.method() != Method::GET
        && request
            .headers()
            .get("origin")
            .and_then(|v| v.to_str().ok())
            != Some(auth.0.base_url.origin().ascii_serialization().as_str())
    {
        return Err(AuthError::new(
            StatusCode::FORBIDDEN,
            "INVALID_ORIGIN",
            "Use the application origin for account mutations.",
        ));
    }
    let path = request.uri().path();
    let ip = request
        .headers()
        .get("x-datix-client-ip")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown");
    let (window, max) = if path.ends_with("send-verification-email") {
        (60, 3)
    } else if path.ends_with("sign-in/email")
        || path.ends_with("sign-up/email")
        || path.ends_with("sign-in/social")
    {
        (10, 3)
    } else {
        (10, 100)
    };
    auth.api()
        .rate_limit(&format!("{ip}:{path}"), window, max)
        .await?;
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

async fn body<T: serde::de::DeserializeOwned>(
    request: Request,
) -> Result<(HeaderMap, T), AuthError> {
    let (parts, body) = request.into_parts();
    let content_type = parts
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("");
    if content_type != "application/json" {
        return Err(AuthError::invalid());
    }
    let bytes = axum::body::to_bytes(body, 16 * 1024).await.map_err(|_| {
        AuthError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "BODY_TOO_LARGE",
            "Request body is too large.",
        )
    })?;
    let value = serde_json::from_slice(&bytes).map_err(|_| AuthError::invalid())?;
    Ok((parts.headers, value))
}

fn append_cookie(
    response: &mut Response,
    auth: &Auth,
    suffix: &str,
    value: &str,
    age: Option<i64>,
) -> Result<(), AuthError> {
    let encoded: String =
        percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC)
            .to_string();
    let mut cookie = format!(
        "{}={encoded}; Path=/; HttpOnly; SameSite=Lax",
        auth.cookie_name(suffix)
    );
    if auth.0.base_url.scheme() == "https" {
        cookie.push_str("; Secure");
    }
    if let Some(age) = age {
        cookie.push_str(&format!("; Max-Age={age}"));
    }
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).map_err(|_| AuthError::unavailable())?,
    );
    Ok(())
}

fn session_response(
    auth: &Auth,
    session: &SessionData,
    remember: bool,
    value: Value,
) -> Result<Response, AuthError> {
    let mut response = Json(value).into_response();
    let signed = crypto::signed_cookie(&auth.0.secret, &session.session.token)?;
    append_cookie(
        &mut response,
        auth,
        "session_token",
        &signed,
        remember.then_some(604800),
    )?;
    if !remember {
        append_cookie(
            &mut response,
            auth,
            "dont_remember",
            &crypto::signed_cookie(&auth.0.secret, "true")?,
            None,
        )?;
    } else {
        append_cookie(&mut response, auth, "dont_remember", "", Some(0))?;
    }
    Ok(response)
}

fn clear_cookies(auth: &Auth, mut response: Response) -> Result<Response, AuthError> {
    for suffix in [
        "session_token",
        "session_data",
        "account_data",
        "dont_remember",
    ] {
        append_cookie(&mut response, auth, suffix, "", Some(0))?;
    }
    Ok(response)
}

async fn get_session(State(auth): State<Auth>, headers: HeaderMap) -> Result<Response, AuthError> {
    match auth.api().get_session(&headers).await? {
        Some(data) => {
            let remember =
                super::service::cookie_value(&headers, &auth.cookie_name("dont_remember"))
                    .and_then(|v| crypto::verify_cookie(&auth.0.secret, v))
                    .is_none();
            session_response(&auth, &data, remember, json!(data))
        }
        None => clear_cookies(&auth, Json(Value::Null).into_response()),
    }
}

async fn sign_up(State(auth): State<Auth>, request: Request) -> Result<Json<Value>, AuthError> {
    let (_, input) = body::<EmailCredentials>(request).await?;
    let user = auth.api().sign_up_email(input).await?;
    Ok(Json(json!({"token":null,"user":user})))
}

async fn sign_in(State(auth): State<Auth>, request: Request) -> Result<Response, AuthError> {
    let (headers, input) = body::<EmailCredentials>(request).await?;
    let remember = input.remember_me != Some(false);
    let callback = input.callback_url.clone();
    let session = auth.api().sign_in_email(input, &headers).await?;
    session_response(
        &auth,
        &session,
        remember,
        json!({"redirect":callback.is_some(),"token":session.session.token,"url":callback,"user":session.user}),
    )
}

async fn sign_out(State(auth): State<Auth>, headers: HeaderMap) -> Result<Response, AuthError> {
    auth.api().sign_out(&headers).await?;
    clear_cookies(&auth, Json(json!({"success":true})).into_response())
}

async fn sign_in_social(State(auth): State<Auth>, request: Request) -> Result<Response, AuthError> {
    let (_, input) = body::<crate::SocialSignIn>(request).await?;
    let redirect = !input.disable_redirect;
    let authorization = auth.api().sign_in_social(input).await?;
    let mut response = Json(json!({"url":authorization.url,"redirect":redirect})).into_response();
    append_cookie(
        &mut response,
        &auth,
        "oauth_state",
        &authorization.state_cookie,
        Some(600),
    )?;
    Ok(response)
}

#[derive(Deserialize)]
struct OAuthCallback {
    state: Option<String>,
    code: Option<String>,
    error: Option<String>,
}

async fn social_callback(
    State(auth): State<Auth>,
    Path(provider): Path<String>,
    Query(query): Query<OAuthCallback>,
    headers: HeaderMap,
) -> Result<Response, AuthError> {
    let state = auth
        .api()
        .consume_oauth_state(&provider, query.state.as_deref().unwrap_or(""), &headers)
        .await;
    let fallback = auth.callback_url(Some("/signin?oauth=failed"))?;
    let mut response = match state {
        Err(error) => oauth_failure(&fallback, error.code)?,
        Ok(state) => {
            let result = if query.error.is_some() {
                Err(AuthError::new(
                    StatusCode::BAD_REQUEST,
                    "access_denied",
                    "Social sign-in was declined.",
                ))
            } else {
                auth.api()
                    .finish_social_sign_in(&state, query.code.as_deref().unwrap_or(""), &headers)
                    .await
            };
            match result {
                Ok((session, callback)) => {
                    let mut response = session_response(&auth, &session, true, Value::Null)?;
                    *response.status_mut() = StatusCode::FOUND;
                    response.headers_mut().insert(
                        header::LOCATION,
                        HeaderValue::from_str(&callback).map_err(|_| AuthError::invalid())?,
                    );
                    *response.body_mut() = axum::body::Body::empty();
                    response
                }
                Err(error) => oauth_failure(&state.error_callback, error.code)?,
            }
        }
    };
    append_cookie(&mut response, &auth, "oauth_state", "", Some(0))?;
    Ok(response)
}

fn oauth_failure(callback: &str, code: &str) -> Result<Response, AuthError> {
    let mut url = url::Url::parse(callback).map_err(|_| AuthError::invalid())?;
    url.query_pairs_mut().append_pair("error", code);
    let mut response = Redirect::temporary(url.as_str()).into_response();
    *response.status_mut() = StatusCode::FOUND;
    Ok(response)
}

async fn send_verification(
    State(auth): State<Auth>,
    request: Request,
) -> Result<Json<Value>, AuthError> {
    let (headers, input) = body::<VerificationRequest>(request).await?;
    auth.api().send_verification_email(input, &headers).await?;
    Ok(Json(json!({"status":true})))
}

#[derive(Deserialize)]
struct VerifyQuery {
    token: String,
    #[serde(rename = "callbackURL")]
    callback_url: Option<String>,
}

async fn verify_email(
    State(auth): State<Auth>,
    Query(query): Query<VerifyQuery>,
    headers: HeaderMap,
) -> Result<Response, AuthError> {
    let callback = auth.callback_url(query.callback_url.as_deref())?;
    let result = auth.api().verify_email(&query.token, &headers).await;
    let mut response = match result {
        Ok(Some(session)) => session_response(
            &auth,
            &session,
            true,
            json!({"status":true,"user":session.user}),
        )?,
        Ok(None) => Json(json!({"status":true,"user":null})).into_response(),
        Err(error) => {
            if query.callback_url.is_none() {
                return Err(error);
            }
            let mut target = url::Url::parse(&callback).map_err(|_| AuthError::invalid())?;
            target.query_pairs_mut().append_pair("error", error.code);
            return Ok(Redirect::temporary(target.as_str()).into_response());
        }
    };
    if query.callback_url.is_some() {
        *response.status_mut() = StatusCode::FOUND;
        response.headers_mut().insert(
            header::LOCATION,
            HeaderValue::from_str(&callback).map_err(|_| AuthError::invalid())?,
        );
        *response.body_mut() = axum::body::Body::empty();
    }
    Ok(response)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateUser {
    name: String,
}

async fn update_user(State(auth): State<Auth>, request: Request) -> Result<Json<Value>, AuthError> {
    let (headers, input) = body::<UpdateUser>(request).await?;
    let user = auth.api().update_user(&headers, &input.name).await?;
    Ok(Json(json!({"status":true,"user":user})))
}

async fn change_password(
    State(auth): State<Auth>,
    request: Request,
) -> Result<Response, AuthError> {
    let (headers, input) = body::<PasswordChange>(request).await?;
    let revoke = input.revoke_other_sessions;
    let session = auth.api().change_password(&headers, input).await?;
    let value =
        json!({"token":if revoke {Some(&session.session.token)} else {None},"user":session.user});
    if revoke {
        session_response(&auth, &session, true, value)
    } else {
        Ok(Json(value).into_response())
    }
}

#[derive(Deserialize)]
struct DeleteUser {
    password: Option<String>,
}

async fn delete_user(State(auth): State<Auth>, request: Request) -> Result<Response, AuthError> {
    let (headers, input) = body::<DeleteUser>(request).await?;
    auth.api()
        .delete_user(&headers, input.password.as_deref())
        .await?;
    clear_cookies(
        &auth,
        Json(json!({"success":true,"message":"User deleted"})).into_response(),
    )
}

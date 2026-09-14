use axum::{
    body::{Body, to_bytes},
    http::{Request, header},
};
use datix_auth::{Auth, AuthError, AuthHooks, HookFuture, User};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

#[derive(Default)]
struct Hooks {
    messages: Mutex<Vec<String>>,
}
impl AuthHooks for Hooks {
    fn send_verification<'a>(&'a self, _user: &'a User, url: &'a str) -> HookFuture<'a> {
        Box::pin(async move {
            self.messages.lock().unwrap().push(url.into());
            Ok(())
        })
    }
    fn before_delete<'a>(&'a self, _user: &'a User) -> HookFuture<'a> {
        Box::pin(async { Ok(()) })
    }
}

async fn request(
    auth: &Auth,
    path: &str,
    value: Value,
    cookie: Option<&str>,
    ip: &str,
) -> (u16, axum::http::HeaderMap, Value) {
    let mut builder = Request::builder()
        .method("POST")
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ORIGIN, "http://localhost:3000")
        .header("x-datix-client-ip", ip);
    if let Some(cookie) = cookie {
        builder = builder.header(header::COOKIE, cookie);
    }
    let response = auth
        .router()
        .oneshot(builder.body(Body::from(value.to_string())).unwrap())
        .await
        .unwrap();
    let (parts, body) = response.into_parts();
    let bytes = to_bytes(body, 65536).await.unwrap();
    (
        parts.status.as_u16(),
        parts.headers,
        serde_json::from_slice(&bytes).unwrap(),
    )
}

fn cookies(headers: &axum::http::HeaderMap) -> String {
    headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .filter_map(|v| v.split(';').next())
        .collect::<Vec<_>>()
        .join("; ")
}

#[tokio::test]
#[ignore = "Requires DATIX_TEST_ENV pointing to the isolated Rust Neon development branch"]
async fn signup_verification_cookie_rotation_and_revocation_use_the_existing_schema()
-> Result<(), AuthError> {
    let env_file = std::env::var("DATIX_TEST_ENV").expect("DATIX_TEST_ENV is required");
    let env_file = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(env_file);
    let env: std::collections::HashMap<_, _> = dotenvy::from_path_iter(env_file)
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let database = &env["DATABASE_URL"];
    let identity = datix_db::identity(database).unwrap();
    assert_eq!(
        identity.host,
        "ep-sweet-sun-b1ynkxmz-pooler.c-5.eu-central-1.aws.neon.tech"
    );
    assert_eq!(identity.database, "datix");
    let pool = datix_db::connect_runtime(database, 3).await.unwrap();
    let hooks = Arc::new(Hooks::default());
    let auth = Auth::new(
        pool.clone(),
        "fixture-secret-at-least-32-characters".into(),
        "http://localhost:3000",
        hooks.clone(),
    )?;
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let email = format!("rust-{nonce}@example.test");
    let ip = format!("test-{nonce}");
    let (status,_,created)=request(&auth,"/sign-up/email",json!({"email":email,"password":"Pässｗord-123","name":"Rust integration","callbackURL":"/dashboard"}),None,&ip).await;
    assert_eq!(status, 200, "{created}");
    let user_id = created["user"]["id"].as_str().unwrap();
    assert!(created["token"].is_null());
    let (status, _, error) = request(
        &auth,
        "/sign-in/email",
        json!({"email":email,"password":"Pässword-123"}),
        None,
        &ip,
    )
    .await;
    assert_eq!(
        (status, error["code"].as_str()),
        (403, Some("EMAIL_NOT_VERIFIED"))
    );
    let url = hooks.messages.lock().unwrap()[0].clone();
    let url = url::Url::parse(&url).unwrap();
    let response = auth
        .router()
        .oneshot(
            Request::builder()
                .uri(format!("/verify-email?{}", url.query().unwrap()))
                .header("x-datix-client-ip", &ip)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 302);
    assert_eq!(
        response.headers()[header::LOCATION],
        "http://localhost:3000/dashboard"
    );
    let original_cookie = cookies(response.headers());
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(header::COOKIE, original_cookie.parse().unwrap());
    assert!(
        auth.api()
            .require_session(&headers)
            .await?
            .user
            .email_verified
    );
    let (status,rotated,_)=request(&auth,"/change-password",json!({"currentPassword":"Pässword-123","newPassword":"new-password-123","revokeOtherSessions":true}),Some(&original_cookie),&ip).await;
    assert_eq!(status, 200);
    assert!(auth.api().get_session(&headers).await?.is_none());
    let rotated_cookie = cookies(&rotated);
    let (status, _, _) = request(
        &auth,
        "/update-user",
        json!({"name":"Renamed"}),
        Some(&rotated_cookie),
        &ip,
    )
    .await;
    assert_eq!(status, 200);
    headers.insert(header::COOKIE, rotated_cookie.parse().unwrap());
    assert_eq!(
        auth.api().require_session(&headers).await?.user.name,
        "Renamed"
    );
    let (status, _, deleted) = request(
        &auth,
        "/delete-user",
        json!({"password":"new-password-123"}),
        Some(&rotated_cookie),
        &ip,
    )
    .await;
    assert_eq!((status, deleted["success"].as_bool()), (200, Some(true)));
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM public.\"user\" WHERE id=$1)")
            .bind(user_id)
            .fetch_one(&pool)
            .await?;
    assert!(!exists);
    pool.close().await;
    Ok(())
}

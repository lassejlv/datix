use super::*;
use crate::{AuthHooks, HookFuture};
use axum::{
    Form, Json, Router,
    body::Body,
    extract::State,
    http::{Request, header},
    routing::{get, post},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tower::ServiceExt;

struct Hooks;
impl AuthHooks for Hooks {
    fn send_verification<'a>(&'a self, _: &'a User, _: &'a str) -> HookFuture<'a> {
        Box::pin(async { Ok(()) })
    }
    fn before_delete<'a>(&'a self, _: &'a User) -> HookFuture<'a> {
        Box::pin(async { Ok(()) })
    }
}

#[derive(Clone, Default)]
struct Mock {
    profiles: Arc<Mutex<HashMap<String, Value>>>,
    exchanges: Arc<Mutex<Vec<HashMap<String, String>>>>,
}

async fn token(State(mock): State<Mock>, Form(form): Form<HashMap<String, String>>) -> Json<Value> {
    assert_eq!(form["client_secret"], "fixture-secret");
    assert_eq!(form["grant_type"], "authorization_code");
    let code = form["code"].clone();
    mock.exchanges.lock().unwrap().push(form);
    Json(json!({"access_token":code,"token_type":"bearer","expires_in":3600}))
}

async fn profile(State(mock): State<Mock>, headers: HeaderMap) -> Json<Value> {
    let code = headers[header::AUTHORIZATION]
        .to_str()
        .unwrap()
        .strip_prefix("Bearer ")
        .unwrap();
    Json(mock.profiles.lock().unwrap()[code].clone())
}

async fn begin(auth: &Auth) -> (String, HeaderMap, String) {
    let result = auth.api().sign_in_social(serde_json::from_value(json!({
        "provider":"google","callbackURL":"/dashboard","errorCallbackURL":"/signin?oauth=failed"
    })).unwrap()).await.unwrap();
    let query: HashMap<_, _> = Url::parse(&result.url)
        .unwrap()
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    assert_eq!(
        query["redirect_uri"],
        "http://localhost:3000/api/auth/callback/google"
    );
    assert_eq!(query["code_challenge_method"], "S256");
    let mut headers = HeaderMap::new();
    headers.insert(
        header::COOKIE,
        format!("better-auth.oauth_state={}", result.state_cookie)
            .parse()
            .unwrap(),
    );
    headers.insert(
        "x-datix-client-ip",
        uuid::Uuid::new_v4().to_string().parse().unwrap(),
    );
    (
        query["state"].clone(),
        headers,
        query["code_challenge"].clone(),
    )
}

async fn callback(
    auth: &Auth,
    state: &str,
    headers: &HeaderMap,
    code: &str,
) -> axum::response::Response {
    let mut request = Request::builder()
        .uri(format!("/callback/google?state={state}&code={code}"))
        .body(Body::empty())
        .unwrap();
    *request.headers_mut() = headers.clone();
    auth.router().oneshot(request).await.unwrap()
}

#[tokio::test]
#[ignore = "Requires DATIX_TEST_ENV and an isolated Neon development branch; OAuth provider is local"]
async fn oauth_binds_browser_and_provider_and_preserves_verified_account_linking() {
    let env_file = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(std::env::var("DATIX_TEST_ENV").unwrap());
    let env: HashMap<_, _> = dotenvy::from_path_iter(env_file)
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let identity = datix_db::identity(&env["DATABASE_URL"]).unwrap();
    assert_eq!(
        identity.host,
        "ep-sweet-sun-b1ynkxmz-pooler.c-5.eu-central-1.aws.neon.tech"
    );
    assert_eq!(identity.database, "datix");
    let pool = datix_db::connect_runtime(&env["DATABASE_URL"], 3)
        .await
        .unwrap();
    let mock = Mock::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let mock_router = Router::new()
        .route("/token", post(token))
        .route("/profile", get(profile))
        .with_state(mock.clone());
    let server = tokio::spawn(async move { axum::serve(listener, mock_router).await.unwrap() });
    let mut provider =
        SocialProvider::google("fixture-client".into(), "fixture-secret".into()).unwrap();
    provider.token = format!("{base}/token");
    provider.userinfo = format!("{base}/profile");
    let auth = Auth::new(
        pool.clone(),
        "fixture-secret-at-least-32-characters".into(),
        "http://localhost:3000",
        Arc::new(Hooks),
    )
    .unwrap()
    .with_social_providers(vec![provider]);
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let email = format!("oauth-{nonce}@example.test");
    let original = json!({"sub":nonce,"email":email,"email_verified":true,"name":"OAuth test"});
    mock.profiles
        .lock()
        .unwrap()
        .insert("new".into(), original.clone());

    let invalid: SocialSignIn = serde_json::from_value(
        json!({"provider":"google","callbackURL":"https://untrusted.example/"}),
    )
    .unwrap();
    assert!(auth.api().sign_in_social(invalid).await.is_err());
    let (state, headers, challenge) = begin(&auth).await;
    assert!(
        auth.api()
            .consume_oauth_state("google", &state, &HeaderMap::new())
            .await
            .is_err()
    );
    assert!(
        auth.api()
            .consume_oauth_state("github", &state, &headers)
            .await
            .is_err()
    );
    let response = callback(&auth, &state, &headers, "new").await;
    assert_eq!(response.status(), StatusCode::FOUND);
    assert_eq!(
        response.headers()[header::LOCATION],
        "http://localhost:3000/dashboard"
    );
    let cookie = response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .find(|v| {
            v.to_str()
                .unwrap()
                .starts_with("better-auth.session_token=")
        })
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let mut session_headers = HeaderMap::new();
    session_headers.insert(header::COOKIE, cookie.parse().unwrap());
    let user = auth
        .api()
        .require_session(&session_headers)
        .await
        .unwrap()
        .user;
    assert_eq!(user.email, email);
    assert_eq!(
        challenge,
        URL_SAFE_NO_PAD.encode(Sha256::digest(
            mock.exchanges.lock().unwrap()[0]["code_verifier"].as_bytes()
        ))
    );
    let replay = callback(&auth, &state, &headers, "new").await;
    assert!(
        replay.headers()[header::LOCATION]
            .to_str()
            .unwrap()
            .contains("invalid_state")
    );
    assert_eq!(mock.exchanges.lock().unwrap().len(), 1);

    let unverified_id = uuid::Uuid::new_v4().simple().to_string();
    let blocked_email = format!("unverified-{nonce}@example.test");
    sqlx::query("INSERT INTO public.\"user\"(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Local name',$2,false,now(),now())")
        .bind(&unverified_id).bind(&blocked_email).execute(&pool).await.unwrap();
    mock.profiles.lock().unwrap().insert("link".into(), json!({"sub":format!("linked-{nonce}"),"email":blocked_email,"email_verified":true,"name":"Provider name"}));
    let (state, headers, _) = begin(&auth).await;
    let blocked = callback(&auth, &state, &headers, "link").await;
    assert!(
        blocked.headers()[header::LOCATION]
            .to_str()
            .unwrap()
            .contains("account_not_linked")
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM account WHERE user_id=$1")
        .bind(&unverified_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    sqlx::query("UPDATE public.\"user\" SET email_verified=true WHERE id=$1")
        .bind(&unverified_id)
        .execute(&pool)
        .await
        .unwrap();
    let (state, headers, _) = begin(&auth).await;
    let linked = callback(&auth, &state, &headers, "link").await;
    assert_eq!(
        linked.headers()[header::LOCATION],
        "http://localhost:3000/dashboard"
    );
    let name: String = sqlx::query_scalar("SELECT name FROM public.\"user\" WHERE id=$1")
        .bind(&unverified_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(name, "Local name");

    // Once linked, stable provider identity wins over a changed provider email.
    mock.profiles.lock().unwrap().insert(
        "changed".into(),
        json!({"sub":nonce,"email":blocked_email,"email_verified":true,"name":"Changed"}),
    );
    let (state, headers, _) = begin(&auth).await;
    let changed = callback(&auth, &state, &headers, "changed").await;
    assert_eq!(
        changed.headers()[header::LOCATION],
        "http://localhost:3000/dashboard"
    );
    let owner: String = sqlx::query_scalar(
        "SELECT user_id FROM account WHERE provider_id='google' AND account_id=$1",
    )
    .bind(&nonce)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(owner, user.id);
    // Passwordless deletion retains Better Auth's one-day session-freshness rule.
    sqlx::query("UPDATE public.session SET created_at=now()-interval '2 days' WHERE user_id=$1")
        .bind(&user.id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        auth.api()
            .delete_user(&session_headers, None)
            .await
            .unwrap_err()
            .code,
        "SESSION_EXPIRED"
    );
    sqlx::query("UPDATE public.session SET created_at=now() WHERE user_id=$1")
        .bind(&user.id)
        .execute(&pool)
        .await
        .unwrap();
    auth.api()
        .delete_user(&session_headers, None)
        .await
        .unwrap();
    assert!(
        auth.api()
            .get_session(&session_headers)
            .await
            .unwrap()
            .is_none()
    );
    sqlx::query("DELETE FROM public.\"user\" WHERE id=$1")
        .bind(unverified_id)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    server.abort();
}

#[tokio::test]
async fn github_uses_the_verified_primary_email_from_the_authenticated_email_endpoint() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new()
        .route(
            "/user",
            get(|headers: HeaderMap| async move {
                assert_eq!(headers[header::AUTHORIZATION], "Bearer fixture-token");
                Json(json!({"id":123,"login":"octocat"}))
            }),
        )
        .route(
            "/emails",
            get(|| async {
                Json(json!([
                    {"email":"other@example.test","verified":true,"primary":false},
                    {"email":"primary@example.test","verified":true,"primary":true}
                ]))
            }),
        );
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let mut provider =
        SocialProvider::github("fixture-client".into(), "fixture-secret".into()).unwrap();
    provider.userinfo = format!("{base}/user");
    provider.emails = Some(format!("{base}/emails"));
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://fixture:fixture@localhost/fixture")
        .unwrap();
    let auth = Auth::new(
        pool,
        "fixture-secret-at-least-32-characters".into(),
        "http://localhost:3000",
        Arc::new(Hooks),
    )
    .unwrap();
    let profile = auth
        .api()
        .provider_profile(&provider, "fixture-token")
        .await
        .unwrap();
    assert_eq!(profile.email, "primary@example.test");
    assert_eq!(profile.id, "123");
    assert_eq!(profile.name, "octocat");
    assert!(profile.verified);
    server.abort();
}

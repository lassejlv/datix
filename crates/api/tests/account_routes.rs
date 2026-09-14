use axum::{
    body::{Body, to_bytes},
    extract::ConnectInfo,
    http::{Request, header},
};
use datix_api::{AppState, config::Config};
use datix_auth::{Auth, AuthHooks, HookFuture, User};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex},
};
use tower::ServiceExt;

#[path = "support/admin.rs"]
mod admin;
#[path = "support/analytics.rs"]
mod analytics;
#[path = "support/imports.rs"]
mod imports;

#[derive(Default)]
struct Hooks(Mutex<Vec<String>>);
impl AuthHooks for Hooks {
    fn send_verification<'a>(&'a self, _user: &'a User, url: &'a str) -> HookFuture<'a> {
        Box::pin(async move {
            self.0.lock().unwrap().push(url.into());
            Ok(())
        })
    }
    fn before_delete<'a>(&'a self, _user: &'a User) -> HookFuture<'a> {
        Box::pin(async { Ok(()) })
    }
}

async fn call(
    state: &AppState,
    method: &str,
    path: &str,
    payload: Value,
    cookie: &str,
) -> (u16, axum::http::HeaderMap, Value) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header(header::ORIGIN, "http://localhost:3000")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::COOKIE, cookie)
        .extension(ConnectInfo(SocketAddr::new(
            IpAddr::V4(Ipv4Addr::new(127, 0, 0, 99)),
            12000,
        )))
        .body(Body::from(payload.to_string()))
        .unwrap();
    let response = datix_api::router(state.clone())
        .oneshot(request)
        .await
        .unwrap();
    let (parts, body) = response.into_parts();
    let bytes = to_bytes(body, 128 * 1024).await.unwrap();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (parts.status.as_u16(), parts.headers, value)
}

#[tokio::test]
#[ignore = "Requires DATIX_TEST_ENV and the isolated Rust Neon branch"]
async fn onboarding_site_ownership_and_subscription_gates_match_the_frontend_contract() {
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(std::env::var("DATIX_TEST_ENV").expect("DATIX_TEST_ENV required"));
    let env: HashMap<_, _> = dotenvy::from_path_iter(file)
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let identity = datix_db::identity(&env["DATABASE_URL"]).unwrap();
    assert_eq!(
        identity.host,
        "ep-sweet-sun-b1ynkxmz-pooler.c-5.eu-central-1.aws.neon.tech"
    );
    assert_eq!(identity.database, "datix");
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let config = Config {
        app_url: "http://localhost:3000".into(),
        database_url: env["DATABASE_URL"].clone(),
        redis_url: env["REDIS_URL"].clone(),
        auth_secret: "fixture-secret-at-least-32-characters".into(),
        visitor_secret: "fixture-visitor-secret-at-least-32-characters".into(),
        queue_prefix: format!("test-rust-{nonce}"),
        port: 3001,
        max_connections: 3,
        external_effects: false,
        cloudflare_origin_secret: None,
        metrics_token: None,
        admin_emails: HashSet::new(),
        role: datix_api::config::Role::Api,
        workers: 2,
        batch_size: 64,
    };
    let mut state = AppState::connect(config).await.unwrap();
    let hooks = Arc::new(Hooks::default());
    state.auth = Auth::new(
        state.pool.clone(),
        state.config.auth_secret.clone(),
        &state.config.app_url,
        hooks.clone(),
    )
    .unwrap();
    let (status, _, _) = call(&state, "GET", "/api/sites", Value::Null, "").await;
    assert_eq!(status, 401);
    let email = format!("rust-api-{nonce}@example.test");
    let (status,_,created)=call(&state,"POST","/api/auth/sign-up/email",json!({"email":email,"password":"account-test-password","name":"API fixture","callbackURL":"/dashboard"}),"").await;
    assert_eq!(status, 200, "{created}");
    let user_id = created["user"]["id"].as_str().unwrap();
    let url = hooks.0.lock().unwrap()[0].clone();
    let url = url::Url::parse(&url).unwrap();
    let (status, headers, _) = call(
        &state,
        "GET",
        &format!("/api/auth/verify-email?{}", url.query().unwrap()),
        Value::Null,
        "",
    )
    .await;
    assert_eq!(status, 302);
    let cookie = headers
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|h| h.to_str().unwrap().split(';').next().unwrap())
        .collect::<Vec<_>>()
        .join("; ");
    let (status, _, me) = call(&state, "GET", "/api/me", Value::Null, &cookie).await;
    assert_eq!(
        (status, me["user"]["email"].as_str()),
        (200, Some(email.as_str()))
    );
    let (status, _, created) = call(
        &state,
        "POST",
        "/api/sites",
        json!({"name":"First","domain":"EXAMPLE.test"}),
        &cookie,
    )
    .await;
    assert_eq!(status, 201, "{created}");
    let site = created["site"]["id"].as_str().unwrap();
    assert_eq!(created["site"]["environments"][0]["id"], site);
    assert_eq!(created["site"]["domain"], "example.test");
    let (status, _, _) = call(
        &state,
        "POST",
        "/api/sites",
        json!({"name":"Second","domain":"second.test"}),
        &cookie,
    )
    .await;
    assert_eq!(status, 402);
    let (status, _, _) = call(
        &state,
        "POST",
        "/api/onboarding/complete",
        json!({}),
        &cookie,
    )
    .await;
    assert_eq!(status, 200);
    let (status, _, _) = call(&state, "GET", "/api/sites", Value::Null, &cookie).await;
    assert_eq!(status, 402);
    let (status, _, usage) = call(&state, "GET", "/api/usage", Value::Null, &cookie).await;
    assert_eq!(status, 200, "{usage}");
    assert_eq!(usage["onboardingCompleted"], true);
    assert_eq!(usage["pauseReason"], "subscription_required");
    let start = chrono::Utc::now() - chrono::Duration::days(1);
    let end = chrono::Utc::now() + chrono::Duration::days(29);
    let subscriptions = json!([{"status":"active","currentPeriodEnd":end,"entitlements":{"name":"Basic","eventLimit":1500000,"websiteLimit":10,"used":0,"remaining":1500000,"localBaseline":0,"pending":0,"periodStart":start,"periodEnd":end}}]);
    sqlx::query("INSERT INTO billing_customers(customer_id,owner_id,organization_id,subscriptions,occurred_at) VALUES($1,$2,'8ded9438-0be0-4f4a-8cef-f448d77c202c'::uuid,$3,now())").bind(format!("fixture-{nonce}")).bind(user_id).bind(subscriptions).execute(&state.pool).await.unwrap();
    let (status, _, _) = call(&state, "GET", "/api/sites", Value::Null, &cookie).await;
    assert_eq!(status, 200);
    let (status, _, environment) = call(
        &state,
        "POST",
        &format!("/api/sites/{site}/environments"),
        json!({"name":"Staging","domain":"staging.example.test","trackingMode":"sessions"}),
        &cookie,
    )
    .await;
    assert_eq!(status, 201, "{environment}");
    let environment = environment["environment"]["id"].as_str().unwrap();
    imports::verify(&state, user_id, site, environment, &cookie).await;
    analytics::verify(&state, site, environment, &cookie).await;
    admin::verify(&state, user_id, &email, site, &cookie).await;
    let (status, _, _) = call(
        &state,
        "DELETE",
        &format!("/api/sites/{site}/environments/{site}"),
        Value::Null,
        &cookie,
    )
    .await;
    assert_eq!(status, 409);
    let (status, _, _) = call(
        &state,
        "GET",
        &format!("/api/sites/{}", uuid::Uuid::new_v4()),
        Value::Null,
        &cookie,
    )
    .await;
    assert_eq!(status, 404);
    let (status, _, _) = call(
        &state,
        "DELETE",
        &format!("/api/sites/{site}/environments/{environment}"),
        Value::Null,
        &cookie,
    )
    .await;
    assert_eq!(status, 204);
    let (status, _, _) = call(&state, "GET", "/api/not-a-route", Value::Null, &cookie).await;
    assert_eq!(status, 404);
    sqlx::query("DELETE FROM billing_customers WHERE customer_id=$1")
        .bind(format!("fixture-{nonce}"))
        .execute(&state.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM public.\"user\" WHERE id=$1")
        .bind(user_id)
        .execute(&state.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM analytics_deletions WHERE environment_id=ANY($1)")
        .bind(vec![
            uuid::Uuid::parse_str(site).unwrap(),
            uuid::Uuid::parse_str(environment).unwrap(),
        ])
        .execute(&state.pool)
        .await
        .unwrap();
    let _: i64 = redis::cmd("DEL")
        .arg(format!("{}:diagnostic-stream", state.config.queue_prefix))
        .query_async(&mut state.redis.clone())
        .await
        .unwrap();
    state.pool.close().await;
}

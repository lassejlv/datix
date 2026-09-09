//! Explicitly enabled tests against an isolated Neon branch; all fixture records are cleaned up.
use analytics_core::{Config, State, crypto};
use analytics_server::http;
use analytics_services::{abuse, auth, billing, ingest, queue, tracking::Event};
use axum::{
    body::{Body, to_bytes},
    extract::ConnectInfo,
    http::{Request, StatusCode},
};
use chrono::{Duration, Utc};
use futures_util::FutureExt;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    panic::AssertUnwindSafe,
    sync::{Arc, atomic::AtomicBool},
};
use tower::ServiceExt;
use uuid::Uuid;

struct Fixture {
    state: State,
    user: String,
    email: String,
    cookie: String,
    ip: SocketAddr,
}
impl Fixture {
    async fn new() -> Self {
        dotenvy::dotenv().ok();
        let _ = tracing_subscriber::fmt()
            .with_env_filter("analytics_core=error")
            .with_test_writer()
            .try_init();
        let url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL");
        let host = std::env::var("TEST_DATABASE_HOST").expect("TEST_DATABASE_HOST");
        assert_eq!(
            url::Url::parse(&url).unwrap().host_str(),
            Some(host.as_str())
        );
        assert_ne!(
            url::Url::parse(&url).unwrap().host_str(),
            url::Url::parse(&std::env::var("DATABASE_URL").unwrap())
                .unwrap()
                .host_str(),
            "tests must never use the development or production database"
        );
        let redis = std::env::var("RUST_TEST_REDIS_URL")
            .unwrap_or_else(|_| "redis://127.0.0.1:6394".into());
        assert_eq!(
            url::Url::parse(&redis).unwrap().host_str(),
            Some("127.0.0.1")
        );
        let user = format!("rust-it-{}", Uuid::new_v4().simple());
        let email = format!("{user}@example.com");
        let config = Config {
            app_url: url::Url::parse("http://localhost:3057").unwrap(),
            app_origins: vec!["http://localhost:3057".into()],
            auth_secret: "integration-auth-secret-with-more-than-32-characters".into(),
            visitor_secret: format!("integration-visitor-{user}"),
            origin_secret: Some("test-origin-verification-secret".into()),
            autumn_key: None,
            autumn_url: "http://127.0.0.1:1".into(),
            railway: false,
            port: 3057,
            static_dir: concat!(env!("CARGO_MANIFEST_DIR"), "/../../web/dist/client").into(),
            event_stream: format!("analytics:test:{user}"),
            runtime: analytics_core::config::Runtime {
                report_cache_seconds: 0,
                ..Default::default()
            },
            metrics_token: Some("test-metrics-token".into()),
        };
        let state = State::connect(config, &url, &redis).await.unwrap();
        sqlx::query("INSERT INTO \"user\"(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Rust fixture',$2,false,now(),now())").bind(&user).bind(&email).execute(&state.db).await.unwrap();
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../web/tests/fixtures/legacy-crypto.json"
        ))
        .unwrap();
        sqlx::query("INSERT INTO account(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES($1,$2,'credential',$2,$3,now(),now())").bind(Uuid::new_v4().to_string()).bind(&user).bind(fixture["hash"].as_str().unwrap()).execute(&state.db).await.unwrap();
        let token = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,$3,now()+interval '7 days',now(),now())").bind(Uuid::new_v4().to_string()).bind(&token).bind(&user).execute(&state.db).await.unwrap();
        let cookie = auth::cookie(&state, &token, true)
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let bytes = Uuid::new_v4();
        let b = bytes.as_bytes();
        let ip = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(198, 18, b[0], b[1])), 12345);
        Self {
            state,
            user,
            email,
            cookie,
            ip,
        }
    }
    async fn cleanup(&self) {
        sqlx::query("DELETE FROM billing_customers WHERE customer_id=$1 OR owner_id=$2")
            .bind(format!("test-{}", self.user))
            .bind(&self.user)
            .execute(&self.state.db)
            .await
            .unwrap();
        sqlx::query("DELETE FROM billing_webhook_events WHERE id LIKE $1")
            .bind(format!("{}%", self.user))
            .execute(&self.state.db)
            .await
            .unwrap();
        sqlx::query("DELETE FROM \"user\" WHERE id=$1 AND email=$2")
            .bind(&self.user)
            .bind(&self.email)
            .execute(&self.state.db)
            .await
            .unwrap();
        let mut redis = self.state.redis.clone();
        let _: i64 = redis::cmd("DEL")
            .arg(&self.state.config.event_stream)
            .arg(format!("{}:failed", self.state.config.event_stream))
            .arg(format!(
                "analytics:rate:auth:{}",
                crypto::hash(&self.state.config.visitor_secret, &self.ip.ip().to_string())
            ))
            .arg(format!(
                "analytics:rate:collect:{}",
                crypto::hash(&self.state.config.visitor_secret, &self.ip.ip().to_string())
            ))
            .arg(format!(
                "analytics:rate:api:ip:{}",
                crypto::hash(&self.state.config.visitor_secret, &self.ip.ip().to_string())
            ))
            .arg(format!("analytics:rate:api:user:{}", self.user))
            .query_async(&mut redis)
            .await
            .unwrap();
        self.state.db.close().await;
    }
    async fn request(
        &self,
        path: &str,
        method: &str,
        body: Option<Value>,
    ) -> (u16, Value, axum::http::HeaderMap) {
        self.request_headers(path, method, body, &[]).await
    }
    async fn request_headers(
        &self,
        path: &str,
        method: &str,
        body: Option<Value>,
        headers: &[(&str, &str)],
    ) -> (u16, Value, axum::http::HeaderMap) {
        let mut req = Request::builder()
            .uri(path)
            .method(method)
            .header("origin", "http://localhost:3057")
            .header("content-type", "application/json")
            .header("cookie", &self.cookie)
            .header("user-agent", "Integration browser");
        for (name, value) in headers {
            req = req.header(*name, *value);
        }
        let mut request = req
            .body(
                body.map(|v| Body::from(v.to_string()))
                    .unwrap_or_else(Body::empty),
            )
            .unwrap();
        request.extensions_mut().insert(ConnectInfo(self.ip));
        // header() appends values. Replace custom headers so origin/cookie test overrides are unambiguous.
        for (name, value) in headers {
            request.headers_mut().insert(
                axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                value.parse().unwrap(),
            );
        }
        let response = http::router(self.state.clone(), Arc::new(AtomicBool::new(true)))
            .oneshot(request)
            .await
            .unwrap();
        let code = response.status().as_u16();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        let value = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).to_string()));
        (code, value, headers)
    }
    async fn pro(&self) {
        let now = Utc::now();
        let annual = json!({"id":"basic_annual"});
        let subscriptions = json!([{"id":Uuid::new_v4(),"productId":annual["id"],"entitlements":{"name":"Basic Annual","eventLimit":10000000,"websiteLimit":10,"used":0,"remaining":10000000,"localBaseline":0,"pending":0,"periodStart":now-Duration::days(5),"periodEnd":now+Duration::days(25)},"status":"active","currentPeriodStart":now-Duration::days(5),"currentPeriodEnd":now+Duration::days(360),"trialEnd":null,"cancelAtPeriodEnd":false,"endsAt":null}]);
        sqlx::query("INSERT INTO billing_customers(customer_id,owner_id,subscriptions,occurred_at,provider) VALUES($1,$2,$3,now(),'autumn')").bind(format!("test-{}",self.user)).bind(&self.user).bind(subscriptions).execute(&self.state.db).await.unwrap();
    }
    async fn site(&self) -> Uuid {
        let (status, body, _) = self
            .request(
                "/api/sites",
                "POST",
                Some(json!({"name":"Test site","domain":"example.com"})),
            )
            .await;
        assert_eq!(status, 201, "{body}");
        let id: Uuid = body["site"]["id"].as_str().unwrap().parse().unwrap();
        // These fixtures exercise every activity kind; production defaults are opt-in.
        sqlx::query("UPDATE environments SET tracking_settings=$1 WHERE site_id=$2")
            .bind(json!({"click":true,"download":true,"scroll":true}))
            .bind(id)
            .execute(&self.state.db)
            .await
            .unwrap();
        id
    }
    fn event(&self, site: Uuid) -> Event {
        let now = Utc::now();
        serde_json::from_value(json!({"version":1,"siteId":site,"id":Uuid::new_v4(),"receivedAt":now,"day":now.date_naive(),"type":"pageview","name":"","path":"/pricing","referrer":"search.example","country":"DK","device":"desktop","visitor":"a".repeat(64)})).unwrap()
    }
    async fn queued(&self) -> Vec<Event> {
        let mut redis = self.state.redis.clone();
        let result: redis::streams::StreamRangeReply = redis::cmd("XRANGE")
            .arg(&self.state.config.event_stream)
            .arg("-")
            .arg("+")
            .query_async(&mut redis)
            .await
            .unwrap();
        result
            .ids
            .into_iter()
            .map(|r| serde_json::from_str(&r.get::<String>("data").unwrap()).unwrap())
            .collect()
    }
}
macro_rules! fixture {($name:ident,$body:block)=>{{let $name=Fixture::new().await;let outcome=AssertUnwindSafe(async $body).catch_unwind().await;$name.cleanup().await;if let Err(error)=outcome{std::panic::resume_unwind(error)}}}}

#[path = "imports/mod.rs"]
mod imports;
#[path = "scaling/mod.rs"]
mod scaling;

#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn http_auth_ownership_methods_validation_and_environment_contracts() {
    fixture!(f, {
        let (status, _, _) = f
            .request_headers("/api/me", "GET", None, &[("cookie", "")])
            .await;
        assert_eq!(status, 401);
        for path in ["/api/sites/unknown/nested", "/api/billing/unknown"] {
            assert_eq!(
                f.request_headers(path, "GET", None, &[("cookie", "")])
                    .await
                    .0,
                401
            );
        }
        let (status, _, headers) = f.request("/api/me", "HEAD", None).await;
        assert_eq!(status, 405);
        assert!(headers.contains_key("x-request-id"));
        assert_eq!(
            f.request(
                "/api/sites",
                "POST",
                Some(json!({"name":"Test","domain":"https://example.com"}))
            )
            .await
            .0,
            400
        );
        assert_eq!(
            f.request_headers(
                "/api/sites",
                "POST",
                Some(json!({"name":"Test","domain":"example.com"})),
                &[("origin", "https://attacker.example")]
            )
            .await
            .0,
            403
        );
        let site = f.site().await;
        let (status, body, _) = f.request(&format!("/api/sites/{site}"), "GET", None).await;
        assert_eq!(status, 200);
        assert_eq!(body["site"]["environments"][0]["id"], site.to_string());
        let (status,body,_)=f.request(&format!("/api/sites/{site}/environments"),"POST",Some(json!({"name":"Staging","domain":"staging.example.com","trackingMode":"sessions"}))).await;
        assert_eq!(status, 201, "{body}");
        let env = body["environment"]["id"].as_str().unwrap();
        assert_eq!(
            f.request(
                &format!("/api/sites/{site}/environments"),
                "POST",
                Some(json!({"name":"staging"}))
            )
            .await
            .0,
            409
        );
        assert_eq!(
            f.request(
                &format!("/api/sites/{site}/environments/{site}"),
                "DELETE",
                None
            )
            .await
            .0,
            409
        );
        assert_eq!(
            f.request(
                &format!("/api/sites/{site}/environments/{site}"),
                "PATCH",
                Some(json!({"domain":"elsewhere.example.com"}))
            )
            .await
            .0,
            400
        );
        assert_eq!(
            f.request(
                &format!("/api/sites/{site}/environments/{env}"),
                "PATCH",
                Some(json!({"enabled":false,"allowLocalhost":true}))
            )
            .await
            .0,
            200
        );
        assert_eq!(
            f.request(
                &format!("/api/sites/{site}/environments/{env}"),
                "DELETE",
                None
            )
            .await
            .0,
            204
        );
        assert_eq!(
            f.request(
                &format!("/api/sites/{site}/environments/{env}"),
                "GET",
                None
            )
            .await
            .0,
            404
        );
        assert_eq!(
            f.request(
                &format!("/api/sites/{site}"),
                "PATCH",
                Some(json!({"enabled":false,"creditBudget":0.3}))
            )
            .await
            .0,
            200
        );
        let (_, body, _) = f
            .request(
                &format!("/api/sites/{site}/environments/{site}"),
                "GET",
                None,
            )
            .await;
        assert_eq!(body["environment"]["enabled"], false);
        let (_, body, _) = f
            .request(
                &format!("/api/sites/{site}"),
                "PATCH",
                Some(json!({"creditBudget":null})),
            )
            .await;
        assert!(body["site"]["creditBudget"].is_null());
        assert_eq!(
            f.request(
                &format!("/api/sites/{site}/overview?from=2026-02-30"),
                "GET",
                None
            )
            .await
            .0,
            400
        );
        assert_eq!(
            f.request(
                &format!("/api/sites/{site}/breakdown?dimension=owner_id"),
                "GET",
                None
            )
            .await
            .0,
            400
        );
    });
}
#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn atomic_ingestion_deduplicates_and_preserves_fractional_budgets() {
    fixture!(f, {
        f.pro().await;
        let site = f.site().await;
        let event = f.event(site);
        let mut tasks = vec![];
        for _ in 0..8 {
            let state = f.state.clone();
            let event = event.clone();
            tasks.push(tokio::spawn(async move {
                ingest::ingest(&state, &event, Utc::now()).await.unwrap()
            }));
        }
        let mut inserted = 0;
        for task in tasks {
            inserted += task.await.unwrap() as i32;
        }
        assert_eq!(inserted, 1);
        let usage = billing::account_usage(&f.state, &f.user).await.unwrap();
        assert_eq!(usage["events"]["used"], 1.0);
        let (status, summary, _) = f
            .request(&format!("/api/sites/{site}/overview"), "GET", None)
            .await;
        assert_eq!(status, 200);
        assert_eq!(summary["pageviews"], 1);
        assert_eq!(summary["dailyUniqueVisitors"], 1);
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM billing_outbox WHERE owner_id=$1")
                .bind(&f.user)
                .fetch_one(&f.state.db)
                .await
                .unwrap();
        assert_eq!(count, 1);
        sqlx::query("UPDATE sites SET credit_budget=1.5 WHERE id=$1")
            .bind(site)
            .execute(&f.state.db)
            .await
            .unwrap();
        let mut event = f.event(site);
        event.event_type = "event".into();
        event.name = "signup".into();
        assert!(ingest::ingest(&f.state, &event, Utc::now()).await.unwrap());
        assert!(
            !ingest::ingest(&f.state, &f.event(site), Utc::now())
                .await
                .unwrap()
        );
        assert_eq!(
            billing::account_usage(&f.state, &f.user).await.unwrap()["websites"][0]["pauseReason"],
            "website_budget"
        );
        assert_eq!(
            f.request(&format!("/api/sites/{site}"), "DELETE", None)
                .await
                .0,
            204
        );
        assert_eq!(
            billing::account_usage(&f.state, &f.user).await.unwrap()["events"]["used"],
            1.5,
            "deletion must not reset quota"
        );
    });
}
#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn concurrent_website_creation_and_account_allowances_are_serialized() {
    fixture!(f, {
        f.pro().await;
        let mut tasks = vec![];
        for i in 0..13 {
            let state = f.state.clone();
            let owner = f.user.clone();
            tasks.push(tokio::spawn(async move {
                analytics_services::sites::create(
                    &state,
                    &owner,
                    json!({"name":format!("Site {i}"),"domain":format!("site{i}.example.com")}),
                )
                .await
            }));
        }
        let mut created = 0;
        let mut rejected = 0;
        for task in tasks {
            match task.await.unwrap() {
                Ok(_) => created += 1,
                Err(e) => {
                    assert_eq!(e.code, "site_limit");
                    rejected += 1;
                }
            }
        }
        assert_eq!((created, rejected), (10, 3));
        let site: Uuid =
            sqlx::query_scalar("SELECT id FROM sites WHERE owner_id=$1 ORDER BY id LIMIT 1")
                .bind(&f.user)
                .fetch_one(&f.state.db)
                .await
                .unwrap();
        let usage = billing::account_usage(&f.state, &f.user).await.unwrap();
        let start: chrono::DateTime<Utc> =
            usage["period"]["start"].as_str().unwrap().parse().unwrap();
        let end: chrono::DateTime<Utc> = usage["period"]["end"].as_str().unwrap().parse().unwrap();
        sqlx::query("INSERT INTO billing_usage(owner_id,site_id,period_start,period_end,events) VALUES($1,$2,$3,$4,99999)").bind(&f.user).bind(site).bind(start).bind(end).execute(&f.state.db).await.unwrap();
        let mut tasks = vec![];
        for _ in 0..6 {
            let state = f.state.clone();
            let event = f.event(site);
            tasks.push(tokio::spawn(async move {
                ingest::ingest(&state, &event, Utc::now()).await.unwrap()
            }));
        }
        let mut count = 0;
        for task in tasks {
            count += task.await.unwrap() as i32;
        }
        assert_eq!(count, 1);
        assert_eq!(
            billing::account_usage(&f.state, &f.user).await.unwrap()["events"]["used"],
            100000.0
        );
    });
}
#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn collection_preserves_consent_privacy_policy_and_abuse_boundaries() {
    fixture!(f, {
        f.pro().await;
        let site = f.site().await;
        let base = json!({"siteId":site,"id":Uuid::new_v4(),"type":"pageview","url":"https://example.com/pricing?private=yes#secret","referrer":"https://search.example/?private=yes"});
        let endpoint = "/api/collect";
        let origin = [("origin", "https://example.com")];
        assert_eq!(f.request(endpoint, "POST", Some(base.clone())).await.0, 403);
        let (status, body, headers) = f
            .request_headers(endpoint, "POST", Some(base.clone()), &origin)
            .await;
        assert_eq!(status, 202, "{body}");
        assert_eq!(body["accepted"], true);
        assert_eq!(headers["access-control-allow-origin"], "*");
        let queued = f.queued().await;
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].path, "/pricing");
        assert_eq!(queued[0].referrer, "search.example");
        assert_eq!(queued[0].country, "");
        let mut body = base.clone();
        body["properties"] = json!({"email":"private"});
        assert_eq!(
            f.request_headers(endpoint, "POST", Some(body), &origin)
                .await
                .0,
            400
        );
        let (_, body, _) = f
            .request_headers(
                endpoint,
                "POST",
                Some(base.clone()),
                &[("origin", "https://example.com"), ("dnt", "1")],
            )
            .await;
        assert_eq!(body["reason"], "excluded");
        let details = json!({"viewportWidth":1000,"viewportHeight":800,"screenWidth":1000,"screenHeight":800,"language":"en"});
        let mut session = base.clone();
        session["session"] = json!({"consent":true,"visitorId":Uuid::new_v4(),"sessionId":Uuid::new_v4(),"kind":"pageview","details":details});
        assert_eq!(
            f.request_headers(endpoint, "POST", Some(session.clone()), &origin)
                .await
                .1["error"]["code"],
            "tracking_mode_mismatch"
        );
        let mut settings = analytics_services::tracking::settings(&json!({}));
        settings["country"] = json!(false);
        settings["dimensions"] = json!(false);
        assert_eq!(
            f.request(
                &format!("/api/sites/{site}/environments/{site}"),
                "PATCH",
                Some(json!({"trackingMode":"sessions","trackingSettings":settings}))
            )
            .await
            .0,
            200
        );
        session["id"] = json!(Uuid::new_v4());
        assert_eq!(
            f.request_headers(endpoint, "POST", Some(session.clone()), &origin)
                .await
                .1["accepted"],
            true
        );
        session["session"]["consent"] = json!(false);
        assert_eq!(
            f.request_headers(endpoint, "POST", Some(session), &origin)
                .await
                .0,
            400
        );
        let queued = f.queued().await;
        assert_eq!(queued.len(), 2);
        assert_eq!(
            queued[1].activity.as_ref().unwrap().details.viewport_width,
            0
        );
        assert_eq!(
            f.request_headers(endpoint, "POST", Some(base), &origin)
                .await
                .1["error"]["code"],
            "tracking_mode_mismatch"
        );
    });
}
#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn session_journeys_merge_raw_and_rich_events_without_double_counting() {
    fixture!(f, {
        f.pro().await;
        let site = f.site().await;
        let event = f.event(site);
        assert!(ingest::ingest(&f.state, &event, Utc::now()).await.unwrap());
        let mut rich = serde_json::to_value(f.event(site)).unwrap();
        rich["version"] = json!(3);
        rich["environmentId"] = json!(site);
        rich["type"] = json!("event");
        rich["name"] = json!("click");
        rich["activity"] = json!({"sessionKey":"b".repeat(64),"visitorKey":"c".repeat(64),"kind":"click","browser":"Chrome","os":"macOS","details":{"viewportWidth":1000,"viewportHeight":800,"screenWidth":1000,"screenHeight":800,"language":"da","sequence":1,"clientTime":Utc::now().timestamp_millis()}});
        let rich: Event = serde_json::from_value(rich).unwrap();
        assert!(ingest::ingest(&f.state, &rich, Utc::now()).await.unwrap());
        let mut heartbeat = rich.clone();
        heartbeat.id = Uuid::new_v4();
        let a = heartbeat.activity.as_mut().unwrap();
        a.kind = "engagement".into();
        a.details.active_seconds = Some(15);
        assert!(
            ingest::ingest(&f.state, &heartbeat, Utc::now())
                .await
                .unwrap()
        );
        let (status, report, _) = f
            .request(&format!("/api/sites/{site}/sessions"), "GET", None)
            .await;
        assert_eq!(status, 200, "{report}");
        assert_eq!(report["summary"]["sessions"], 2);
        assert_eq!(report["summary"]["clicks"], 1);
        assert_eq!(report["summary"]["averageActiveSeconds"], 8);
        let (status, detail, _) = f
            .request(
                &format!("/api/sites/{site}/sessions?session={}", "b".repeat(64)),
                "GET",
                None,
            )
            .await;
        assert_eq!(status, 200, "{detail}");
        assert_eq!(detail["events"].as_array().unwrap().len(), 1);
        assert_eq!(detail["events"][0]["kind"], "click");
        let (_, overview, _) = f
            .request(&format!("/api/sites/{site}/overview"), "GET", None)
            .await;
        assert_eq!(overview["customEvents"], 1);
        assert_eq!(
            billing::account_usage(&f.state, &f.user).await.unwrap()["events"]["used"],
            1.5
        );
    });
}
#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn source_counters_remain_exact_under_concurrent_requests() {
    fixture!(f, {
        let site = f.site().await;
        let now = Utc::now();
        let mut tasks = vec![];
        for _ in 0..25 {
            let state = f.state.clone();
            tasks.push(tokio::spawn(async move {
                abuse::guard(&state, site, "same-source", "same-signature", true, now)
                    .await
                    .unwrap()
            }));
        }
        let results = futures_util::future::join_all(tasks).await;
        let mut blocked = 0;
        for result in results {
            blocked += result.unwrap().is_some() as usize;
        }
        assert_eq!(blocked, 5);
        let report = abuse::summary(&f.state, &f.user).await.unwrap();
        assert_eq!(report["blocked"], 5);
        assert_eq!(report["learning"], 1);
    });
}

#[derive(Default)]
struct ProviderData {
    customer: Option<Value>,
    checkouts: HashMap<String, Value>,
    ingested: Vec<Value>,
    partial_delivery: bool,
    duplicate_delivery: bool,
    created: usize,
    portals: usize,
}
struct MockProvider {
    url: String,
    data: Arc<tokio::sync::Mutex<ProviderData>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for MockProvider {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl MockProvider {
    async fn start() -> Self {
        let data = Arc::new(tokio::sync::Mutex::new(ProviderData::default()));
        let app = axum::Router::new()
            .fallback(axum::routing::any(mock_provider))
            .with_state(data.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self { url, data, task }
    }
    fn state(&self, f: &Fixture) -> State {
        let mut state = f.state.clone();
        let mut config = (*state.config).clone();
        config.autumn_key = Some("test-token".into());
        config.autumn_url = self.url.clone();
        state.config = Arc::new(config);
        state
    }
}
async fn mock_provider(
    axum::extract::State(data): axum::extract::State<Arc<tokio::sync::Mutex<ProviderData>>>,
    request: axum::extract::Request,
) -> (StatusCode, axum::Json<Value>) {
    let path = request.uri().path().to_owned();
    assert_eq!(request.headers()["x-api-version"], "2.2");
    let retry_key = request
        .headers()
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let bytes = to_bytes(request.into_body(), 1024 * 1024).await.unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let mut data = data.lock().await;
    let response = match path.as_str() {
        "/v1/customers.get" => match data.customer.clone() {
            Some(c) => c,
            None => {
                return (
                    StatusCode::NOT_FOUND,
                    axum::Json(json!({"code":"customer_not_found"})),
                );
            }
        },
        "/v1/customers.get_or_create" => {
            let c = json!({"id":body["customer_id"],"subscriptions":[],"flags":{},"balances":{}});
            data.customer = Some(c.clone());
            c
        }
        "/v1/billing.open_customer_portal" => {
            data.portals += 1;
            json!({"url":"https://billing.example/portal"})
        }
        "/v1/billing.attach" => {
            assert_eq!(body["redirect_mode"], "always");
            assert_eq!(
                body["checkout_session_params"]["managed_payments"]["enabled"],
                true
            );
            data.created += 1;
            data.checkouts
                .insert(body["plan_id"].as_str().unwrap().into(), body.clone());
            json!({"payment_url":format!("https://billing.example/checkout/{}",body["plan_id"].as_str().unwrap())})
        }
        "/v1/balances.track" => {
            data.ingested.push(json!({"key":retry_key,"body":body}));
            if data.duplicate_delivery {
                return (
                    StatusCode::CONFLICT,
                    axum::Json(json!({"code":"duplicate_idempotency_key"})),
                );
            }
            if data.partial_delivery {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    axum::Json(json!({"code":"unavailable"})),
                );
            }
            json!({"customer_id":body["customer_id"],"value":body["value"]})
        }
        _ => panic!("Unexpected Autumn request {path}"),
    };
    (StatusCode::OK, axum::Json(response))
}
fn autumn_customer(owner: &str) -> Value {
    json!({"id":owner,"balances":{"events":{"feature_id":"events","granted":100000,"remaining":100000,"usage":0,"unlimited":false},"websites":{"feature_id":"websites","granted":10,"unlimited":false}},"flags":{"analytics":{"feature_id":"analytics"}},"subscriptions":[{"id":"subscription","plan_id":"basic","plan":{"name":"Basic"},"status":"active","past_due":false,"current_period_start":(Utc::now()-Duration::days(1)).timestamp_millis(),"current_period_end":(Utc::now()+Duration::days(29)).timestamp_millis(),"trial_ends_at":null,"canceled_at":null,"expires_at":null}]})
}
#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn autumn_checkout_always_requires_hosted_confirmation_and_supports_annual_plans() {
    fixture!(f, {
        let mock = MockProvider::start().await;
        let state = mock.state(&f);
        let owner = auth::require(
            &state,
            &axum::http::HeaderMap::from_iter([(
                axum::http::header::COOKIE,
                f.cookie.parse().unwrap(),
            )]),
        )
        .await
        .unwrap()
        .user;
        for (events, interval, id) in [
            (100000, "month", "basic"),
            (1000000, "year", "pro_annual"),
            (5000000, "month", "ultra"),
        ] {
            let response = billing::provider::handle(
                &state,
                &owner,
                "checkout",
                "POST",
                json!({"events":events,"interval":interval,"locale":"da"}),
            )
            .await
            .unwrap();
            assert!(response["url"].as_str().unwrap().ends_with(id));
            let data = mock.data.lock().await;
            assert_eq!(data.checkouts[id]["customer_id"], f.user);
            assert_eq!(
                data.checkouts[id]["checkout_session_params"]["locale"],
                "da"
            );
        }
        for (locale, currency) in [("en", "usd"), ("da", "dkk"), ("de", "eur")] {
            let before = mock.data.lock().await.created;
            for _ in 0..2 {
                billing::provider::handle(
                    &state,
                    &owner,
                    "checkout",
                    "POST",
                    json!({"events":100000,"interval":"month","locale":locale}),
                )
                .await
                .unwrap();
            }
            let data = mock.data.lock().await;
            assert_eq!(
                data.created,
                before + 1,
                "same options reuse a session, changed locale creates one"
            );
            assert_eq!(data.checkouts["basic"]["currency"], currency);
            assert_eq!(
                data.checkouts["basic"]["checkout_session_params"]["currency"],
                currency
            );
            assert_eq!(
                data.checkouts["basic"]["checkout_session_params"]["managed_payments"]["enabled"],
                true
            );
        }
        mock.data.lock().await.customer = Some(autumn_customer(&f.user));
        assert_eq!(
            billing::provider::ensure_deletable(&state, &f.user)
                .await
                .unwrap_err()
                .code,
            "cancel_subscription_first"
        );
        mock.data.lock().await.customer.as_mut().unwrap()["subscriptions"][0]["canceled_at"] =
            json!(Utc::now().timestamp_millis());
        billing::provider::ensure_deletable(&state, &f.user)
            .await
            .unwrap();
        let portal = billing::provider::handle(&state, &owner, "portal", "POST", Value::Null)
            .await
            .unwrap();
        assert_eq!(portal["url"], "https://billing.example/portal");
    });
}
#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn autumn_refresh_revokes_access_and_stale_or_foreign_snapshots_fail_closed() {
    fixture!(f, {
        let mock = MockProvider::start().await;
        let state = mock.state(&f);
        mock.data.lock().await.customer = Some(autumn_customer(&f.user));
        let mut conn = state.db.acquire().await.unwrap();
        billing::provider::sync(&state, &mut conn, &f.user)
            .await
            .unwrap();
        assert!(
            billing::usage::usage(&mut conn, &f.user, Utc::now())
                .await
                .unwrap()["plan"]
                .is_object()
        );
        sqlx::query(
            "UPDATE billing_customers SET updated_at=now()-interval '6 minutes' WHERE owner_id=$1",
        )
        .bind(&f.user)
        .execute(&mut *conn)
        .await
        .unwrap();
        assert!(
            billing::usage::usage(&mut conn, &f.user, Utc::now())
                .await
                .unwrap()["plan"]
                .is_null()
        );
        mock.data.lock().await.customer = Some(autumn_customer("different-owner"));
        assert_eq!(
            billing::provider::sync(&state, &mut conn, &f.user)
                .await
                .unwrap_err()
                .code,
            "invalid_billing_customer"
        );
        mock.data.lock().await.customer = Some(autumn_customer(&f.user));
        mock.data.lock().await.customer.as_mut().unwrap()["subscriptions"] = json!([]);
        billing::provider::sync(&state, &mut conn, &f.user)
            .await
            .unwrap();
        assert!(
            billing::usage::usage(&mut conn, &f.user, Utc::now())
                .await
                .unwrap()["plan"]
                .is_null()
        );
        assert_eq!(
            f.request("/api/webhooks/polar", "POST", Some(json!({})))
                .await
                .0,
            404
        );
    });
}
#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn autumn_outbox_preserves_quantities_and_stable_retry_ids() {
    fixture!(f, {
        f.pro().await;
        let site = f.site().await;
        ingest::ingest(&f.state, &f.event(site), Utc::now())
            .await
            .unwrap();
        let mock = MockProvider::start().await;
        let state = mock.state(&f);
        mock.data.lock().await.partial_delivery = true;
        assert_eq!(billing::delivery::deliver(&state).await.unwrap(), 0);
        let first = mock.data.lock().await.ingested[0].clone();
        assert_eq!(first["body"]["value"], 1.0);
        assert_eq!(first["body"]["feature_id"], "events");
        assert!(!first.to_string().contains("visitor"));
        sqlx::query("UPDATE billing_outbox SET available_at=now() WHERE owner_id=$1")
            .bind(&f.user)
            .execute(&state.db)
            .await
            .unwrap();
        mock.data.lock().await.partial_delivery = false;
        mock.data.lock().await.duplicate_delivery = true;
        assert_eq!(billing::delivery::deliver(&state).await.unwrap(), 1);
        assert_eq!(first, mock.data.lock().await.ingested[1]);
        let remaining: i64 =
            sqlx::query_scalar("SELECT count(*) FROM billing_outbox WHERE owner_id=$1")
                .bind(&f.user)
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(remaining, 0);
        // Legacy writes and keys past the safe retry window must never reach Autumn.
        sqlx::query("INSERT INTO billing_outbox(owner_id,event_type,event_count,occurred_at) VALUES($1,'pageview',1,now())")
            .bind(&f.user).execute(&state.db).await.unwrap();
        sqlx::query("INSERT INTO billing_outbox(owner_id,event_type,event_count,occurred_at,provider,delivery_started_at) VALUES($1,'pageview',1,now(),'autumn',now()-interval '24 hours')")
            .bind(&f.user).execute(&state.db).await.unwrap();
        assert_eq!(billing::delivery::deliver(&state).await.unwrap(), 0);
        assert_eq!(mock.data.lock().await.ingested.len(), 2);
        let retained: i64 =
            sqlx::query_scalar("SELECT count(*) FROM billing_outbox WHERE owner_id=$1")
                .bind(&f.user)
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(retained, 2);
    });
}
#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn trusted_proxy_country_preferences_and_static_fallbacks() {
    fixture!(f, {
        let mut state = f.state.clone();
        let mut config = (*state.config).clone();
        config.railway = true;
        state.config = Arc::new(config);
        let request = Request::builder()
            .uri("/api/preferences")
            .header("cf-ipcountry", "DK")
            .header("cf-connecting-ip", "203.0.113.5")
            .header("x-real-ip", "198.51.100.1")
            .header("x-analytics-origin-key", "test-origin-verification-secret")
            .body(Body::empty())
            .unwrap();
        let response = http::router(state.clone(), Arc::new(AtomicBool::new(true)))
            .oneshot(request)
            .await
            .unwrap();
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 8192).await.unwrap()).unwrap();
        assert_eq!(body["locale"], "da");
        assert_eq!(
            f.request_headers(
                "/api/preferences",
                "GET",
                None,
                &[("cf-ipcountry", "DK"), ("x-analytics-country", "DK")]
            )
            .await
            .1["locale"],
            "en"
        );
        assert_eq!(
            f.request_headers(
                "/api/preferences",
                "GET",
                None,
                &[("cookie", "ab-language=de; ab-theme=dark")]
            )
            .await
            .1,
            json!({"locale":"de","theme":"dark"})
        );
        for path in [
            "/api/does-not-exist",
            "/assets/missing.js",
            "/media/missing.webp",
            "/unknown-page",
            "/%2eenv",
            "/public%5csecret",
        ] {
            assert_eq!(f.request(path, "GET", None).await.0, 404, "{path}");
        }
        assert_eq!(f.request("/signin", "GET", None).await.0, 200);
        assert_eq!(f.request("/dashboard", "GET", None).await.0, 200);
        assert_eq!(f.request("/api/collect", "OPTIONS", None).await.0, 204);
    });
}
#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn redis_workers_recover_abandoned_deliveries_and_quarantine_invalid_envelopes() {
    fixture!(f, {
        f.pro().await;
        let site = f.site().await;
        let event = f.event(site);
        queue::initialize(&f.state).await.unwrap();
        queue::enqueue(&f.state, &event).await.unwrap();
        let mut redis = f.state.redis.clone();
        let reply: redis::streams::StreamReadReply = redis::cmd("XREADGROUP")
            .arg("GROUP")
            .arg(queue::GROUP)
            .arg("crashed-worker")
            .arg("COUNT")
            .arg(1)
            .arg("STREAMS")
            .arg(queue::stream(&f.state))
            .arg(">")
            .query_async(&mut redis)
            .await
            .unwrap();
        let message = &reply.keys[0].ids[0].id;
        // Simulate a process dying after committing to PostgreSQL but before acknowledging Redis.
        assert!(ingest::ingest(&f.state, &event, Utc::now()).await.unwrap());
        let _: redis::Value = redis::cmd("XCLAIM")
            .arg(queue::stream(&f.state))
            .arg(queue::GROUP)
            .arg("crashed-worker")
            .arg(0)
            .arg(message)
            .arg("IDLE")
            .arg(61000)
            .query_async(&mut redis)
            .await
            .unwrap();
        let _: String = redis::cmd("XADD")
            .arg(queue::stream(&f.state))
            .arg("*")
            .arg("data")
            .arg("invalid envelope")
            .query_async(&mut redis)
            .await
            .unwrap();
        let jobs = analytics_server::jobs::Jobs::start_events(f.state.clone())
            .await
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            let count: i64 = redis::cmd("XLEN")
                .arg(queue::stream(&f.state))
                .query_async(&mut redis)
                .await
                .unwrap();
            if count == 0 {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "workers failed to recover pending messages"
            );
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        jobs.close().await;
        assert_eq!(
            billing::account_usage(&f.state, &f.user).await.unwrap()["events"]["used"],
            1.0
        );
        let failed: i64 = redis::cmd("XLEN")
            .arg(format!("{}:failed", queue::stream(&f.state)))
            .query_async(&mut redis)
            .await
            .unwrap();
        assert_eq!(failed, 1);
    });
}

#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn autumn_customer_overrides_control_usage_admission_and_ingestion() {
    fixture!(f, {
        let site = f.site().await;
        let mock = MockProvider::start().await;
        let state = mock.state(&f);
        let mut customer = autumn_customer(&f.user);
        customer["subscriptions"][0]["plan_id"] = json!("bespoke-customer-plan");
        customer["subscriptions"][0]["plan"]["name"] = json!("Customer Special");
        customer["balances"]["events"]["granted"] = json!(10000000);
        customer["balances"]["events"]["usage"] = json!(9999999);
        customer["balances"]["events"]["remaining"] = json!(1);
        customer["balances"]["websites"]["granted"] = json!(1);
        mock.data.lock().await.customer = Some(customer.clone());
        let mut conn = state.db.acquire().await.unwrap();
        billing::provider::sync(&state, &mut conn, &f.user)
            .await
            .unwrap();
        let usage = billing::usage::usage(&mut conn, &f.user, Utc::now())
            .await
            .unwrap();
        assert_eq!(usage["plan"]["name"], "Customer Special");
        assert_eq!(usage["plan"]["eventLimit"], 10000000.0);
        assert_eq!(usage["plan"]["websiteLimit"], 1);
        assert_eq!(usage["events"]["used"], 9999999.0);
        assert_eq!(
            f.request(
                "/api/sites",
                "POST",
                Some(json!({"name":"Second","domain":"second.example"}))
            )
            .await
            .0,
            409
        );
        assert!(
            ingest::ingest(&f.state, &f.event(site), Utc::now())
                .await
                .unwrap()
        );
        assert!(
            !ingest::ingest(&f.state, &f.event(site), Utc::now())
                .await
                .unwrap()
        );
        assert_eq!(
            billing::admission::load(&f.state, site, site)
                .await
                .unwrap()
                .pause_reason(site, Utc::now())
                .unwrap(),
            Some("event_limit")
        );
        // Refresh before delivery: pending local usage remains reserved exactly once.
        billing::provider::sync(&state, &mut conn, &f.user)
            .await
            .unwrap();
        let usage = billing::usage::usage(&mut conn, &f.user, Utc::now())
            .await
            .unwrap();
        assert_eq!(usage["events"]["used"], 10000000.0);
        assert_eq!(usage["events"]["remaining"], 0.0);
        assert_eq!(billing::delivery::deliver(&state).await.unwrap(), 1);
        // The provider now includes the delivery, so no pending reservation is added again.
        customer["balances"]["events"]["usage"] = json!(10000000);
        customer["balances"]["events"]["remaining"] = json!(0);
        mock.data.lock().await.customer = Some(customer.clone());
        billing::provider::sync(&state, &mut conn, &f.user)
            .await
            .unwrap();
        assert_eq!(
            billing::usage::usage(&mut conn, &f.user, Utc::now())
                .await
                .unwrap()["events"]["used"],
            10000000.0
        );
        // An operator's usage reset and increased website allowance replace the old snapshot.
        customer["balances"]["events"]["usage"] = json!(0);
        customer["balances"]["events"]["remaining"] = json!(10000000);
        customer["balances"]["websites"]["granted"] = json!(23);
        mock.data.lock().await.customer = Some(customer.clone());
        billing::provider::sync(&state, &mut conn, &f.user)
            .await
            .unwrap();
        let usage = billing::usage::usage(&mut conn, &f.user, Utc::now())
            .await
            .unwrap();
        assert_eq!(usage["events"]["used"], 0.0);
        assert_eq!(usage["plan"]["websiteLimit"], 23);
        for index in 1..=10 {
            assert_eq!(f.request("/api/sites", "POST", Some(json!({"name":format!("Extra {index}"),"domain":format!("extra-{index}.example")}))).await.0, 201);
        }
        assert!(
            ingest::ingest(&f.state, &f.event(site), Utc::now())
                .await
                .unwrap()
        );
        customer["balances"]["events"]["unlimited"] = json!(true);
        customer["balances"]["websites"]["unlimited"] = json!(true);
        mock.data.lock().await.customer = Some(customer);
        billing::provider::sync(&state, &mut conn, &f.user)
            .await
            .unwrap();
        let usage = billing::usage::usage(&mut conn, &f.user, Utc::now())
            .await
            .unwrap();
        assert!(usage["plan"]["eventLimit"].is_null());
        assert!(usage["plan"]["websiteLimit"].is_null());
        assert!(usage["events"]["remaining"].is_null());
        assert_eq!(usage["paused"], false);
    });
}

use crate::{
    AppState,
    config::{Config, Role},
    ingestion, tracking,
    workers::Workers,
};
use axum::{
    body::{Body, to_bytes},
    extract::ConnectInfo,
    http::{HeaderMap, Request, header},
};
use chrono::{Duration, Utc};
use serde_json::{Value, json};
use sqlx::Row;
use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    sync::Arc,
};
use tower::ServiceExt;
use uuid::Uuid;

fn details() -> Value {
    json!({"viewportWidth":1280,"viewportHeight":720,"screenWidth":1920,"screenHeight":1080,"language":"da","x":42,"y":13,"destination":"https://other.example.test/path?secret=private#fragment"})
}

async fn request(
    state: &AppState,
    path: &str,
    value: Option<Value>,
    authorization: Option<&str>,
) -> (u16, HeaderMap, Value) {
    let mut builder = Request::builder()
        .method(if value.is_some() { "POST" } else { "GET" })
        .uri(path)
        .header(header::ORIGIN, "https://collector.example.test")
        .header(header::CONTENT_TYPE, "text/plain")
        .header(header::USER_AGENT, "Mozilla/5.0 (Macintosh) Chrome/129.0")
        .extension(ConnectInfo(
            "127.0.0.99:4200".parse::<SocketAddr>().unwrap(),
        ));
    if let Some(auth) = authorization {
        builder = builder.header(header::AUTHORIZATION, auth);
    }
    let response = crate::router(state.clone())
        .oneshot(
            builder
                .body(value.map_or(Body::empty(), |v| Body::from(v.to_string())))
                .unwrap(),
        )
        .await
        .unwrap();
    let (parts, body) = response.into_parts();
    let bytes = to_bytes(body, 64 * 1024).await.unwrap();
    let value =
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes)));
    (parts.status.as_u16(), parts.headers, value)
}

#[test]
fn visitor_hashes_match_the_previous_json_hmac_and_tracking_policy() {
    // Fixture also checked against the original Bun normalize implementation.
    let site = "00000000-0000-4000-8000-000000000001";
    let body = json!({"siteId":site,"id":"00000000-0000-4000-8000-000000000002","type":"pageview","url":"https://collector.example.test/path?private=1#hash","activity":{"kind":"pageview","details":details()}});
    let mut headers = HeaderMap::new();
    headers.insert("origin", "https://collector.example.test".parse().unwrap());
    headers.insert("user-agent", "Mozilla/5.0 Chrome/129".parse().unwrap());
    headers.insert("x-datix-client-ip", "192.0.2.1".parse().unwrap());
    let now = "2026-09-14T12:00:00Z".parse().unwrap();
    let event = tracking::normalize(
        serde_json::from_value(body.clone()).unwrap(),
        &headers,
        "DK",
        "fixture-secret",
        tracking::Environment {
            domain: "collector.example.test",
            allow_localhost: false,
            tracking_mode: "cookieless",
            tracking_settings: &json!({}),
        },
        now,
    )
    .unwrap()
    .unwrap();
    assert_eq!(event.path, "/path");
    assert_eq!(
        event.visitor,
        "07da8e65b265889e42b8d88fe4b6733f11ef72b07aaebd868972a5dd796c0063"
    );
    assert_eq!(
        json!(event.activity)["details"]["destination"],
        "https://other.example.test/path"
    );
    assert_eq!(tracking::units(&event), 100);
    let stripped = tracking::apply_policy(
        event,
        &json!({"device":false,"dimensions":false,"coordinates":false,"language":false}),
    )
    .unwrap();
    assert_eq!(stripped.device, "");
    assert_eq!(json!(stripped.activity)["details"]["viewportWidth"], 0);
    assert_eq!(json!(stripped.activity)["details"]["x"], Value::Null);
    let mut invalid = body;
    invalid["activity"]["details"]["unknown"] = json!(true);
    assert!(serde_json::from_value::<tracking::Input>(invalid).is_err());
}

#[tokio::test]
#[ignore = "Requires DATIX_TEST_ENV and isolated Rust Neon branch plus a unique Redis queue prefix"]
async fn receipts_policy_changes_telemetry_recovery_and_worker_lifecycle() {
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(std::env::var("DATIX_TEST_ENV").expect("DATIX_TEST_ENV required"));
    let env: HashMap<_, _> = dotenvy::from_path_iter(file)
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let target = datix_db::identity(&env["DATABASE_URL"]).unwrap();
    assert_eq!(
        target.host,
        "ep-sweet-sun-b1ynkxmz-pooler.c-5.eu-central-1.aws.neon.tech"
    );
    assert_eq!(target.database, "datix");
    let nonce = Uuid::new_v4();
    let owner = format!("rust-ingest-{nonce}");
    let site = Uuid::new_v4();
    let config = Config {
        app_url: "http://localhost:3000".into(),
        database_url: env["DATABASE_URL"].clone(),
        redis_url: env["REDIS_URL"].clone(),
        auth_secret: "fixture-secret-at-least-32-characters".into(),
        visitor_secret: "fixture-visitor-secret-at-least-32-characters".into(),
        queue_prefix: format!("test-rust-ingest-{nonce}"),
        port: 3001,
        max_connections: 4,
        external_effects: false,
        cloudflare_origin_secret: None,
        metrics_token: Some("fixture-metrics".into()),
        admin_emails: HashSet::new(),
        role: Role::Api,
        workers: 1,
        batch_size: 64,
    };
    let mut state = AppState::connect(config).await.unwrap();
    sqlx::query("INSERT INTO public.\"user\"(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Ingestion fixture',$2,true,now(),now())").bind(&owner).bind(format!("{owner}@example.test")).execute(&state.pool).await.unwrap();
    sqlx::query("INSERT INTO sites(id,owner_id,name,domain) VALUES($1,$2,'Collector','collector.example.test')").bind(site).bind(&owner).execute(&state.pool).await.unwrap();
    let input = json!({"siteId":site,"id":Uuid::new_v4(),"type":"pageview","url":"https://collector.example.test/path?private=1","activity":{"kind":"pageview","details":details()}});
    let (status, headers, rejected) =
        request(&state, "/api/collect", Some(input.clone()), None).await;
    assert_eq!(status, 202, "{rejected}");
    assert_eq!(headers["access-control-allow-origin"], "*");
    assert_eq!(rejected["reason"], "subscription_required");
    let start = Utc::now() - Duration::days(1);
    let end = Utc::now() + Duration::days(29);
    let subscriptions = json!([{"status":"active","currentPeriodEnd":end,"entitlements":{"name":"Fixture","eventLimit":10000,"websiteLimit":10,"used":0,"remaining":10000,"localBaseline":0,"pending":0,"periodStart":start,"periodEnd":end}}]);
    sqlx::query("INSERT INTO billing_customers(customer_id,owner_id,organization_id,subscriptions,occurred_at) VALUES($1,$2,$3,$4,now())").bind(&owner).bind(&owner).bind(state.billing.organization_id()).bind(subscriptions).execute(&state.pool).await.unwrap();
    sqlx::query("UPDATE environments SET feature_settings=$1 WHERE id=$2")
        .bind(json!({"goals":true,"errors":true,"webVitals":true}))
        .bind(site)
        .execute(&state.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO conversion_goals(environment_id,name,match_type,match_value) VALUES($1,'Visit','page','/path')").bind(site).execute(&state.pool).await.unwrap();
    let (first, second) = tokio::join!(
        request(&state, "/api/collect", Some(input.clone()), None),
        request(&state, "/api/collect", Some(input.clone()), None)
    );
    assert_eq!(first.2, json!({"accepted":true}), "{}", first.2);
    assert_eq!(second.2, json!({"accepted":true}));
    let reserved: i64 = sqlx::query_scalar(
        "SELECT (events*100)::bigint FROM billing_organization_usage WHERE owner_id=$1",
    )
    .bind(&owner)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(reserved, 100);
    sqlx::query("UPDATE environments SET tracking_settings=$1 WHERE id=$2")
        .bind(json!({"device":false,"dimensions":false,"coordinates":false,"language":false}))
        .bind(site)
        .execute(&state.pool)
        .await
        .unwrap();
    ingestion::deliver(&state, &owner, 64).await.unwrap();
    ingestion::deliver(&state, &owner, 64).await.unwrap();
    let row = sqlx::query("SELECT device,details FROM activity_events WHERE environment_id=$1")
        .bind(site)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("device"), "");
    assert_eq!(row.get::<Value, _>("details")["viewportWidth"], 0);
    let counts:(i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM events WHERE site_id=$1),(SELECT count(*) FROM billing_outbox WHERE owner_id=$2),(SELECT count(*) FROM goal_conversions WHERE environment_id=$1)").bind(site).bind(&owner).fetch_one(&state.pool).await.unwrap();
    assert_eq!(counts, (1, 1, 1));
    let mut cancelled = input.clone();
    cancelled["id"] = json!(Uuid::new_v4());
    assert_eq!(
        request(&state, "/api/collect", Some(cancelled), None)
            .await
            .2["accepted"],
        true
    );
    sqlx::query("UPDATE environments SET enabled=false WHERE id=$1")
        .bind(site)
        .execute(&state.pool)
        .await
        .unwrap();
    ingestion::deliver(&state, &owner, 64).await.unwrap();
    let reserved: i64 = sqlx::query_scalar(
        "SELECT (events*100)::bigint FROM billing_organization_usage WHERE owner_id=$1",
    )
    .bind(&owner)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(reserved, 100);
    sqlx::query("UPDATE environments SET enabled=true WHERE id=$1")
        .bind(site)
        .execute(&state.pool)
        .await
        .unwrap();

    let diagnostic = json!({"siteId":site,"environmentId":site,"id":Uuid::new_v4(),"pageId":Uuid::new_v4(),"url":"https://collector.example.test/path","kind":"vital","payload":{"name":"LCP","value":2000},"consent":true});
    assert_eq!(
        request(&state, "/api/telemetry", Some(diagnostic.clone()), None)
            .await
            .2["accepted"],
        true
    );
    assert_eq!(state.queue.counts().await.unwrap(), (1, 0, 0));
    // Simulate a consumer disappearing after delivery but before acknowledgment.
    let claimed: redis::streams::StreamReadReply = redis::cmd("XREADGROUP")
        .arg("GROUP")
        .arg("datix-rust-v1")
        .arg("crashed-fixture")
        .arg("COUNT")
        .arg(1)
        .arg("STREAMS")
        .arg(state.queue.key())
        .arg(">")
        .query_async(&mut state.redis.clone())
        .await
        .unwrap();
    let entry = &claimed.keys[0].ids[0];
    crate::diagnostics::ingest(
        &state,
        serde_json::from_str(&entry.get::<String>("payload").unwrap()).unwrap(),
    )
    .await
    .unwrap();
    let _: redis::Value = redis::cmd("XCLAIM")
        .arg(state.queue.key())
        .arg("datix-rust-v1")
        .arg("crashed-fixture")
        .arg(0)
        .arg(&entry.id)
        .arg("IDLE")
        .arg(120_001)
        .query_async(&mut state.redis.clone())
        .await
        .unwrap();
    state
        .queue
        .consume(&state, "recovered-fixture", &mut "0-0".to_owned())
        .await
        .unwrap();
    assert_eq!(state.queue.counts().await.unwrap(), (0, 0, 0));
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM diagnostic_events WHERE environment_id=$1")
            .bind(site)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(count, 1);
    let mut revised = diagnostic.clone();
    revised["payload"]["value"] = json!(1500);
    assert_eq!(
        request(&state, "/api/telemetry", Some(revised), None)
            .await
            .2["accepted"],
        true
    );
    state
        .queue
        .consume(&state, "recovered-fixture", &mut "0-0".to_owned())
        .await
        .unwrap();
    let value: Value =
        sqlx::query_scalar("SELECT payload FROM diagnostic_events WHERE environment_id=$1")
            .bind(site)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(value["value"].as_f64(), Some(1500.0));
    sqlx::query("UPDATE environments SET tracking_mode='sessions' WHERE id=$1")
        .bind(site)
        .execute(&state.pool)
        .await
        .unwrap();
    let mut without_consent = diagnostic;
    without_consent["id"] = json!(Uuid::new_v4());
    without_consent["consent"] = json!(false);
    assert_eq!(
        request(&state, "/api/telemetry", Some(without_consent), None)
            .await
            .2["accepted"],
        true
    );
    state
        .queue
        .consume(&state, "recovered-fixture", &mut "0-0".to_owned())
        .await
        .unwrap();
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM diagnostic_events WHERE environment_id=$1")
            .bind(site)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(count, 1);

    assert_eq!(
        request(&state, "/internal/metrics", None, None).await.0,
        404
    );
    let metrics = request(
        &state,
        "/internal/metrics",
        None,
        Some("Bearer fixture-metrics"),
    )
    .await;
    assert_eq!(metrics.0, 200);
    assert!(metrics.2.as_str().unwrap().contains("datix_queue_jobs"));
    let mut config = (*state.config).clone();
    config.role = Role::Worker;
    state.config = Arc::new(config);
    assert_eq!(request(&state, "/health/ready", None, None).await.0, 503);
    let workers = Workers::start(state.clone());
    let mut ready = false;
    for _ in 0..50 {
        if request(&state, "/health/ready", None, None).await.0 == 200 {
            ready = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(ready);
    assert_eq!(
        request(&state, "/api/collect", Some(input), None).await.0,
        404
    );
    tokio::time::timeout(std::time::Duration::from_secs(15), workers.shutdown())
        .await
        .unwrap();
    assert_eq!(request(&state, "/health/ready", None, None).await.0, 503);
    let expired = Uuid::new_v4();
    sqlx::query("INSERT INTO diagnostic_events(environment_id,id,page_id,received_at,kind,path,device,visitor,fingerprint,payload) VALUES($1,$2,$2,now()-interval '45 days','error','/expired','','','fixture-expired',$3)")
        .bind(site).bind(expired).bind(json!({"message":"Expired fixture"})).execute(&state.pool).await.unwrap();
    crate::maintenance::retain(&state).await.unwrap();
    let expired_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM diagnostic_events WHERE environment_id=$1 AND id=$2",
    )
    .bind(site)
    .bind(expired)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(expired_count, 0);
    sqlx::query("DELETE FROM billing_customers WHERE customer_id=$1")
        .bind(&owner)
        .execute(&state.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM public.\"user\" WHERE id=$1")
        .bind(&owner)
        .execute(&state.pool)
        .await
        .unwrap();
    crate::maintenance::clean_deleted(&state).await.unwrap();
    for (table, column) in [
        ("events", "site_id"),
        ("activity_events", "environment_id"),
        ("goal_conversions", "environment_id"),
        ("diagnostic_events", "environment_id"),
        ("ingestion_receipts", "environment_id"),
        ("analytics_deletions", "environment_id"),
    ] {
        let remaining: i64 =
            sqlx::query_scalar(&format!("SELECT count(*) FROM {table} WHERE {column}=$1"))
                .bind(site)
                .fetch_one(&state.pool)
                .await
                .unwrap();
        assert_eq!(remaining, 0, "{table}");
    }
    let _: i64 = redis::cmd("DEL")
        .arg(state.queue.key())
        .arg(format!("{}:failed", state.queue.key()))
        .arg(format!(
            "{}:collect:{}",
            state.config.queue_prefix,
            tracking::hash(&state.config.visitor_secret, &json!("127.0.0.99"))
        ))
        .arg(format!(
            "{}:diagnostics:{}",
            state.config.queue_prefix,
            tracking::hash(&state.config.visitor_secret, &json!("127.0.0.99"))
        ))
        .query_async(&mut state.redis.clone())
        .await
        .unwrap();
    state.pool.close().await;
}

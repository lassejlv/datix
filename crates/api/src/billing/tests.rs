use super::{
    catalog::Catalog,
    provider::{Customer, Provider},
    *,
};
use axum::{
    Json, Router,
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use uuid::Uuid;

const SECRET: &str = "whsec_fixture-raw-utf8-not-base64";

fn signed(id: &str, body: &[u8], timestamp: i64) -> HeaderMap {
    let mut mac = Hmac::<Sha256>::new_from_slice(SECRET.as_bytes()).unwrap();
    mac.update(format!("{id}.{timestamp}.").as_bytes());
    mac.update(body);
    let mut headers = HeaderMap::new();
    headers.insert("webhook-id", id.parse().unwrap());
    headers.insert("webhook-timestamp", timestamp.to_string().parse().unwrap());
    headers.insert(
        "webhook-signature",
        format!("v1,{}", STANDARD.encode(mac.finalize().into_bytes()))
            .parse()
            .unwrap(),
    );
    headers
}

fn plan<'a>(catalog: &'a Catalog, id: &str) -> &'a catalog::Plan {
    catalog.plans.iter().find(|plan| plan.id == id).unwrap()
}

fn customer(catalog: &Catalog, owner: &str, plan: &str) -> Value {
    let plan = self::plan(catalog, plan);
    json!({"id":Uuid::new_v4(),"external_id":owner,"organization_id":catalog.organization_id,"deleted_at":null,
        "active_subscriptions":[{"id":Uuid::new_v4(),"product_id":plan.product_id,"status":"trialing","currency":catalog.currency,"recurring_interval":plan.interval,
            "current_period_start":Utc::now()-Duration::days(1),"current_period_end":Utc::now()+Duration::days(29),"trial_end":Utc::now()+Duration::days(6),"ends_at":null,"cancel_at_period_end":false}],
        "granted_benefits":[{"benefit_id":catalog.analytics_benefit_id,"benefit_type":"custom","properties":{}},
            {"benefit_id":plan.websites_benefit_id,"benefit_type":"custom","benefit_metadata":{"included":3},"properties":{}},
            {"benefit_id":plan.events_benefit_id,"benefit_type":"meter_credit","properties":{}}]})
}

#[test]
fn entitlements_require_matching_catalog_grants_and_safe_integer_credits() {
    let catalog = Catalog::load(None, false).unwrap();
    let fixture = customer(&catalog, "fixture", "free");
    let read = |value: Value| {
        operations::subscriptions(
            &serde_json::from_value::<Customer>(value).unwrap(),
            &catalog,
            Utc::now(),
        )
        .unwrap()
    };
    assert_eq!(
        read(fixture.clone())[0]["entitlements"]["eventLimit"],
        plan(&catalog, "free").events * 100
    );
    let mut value = fixture.clone();
    value["granted_benefits"][2]["properties"] =
        json!({"last_credited_meter_id":catalog.meter.id,"last_credited_units":1.23});
    assert_eq!(read(value.clone())[0]["entitlements"]["eventLimit"], 123);
    for units in [
        json!(0),
        json!(-1),
        json!(0.001),
        json!(9_007_199_254_740_992_u64),
        json!("10"),
    ] {
        value["granted_benefits"][2]["properties"]["last_credited_units"] = units;
        assert!(read(value.clone()).is_empty());
    }
    for (path, invalid) in [
        ("/organization_id", json!(Uuid::new_v4())),
        ("/active_subscriptions/0/currency", json!("eur")),
        ("/active_subscriptions/0/trial_end", Value::Null),
        ("/active_subscriptions/0/status", json!("canceled")),
        (
            "/active_subscriptions/0/current_period_end",
            json!(Utc::now() - Duration::days(1)),
        ),
        ("/granted_benefits/1/benefit_metadata/included", json!(1.5)),
    ] {
        let mut value = fixture.clone();
        *value.pointer_mut(path).unwrap() = invalid;
        if path == "/organization_id" {
            assert!(
                provider::verify_customer(
                    &serde_json::from_value(value).unwrap(),
                    "fixture",
                    &catalog
                )
                .is_err()
            );
        } else {
            assert!(read(value).is_empty(), "{path}");
        }
    }
}

#[test]
fn overage_plans_are_uncapped_and_legacy_plans_still_grant_access() {
    let catalog = Catalog::load(None, false).unwrap();
    let read = |value: Value| {
        operations::subscriptions(
            &serde_json::from_value::<Customer>(value).unwrap(),
            &catalog,
            Utc::now(),
        )
        .unwrap()
    };
    let pro = read(customer(&catalog, "fixture", "pro"));
    let entitlements = &pro[0]["entitlements"];
    assert_eq!(entitlements["eventLimit"], Value::Null);
    assert_eq!(entitlements["remaining"], Value::Null);
    assert_eq!(entitlements["includedEvents"], 50_000 * 100);
    assert_eq!(entitlements["overageUnitAmount"], "0.004");
    let free = read(customer(&catalog, "fixture", "free"));
    assert_eq!(free[0]["entitlements"]["remaining"], 15_000 * 100);
    assert_eq!(free[0]["entitlements"]["overageUnitAmount"], Value::Null);
    let legacy = read(customer(&catalog, "fixture", "legacy_ultra"));
    assert_eq!(legacy[0]["entitlements"]["eventLimit"], 5_000_000 * 100);
    // A benefit from another plan must not stand in for the plan's own website grant.
    let mut mismatched = customer(&catalog, "fixture", "free");
    mismatched["granted_benefits"][1]["benefit_id"] =
        json!(plan(&catalog, "pro").websites_benefit_id);
    assert!(read(mismatched).is_empty());
    assert!(
        catalog
            .plans
            .iter()
            .filter(|p| !p.legacy)
            .all(|p| p.interval == "month")
    );
    assert!(plan(&catalog, "free").free() && !plan(&catalog, "pro").free());
    assert_eq!(entitlements["environments"], true);
    assert_eq!(free[0]["entitlements"]["environments"], false);
    assert_eq!(legacy[0]["entitlements"]["environments"], true);
    // States stored before the flag existed belong to paid plans and keep environments.
    let stored: Entitlement = serde_json::from_value(json!({"name":"Basic","eventLimit":100,"websiteLimit":10,"used":0,"remaining":100,"localBaseline":0,"pending":0,"periodStart":Utc::now(),"periodEnd":Utc::now()})).unwrap();
    assert!(stored.environments);
    let parsed: Entitlement = serde_json::from_value(free[0]["entitlements"].clone()).unwrap();
    assert!(!parsed.environments);
}

#[derive(Clone)]
struct Mock(Arc<Mutex<MockData>>);
struct MockData {
    customer: Value,
    checkout: Value,
    statuses: Vec<Value>,
    created: Value,
    response: Value,
    fail_state: bool,
    requests: Vec<(String, Value)>,
}

async fn provider_call(State(mock): State<Mock>, request: Request) -> Response {
    assert_eq!(request.headers()["authorization"], "Bearer fixture-token");
    assert_eq!(request.headers()["polar-version"], "2026-04");
    let path = request.uri().path().to_owned();
    let method = request.method().clone();
    let body = axum::body::to_bytes(request.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let body = serde_json::from_slice::<Value>(&body).unwrap_or(Value::Null);
    let mut data = mock.0.lock().unwrap();
    data.requests.push((format!("{method} {path}"), body));
    let value = if path.ends_with("/state") {
        if data.fail_state {
            return (StatusCode::BAD_GATEWAY, "private-provider-details").into_response();
        }
        data.customer.clone()
    } else if path == "/v1/subscriptions/" && method == axum::http::Method::POST {
        data.created.clone()
    } else if path == "/v1/subscriptions/" {
        json!({"items":data.statuses,"pagination":{"max_page":1}})
    } else if path.starts_with("/v1/subscriptions/") && method == axum::http::Method::DELETE {
        let mut revoked = data.created.clone();
        revoked["status"] = json!("canceled");
        revoked
    } else if path == "/v1/customer-sessions/" {
        json!({"customer_id":data.customer["id"],"customer_portal_url":"https://polar.example.test/portal"})
    } else if path.starts_with("/v1/checkouts/") {
        data.checkout.clone()
    } else if path == "/v1/events/ingest" {
        data.response.clone()
    } else {
        panic!("Unexpected local provider path: {path}")
    };
    Json(value).into_response()
}

async fn webhook(
    billing: &Billing,
    id: &str,
    kind: &str,
    at: DateTime<Utc>,
    customer: Value,
) -> Value {
    let body = json!({"type":kind,"timestamp":at,"data":customer}).to_string();
    billing
        .webhook(
            &signed(id, body.as_bytes(), Utc::now().timestamp()),
            body.as_bytes(),
        )
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "Requires DATIX_TEST_ENV and the isolated Rust Neon branch; provider requests stay on loopback"]
async fn billing_replays_checkout_cancellation_and_outbox_recovery() {
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
    let pool = datix_db::connect_runtime(&env["DATABASE_URL"], 3)
        .await
        .unwrap();
    let owner = format!("rust-billing-{}", Uuid::new_v4());
    let mut catalog = Catalog::load(None, false).unwrap();
    catalog.organization_id = Uuid::new_v4();
    let fixture = customer(&catalog, &owner, "pro");
    let pro = plan(&catalog, "pro").clone();
    let free = plan(&catalog, "free").clone();
    let free_subscription = json!({"id":Uuid::new_v4(),"product_id":free.product_id,"customer_id":fixture["id"],"status":"active","cancel_at_period_end":false});
    let mock = Mock(Arc::new(Mutex::new(MockData {
        checkout: json!({"id":Uuid::new_v4(),"product_id":pro.product_id,"customer_id":fixture["id"],"currency":"usd","url":"https://polar.example.test/checkout","status":"open","expires_at":Utc::now()+Duration::hours(1)}),
        customer: fixture.clone(),
        statuses: vec![
            json!({"id":Uuid::new_v4(),"product_id":pro.product_id,"customer_id":fixture["id"],"status":"trialing","cancel_at_period_end":false}),
        ],
        created: free_subscription.clone(),
        response: json!({"inserted":1}),
        fail_state: false,
        requests: vec![],
    })));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = url::Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let app = Router::new()
        .fallback(provider_call)
        .with_state(mock.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let billing = Billing {
        pool: pool.clone(),
        provider: Some(Provider::local_fixture(base, &catalog)),
        catalog: Arc::new(catalog),
        enabled: true,
        webhook_secret: Some(SECRET.into()),
        app_url: "http://localhost:3000".into(),
    };
    sqlx::query("INSERT INTO public.\"user\"(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Billing fixture',$2,true,now(),now())").bind(&owner).bind(format!("{owner}@example.test")).execute(&pool).await.unwrap();
    assert!(!billing.has_customer(&owner).await.unwrap());
    billing.sync(&owner).await.unwrap();
    let mut connection = pool.acquire().await.unwrap();
    let active = allowance(&mut connection, &owner, billing.organization_id(), true)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(active.entitlement.event_limit, None);
    assert_eq!(active.entitlement.included_events, Some(pro.events * 100));
    assert!(active.entitlement.period_end < Utc::now() + Duration::days(7));
    drop(connection);
    assert_eq!(
        billing.ensure_deletable(&owner).await.unwrap_err().code,
        "cancel_subscription_first"
    );
    let selection = json!({"events":pro.events,"interval":"month","locale":"da"});
    assert_eq!(
        billing.checkout(&owner, selection.clone()).await.unwrap()["url"],
        "https://polar.example.test/portal"
    );
    mock.0.lock().unwrap().statuses[0]["cancel_at_period_end"] = json!(true);
    billing.ensure_deletable(&owner).await.unwrap();
    assert_eq!(
        billing.checkout(&owner, selection.clone()).await.unwrap()["url"],
        "https://polar.example.test/portal"
    );
    {
        let mut data = mock.0.lock().unwrap();
        data.statuses.clear();
        data.customer["active_subscriptions"] = json!([]);
    }
    for _ in 0..2 {
        assert_eq!(
            billing.checkout(&owner, selection.clone()).await.unwrap()["url"],
            "https://polar.example.test/checkout"
        );
    }
    {
        let data = mock.0.lock().unwrap();
        let requests = data
            .requests
            .iter()
            .filter(|(path, _)| path == "POST /v1/checkouts/")
            .collect::<Vec<_>>();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].1["locale"], "da");
        assert_eq!(
            requests[0].1["success_url"],
            "http://localhost:3000/dashboard?checkout_id={CHECKOUT_ID}"
        );
        assert!(requests[0].1.get("subscription_id").is_none());
    }
    // Free starts without checkout; a later paid selection upgrades that subscription.
    let started = billing
        .checkout(&owner, json!({"events":free.events,"interval":"month"}))
        .await
        .unwrap();
    assert_eq!(
        started["url"],
        format!(
            "http://localhost:3000/dashboard?checkout_id={}",
            free_subscription["id"].as_str().unwrap()
        )
    );
    mock.0.lock().unwrap().statuses = vec![free_subscription.clone()];
    assert_eq!(
        billing
            .checkout(&owner, json!({"events":free.events,"interval":"month"}))
            .await
            .unwrap()["url"],
        "https://polar.example.test/portal"
    );
    billing.checkout(&owner, selection.clone()).await.unwrap();
    {
        let data = mock.0.lock().unwrap();
        let created = data
            .requests
            .iter()
            .filter(|(path, _)| path == "POST /v1/subscriptions/")
            .collect::<Vec<_>>();
        assert_eq!(created.len(), 1);
        assert_eq!(created[0].1["product_id"], json!(free.product_id));
        let checkouts = data
            .requests
            .iter()
            .filter(|(path, _)| path == "POST /v1/checkouts/")
            .collect::<Vec<_>>();
        assert_eq!(checkouts.len(), 2);
        assert_eq!(checkouts[1].1["subscription_id"], free_subscription["id"]);
    }
    billing.ensure_deletable(&owner).await.unwrap();
    assert!(mock.0.lock().unwrap().requests.iter().any(|(path, _)| path
        == &format!(
            "DELETE /v1/subscriptions/{}",
            free_subscription["id"].as_str().unwrap()
        )));
    mock.0.lock().unwrap().statuses.clear();
    for legacy in [
        json!({"events":500000,"interval":"month"}),
        json!({"events":pro.events,"interval":"year"}),
    ] {
        assert_eq!(
            billing.checkout(&owner, legacy).await.unwrap_err().code,
            "invalid_request"
        );
    }
    mock.0.lock().unwrap().fail_state = true;
    assert_eq!(
        billing.sync(&owner).await.err().unwrap().code,
        "unavailable"
    );
    assert!(billing.has_customer(&owner).await.unwrap());
    mock.0.lock().unwrap().fail_state = false;

    // Unique organization IDs keep these workers away from any other dev fixture.
    for _ in 0..2 {
        sqlx::query("INSERT INTO billing_outbox(owner_id,event_type,event_count,occurred_at,organization_id) VALUES($1,'pageview',0.15,now(),$2)").bind(&owner).bind(billing.organization_id()).execute(&pool).await.unwrap();
    }
    billing.drain_outbox().await.unwrap();
    let (count, attempts): (i64, i64) =
        sqlx::query_as("SELECT count(*),min(attempts) FROM billing_outbox WHERE owner_id=$1")
            .bind(&owner)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!((count, attempts), (2, 1));
    sqlx::query("UPDATE billing_outbox SET available_at=now() WHERE owner_id=$1")
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    mock.0.lock().unwrap().response = json!({"inserted":1,"duplicates":1});
    billing.drain_outbox().await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM billing_outbox WHERE owner_id=$1")
        .bind(&owner)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    {
        let data = mock.0.lock().unwrap();
        let requests = data
            .requests
            .iter()
            .filter(|(path, _)| path == "POST /v1/events/ingest")
            .collect::<Vec<_>>();
        assert_eq!(requests.len(), 2);
        let ids = |body: &Value| {
            let mut ids = body["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| e["external_id"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>();
            ids.sort();
            ids
        };
        assert_eq!(ids(&requests[0].1), ids(&requests[1].1));
        assert_eq!(requests[0].1["events"][0]["metadata"]["quantity"], 0.15);
    }

    let at = Utc::now() + Duration::seconds(1);
    let event_id = format!("{owner}-current");
    let applied = webhook(
        &billing,
        &event_id,
        "customer.state_changed",
        at,
        fixture.clone(),
    )
    .await;
    assert_eq!(applied["updated"], true);
    assert_eq!(
        webhook(
            &billing,
            &event_id,
            "customer.state_changed",
            at,
            fixture.clone()
        )
        .await["duplicate"],
        true
    );
    assert_eq!(
        webhook(
            &billing,
            &format!("{owner}-old"),
            "customer.deleted",
            at - Duration::days(1),
            fixture.clone()
        )
        .await["updated"],
        false
    );
    assert!(billing.has_customer(&owner).await.unwrap());
    let mut disabled = billing.clone();
    disabled.enabled = false;
    assert_eq!(
        disabled.ensure_deletable(&owner).await.unwrap_err().code,
        "billing_unconfigured"
    );
    assert_eq!(
        webhook(
            &billing,
            &format!("{owner}-deleted"),
            "customer.deleted",
            at + Duration::seconds(1),
            fixture.clone()
        )
        .await["updated"],
        true
    );
    assert!(!billing.has_customer(&owner).await.unwrap());
    disabled.ensure_deletable(&owner).await.unwrap();
    for timestamp in [i64::MIN, i64::MAX, Utc::now().timestamp() - 600] {
        let body = b"{}";
        assert_eq!(
            billing
                .webhook(&signed("hostile", body, timestamp), body)
                .await
                .unwrap_err()
                .code,
            "invalid_webhook_signature"
        );
    }
    let body = json!({"type":"customer.deleted","timestamp":at,"data":fixture}).to_string();
    assert_eq!(
        billing
            .webhook(
                &signed("tampered", body.as_bytes(), Utc::now().timestamp()),
                b"{}"
            )
            .await
            .unwrap_err()
            .code,
        "invalid_webhook_signature"
    );
    sqlx::query("DELETE FROM billing_customers WHERE owner_id=$1")
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM billing_webhook_events WHERE id=ANY($1)")
        .bind([
            format!("polar:{}:{event_id}", billing.organization_id()),
            format!("polar:{}:{owner}-old", billing.organization_id()),
            format!("polar:{}:{owner}-deleted", billing.organization_id()),
        ])
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM public.\"user\" WHERE id=$1")
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    server.abort();
    pool.close().await;
}

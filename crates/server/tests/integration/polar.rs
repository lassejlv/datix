use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use billing::catalog::CATALOG;

#[derive(Default)]
pub(crate) struct ProviderData {
    customer: Option<Value>,
    subscriptions: Option<Vec<Value>>,
    checkouts: HashMap<String, Value>,
    checkout_requests: Vec<Value>,
    pub(crate) ingested: Vec<Value>,
    delivery_response: Option<(StatusCode, Value)>,
    created: usize,
    portals: usize,
}
pub(crate) struct MockProvider {
    url: String,
    pub(crate) data: Arc<tokio::sync::Mutex<ProviderData>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for MockProvider {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl MockProvider {
    pub(crate) async fn start() -> Self {
        let data = Arc::new(tokio::sync::Mutex::new(ProviderData::default()));
        let app = axum::Router::new()
            .fallback(axum::routing::any(mock_provider))
            .with_state(data.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self { url, data, task }
    }
    pub(crate) fn state(&self, f: &Fixture) -> State {
        let mut state = f.state.clone();
        let mut config = (*state.config).clone();
        config.polar_token = Some("test-polar-token".into());
        config.polar_url = self.url.clone();
        config.polar_webhook_secret = Some(format!("whsec_{}", STANDARD.encode([7u8; 32])));
        state.config = Arc::new(config);
        state
    }
}
async fn mock_provider(
    axum::extract::State(data): axum::extract::State<Arc<tokio::sync::Mutex<ProviderData>>>,
    request: axum::extract::Request,
) -> (StatusCode, axum::Json<Value>) {
    let path = request.uri().path().to_owned();
    assert_eq!(request.headers()["polar-version"], "2026-04");
    assert_eq!(
        request.headers()["authorization"],
        "Bearer test-polar-token"
    );
    let query = request.uri().query().unwrap_or("").to_owned();
    let bytes = to_bytes(request.into_body(), 1024 * 1024).await.unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let mut data = data.lock().await;
    let response = match path.as_str() {
        p if p.starts_with("/v1/customers/external/") && p.ends_with("/state") => {
            match data.customer.clone() {
                Some(c) => c,
                None => {
                    return (
                        StatusCode::NOT_FOUND,
                        axum::Json(json!({"detail":"Not found"})),
                    );
                }
            }
        }
        "/v1/customers/" => {
            // Organization tokens infer this field and reject an explicit value.
            if body.get("organization_id").is_some() {
                return (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    axum::Json(
                        json!({"detail":"organization_id is disallowed for organization tokens"}),
                    ),
                );
            }
            let c = json!({"id":Uuid::new_v4(),"organization_id":CATALOG.organization_id,"external_id":body["external_id"],"active_subscriptions":[],"granted_benefits":[],"deleted_at":null});
            data.customer = Some(c.clone());
            c
        }
        "/v1/subscriptions/" => {
            assert!(query.contains(&format!("organization_id={}", CATALOG.organization_id)));
            let customer = data.customer.as_ref().unwrap();
            assert!(query.contains(customer["id"].as_str().unwrap()));
            let rows = data.subscriptions.clone().unwrap_or_else(|| {
                customer["active_subscriptions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| {
                        let mut s = s.clone();
                        s["customer_id"] = customer["id"].clone();
                        s
                    })
                    .collect()
            });
            json!({"items":rows,"pagination":{"max_page":1,"total_count":rows.len()}})
        }
        "/v1/customer-sessions/" => {
            assert_eq!(body["customer_id"], data.customer.as_ref().unwrap()["id"]);
            data.portals += 1;
            json!({"customer_id":body["customer_id"],"customer_portal_url":"https://polar.sh/test-portal"})
        }
        "/v1/checkouts/" => {
            assert_eq!(body["currency"], "usd");
            assert_eq!(
                body["external_customer_id"],
                data.customer.as_ref().unwrap()["external_id"]
            );
            assert_eq!(body["customer_id"], data.customer.as_ref().unwrap()["id"]);
            let id = Uuid::new_v4().to_string();
            let checkout = json!({"id":id,"url":format!("https://polar.sh/checkout/{id}"),"status":"open","expires_at":Utc::now()+Duration::hours(1),"product_id":body["products"][0],"currency":"usd","customer_id":body["customer_id"]});
            data.checkout_requests.push(body);
            data.created += 1;
            data.checkouts.insert(id, checkout.clone());
            checkout
        }
        p if p.starts_with("/v1/checkouts/") => data
            .checkouts
            .get(p.trim_start_matches("/v1/checkouts/"))
            .cloned()
            .unwrap(),
        "/v1/events/ingest" => {
            let count = body["events"].as_array().unwrap().len();
            data.ingested.push(body);
            if let Some((status, response)) = &data.delivery_response {
                return (*status, axum::Json(response.clone()));
            }
            json!({"inserted":count,"duplicates":0})
        }
        _ => panic!("Unexpected Polar request {path}"),
    };
    (StatusCode::OK, axum::Json(response))
}
fn customer(owner: &str) -> Value {
    let mut c: Value = serde_json::from_str(include_str!(
        "../../../../web/tests/fixtures/polar-customer-state.json"
    ))
    .unwrap();
    c["external_id"] = json!(owner);
    c["id"] = json!(Uuid::new_v4());
    c["active_subscriptions"][0]["current_period_start"] = json!(Utc::now() - Duration::days(1));
    c["active_subscriptions"][0]["current_period_end"] = json!(Utc::now() + Duration::days(29));
    c
}
async fn owner(state: &State, f: &Fixture) -> analytics_core::models::User {
    auth::require(
        state,
        &axum::http::HeaderMap::from_iter([(
            axum::http::header::COOKIE,
            f.cookie.parse().unwrap(),
        )]),
    )
    .await
    .unwrap()
    .user
}

#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn checkout_is_usd_only_reuses_open_sessions_and_blocks_annual_drafts() {
    fixture!(f, {
        let mock = MockProvider::start().await;
        let state = mock.state(&f);
        let owner = owner(&state, &f).await;
        for locale in ["en", "da", "de"] {
            let before = mock.data.lock().await.created;
            for _ in 0..2 {
                let result = billing::provider::handle(
                    &state,
                    &owner,
                    "checkout",
                    "POST",
                    json!({"events":15000,"interval":"month","locale":locale}),
                )
                .await
                .unwrap();
                assert!(
                    result["url"]
                        .as_str()
                        .unwrap()
                        .starts_with("https://polar.sh/checkout/")
                );
            }
            let data = mock.data.lock().await;
            assert_eq!(data.created, before + 1);
            let body = data.checkout_requests.last().unwrap();
            assert_eq!(body["currency"], "usd");
            assert_eq!(body["locale"], locale);
            assert_eq!(body["allow_trial"], true);
            assert_eq!(
                body["success_url"],
                "http://localhost:3057/usage?checkout_id={CHECKOUT_ID}"
            );
        }
        // A paid, expired or changed session is never reused, even inside the local cache TTL.
        for replacement in [
            json!({"status":"succeeded"}),
            json!({"expires_at":Utc::now()-Duration::minutes(1)}),
            json!({"product_id":Uuid::new_v4()}),
        ] {
            let before = mock.data.lock().await.created;
            for checkout in mock.data.lock().await.checkouts.values_mut() {
                for (key, value) in replacement.as_object().unwrap() {
                    checkout[key] = value.clone();
                }
            }
            billing::provider::handle(
                &state,
                &owner,
                "checkout",
                "POST",
                json!({"events":15000,"interval":"month","locale":"de"}),
            )
            .await
            .unwrap();
            assert_eq!(mock.data.lock().await.created, before + 1);
        }
        for events in [15000, 500000, 5000000] {
            assert_eq!(
                billing::provider::handle(
                    &state,
                    &owner,
                    "checkout",
                    "POST",
                    json!({"events":events,"interval":"year"})
                )
                .await
                .unwrap_err()
                .code,
                "plan_unavailable"
            );
        }
        for events in [500000, 5000000] {
            billing::provider::handle(
                &state,
                &owner,
                "checkout",
                "POST",
                json!({"events":events,"interval":"month"}),
            )
            .await
            .unwrap();
            assert_eq!(
                mock.data.lock().await.checkout_requests.last().unwrap()["allow_trial"],
                false
            );
        }
        mock.data.lock().await.customer = Some(customer(&f.user));
        let before = mock.data.lock().await.created;
        let result = billing::provider::handle(
            &state,
            &owner,
            "checkout",
            "POST",
            json!({"events":500000,"interval":"month"}),
        )
        .await
        .unwrap();
        assert_eq!(result["url"], "https://polar.sh/test-portal");
        assert_eq!(mock.data.lock().await.created, before);
        assert_eq!(
            billing::provider::ensure_deletable(&state, &f.user)
                .await
                .unwrap_err()
                .code,
            "cancel_subscription_first"
        );
        mock.data.lock().await.customer.as_mut().unwrap()["active_subscriptions"][0]["cancel_at_period_end"] =
            json!(true);
        billing::provider::ensure_deletable(&state, &f.user)
            .await
            .unwrap();
        // Past-due accounts aren't in CustomerState.active_subscriptions but may still renew.
        let id = mock.data.lock().await.customer.as_ref().unwrap()["id"].clone();
        for status in ["past_due", "paused", "incomplete"] {
            mock.data.lock().await.customer.as_mut().unwrap()["active_subscriptions"] = json!([]);
            mock.data.lock().await.subscriptions = Some(vec![
                json!({"customer_id":id,"status":status,"cancel_at_period_end":false}),
            ]);
            assert_eq!(
                billing::provider::ensure_deletable(&state, &f.user)
                    .await
                    .unwrap_err()
                    .code,
                "cancel_subscription_first"
            );
            assert_eq!(
                billing::provider::handle(
                    &state,
                    &owner,
                    "checkout",
                    "POST",
                    json!({"events":15000,"interval":"month"})
                )
                .await
                .unwrap()["url"],
                "https://polar.sh/test-portal"
            );
        }
    });
}

#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn refresh_rejects_foreign_state_expires_stale_access_and_revokes_grants() {
    fixture!(f, {
        let mock = MockProvider::start().await;
        let state = mock.state(&f);
        mock.data.lock().await.customer = Some(customer(&f.user));
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
        for field in ["external_id", "organization_id"] {
            let mut c = customer(&f.user);
            c[field] = json!(Uuid::new_v4());
            mock.data.lock().await.customer = Some(c);
            assert_eq!(
                billing::provider::sync(&state, &mut conn, &f.user)
                    .await
                    .unwrap_err()
                    .code,
                "invalid_billing_customer"
            );
        }
        let mut c = customer(&f.user);
        c["granted_benefits"] = json!([]);
        mock.data.lock().await.customer = Some(c);
        billing::provider::sync(&state, &mut conn, &f.user)
            .await
            .unwrap();
        assert!(
            billing::usage::usage(&mut conn, &f.user, Utc::now())
                .await
                .unwrap()["plan"]
                .is_null()
        );
        mock.data.lock().await.customer = None;
        billing::provider::sync(&state, &mut conn, &f.user)
            .await
            .unwrap();
        assert!(
            sqlx::query_scalar::<_, bool>(
                "SELECT deleted FROM billing_customers WHERE owner_id=$1"
            )
            .bind(&f.user)
            .fetch_one(&mut *conn)
            .await
            .unwrap()
        );
        assert_eq!(
            f.request("/api/webhooks/polar", "POST", Some(json!({})))
                .await
                .0,
            503
        );
    });
}

#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn outbox_preserves_fractional_usage_and_retries_without_crossing_organizations() {
    fixture!(f, {
        f.pro().await;
        let site = f.site().await;
        sqlx::query("UPDATE environments SET allow_localhost=true WHERE id=$1")
            .bind(site)
            .execute(&f.state.db)
            .await
            .unwrap();
        let mut event = f.event(site);
        event.localhost = true;
        assert!(ingest::ingest(&f.state, &event, Utc::now()).await.unwrap());
        assert!(!ingest::ingest(&f.state, &event, Utc::now()).await.unwrap());
        let mock = MockProvider::start().await;
        let state = mock.state(&f);
        mock.data.lock().await.delivery_response =
            Some((StatusCode::SERVICE_UNAVAILABLE, json!({})));
        assert_eq!(billing::delivery::deliver(&state).await.unwrap(), 0);
        let first = mock.data.lock().await.ingested[0].clone();
        let payload = &first["events"][0];
        assert_eq!(payload["metadata"]["quantity"], 0.3);
        assert_eq!(payload["name"], "events");
        assert_eq!(payload["external_customer_id"], f.user);
        assert_eq!(
            payload["organization_id"],
            CATALOG.organization_id.to_string()
        );
        for private in ["visitor", "path", "email", "ip_address"] {
            assert!(!first.to_string().contains(private));
        }
        // A 2xx response without an inserted/duplicate acknowledgment must not delete the row.
        mock.data.lock().await.delivery_response =
            Some((StatusCode::OK, json!({"inserted":0,"duplicates":0})));
        sqlx::query("UPDATE billing_outbox SET available_at=now() WHERE owner_id=$1")
            .bind(&f.user)
            .execute(&state.db)
            .await
            .unwrap();
        assert_eq!(billing::delivery::deliver(&state).await.unwrap(), 0);
        mock.data.lock().await.delivery_response =
            Some((StatusCode::OK, json!({"inserted":0,"duplicates":1})));
        // Polar event external IDs remain stable beyond Autumn's old 24-hour retry window.
        sqlx::query("UPDATE billing_outbox SET available_at=now(),delivery_started_at=now()-interval '2 days' WHERE owner_id=$1").bind(&f.user).execute(&state.db).await.unwrap();
        assert_eq!(billing::delivery::deliver(&state).await.unwrap(), 1);
        assert!(
            mock.data
                .lock()
                .await
                .ingested
                .iter()
                .all(|value| value == &first)
        );
        assert_eq!(
            billing::account_usage(&f.state, &f.user).await.unwrap()["events"]["used"],
            0.3
        );
        // Partial batch acceptance retains every ID; the provider can acknowledge
        // a later retry as a mixture of new inserts and duplicates.
        sqlx::query("INSERT INTO billing_outbox(owner_id,event_type,event_count,occurred_at,provider,organization_id) SELECT $1,'pageview',0.15,now(),'polar',$2 FROM generate_series(1,2)")
            .bind(&f.user).bind(CATALOG.organization_id).execute(&state.db).await.unwrap();
        mock.data.lock().await.delivery_response =
            Some((StatusCode::OK, json!({"inserted":1,"duplicates":0})));
        assert_eq!(billing::delivery::deliver(&state).await.unwrap(), 0);
        let partial = mock.data.lock().await.ingested.last().unwrap().clone();
        assert_eq!(partial["events"].as_array().unwrap().len(), 2);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM billing_outbox WHERE owner_id=$1")
                .bind(&f.user)
                .fetch_one(&state.db)
                .await
                .unwrap(),
            2
        );
        sqlx::query("UPDATE billing_outbox SET available_at=now() WHERE owner_id=$1")
            .bind(&f.user)
            .execute(&state.db)
            .await
            .unwrap();
        mock.data.lock().await.delivery_response =
            Some((StatusCode::OK, json!({"inserted":1,"duplicates":1})));
        assert_eq!(billing::delivery::deliver(&state).await.unwrap(), 2);
        assert_eq!(mock.data.lock().await.ingested.last().unwrap(), &partial);
        for (provider, org) in [
            ("autumn", None),
            ("polar", None),
            ("polar", Some(Uuid::new_v4())),
        ] {
            sqlx::query("INSERT INTO billing_outbox(owner_id,event_type,event_count,occurred_at,provider,organization_id) VALUES($1,'pageview',1,now(),$2,$3)").bind(&f.user).bind(provider).bind(org).execute(&state.db).await.unwrap();
        }
        let before = mock.data.lock().await.ingested.len();
        assert_eq!(billing::delivery::deliver(&state).await.unwrap(), 0);
        assert_eq!(mock.data.lock().await.ingested.len(), before);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM billing_outbox WHERE owner_id=$1")
                .bind(&f.user)
                .fetch_one(&state.db)
                .await
                .unwrap(),
            3
        );
    });
}

#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn local_quota_remains_exact_across_async_provider_updates_and_plan_changes() {
    fixture!(f, {
        let mock = MockProvider::start().await;
        let state = mock.state(&f);
        let mut c = customer(&f.user);
        c["granted_benefits"][2]["properties"]["last_credited_units"] = json!(1);
        mock.data.lock().await.customer = Some(c.clone());
        let mut conn = state.db.acquire().await.unwrap();
        billing::provider::sync(&state, &mut conn, &f.user)
            .await
            .unwrap();
        let site = f.site().await;
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
        billing::provider::sync(&state, &mut conn, &f.user)
            .await
            .unwrap();
        assert_eq!(
            billing::usage::usage(&mut conn, &f.user, Utc::now())
                .await
                .unwrap()["events"]["remaining"],
            0.0
        );
        assert_eq!(billing::delivery::deliver(&state).await.unwrap(), 1);
        for used in [0, 1] {
            c["active_meters"][0]["consumed_units"] = json!(used);
            c["active_meters"][0]["balance"] = json!(1 - used);
            mock.data.lock().await.customer = Some(c.clone());
            billing::provider::sync(&state, &mut conn, &f.user)
                .await
                .unwrap();
            assert_eq!(
                billing::usage::usage(&mut conn, &f.user, Utc::now())
                    .await
                    .unwrap()["events"]["used"],
                1.0
            );
            assert!(
                !ingest::ingest(&f.state, &f.event(site), Utc::now())
                    .await
                    .unwrap()
            );
        }
        let pro = CATALOG.plans.iter().find(|p| p.id == "pro").unwrap();
        c["active_subscriptions"][0]["product_id"] = json!(pro.product_id);
        c["granted_benefits"][2]["benefit_id"] = json!(pro.events_benefit_id);
        c["granted_benefits"][2]["properties"]["last_credited_units"] = json!(pro.events);
        mock.data.lock().await.customer = Some(c.clone());
        billing::provider::sync(&state, &mut conn, &f.user)
            .await
            .unwrap();
        let usage = billing::usage::usage(&mut conn, &f.user, Utc::now())
            .await
            .unwrap();
        assert_eq!(usage["plan"]["name"], "Pro");
        assert_eq!(usage["events"]["remaining"], 999999.0);
        assert!(
            ingest::ingest(&f.state, &f.event(site), Utc::now())
                .await
                .unwrap()
        );
        sqlx::query("INSERT INTO billing_usage(owner_id,site_id,period_start,period_end,events) VALUES($1,$2,$3,$4,999999) ON CONFLICT(owner_id,period_start,site_id) DO UPDATE SET events=billing_usage.events+excluded.events")
            .bind(&f.user).bind(site).bind(c["active_subscriptions"][0]["current_period_start"].as_str().unwrap().parse::<chrono::DateTime<Utc>>().unwrap()).bind(c["active_subscriptions"][0]["current_period_end"].as_str().unwrap().parse::<chrono::DateTime<Utc>>().unwrap()).execute(&state.db).await.unwrap();
        assert_eq!(
            billing::usage::usage(&mut conn, &f.user, Utc::now())
                .await
                .unwrap()["events"]["used"],
            2.0
        );
        c["active_subscriptions"][0]["current_period_start"] =
            json!(Utc::now() - Duration::milliseconds(1));
        c["active_subscriptions"][0]["current_period_end"] = json!(Utc::now() + Duration::days(30));
        mock.data.lock().await.customer = Some(c);
        billing::provider::sync(&state, &mut conn, &f.user)
            .await
            .unwrap();
        assert_eq!(
            billing::usage::usage(&mut conn, &f.user, Utc::now())
                .await
                .unwrap()["events"]["used"],
            0.0
        );
    });
}

async fn webhook(
    state: &State,
    f: &Fixture,
    id: &str,
    value: &Value,
    valid: bool,
) -> (StatusCode, Value) {
    let body = value.to_string();
    let timestamp = Utc::now().timestamp();
    let signature = STANDARD.encode(crypto::signature(
        &[7u8; 32],
        format!("{id}.{timestamp}.{body}").as_bytes(),
    ));
    let mut req = Request::builder()
        .uri("/api/webhooks/polar")
        .method("POST")
        .header("content-type", "application/json")
        .header("webhook-id", id)
        .header("webhook-timestamp", timestamp.to_string())
        .header(
            "webhook-signature",
            format!("v1,{}", if valid { signature } else { "invalid".into() }),
        )
        .body(Body::from(body))
        .unwrap();
    req.extensions_mut().insert(ConnectInfo(f.ip));
    let res = http::router(state.clone(), Arc::new(AtomicBool::new(true)))
        .oneshot(req)
        .await
        .unwrap();
    let status = res.status();
    let body = to_bytes(res.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}
#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn webhooks_verify_deduplicate_order_and_never_link_by_email() {
    fixture!(f, {
        let mock = MockProvider::start().await;
        let state = mock.state(&f);
        let mut c = customer(&f.user);
        c["granted_benefits"][2]["properties"] = json!({});
        c["active_subscriptions"][0]["status"] = json!("trialing");
        c["active_subscriptions"][0]["trial_end"] = json!(Utc::now() + Duration::days(14));
        let at = Utc::now() - Duration::minutes(1);
        let payload = json!({"type":"customer.state_changed","timestamp":at,"data":c});
        let id = format!("{}-state", f.user);
        assert_eq!(
            webhook(&state, &f, &id, &payload, false).await.0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            webhook(&state, &f, &id, &payload, true).await.1["updated"],
            true
        );
        assert_eq!(
            webhook(&state, &f, &id, &payload, true).await.1["duplicate"],
            true
        );
        assert!(billing::account_usage(&f.state, &f.user).await.unwrap()["plan"].is_object());
        let mut deleted =
            json!({"type":"customer.deleted","timestamp":at+Duration::microseconds(1),"data":c});
        assert_eq!(
            webhook(&state, &f, &format!("{}-deleted", f.user), &deleted, true)
                .await
                .1["updated"],
            true
        );
        assert!(billing::account_usage(&f.state, &f.user).await.unwrap()["plan"].is_null());
        assert_eq!(
            webhook(&state, &f, &format!("{}-old", f.user), &payload, true)
                .await
                .1["updated"],
            false
        );
        assert!(billing::account_usage(&f.state, &f.user).await.unwrap()["plan"].is_null());
        deleted["data"]["organization_id"] = json!(Uuid::new_v4());
        assert_eq!(
            webhook(&state, &f, &format!("{}-foreign", f.user), &deleted, true)
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
        let mut unknown = payload.clone();
        unknown["data"]["external_id"] = json!("nonexistent-app-user");
        unknown["data"]["email"] = json!(f.email);
        assert_eq!(
            webhook(&state, &f, &format!("{}-unknown", f.user), &unknown, true)
                .await
                .1["updated"],
            false
        );
        unknown["data"]["external_id"] = Value::Null;
        assert_eq!(
            webhook(&state, &f, &format!("{}-unlinked", f.user), &unknown, true)
                .await
                .1["handled"],
            false
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM billing_customers WHERE owner_id=$1"
            )
            .bind(&f.user)
            .fetch_one(&state.db)
            .await
            .unwrap(),
            1
        );
        let saved: Value =
            sqlx::query_scalar("SELECT subscriptions FROM billing_customers WHERE owner_id=$1")
                .bind(&f.user)
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(saved, json!([]));
    });
}

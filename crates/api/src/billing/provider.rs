use super::{catalog::Catalog, unconfigured};
use crate::error::ApiError;
use chrono::{DateTime, Utc};
use reqwest::{Client, Method, StatusCode};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::Value;
use url::Url;
use uuid::Uuid;

#[derive(Clone)]
pub(super) struct Provider {
    client: Client,
    base: Url,
    token: String,
    version: String,
}

#[cfg(test)]
mod diagnostic_tests {
    use super::*;
    use std::{
        io::Write,
        sync::{Arc, Mutex},
    };
    use tracing::instrument::WithSubscriber;

    #[tokio::test]
    async fn new_customer_uses_token_organization_and_checks_returned_identity() {
        use axum::{Json, Router, routing::post};
        use serde_json::json;

        let catalog = Catalog::load(None, false).unwrap();
        for (organization, owner, accepted) in [
            (catalog.organization_id, "fixture-owner", true),
            (Uuid::new_v4(), "fixture-owner", false),
            (catalog.organization_id, "another-owner", false),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
            let app = Router::new().route("/v1/customers/", post(move |Json(body): Json<Value>| async move {
                // Reproduce Polar's organization-token validation at the HTTP boundary.
                if body.get("organization_id").is_some() {
                    return (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({"detail":[{
                        "type":"organization_token", "loc":["body","organization_id"],
                        "msg":"Setting organization_id is disallowed when using an organization token."
                    }]})));
                }
                assert_eq!(body["external_id"], "fixture-owner");
                assert_eq!(body["email"], "fixture@example.test");
                assert_eq!(body["name"], "Fixture");
                assert_eq!(body["locale"], "da");
                (StatusCode::CREATED, Json(json!({"id":Uuid::new_v4(), "organization_id":organization, "external_id":owner})))
            }));
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let result = Provider::local_fixture(base, &catalog)
                .create_customer(
                    &catalog,
                    "fixture-owner",
                    "Fixture",
                    "fixture@example.test",
                    "da",
                )
                .await;
            server.abort();
            if accepted {
                assert!(
                    result.is_ok(),
                    "Fresh customer creation failed: {:?}",
                    result.err()
                );
            } else {
                assert_eq!(result.err().unwrap().code, "invalid_billing_customer");
            }
        }
    }

    #[derive(Clone, Default)]
    struct Capture(Arc<Mutex<Vec<u8>>>);
    impl Write for Capture {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn checkout_diagnostics_include_stage_and_attempt_without_account_data() {
        let catalog = Arc::new(Catalog::load(None, false).unwrap());
        let input = serde_json::json!({"events":catalog.plans[0].events,"interval":catalog.plans[0].interval});
        let billing = crate::billing::Billing {
            pool: sqlx::postgres::PgPoolOptions::new()
                .connect_lazy("postgres://fixture:fixture@localhost/fixture")
                .unwrap(),
            catalog,
            provider: None,
            enabled: false,
            webhook_secret: None,
            app_url: "https://private-app.example.test".into(),
        };
        let capture = Capture::default();
        let writer = capture.clone();
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish();
        let result = billing
            .checkout("private-owner", input)
            .with_subscriber(subscriber)
            .await;
        assert_eq!(result.unwrap_err().code, "billing_unconfigured");
        let log = String::from_utf8(capture.0.lock().unwrap().clone()).unwrap();
        assert!(
            log.contains("configuration")
                && log.contains("attempt_id")
                && log.contains("checkout_failed")
                && log.contains("503"),
            "{log}"
        );
        assert!(
            !log.contains("private-") && !log.contains("fixture"),
            "Private data in diagnostics"
        );
    }

    #[tokio::test]
    async fn provider_diagnostics_report_categories_without_private_data() {
        for (status, category) in [
            (StatusCode::UNPROCESSABLE_ENTITY, "http_rejected"),
            (StatusCode::OK, "response_decode"),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
            let server = tokio::spawn(async move {
                axum::serve(
                    listener,
                    axum::Router::new().fallback(move || async move {
                        (
                            status,
                            if status == StatusCode::UNPROCESSABLE_ENTITY {
                                r#"{"detail":[{"type":"value_error","loc":["body","email"],"msg":"A customer with this email address already exists.","input":"private-response customer@example.test secret-token"}]}"#
                            } else {
                                "private-response customer@example.test secret-token"
                            },
                        )
                    }),
                )
                .await
                .unwrap();
            });
            let provider = Provider {
                client: Client::new(),
                base,
                token: "private-token".into(),
                version: "2026-04".into(),
            };
            let capture = Capture::default();
            let writer = capture.clone();
            let subscriber = tracing_subscriber::fmt()
                .without_time()
                .with_ansi(false)
                .with_writer(move || writer.clone())
                .finish();
            let result = provider
                .request::<Value>(
                    Method::POST,
                    &["v1", "checkouts", "private-path"],
                    &[("private-query", "secret-query".into())],
                    Some(serde_json::json!({"email":"private-request@example.test"})),
                    false,
                )
                .with_subscriber(subscriber)
                .await;
            server.abort();
            let error = result.unwrap_err();
            assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(error.message, "Service temporarily unavailable.");
            let log = String::from_utf8(capture.0.lock().unwrap().clone()).unwrap();
            assert!(
                log.contains(category)
                    && log.contains("checkouts")
                    && log.contains(&status.as_u16().to_string()),
                "{log}"
            );
            for private in ["private-", "secret-", "example.test", "2026-04"] {
                assert!(!log.contains(private), "Private data in diagnostics");
            }
            if status == StatusCode::UNPROCESSABLE_ENTITY {
                assert!(
                    log.contains("email") && log.contains("duplicate_email"),
                    "{log}"
                );
            }
        }
    }
}

#[derive(Deserialize)]
pub(super) struct Customer {
    pub id: Uuid,
    pub external_id: Option<String>,
    pub organization_id: Uuid,
    pub deleted_at: Option<DateTime<Utc>>,
    pub active_subscriptions: Option<Vec<Subscription>>,
    pub granted_benefits: Option<Vec<Grant>>,
}

#[derive(Deserialize)]
pub(super) struct Subscription {
    pub id: Uuid,
    pub product_id: Uuid,
    pub status: String,
    pub currency: String,
    pub recurring_interval: String,
    pub current_period_start: DateTime<Utc>,
    pub current_period_end: DateTime<Utc>,
    pub trial_end: Option<DateTime<Utc>>,
    pub ends_at: Option<DateTime<Utc>>,
    pub cancel_at_period_end: bool,
}

#[derive(Deserialize)]
pub(super) struct Grant {
    pub benefit_id: Uuid,
    pub benefit_type: String,
    pub benefit_metadata: Option<Value>,
    pub properties: Option<Value>,
}

#[derive(Deserialize)]
pub(super) struct Checkout {
    pub id: Uuid,
    pub product_id: Option<Uuid>,
    pub customer_id: Option<Uuid>,
    pub currency: String,
    pub url: String,
    pub status: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Deserialize)]
pub(super) struct CustomerSession {
    pub customer_id: Uuid,
    pub customer_portal_url: String,
}

#[derive(Deserialize)]
pub(super) struct SubscriptionPage {
    pub items: Vec<SubscriptionStatus>,
    pub pagination: Pagination,
}
#[derive(Deserialize)]
pub(super) struct SubscriptionStatus {
    pub id: Uuid,
    pub product_id: Uuid,
    pub customer_id: Uuid,
    pub status: String,
    pub cancel_at_period_end: bool,
}
#[derive(Deserialize)]
pub(super) struct Pagination {
    pub max_page: u32,
}

impl Provider {
    #[cfg(test)]
    pub(super) fn local_fixture(base: Url, catalog: &Catalog) -> Self {
        assert_eq!(base.host_str(), Some("127.0.0.1"));
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(2))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            base,
            token: "fixture-token".into(),
            version: catalog.api_version.clone(),
        }
    }
    pub fn from_env(catalog: &Catalog, sandbox: bool) -> Result<Option<Self>, ApiError> {
        let base = std::env::var("POLAR_API_URL").unwrap_or_else(|_| "https://api.polar.sh".into());
        if !["https://api.polar.sh", "https://sandbox-api.polar.sh"].contains(&base.as_str())
            || (base == "https://sandbox-api.polar.sh") != sandbox
        {
            return Err(unconfigured());
        }
        let Some(token) = std::env::var("POLAR_ACCESS_TOKEN")
            .ok()
            .filter(|s| !s.trim().is_empty())
        else {
            return Ok(None);
        };
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| unconfigured())?;
        Ok(Some(Self {
            client,
            base: Url::parse(&base).map_err(|_| unconfigured())?,
            token,
            version: catalog.api_version.clone(),
        }))
    }

    fn url(&self, path: &[&str]) -> Result<Url, ApiError> {
        let mut url = self.base.clone();
        if path.iter().any(|s| matches!(*s, "." | "..")) {
            return Err(ApiError::invalid());
        }
        url.path_segments_mut()
            .map_err(|_| unconfigured())?
            .pop_if_empty()
            .extend(path);
        Ok(url)
    }

    async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &[&str],
        query: &[(&str, String)],
        body: Option<Value>,
        optional: bool,
    ) -> Result<Option<T>, ApiError> {
        // Never log paths: customer-state paths contain account identifiers.
        let resource = match path.get(1).copied() {
            Some("customers") => "customers",
            Some("checkouts") => "checkouts",
            Some("customer-sessions") => "customer_sessions",
            Some("subscriptions") => "subscriptions",
            Some("events") => "events",
            _ => "other",
        };
        let method_name = if method == Method::GET {
            "GET"
        } else if method == Method::DELETE {
            "DELETE"
        } else {
            "POST"
        };
        let failure = |category: &'static str, status: Option<StatusCode>| {
            tracing::warn!(
                provider = "polar",
                resource,
                method = method_name,
                category,
                http_status = status.map(|s| s.as_u16()),
                "Billing provider request failed"
            );
            ApiError::unavailable()
        };
        let mut request = self
            .client
            .request(method, self.url(path)?)
            .bearer_auth(&self.token)
            .header("Polar-Version", &self.version)
            .header("accept", "application/json")
            .query(query);
        if let Some(body) = body {
            request = request.json(&body);
        }
        // No transport retries: checkout creation is not inherently idempotent and the
        // billing outbox, not an HTTP client, owns meter delivery retries.
        let mut response = request.send().await.map_err(|error| {
            failure(
                if error.is_timeout() {
                    "timeout"
                } else if error.is_connect() {
                    "connection"
                } else {
                    "transport"
                },
                None,
            )
        })?;
        if optional && response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            let status = response.status();
            if status == StatusCode::UNPROCESSABLE_ENTITY {
                // Validation errors echo submitted values. Read a bounded body and
                // emit only allowlisted field names and fixed categories.
                let mut bytes = Vec::new();
                while let Ok(Some(chunk)) = response.chunk().await {
                    if bytes.len() + chunk.len() > 64 * 1024 {
                        bytes.clear();
                        break;
                    }
                    bytes.extend_from_slice(&chunk);
                }
                if let Ok(value) = serde_json::from_slice::<Value>(&bytes)
                    && let Some(details) = value.get("detail").and_then(Value::as_array)
                {
                    for detail in details.iter().take(8) {
                        let field = detail
                            .get("loc")
                            .and_then(Value::as_array)
                            .and_then(|path| path.last())
                            .and_then(Value::as_str)
                            .filter(|field| {
                                matches!(
                                    *field,
                                    "email"
                                        | "name"
                                        | "external_id"
                                        | "organization_id"
                                        | "locale"
                                        | "type"
                                        | "customer_id"
                                        | "external_customer_id"
                                        | "products"
                                        | "product_id"
                                        | "subscription_id"
                                        | "currency"
                                        | "allow_trial"
                                        | "success_url"
                                        | "return_url"
                                )
                            })
                            .unwrap_or("other");
                        let reason = match detail.get("msg").and_then(Value::as_str) {
                            Some("A customer with this email address already exists.") => {
                                "duplicate_email"
                            }
                            Some("A customer with this external ID already exists.") => {
                                "duplicate_external_id"
                            }
                            _ => match detail.get("type").and_then(Value::as_str) {
                                Some("missing") => "missing",
                                Some("extra_forbidden") => "extra_forbidden",
                                Some("organization_token") => "organization_token",
                                Some("string_too_long") => "string_too_long",
                                Some("uuid_parsing" | "uuid_version") => "invalid_uuid",
                                Some("literal_error" | "union_tag_invalid" | "enum") => {
                                    "invalid_choice"
                                }
                                Some("value_error") => "value_error",
                                _ => "other",
                            },
                        };
                        tracing::warn!(
                            provider = "polar",
                            resource,
                            field,
                            reason,
                            "Billing provider validation failed"
                        );
                    }
                }
            }
            return Err(failure("http_rejected", Some(status)));
        }
        let status = response.status();
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| failure("response_read", Some(status)))?
        {
            if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
                return Err(failure("response_too_large", Some(status)));
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| failure("response_decode", Some(status)))
    }

    pub async fn customer_state(&self, owner: &str) -> Result<Option<Customer>, ApiError> {
        self.request(
            Method::GET,
            &["v1", "customers", "external", owner, "state"],
            &[],
            None,
            true,
        )
        .await
    }
    pub async fn checkout(&self, id: Uuid) -> Result<Option<Checkout>, ApiError> {
        self.request(
            Method::GET,
            &["v1", "checkouts", &id.to_string()],
            &[],
            None,
            true,
        )
        .await
    }
    pub async fn create<T: DeserializeOwned>(
        &self,
        resource: &str,
        body: Value,
    ) -> Result<T, ApiError> {
        self.request(Method::POST, &["v1", resource, ""], &[], Some(body), false)
            .await?
            .ok_or_else(ApiError::unavailable)
    }

    pub async fn create_customer(
        &self,
        catalog: &Catalog,
        owner: &str,
        name: &str,
        email: &str,
        locale: &str,
    ) -> Result<Customer, ApiError> {
        // Organization access tokens choose the organization implicitly; Polar
        // rejects an explicit organization_id in this request body.
        let customer = self
            .create(
                "customers",
                serde_json::json!({
                    "type":"individual", "external_id":owner,
                    "email":email, "name":name, "locale":locale
                }),
            )
            .await?;
        verify_customer(&customer, owner, catalog)?;
        Ok(customer)
    }
    pub async fn subscriptions(
        &self,
        customer: Uuid,
        organization: Uuid,
        page: u32,
    ) -> Result<SubscriptionPage, ApiError> {
        self.request(
            Method::GET,
            &["v1", "subscriptions", ""],
            &[
                ("customer_id", customer.to_string()),
                ("organization_id", organization.to_string()),
                ("limit", "100".into()),
                ("page", page.to_string()),
            ],
            None,
            false,
        )
        .await?
        .ok_or_else(ApiError::unavailable)
    }
    /// Ends a subscription immediately. Only used for free subscriptions.
    pub async fn revoke(&self, subscription: Uuid) -> Result<SubscriptionStatus, ApiError> {
        self.request(
            Method::DELETE,
            &["v1", "subscriptions", &subscription.to_string()],
            &[],
            None,
            false,
        )
        .await?
        .ok_or_else(ApiError::unavailable)
    }
    pub async fn ingest(&self, body: Value) -> Result<Value, ApiError> {
        self.request(
            Method::POST,
            &["v1", "events", "ingest"],
            &[],
            Some(body),
            false,
        )
        .await?
        .ok_or_else(ApiError::unavailable)
    }
}

pub(super) fn verify_customer(
    customer: &Customer,
    owner: &str,
    catalog: &Catalog,
) -> Result<(), ApiError> {
    if customer.external_id.as_deref() != Some(owner)
        || customer.organization_id != catalog.organization_id
    {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "invalid_billing_customer",
            "Billing customer could not be verified.",
        ));
    }
    Ok(())
}

pub(super) fn redirect_url(value: &str) -> Result<&str, ApiError> {
    let url = Url::parse(value).map_err(|_| ApiError::unavailable())?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err(ApiError::unavailable());
    }
    Ok(value)
}

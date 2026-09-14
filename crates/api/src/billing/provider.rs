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
        let mut response = request.send().await.map_err(|_| ApiError::unavailable())?;
        if optional && response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(ApiError::unavailable());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| ApiError::unavailable())?
        {
            if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
                return Err(ApiError::unavailable());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| ApiError::unavailable())
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

use super::{
    catalog::Catalog,
    provider::{Checkout, Customer, CustomerSession, Provider, redirect_url, verify_customer},
    unconfigured,
};
use crate::{config::Config, error::ApiError};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use rust_decimal::{Decimal, prelude::ToPrimitive};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool};
use std::{str::FromStr, sync::Arc};
use uuid::Uuid;

#[derive(Clone)]
pub struct Billing {
    pub(super) pool: PgPool,
    pub(super) catalog: Arc<Catalog>,
    pub(super) provider: Option<Provider>,
    pub(super) enabled: bool,
    pub(super) webhook_secret: Option<String>,
    pub(super) app_url: String,
}

impl Billing {
    pub(crate) fn from_env(pool: PgPool, config: &Config) -> Result<Self, ApiError> {
        let mapping = std::env::var("POLAR_SANDBOX_IDS")
            .ok()
            .filter(|s| !s.is_empty());
        let catalog = Arc::new(Catalog::load(
            mapping.as_deref(),
            std::env::var("BILLING_STATE_MODE").as_deref() == Ok("snapshot"),
        )?);
        Ok(Self {
            pool,
            provider: if config.external_effects {
                Provider::from_env(&catalog, mapping.is_some())?
            } else {
                None
            },
            catalog,
            enabled: config.external_effects,
            webhook_secret: std::env::var("POLAR_WEBHOOK_SECRET")
                .ok()
                .filter(|s| !s.is_empty()),
            app_url: config.app_url.clone(),
        })
    }

    pub fn organization_id(&self) -> Uuid {
        self.catalog.organization_id
    }

    pub(super) fn client(&self) -> Result<&Provider, ApiError> {
        if !self.enabled {
            return Err(unconfigured());
        }
        self.provider.as_ref().ok_or_else(unconfigured)
    }

    pub(crate) async fn has_customer(&self, owner: &str) -> Result<bool, ApiError> {
        Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM billing_customers WHERE owner_id=$1 AND deleted=false AND provider='polar' AND organization_id=$2)")
            .bind(owner).bind(self.organization_id()).fetch_one(&self.pool).await?)
    }

    pub(crate) async fn sync_if_enabled(&self, owner: &str) -> Result<(), ApiError> {
        if self.enabled {
            self.sync(owner).await?;
        }
        Ok(())
    }

    pub(super) async fn sync(&self, owner: &str) -> Result<Option<Customer>, ApiError> {
        let client = self.client()?;
        let mut tx = self.pool.begin().await?;
        let user: Option<String> =
            sqlx::query_scalar("SELECT id FROM public.\"user\" WHERE id=$1 FOR UPDATE")
                .bind(owner)
                .fetch_optional(&mut *tx)
                .await?;
        if user.is_none() {
            return Err(ApiError::unavailable());
        }
        let at = Utc::now();
        let customer = client.customer_state(owner).await?;
        if let Some(customer) = &customer {
            verify_customer(customer, owner, &self.catalog)?;
        }
        self.save(&mut tx, owner, customer.as_ref(), at).await?;
        tx.commit().await?;
        Ok(customer.filter(|c| c.deleted_at.is_none()))
    }

    pub(super) async fn save(
        &self,
        connection: &mut PgConnection,
        owner: &str,
        customer: Option<&Customer>,
        at: DateTime<Utc>,
    ) -> Result<bool, ApiError> {
        let subscriptions = customer
            .map(|c| subscriptions(c, &self.catalog, Utc::now()))
            .transpose()?
            .unwrap_or_default();
        let deleted = customer.is_none_or(|c| c.deleted_at.is_some());
        let result=sqlx::query("INSERT INTO billing_customers(customer_id,owner_id,subscriptions,deleted,occurred_at,updated_at,provider,organization_id,sync_attempted_at) VALUES($1,$2,$3,$4,$5,now(),'polar',$6,now()) ON CONFLICT(customer_id) DO UPDATE SET subscriptions=excluded.subscriptions,deleted=excluded.deleted,occurred_at=excluded.occurred_at,updated_at=excluded.updated_at,sync_attempted_at=excluded.sync_attempted_at WHERE billing_customers.provider='polar' AND billing_customers.organization_id=excluded.organization_id AND billing_customers.owner_id=excluded.owner_id AND billing_customers.occurred_at<excluded.occurred_at")
            .bind(format!("polar:{}:{owner}",self.organization_id())).bind(owner).bind(json!(subscriptions)).bind(deleted).bind(at).bind(self.organization_id()).execute(connection).await?;
        Ok(result.rows_affected() > 0)
    }

    async fn has_subscription(
        &self,
        customer: Uuid,
        include_canceling: bool,
    ) -> Result<bool, ApiError> {
        for page in 1..=100 {
            let result = self
                .client()?
                .subscriptions(customer, self.organization_id(), page)
                .await?;
            for row in result.items {
                if row.customer_id != customer {
                    return Err(ApiError::unavailable());
                }
                if !matches!(
                    row.status.as_str(),
                    "canceled" | "unpaid" | "incomplete_expired"
                ) && (include_canceling || !row.cancel_at_period_end)
                {
                    return Ok(true);
                }
            }
            if page >= result.pagination.max_page {
                return Ok(false);
            }
        }
        Err(ApiError::unavailable())
    }

    async fn portal_for(&self, customer: Uuid) -> Result<Value, ApiError> {
        let response: CustomerSession = self
            .client()?
            .create(
                "customer-sessions",
                json!({"customer_id":customer,"return_url":format!("{}/dashboard",self.app_url)}),
            )
            .await?;
        if response.customer_id != customer {
            return Err(ApiError::unavailable());
        }
        Ok(json!({"url":redirect_url(&response.customer_portal_url)?}))
    }

    pub(crate) async fn portal(&self, owner: &str) -> Result<Value, ApiError> {
        let customer = self.sync(owner).await?.ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                "no_billing_customer",
                "Start a plan before opening billing.",
            )
        })?;
        self.portal_for(customer.id).await
    }

    pub(crate) async fn checkout(&self, owner: &str, input: Value) -> Result<Value, ApiError> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Selection {
            events: i64,
            interval: String,
            locale: Option<String>,
        }
        let selection: Selection =
            serde_json::from_value(input).map_err(|_| ApiError::invalid())?;
        let locale = selection.locale.as_deref().unwrap_or("en");
        if !["en", "da", "de"].contains(&locale)
            || !matches!(selection.interval.as_str(), "month" | "year")
        {
            return Err(ApiError::invalid());
        }
        let plan = self
            .catalog
            .plans
            .iter()
            .find(|p| p.events == selection.events && p.interval == selection.interval)
            .ok_or_else(|| {
                ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "Select an available plan.",
                )
            })?;
        if !plan.checkout_enabled {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "plan_unavailable",
                "Yearly billing is not available yet. Choose a monthly plan.",
            ));
        }
        let client = self.client()?;
        let mut customer = self.sync(owner).await?;
        if let Some(customer) = &customer
            && self.has_subscription(customer.id, true).await?
        {
            return self.portal_for(customer.id).await;
        }
        let mut tx = self.pool.begin().await?;
        let (name, email): (String, String) =
            sqlx::query_as("SELECT name,email FROM public.\"user\" WHERE id=$1 FOR UPDATE")
                .bind(owner)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(ApiError::unavailable)?;
        let options = json!({"locale":locale,"currency":self.catalog.currency});
        let cached:Option<String>=sqlx::query_scalar("SELECT checkout_id FROM billing_checkouts WHERE owner_id=$1 AND provider='polar' AND organization_id=$2 AND plan_id=$3 AND checkout_options=$4 AND created_at>now()-interval '10 minutes'")
            .bind(owner).bind(self.organization_id()).bind(plan.product_id.to_string()).bind(&options).fetch_optional(&mut *tx).await?;
        if let (Some(cached), Some(customer)) = (cached, &customer) {
            let id = Uuid::parse_str(&cached).map_err(|_| ApiError::unavailable())?;
            if let Some(checkout) = client.checkout(id).await?
                && matches!(checkout.status.as_str(), "open" | "confirmed")
                && checkout.expires_at > Utc::now()
                && checkout.product_id == Some(plan.product_id)
                && checkout.customer_id == Some(customer.id)
                && checkout.currency == self.catalog.currency
            {
                return Ok(json!({"url":redirect_url(&checkout.url)?}));
            }
        }
        if customer.is_none() {
            let created:Customer=client.create("customers",json!({"type":"individual","external_id":owner,"organization_id":self.organization_id(),"email":email,"name":name,"locale":locale})).await?;
            verify_customer(&created, owner, &self.catalog)?;
            customer = Some(created);
        }
        let customer = customer.ok_or_else(ApiError::unavailable)?;
        let checkout:Checkout=client.create("checkouts",json!({"products":[plan.product_id],"customer_id":customer.id,"external_customer_id":owner,
            "currency":self.catalog.currency,"locale":locale,"allow_trial":plan.trial_days>0,
            "success_url":format!("{}/dashboard?checkout_id={{CHECKOUT_ID}}",self.app_url),"return_url":format!("{}/dashboard",self.app_url)})).await?;
        if checkout.product_id != Some(plan.product_id)
            || checkout.customer_id != Some(customer.id)
            || checkout.currency != self.catalog.currency
        {
            return Err(ApiError::unavailable());
        }
        let url = redirect_url(&checkout.url)?;
        sqlx::query("INSERT INTO billing_checkouts(owner_id,checkout_id,organization_id,plan_id,checkout_url,checkout_options) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_id) DO UPDATE SET checkout_id=excluded.checkout_id,organization_id=excluded.organization_id,plan_id=excluded.plan_id,checkout_url=excluded.checkout_url,checkout_options=excluded.checkout_options,created_at=now()")
            .bind(owner).bind(checkout.id.to_string()).bind(self.organization_id()).bind(plan.product_id.to_string()).bind(url).bind(options).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(json!({"url":url}))
    }

    pub(crate) async fn ensure_deletable(&self, owner: &str) -> Result<(), ApiError> {
        if !self.enabled {
            return if self.has_customer(owner).await? {
                Err(unconfigured())
            } else {
                Ok(())
            };
        }
        if let Some(customer) = self.sync(owner).await?
            && self.has_subscription(customer.id, false).await?
        {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "cancel_subscription_first",
                "Cancel your subscription in Usage → Manage billing before deleting your account.",
            ));
        }
        Ok(())
    }
}

fn integer(value: &Value, scale: i64) -> Option<i64> {
    if !value.is_number() {
        return None;
    }
    let number = Decimal::from_str(&value.to_string())
        .ok()?
        .checked_mul(Decimal::from(scale))?;
    if !number.fract().is_zero() {
        return None;
    }
    number
        .to_i64()
        .filter(|n| (0..=9_007_199_254_740_991).contains(n))
}

pub(super) fn subscriptions(
    customer: &Customer,
    catalog: &Catalog,
    now: DateTime<Utc>,
) -> Result<Vec<Value>, ApiError> {
    if customer.deleted_at.is_some() {
        return Ok(Vec::new());
    }
    let rows = customer
        .active_subscriptions
        .as_ref()
        .ok_or_else(ApiError::unavailable)?;
    let grants = customer
        .granted_benefits
        .as_ref()
        .ok_or_else(ApiError::unavailable)?;
    let grant = |id, kind: &str| {
        grants
            .iter()
            .find(|g| g.benefit_id == id && g.benefit_type == kind)
    };
    let websites = grant(catalog.websites_benefit_id, "custom")
        .and_then(|g| g.benefit_metadata.as_ref())
        .and_then(|m| integer(&m["included"], 1));
    let Some(websites) =
        websites.filter(|_| grant(catalog.analytics_benefit_id, "custom").is_some())
    else {
        return Ok(Vec::new());
    };
    let mut result = Vec::new();
    for row in rows {
        let Some(plan) = catalog
            .plans
            .iter()
            .find(|p| p.product_id == row.product_id)
        else {
            continue;
        };
        if !plan.checkout_enabled
            || row.currency != catalog.currency
            || row.recurring_interval != plan.interval
            || !matches!(row.status.as_str(), "active" | "trialing")
        {
            continue;
        }
        let Some(properties) = grant(plan.events_benefit_id, "meter_credit")
            .and_then(|g| g.properties.as_ref())
            .and_then(Value::as_object)
        else {
            continue;
        };
        let count = if properties.is_empty() {
            Some(plan.events * 100)
        } else if properties
            .get("last_credited_meter_id")
            .and_then(Value::as_str)
            == Some(catalog.meter.id.to_string().as_str())
        {
            properties
                .get("last_credited_units")
                .and_then(|v| integer(v, 100))
        } else {
            None
        };
        let Some(limit) = count.filter(|n| *n > 0) else {
            continue;
        };
        if now < row.current_period_start
            || now >= row.current_period_end
            || (row.status == "trialing" && row.trial_end.is_none())
        {
            continue;
        }
        result.push(json!({"id":row.id,"productId":row.product_id,"status":row.status,"currentPeriodStart":row.current_period_start,"currentPeriodEnd":row.current_period_end,"trialEnd":row.trial_end,"endsAt":row.ends_at,"cancelAtPeriodEnd":row.cancel_at_period_end,
            "entitlements":{"name":plan.name,"eventLimit":limit,"websiteLimit":websites,"used":0,"remaining":limit,"localBaseline":0,"pending":0,"periodStart":row.current_period_start,"periodEnd":row.current_period_end}}));
    }
    Ok(result)
}

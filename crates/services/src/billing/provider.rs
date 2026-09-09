use super::{
    allowance::{self, Entitlements, Subscription},
    catalog::CATALOG,
    usage,
};
use analytics_core::{Error, Result, State, models::User, validation};
use chrono::{DateTime, Utc};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Connection, PgConnection};
use uuid::Uuid;

pub async fn request(
    state: &State,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Option<Value>> {
    let token = state
        .config
        .polar_token
        .as_deref()
        .ok_or_else(unconfigured)?;
    let mut req = state
        .http
        .request(
            method,
            format!("{}{path}", state.config.polar_url.trim_end_matches('/')),
        )
        .bearer_auth(token)
        .header("Polar-Version", &CATALOG.api_version)
        .timeout(std::time::Duration::from_secs(10));
    if let Some(body) = body {
        req = req.json(&body);
    }
    let response = req.send().await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        tracing::error!(status = response.status().as_u16(), "Polar request failed");
        return Err(Error::unavailable());
    }
    Ok(Some(response.json().await?))
}
fn unconfigured() -> Error {
    Error::new(
        503,
        "billing_unconfigured",
        "Billing is temporarily unavailable.",
    )
}
fn required(value: Option<Value>) -> Result<Value> {
    value.ok_or_else(Error::unavailable)
}
fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().ok_or_else(Error::unavailable)
}
pub(super) fn date(value: &Value, key: &str) -> Option<DateTime<Utc>> {
    value[key].as_str()?.parse().ok()
}
fn uuid(value: &Value) -> Option<Uuid> {
    Uuid::parse_str(value.as_str()?).ok()
}

/// Identity is established only by an existing app user ID and the pinned organization,
/// never by customer email, metadata, or a caller-supplied customer identifier.
pub(super) fn verify_customer(customer: &Value, owner: &str) -> Result<Uuid> {
    if customer["external_id"] != owner
        || uuid(&customer["organization_id"]) != Some(CATALOG.organization_id)
    {
        return Err(Error::new(
            502,
            "invalid_billing_customer",
            "Billing customer could not be verified.",
        ));
    }
    uuid(&customer["id"]).ok_or_else(Error::unavailable)
}

pub fn subscriptions(value: &Value, now: DateTime<Utc>) -> Result<Value> {
    if uuid(&value["organization_id"]) != Some(CATALOG.organization_id) {
        return Err(Error::new(
            502,
            "invalid_billing_customer",
            "Billing customer could not be verified.",
        ));
    }
    if !value["deleted_at"].is_null() {
        return Ok(json!([]));
    }
    let rows = value["active_subscriptions"]
        .as_array()
        .ok_or_else(Error::unavailable)?;
    let grants = value["granted_benefits"]
        .as_array()
        .ok_or_else(Error::unavailable)?;
    let grant = |id, kind: &str| {
        grants
            .iter()
            .find(|g| uuid(&g["benefit_id"]) == Some(id) && g["benefit_type"] == kind)
    };
    // An active subscription with revoked benefits must not retain access.
    let Some(_) = grant(CATALOG.analytics_benefit_id, "custom") else {
        return Ok(json!([]));
    };
    let Some(websites) = grant(CATALOG.websites_benefit_id, "custom") else {
        return Ok(json!([]));
    };
    let Some(website_limit) = websites["benefit_metadata"]["included"]
        .as_i64()
        .filter(|v| *v >= 0)
    else {
        return Ok(json!([]));
    };
    let mut result = Vec::new();
    for row in rows {
        let Some(plan) = CATALOG
            .plans
            .iter()
            .find(|p| Some(p.product_id) == uuid(&row["product_id"]))
        else {
            continue;
        };
        if !plan.checkout_enabled
            || row["currency"] != CATALOG.currency
            || row["recurring_interval"] != plan.interval
            || !matches!(row["status"].as_str(), Some("active" | "trialing"))
        {
            continue;
        }
        let Some(credit) = grant(plan.events_benefit_id, "meter_credit") else {
            continue;
        };
        // Public customer-state payloads omit meter-credit grant internals.
        // The verified product and granted benefit identify the catalog allowance;
        // cumulative meter credits/balance must never determine a period's limit.
        let properties = &credit["properties"];
        let units = if properties.as_object().is_some_and(|p| p.is_empty()) {
            Some(plan.events)
        } else if uuid(&properties["last_credited_meter_id"]) == Some(CATALOG.meter.id) {
            properties["last_credited_units"].as_i64()
        } else {
            None
        };
        let Some(event_limit) = units.filter(|v| *v > 0).and_then(|v| v.checked_mul(100)) else {
            continue;
        };
        let Some(start) = date(row, "current_period_start") else {
            continue;
        };
        let Some(end) = date(row, "current_period_end") else {
            continue;
        };
        let Some(id) = uuid(&row["id"]) else {
            continue;
        };
        let trial_end = date(row, "trial_end");
        let ends_at = date(row, "ends_at");
        let Some(cancel_at_period_end) = row["cancel_at_period_end"].as_bool() else {
            continue;
        };
        if (row["status"] == "trialing" && trial_end.is_none())
            || (!row["trial_end"].is_null() && trial_end.is_none())
            || (!row["ends_at"].is_null() && ends_at.is_none())
        {
            continue;
        }
        let mut subscription = Subscription {
            id: id.to_string(),
            product_id: plan.product_id.to_string(),
            status: field(row, "status")?.to_owned(),
            current_period_start: Some(start),
            current_period_end: end,
            trial_end,
            cancel_at_period_end,
            ends_at,
            entitlements: None,
        };
        // Monthly subscriptions use the exact provider period. Annual plans, once enabled
        // in the verified catalog, retain their monthly anniversary without pooling a year.
        let Some(period) = (if plan.interval == "month" {
            (now >= start && now < end).then_some(allowance::Period { start, end })
        } else {
            allowance::period(&subscription, now)
        }) else {
            continue;
        };
        subscription.entitlements = Some(Entitlements {
            name: plan.name.clone(),
            event_limit: Some(event_limit),
            website_limit: Some(website_limit),
            used: 0,
            remaining: Some(event_limit),
            local_baseline: 0,
            pending: 0,
            period_start: period.start,
            period_end: period.end,
        });
        if allowance::active(vec![subscription.clone()], now).is_some() {
            result.push(subscription);
        }
    }
    Ok(json!(result))
}

pub(super) fn snapshot_id(owner: &str) -> String {
    format!("polar:{}:{owner}", CATALOG.organization_id)
}
pub async fn save_snapshot(
    conn: &mut PgConnection,
    owner: &str,
    subscriptions: Value,
    deleted: bool,
    occurred: DateTime<Utc>,
) -> Result<bool> {
    let n = sqlx::query("INSERT INTO billing_customers(customer_id,owner_id,subscriptions,deleted,occurred_at,updated_at,provider,organization_id,sync_attempted_at) VALUES($1,$2,$3,$4,$5,now(),'polar',$6,now()) ON CONFLICT(customer_id) DO UPDATE SET subscriptions=excluded.subscriptions,deleted=excluded.deleted,occurred_at=excluded.occurred_at,updated_at=excluded.updated_at,sync_attempted_at=excluded.sync_attempted_at WHERE billing_customers.provider='polar' AND billing_customers.organization_id=excluded.organization_id AND billing_customers.owner_id=excluded.owner_id AND billing_customers.occurred_at < excluded.occurred_at")
        .bind(snapshot_id(owner)).bind(owner).bind(subscriptions).bind(deleted).bind(occurred)
        .bind(CATALOG.organization_id).execute(conn).await?.rows_affected();
    Ok(n > 0)
}
pub async fn sync(state: &State, conn: &mut PgConnection, owner: &str) -> Result<Option<Value>> {
    let mut tx = conn.begin().await?;
    sqlx::query("SELECT id FROM \"user\" WHERE id=$1 FOR UPDATE")
        .bind(owner)
        .fetch_one(&mut *tx)
        .await?;
    // Taking the timestamp after the owner lock also orders concurrent webhook snapshots.
    let occurred = Utc::now();
    let encoded = percent_encoding::utf8_percent_encode(owner, percent_encoding::NON_ALPHANUMERIC);
    let customer = request(
        state,
        Method::GET,
        &format!("/v1/customers/external/{encoded}/state"),
        None,
    )
    .await?;
    if let Some(c) = &customer {
        verify_customer(c, owner)?;
    }
    let subs = match &customer {
        Some(c) => subscriptions(c, occurred)?,
        None => json!([]),
    };
    let deleted = customer.as_ref().is_none_or(|c| !c["deleted_at"].is_null());
    save_snapshot(&mut tx, owner, subs, deleted, occurred).await?;
    tx.commit().await?;
    Ok(customer.filter(|_| !deleted))
}
pub async fn refresh_if_due(state: &State, owner: &str) -> Result<()> {
    if state.config.polar_token.is_none() {
        return Ok(());
    }
    let mut conn = state.db.acquire().await?;
    let fresh: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM billing_customers WHERE owner_id=$1 AND provider='polar' AND organization_id=$2 AND updated_at>now()-interval '60 seconds')")
        .bind(owner).bind(CATALOG.organization_id).fetch_one(&mut *conn).await?;
    if !fresh {
        sync(state, &mut conn, owner).await?;
    }
    Ok(())
}
/// Polling backs up webhooks so stale access expires even if a delivery is missed.
pub async fn refresh_due(state: &State) -> Result<()> {
    let owners: Vec<String> = sqlx::query_scalar("UPDATE billing_customers SET sync_attempted_at=now() WHERE customer_id IN (SELECT customer_id FROM billing_customers WHERE provider='polar' AND organization_id=$1 AND owner_id IS NOT NULL AND sync_attempted_at<now()-interval '60 seconds' ORDER BY sync_attempted_at LIMIT 10 FOR UPDATE SKIP LOCKED) RETURNING owner_id")
        .bind(CATALOG.organization_id).fetch_all(&state.db).await?;
    let mut tasks = tokio::task::JoinSet::new();
    for owner in owners {
        let state = state.clone();
        tasks.spawn(async move {
            let mut conn = state.db.acquire().await?;
            sync(&state, &mut conn, &owner).await.map(|_| ())
        });
    }
    while let Some(result) = tasks.join_next().await {
        if !matches!(result, Ok(Ok(()))) {
            tracing::warn!("Polar subscription refresh failed; stale access expires automatically");
        }
    }
    Ok(())
}
async fn portal(state: &State, customer: Uuid) -> Result<Value> {
    let response = required(request(state, Method::POST, "/v1/customer-sessions/", Some(json!({
        "customer_id":customer,
        "return_url":format!("{}/usage", state.config.app_url.as_str().trim_end_matches('/')),
    }))).await?)?;
    if uuid(&response["customer_id"]) != Some(customer) {
        return Err(Error::unavailable());
    }
    Ok(json!({"url":field(&response, "customer_portal_url")?}))
}
// Customer state intentionally omits past-due and paused subscriptions. They still
// require portal management and must not be bypassed by checkout/account deletion.
async fn has_subscription(state: &State, customer: Uuid, include_canceling: bool) -> Result<bool> {
    for page in 1..=100 {
        let response = required(request(state, Method::GET, &format!(
            "/v1/subscriptions/?customer_id={customer}&organization_id={}&limit=100&page={page}", CATALOG.organization_id
        ), None).await?)?;
        let rows = response["items"]
            .as_array()
            .ok_or_else(Error::unavailable)?;
        for row in rows {
            if uuid(&row["customer_id"]) != Some(customer) {
                return Err(Error::unavailable());
            }
            let status = field(row, "status")?;
            let canceling = row["cancel_at_period_end"]
                .as_bool()
                .ok_or_else(Error::unavailable)?;
            if !matches!(status, "canceled" | "unpaid" | "incomplete_expired")
                && (include_canceling || !canceling)
            {
                return Ok(true);
            }
        }
        let max_page = response["pagination"]["max_page"]
            .as_u64()
            .ok_or_else(Error::unavailable)?;
        if page >= max_page {
            return Ok(false);
        }
    }
    Err(Error::unavailable())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    events: i64,
    interval: String,
    locale: Option<String>,
}
pub struct Plan {
    pub product_id: Uuid,
    pub locale: String,
    pub allow_trial: bool,
}
pub fn select(body: Value) -> Result<Plan> {
    let selected: Selection = validation::decode(body)?;
    let locale = selected.locale.unwrap_or_else(|| "en".into());
    if !["month", "year"].contains(&selected.interval.as_str())
        || !["en", "da", "de"].contains(&locale.as_str())
    {
        return Err(Error::invalid(
            "Select an available plan and supported locale.",
        ));
    }
    let plan = CATALOG
        .plans
        .iter()
        .find(|p| p.events == selected.events && p.interval == selected.interval)
        .ok_or_else(|| Error::new(400, "invalid_plan", "Select an available plan."))?;
    if !plan.checkout_enabled {
        return Err(Error::new(
            409,
            "plan_unavailable",
            "Yearly billing is not available yet. Choose a monthly plan.",
        ));
    }
    Ok(Plan {
        product_id: plan.product_id,
        locale,
        allow_trial: plan.trial_days > 0,
    })
}
pub async fn handle(
    state: &State,
    owner: &User,
    path: &str,
    method: &str,
    body: Value,
) -> Result<Value> {
    if state.config.polar_token.is_none() {
        return Err(unconfigured());
    }
    if path.is_empty() && method == "GET" {
        refresh_if_due(state, &owner.id).await?;
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM billing_customers WHERE owner_id=$1 AND provider='polar' AND organization_id=$2 AND deleted=false)")
            .bind(&owner.id).bind(CATALOG.organization_id).fetch_one(&state.db).await?;
        return Ok(json!({"hasCustomer":exists}));
    }
    if method != "POST" {
        return Err(Error::new(405, "method_not_allowed", "Use POST."));
    }
    if path == "sync" || path == "portal" {
        let mut conn = state.db.acquire().await?;
        let customer = sync(state, &mut conn, &owner.id).await?;
        if path == "sync" {
            return usage::usage(&mut conn, &owner.id, Utc::now()).await;
        }
        let customer = customer.ok_or_else(|| {
            Error::new(
                404,
                "no_billing_customer",
                "Start a plan before opening billing.",
            )
        })?;
        return portal(state, verify_customer(&customer, &owner.id)?).await;
    }
    if path != "checkout" {
        return Err(Error::new(404, "not_found", "Endpoint not found."));
    }
    let plan = select(body)?;
    let options = json!({"locale":plan.locale,"currency":CATALOG.currency});
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT id FROM \"user\" WHERE id=$1 FOR UPDATE")
        .bind(&owner.id)
        .fetch_one(&mut *tx)
        .await?;
    let mut customer = sync(state, &mut tx, &owner.id).await?;
    // Paid plan changes and cancellations are confirmed in Polar's customer portal.
    // Never start a second checkout or perform a server-side charge for an existing plan.
    if let Some(c) = &customer
        && has_subscription(state, verify_customer(c, &owner.id)?, true).await?
    {
        let id = verify_customer(c, &owner.id)?;
        tx.commit().await?;
        return portal(state, id).await;
    }
    if let Some(c) = &customer {
        // Reuse only a checkout that Polar still reports as open and owned by this customer.
        let cached: Option<String> = sqlx::query_scalar("SELECT checkout_id FROM billing_checkouts WHERE owner_id=$1 AND provider='polar' AND organization_id=$2 AND plan_id=$3 AND created_at>now()-interval '10 minutes' AND checkout_options=$4")
            .bind(&owner.id).bind(CATALOG.organization_id).bind(plan.product_id.to_string()).bind(&options).fetch_optional(&mut *tx).await?;
        if let Some(id) = cached
            && Uuid::parse_str(&id).is_ok()
            && let Some(checkout) =
                request(state, Method::GET, &format!("/v1/checkouts/{id}"), None).await?
            && matches!(checkout["status"].as_str(), Some("open" | "confirmed"))
            && date(&checkout, "expires_at").is_some_and(|end| end > Utc::now())
            && checkout_matches(&checkout, &plan, verify_customer(c, &owner.id)?)
        {
            let url = field(&checkout, "url")?.to_owned();
            tx.commit().await?;
            return Ok(json!({"url":url}));
        }
    }
    if customer.is_none() {
        let created = required(
            request(
                state,
                Method::POST,
                "/v1/customers/",
                Some(json!({
                    "external_id":owner.id,
                    "email":owner.email, "name":owner.name, "locale":plan.locale,
                })),
            )
            .await?,
        )?;
        verify_customer(&created, &owner.id)?;
        customer = Some(created);
    }
    let customer_id = verify_customer(customer.as_ref().expect("created customer"), &owner.id)?;
    let app = state.config.app_url.as_str().trim_end_matches('/');
    let response = required(request(state, Method::POST, "/v1/checkouts/", Some(json!({
        "products":[plan.product_id], "customer_id":customer_id, "external_customer_id":owner.id,
        "currency":CATALOG.currency, "locale":plan.locale, "allow_trial":plan.allow_trial,
        "success_url":format!("{app}/usage?checkout_id={{CHECKOUT_ID}}"), "return_url":format!("{app}/usage"),
    }))).await?)?;
    if !checkout_matches(&response, &plan, customer_id) {
        return Err(Error::unavailable());
    }
    let id = uuid(&response["id"]).ok_or_else(Error::unavailable)?;
    let url = field(&response, "url")?;
    sqlx::query("INSERT INTO billing_checkouts(owner_id,checkout_id,provider,organization_id,plan_id,checkout_url,created_at,checkout_options) VALUES($1,$2,'polar',$3,$4,$5,now(),$6) ON CONFLICT(owner_id) DO UPDATE SET checkout_id=excluded.checkout_id,provider=excluded.provider,organization_id=excluded.organization_id,plan_id=excluded.plan_id,checkout_url=excluded.checkout_url,created_at=excluded.created_at,checkout_options=excluded.checkout_options")
        .bind(&owner.id).bind(id.to_string()).bind(CATALOG.organization_id).bind(plan.product_id.to_string()).bind(url).bind(&options).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(json!({"url":url}))
}
fn checkout_matches(checkout: &Value, plan: &Plan, customer: Uuid) -> bool {
    uuid(&checkout["product_id"]) == Some(plan.product_id)
        && uuid(&checkout["customer_id"]) == Some(customer)
        && checkout["currency"] == CATALOG.currency
}
pub async fn ensure_deletable(state: &State, owner: &str) -> Result<()> {
    // Missing credentials must not bypass a cached subscription that can still renew.
    let mut conn = state.db.acquire().await?;
    if state.config.polar_token.is_none() {
        let cached: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM billing_customers WHERE owner_id=$1 AND provider='polar' AND organization_id=$2 AND deleted=false)")
            .bind(owner).bind(CATALOG.organization_id).fetch_one(&mut *conn).await?;
        return if cached { Err(unconfigured()) } else { Ok(()) };
    }
    if let Some(customer) = sync(state, &mut conn, owner).await?
        && has_subscription(state, verify_customer(&customer, owner)?, false).await?
    {
        return Err(Error::new(
            409,
            "cancel_subscription_first",
            "Cancel your subscription in Usage → Manage billing before deleting your account.",
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "provider_tests.rs"]
mod tests;

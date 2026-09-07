use super::{
    ORGANIZATION_ID,
    allowance::{CATALOG, Subscription},
    usage,
};
use analytics_core::{Error, Result, State, models::User, validation};
use chrono::{DateTime, Utc};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgConnection;

pub async fn request(
    state: &State,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Option<Value>> {
    let token = state.config.polar_token.as_deref().ok_or_else(|| {
        Error::new(
            503,
            "billing_unconfigured",
            "Billing is temporarily unavailable.",
        )
    })?;
    let mut req = state
        .http
        .request(
            method,
            format!("{}{path}", state.config.polar_url.trim_end_matches('/')),
        )
        .bearer_auth(token);
    if let Some(body) = body {
        req = req.json(&body)
    }
    let response = req.send().await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        tracing::error!(
            status = response.status().as_u16(),
            "billing provider request failed"
        );
        return Err(Error::unavailable());
    }
    Ok(Some(response.json().await?))
}
fn required(value: Option<Value>) -> Result<Value> {
    value.ok_or_else(Error::unavailable)
}
fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().ok_or_else(Error::unavailable)
}
fn date(value: &Value, key: &str) -> Option<DateTime<Utc>> {
    value[key].as_str()?.parse().ok()
}
pub fn subscriptions(value: &Value) -> Result<Value> {
    let rows = value["active_subscriptions"]
        .as_array()
        .ok_or_else(|| Error::new(400, "invalid_webhook", "Invalid subscription state."))?;
    let mut subscriptions = vec![];
    for row in rows {
        let normalized = json!({"id":row["id"],"productId":row["product_id"],"status":row["status"],"currentPeriodStart":row["current_period_start"],"currentPeriodEnd":row["current_period_end"],"trialEnd":row["trial_end"],"cancelAtPeriodEnd":row["cancel_at_period_end"],"endsAt":row["ends_at"]});
        serde_json::from_value::<Subscription>(normalized.clone())
            .map_err(|_| Error::new(400, "invalid_webhook", "Invalid subscription state."))?;
        subscriptions.push(normalized);
    }
    Ok(json!(subscriptions))
}
pub async fn save_snapshot(
    conn: &mut PgConnection,
    customer: &str,
    owner: Option<&str>,
    subscriptions: Value,
    deleted: bool,
    occurred: DateTime<Utc>,
) -> Result<bool> {
    let n=sqlx::query("INSERT INTO billing_customers(customer_id,owner_id,subscriptions,deleted,occurred_at,updated_at) VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(customer_id) DO UPDATE SET owner_id=excluded.owner_id,subscriptions=excluded.subscriptions,deleted=excluded.deleted,occurred_at=excluded.occurred_at,updated_at=excluded.updated_at WHERE billing_customers.occurred_at < excluded.occurred_at")
 .bind(customer).bind(owner).bind(subscriptions).bind(deleted).bind(occurred).execute(conn).await?.rows_affected();
    Ok(n > 0)
}
pub async fn sync(state: &State, conn: &mut PgConnection, owner: &str) -> Result<Option<Value>> {
    let occurred = Utc::now();
    let path = format!(
        "/v1/customers/external/{}/state",
        utf8_percent_encode(owner, NON_ALPHANUMERIC)
    );
    let Some(customer) = request(state, Method::GET, &path, None).await? else {
        sqlx::query("UPDATE billing_customers SET deleted=true,subscriptions='[]'::jsonb,occurred_at=$1,updated_at=now() WHERE owner_id=$2 AND occurred_at < $1").bind(occurred).bind(owner).execute(conn).await?;
        return Ok(None);
    };
    if customer["organization_id"] != ORGANIZATION_ID || customer["external_id"] != owner {
        return Err(Error::new(
            502,
            "invalid_billing_customer",
            "Billing customer could not be verified.",
        ));
    }
    let deleted = !customer["deleted_at"].is_null();
    let subs = if deleted {
        json!([])
    } else {
        subscriptions(&customer)?
    };
    save_snapshot(
        conn,
        field(&customer, "id")?,
        Some(owner),
        subs,
        deleted,
        occurred,
    )
    .await?;
    Ok(Some(customer))
}
async fn portal(state: &State, owner: &str) -> Result<Value> {
    let response=required(request(state,Method::POST,"/v1/customer-sessions/",Some(json!({"external_customer_id":owner,"return_url":format!("{}/usage",state.config.app_url.as_str().trim_end_matches('/'))}))).await?)?;
    Ok(json!({"url":field(&response,"customer_portal_url")?}))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    events: i64,
    interval: String,
    locale: Option<String>,
}
pub struct Plan {
    pub product_id: String,
    pub locale: String,
    pub allow_trial: bool,
}
pub fn select(body: Value) -> Result<Plan> {
    let selected: Selection = validation::decode(body)?;
    let locale = selected.locale.unwrap_or_else(|| "en".into());
    if selected.interval != "month" || !["en", "da", "de"].contains(&locale.as_str()) {
        return Err(Error::invalid(
            "Select a monthly plan and supported locale.",
        ));
    }
    let product = CATALOG["products"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| {
            p["metadata"]["plan"] == "pro"
                && p["metadata"]["monthly_events"] == selected.events
                && p["recurring_interval"] == "month"
                && p["is_archived"] == false
        })
        .ok_or_else(|| Error::new(400, "invalid_plan", "Select an available monthly plan."))?;
    Ok(Plan {
        product_id: field(product, "id")?.into(),
        locale,
        allow_trial: selected.events == 100000,
    })
}
fn valid_open(current: &Value, owner: &str, plan: &Plan) -> bool {
    current["organization_id"] == ORGANIZATION_ID
        && current["external_customer_id"] == owner
        && current["status"] == "open"
        && date(current, "expires_at").is_some_and(|d| d > Utc::now())
        && current["products"].as_array().is_some_and(|p| p.len() == 1)
        && current["product_id"] == plan.product_id
}
async fn verified_checkout(state: &State, mut checkout: Value, plan: &Plan) -> Result<Value> {
    if !plan.allow_trial && checkout["allow_trial"] != false {
        checkout = required(
            request(
                state,
                Method::PATCH,
                &format!(
                    "/v1/checkouts/{}",
                    utf8_percent_encode(field(&checkout, "id")?, NON_ALPHANUMERIC)
                ),
                Some(json!({"allow_trial":false})),
            )
            .await?,
        )?;
    }
    Ok(json!({"url":field(&checkout,"url")?}))
}
pub async fn handle(
    state: &State,
    owner: &User,
    path: &str,
    method: &str,
    body: Value,
) -> Result<Value> {
    if state.config.polar_token.is_none() {
        return Err(Error::new(
            503,
            "billing_unconfigured",
            "Billing is temporarily unavailable.",
        ));
    }
    if path.is_empty() && method == "GET" {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM billing_customers WHERE owner_id=$1 AND deleted=false)",
        )
        .bind(&owner.id)
        .fetch_one(&state.db)
        .await?;
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
        if customer.is_none_or(|c| !c["deleted_at"].is_null()) {
            return Err(Error::new(
                404,
                "no_billing_customer",
                "Start a plan before opening billing.",
            ));
        }
        return portal(state, &owner.id).await;
    }
    if path != "checkout" {
        return Err(Error::new(404, "not_found", "Endpoint not found."));
    }
    let plan = select(body)?;
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT id FROM \"user\" WHERE id=$1 FOR UPDATE")
        .bind(&owner.id)
        .fetch_one(&mut *tx)
        .await?;
    let customer = sync(state, &mut tx, &owner.id).await?;
    if customer.as_ref().is_some_and(|c| {
        c["active_subscriptions"]
            .as_array()
            .is_some_and(|s| !s.is_empty())
    }) {
        let result = portal(state, &owner.id).await?;
        tx.commit().await?;
        return Ok(result);
    }
    let saved: Option<String> =
        sqlx::query_scalar("SELECT checkout_id FROM billing_checkouts WHERE owner_id=$1")
            .bind(&owner.id)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some(id) = saved
        && let Some(current) = request(
            state,
            Method::GET,
            &format!(
                "/v1/checkouts/{}",
                utf8_percent_encode(&id, NON_ALPHANUMERIC)
            ),
            None,
        )
        .await?
        && current["organization_id"] == ORGANIZATION_ID
        && current["external_customer_id"] == owner.id
    {
        if ["confirmed", "succeeded"].contains(&current["status"].as_str().unwrap_or(""))
            && date(&current, "created_at").is_some_and(|d| (Utc::now() - d).num_seconds() < 300)
        {
            return Err(Error::new(
                409,
                "billing_pending",
                "Your checkout is being activated. Return to Usage and refresh shortly.",
            ));
        }
        if valid_open(&current, &owner.id, &plan) {
            let result = verified_checkout(state, current, &plan).await?;
            tx.commit().await?;
            return Ok(result);
        }
    }
    let recovered=required(request(state,Method::GET,&format!("/v1/checkouts/?external_customer_id={}&organization_id={ORGANIZATION_ID}&status=open&limit=100",utf8_percent_encode(&owner.id,NON_ALPHANUMERIC)),None).await?)?;
    if let Some(open) = recovered["items"]
        .as_array()
        .and_then(|items| items.iter().find(|c| valid_open(c, &owner.id, &plan)))
    {
        sqlx::query("INSERT INTO billing_checkouts(owner_id,checkout_id) VALUES($1,$2) ON CONFLICT(owner_id) DO UPDATE SET checkout_id=excluded.checkout_id").bind(&owner.id).bind(field(open,"id")?).execute(&mut *tx).await?;
        let result = verified_checkout(state, open.clone(), &plan).await?;
        tx.commit().await?;
        return Ok(result);
    }
    let product = required(
        request(
            state,
            Method::GET,
            &format!("/v1/products/{}", plan.product_id),
            None,
        )
        .await?,
    )?;
    if product["organization_id"] != ORGANIZATION_ID
        || product["is_archived"] != false
        || product["visibility"] == "draft"
    {
        return Err(Error::new(
            409,
            "plan_unavailable",
            "This plan is not available yet.",
        ));
    }
    let customer = match customer {
        Some(c) => c,
        None => required(
            request(
                state,
                Method::POST,
                "/v1/customers/",
                Some(json!({"external_id":owner.id,"email":owner.email,"name":owner.name})),
            )
            .await?,
        )?,
    };
    let app = state.config.app_url.as_str().trim_end_matches('/');
    let checkout=required(request(state,Method::POST,"/v1/checkouts/",Some(json!({"products":[plan.product_id],"allow_trial":plan.allow_trial,"customer_id":field(&customer,"id")?,"external_customer_id":owner.id,"customer_email":owner.email,"customer_name":owner.name,"success_url":format!("{app}/usage?checkout_id={{CHECKOUT_ID}}"),"return_url":format!("{app}/usage"),"locale":plan.locale}))).await?)?;
    sqlx::query("INSERT INTO billing_checkouts(owner_id,checkout_id) VALUES($1,$2) ON CONFLICT(owner_id) DO UPDATE SET checkout_id=excluded.checkout_id").bind(&owner.id).bind(field(&checkout,"id")?).execute(&mut *tx).await?;
    let result = json!({"url":field(&checkout,"url")?});
    tx.commit().await?;
    Ok(result)
}
pub async fn ensure_deletable(state: &State, owner: &str) -> Result<()> {
    if state.config.polar_token.is_none() {
        return Ok(());
    }
    let mut conn = state.db.acquire().await?;
    if sync(state, &mut conn, owner)
        .await?
        .as_ref()
        .is_some_and(|s| {
            s["active_subscriptions"]
                .as_array()
                .is_some_and(|a| a.iter().any(|s| s["cancel_at_period_end"] != true))
        })
    {
        return Err(Error::new(
            409,
            "cancel_subscription_first",
            "Cancel your subscription in Usage → Manage billing before deleting your account.",
        ));
    }
    Ok(())
}

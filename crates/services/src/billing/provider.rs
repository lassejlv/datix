use super::{
    allowance::{CATALOG, Entitlements, Subscription},
    usage,
};
use analytics_core::{Error, Result, State, models::User, validation};
use chrono::{DateTime, Utc};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Connection, PgConnection};

pub async fn request(
    state: &State,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Option<Value>> {
    let token = state.config.autumn_key.as_deref().ok_or_else(|| {
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
            format!("{}{path}", state.config.autumn_url.trim_end_matches('/')),
        )
        .bearer_auth(token)
        .header("x-api-version", "2.2")
        .timeout(std::time::Duration::from_secs(10));
    if let Some(body) = body {
        req = req.json(&body);
    }
    let response = req.send().await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        tracing::error!(status = response.status().as_u16(), "Autumn request failed");
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
    DateTime::from_timestamp_millis(value[key].as_i64()?)
}

fn units(value: &Value) -> Option<i64> {
    let n = value.as_f64()?;
    (n.is_finite() && n >= 0.0 && n < (i64::MAX / 100) as f64)
        .then_some((n * 100.0).round() as i64)
}
fn entitlements(customer: &Value, row: &Value, start: DateTime<Utc>, end: DateTime<Utc>) -> Option<Entitlements> {
    let events = &customer["balances"]["events"];
    let websites = &customer["balances"]["websites"];
    if events["feature_id"] != "events" || websites["feature_id"] != "websites" { return None; }
    let unlimited = events["unlimited"].as_bool()?;
    let event_limit = if unlimited { None } else { Some(units(&events["granted"])? ) };
    let remaining = if unlimited { None } else { Some(units(&events["remaining"])? ) };
    let website_limit = if websites["unlimited"].as_bool()? { None } else { Some(websites["granted"].as_i64()?.max(0)) };
    let reset = date(events, "next_reset_at");
    if !events["next_reset_at"].is_null() && reset.is_none() { return None; }
    let period_end = reset.unwrap_or(end);
    let origin = date(row, "started_at").unwrap_or(start);
    let interval = events["breakdown"].as_array().and_then(|rows| rows.iter().find_map(|r| r["reset"]["interval"].as_str()));
    let period_start = match interval {
        Some("day") => period_end - chrono::Duration::days(1),
        Some("week") => period_end - chrono::Duration::weeks(1),
        Some("quarter") => period_end.checked_sub_months(chrono::Months::new(3))?,
        Some("year") => period_end.checked_sub_months(chrono::Months::new(12))?,
        Some("month") => {
            // Preserve the provider's original month-end anchor where it matches this reset.
            let anchor = Subscription { id: String::new(), product_id: String::new(), status: "active".into(), current_period_start: Some(origin), current_period_end: period_end, trial_end: None, cancel_at_period_end: false, ends_at: None, entitlements: None };
            super::allowance::period(&anchor, period_end - chrono::Duration::milliseconds(1))?.start
        }
        None if reset.is_none() => origin,
        _ => return None,
    };
    Some(Entitlements { name: row["plan"]["name"].as_str()?.to_owned(), event_limit, website_limit,
        used: units(&events["usage"])?, remaining, local_baseline: 0, pending: 0, period_start, period_end })
}

pub fn subscriptions(value: &Value) -> Result<Value> {
    let rows = value["subscriptions"]
        .as_array()
        .ok_or_else(Error::unavailable)?;
    let mut subscriptions = vec![];
    // A subscription alone is insufficient when its analytics entitlement has been revoked.
    let flag = &value["flags"]["analytics"];
    let flag_expiry = date(flag, "expires_at");
    if !flag.is_object()
        || flag["feature_id"] != "analytics"
        || (!flag["expires_at"].is_null() && flag_expiry.is_none())
        || flag_expiry.is_some_and(|expiry| expiry <= Utc::now())
    {
        return Ok(json!([]));
    }
    for row in rows {
        if row["status"] != "active" || row["past_due"] == true || row["scope"] == "entity" {
            continue;
        }
        let Some(start) = date(row, "current_period_start") else {
            continue;
        };
        let Some(end) = date(row, "current_period_end") else {
            continue;
        };
        let Some(entitlements) = entitlements(value, row, start, end) else { continue; };
        let trial = date(row, "trial_ends_at");
        let status = if trial.is_some_and(|t| t > Utc::now()) {
            "trialing"
        } else {
            "active"
        };
        let ends_at = match (date(row, "expires_at"), flag_expiry) {
            (Some(subscription), Some(flag)) => Some(subscription.min(flag)),
            (subscription, flag) => subscription.or(flag),
        };
        let normalized = json!({"id":row["id"],"productId":row["plan_id"],"status":status,"currentPeriodStart":start,"currentPeriodEnd":end,"trialEnd":trial,"cancelAtPeriodEnd":!row["canceled_at"].is_null(),"endsAt":ends_at,"entitlements":entitlements});
        serde_json::from_value::<Subscription>(normalized.clone())
            .map_err(|_| Error::unavailable())?;
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
    let n=sqlx::query("INSERT INTO billing_customers(customer_id,owner_id,subscriptions,deleted,occurred_at,updated_at,provider,sync_attempted_at) VALUES($1,$2,$3,$4,$5,$5,'autumn',$5) ON CONFLICT(customer_id) DO UPDATE SET owner_id=excluded.owner_id,subscriptions=excluded.subscriptions,deleted=excluded.deleted,occurred_at=excluded.occurred_at,updated_at=excluded.updated_at,sync_attempted_at=excluded.sync_attempted_at WHERE billing_customers.provider='autumn' AND billing_customers.occurred_at < excluded.occurred_at")
        .bind(customer).bind(owner).bind(subscriptions).bind(deleted).bind(occurred).execute(conn).await?.rows_affected();
    Ok(n > 0)
}
pub async fn sync(state: &State, conn: &mut PgConnection, owner: &str) -> Result<Option<Value>> {
    let mut tx = conn.begin().await?;
    sqlx::query("SELECT id FROM \"user\" WHERE id=$1 FOR UPDATE").bind(owner).fetch_optional(&mut *tx).await?;
    let occurred = Utc::now();
    let customer = request(
        state,
        Method::POST,
        "/v1/customers.get",
        Some(json!({"customer_id":owner,"expand":["subscriptions.plan"]})),
    )
    .await?;
    if let Some(c) = &customer
        && c["id"] != owner
    {
        return Err(Error::new(
            502,
            "invalid_billing_customer",
            "Billing customer could not be verified.",
        ));
    }
    let mut subs = match &customer {
        Some(c) => subscriptions(c)?,
        None => json!([]),
    };
    if let Some(rows) = subs.as_array_mut() {
        for row in rows {
            let mut subscription: Subscription = serde_json::from_value(row.clone()).map_err(|_| Error::unavailable())?;
            if let Some(e) = &mut subscription.entitlements {
                e.local_baseline = sqlx::query_scalar("SELECT coalesce(sum(events)*100,0)::bigint FROM billing_usage WHERE owner_id=$1 AND period_start=$2")
                    .bind(owner).bind(e.period_start).fetch_one(&mut *tx).await?;
                e.pending = sqlx::query_scalar("SELECT coalesce(sum(event_count)*100,0)::bigint FROM billing_outbox WHERE owner_id=$1 AND provider='autumn' AND occurred_at >= $2 AND occurred_at < $3")
                    .bind(owner).bind(e.period_start).bind(e.period_end).fetch_one(&mut *tx).await?;
            }
            *row = json!(subscription);
        }
    }
    save_snapshot(
        &mut tx,
        &format!("autumn:{owner}"),
        Some(owner),
        subs,
        customer.is_none(),
        occurred,
    )
    .await?;
    tx.commit().await?;
    Ok(customer)
}
pub async fn refresh_if_due(state: &State, owner: &str) -> Result<()> {
    if state.config.autumn_key.is_none() {
        return Ok(());
    }
    let mut conn = state.db.acquire().await?;
    let fresh:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM billing_customers WHERE owner_id=$1 AND provider='autumn' AND updated_at>now()-interval '60 seconds')").bind(owner).fetch_one(&mut *conn).await?;
    if !fresh {
        sync(state, &mut conn, owner).await?;
    }
    Ok(())
}
/// The worker keeps cached access current even when the dashboard is closed.
pub async fn refresh_due(state: &State) -> Result<()> {
    let owners:Vec<String>=sqlx::query_scalar("UPDATE billing_customers SET sync_attempted_at=now() WHERE customer_id IN (SELECT customer_id FROM billing_customers WHERE provider='autumn' AND owner_id IS NOT NULL AND sync_attempted_at<now()-interval '60 seconds' ORDER BY sync_attempted_at LIMIT 10 FOR UPDATE SKIP LOCKED) RETURNING owner_id").fetch_all(&state.db).await?;
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
            tracing::warn!(
                "Autumn subscription refresh failed; stale access expires automatically"
            );
        }
    }
    Ok(())
}
async fn portal(state: &State, owner: &str) -> Result<Value> {
    let response=required(request(state,Method::POST,"/v1/billing.open_customer_portal",Some(json!({"customer_id":owner,"return_url":format!("{}/usage",state.config.app_url.as_str().trim_end_matches('/'))}))).await?)?;
    Ok(json!({"url":field(&response,"url")?}))
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
    pub currency: &'static str,
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
    let plan = CATALOG["plans"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["events"] == selected.events && p["interval"] == selected.interval)
        .ok_or_else(|| Error::new(400, "invalid_plan", "Select an available plan."))?;
    Ok(Plan {
        product_id: field(plan, "id")?.into(),
        currency: match locale.as_str() {
            "da" => "dkk",
            "de" => "eur",
            _ => "usd",
        },
        locale,
        allow_trial: selected.events == 100000,
    })
}
pub async fn handle(
    state: &State,
    owner: &User,
    path: &str,
    method: &str,
    body: Value,
) -> Result<Value> {
    if state.config.autumn_key.is_none() {
        return Err(Error::new(
            503,
            "billing_unconfigured",
            "Billing is temporarily unavailable.",
        ));
    }
    if path.is_empty() && method == "GET" {
        refresh_if_due(state, &owner.id).await?;
        let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM billing_customers WHERE owner_id=$1 AND provider='autumn' AND deleted=false)").bind(&owner.id).fetch_one(&state.db).await?;
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
        if customer.is_none() {
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
    let checkout_options =
        json!({"locale":plan.locale,"currency":plan.currency,"managed_payments":{"enabled":true}});
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT id FROM \"user\" WHERE id=$1 FOR UPDATE")
        .bind(&owner.id)
        .fetch_one(&mut *tx)
        .await?;
    let customer = sync(state, &mut tx, &owner.id).await?;
    let has_active = customer.as_ref().is_some_and(|c| {
        c["subscriptions"]
            .as_array()
            .is_some_and(|rows| rows.iter().any(|r| r["status"] == "active"))
    });
    if customer.as_ref().is_some_and(|c| {
        c["subscriptions"].as_array().is_some_and(|rows| {
            rows.iter()
                .any(|r| r["status"] == "active" && r["plan_id"] == plan.product_id)
        })
    }) {
        tx.commit().await?;
        return portal(state, &owner.id).await;
    }
    if !has_active {
        let cached: Option<String> = sqlx::query_scalar("SELECT checkout_url FROM billing_checkouts WHERE owner_id=$1 AND provider='autumn' AND plan_id=$2 AND checkout_url IS NOT NULL AND created_at>now()-interval '10 minutes' AND checkout_options=$3")
            .bind(&owner.id).bind(&plan.product_id).bind(&checkout_options).fetch_optional(&mut *tx).await?;
        if let Some(url) = cached {
            tx.commit().await?;
            return Ok(json!({"url":url}));
        }
    }
    if customer.is_none() {
        required(
            request(
                state,
                Method::POST,
                "/v1/customers.get_or_create",
                Some(json!({"customer_id":owner.id,"email":owner.email,"name":owner.name})),
            )
            .await?,
        )?;
    }
    // Always require a hosted confirmation, including upgrades with a saved card.
    let app = state.config.app_url.as_str().trim_end_matches('/');
    let response=required(request(state,Method::POST,"/v1/billing.attach",Some(json!({"customer_id":owner.id,"plan_id":plan.product_id,"currency":plan.currency,"redirect_mode":"always","success_url":format!("{app}/usage?checkout_id=autumn"),"checkout_session_params":checkout_options}))).await?)?;
    let url = field(&response, "payment_url")?;
    sqlx::query("INSERT INTO billing_checkouts(owner_id,checkout_id,provider,plan_id,checkout_url,created_at,checkout_options) VALUES($1,$2,'autumn',$3,$4,now(),$5) ON CONFLICT(owner_id) DO UPDATE SET checkout_id=excluded.checkout_id,provider=excluded.provider,plan_id=excluded.plan_id,checkout_url=excluded.checkout_url,created_at=excluded.created_at,checkout_options=excluded.checkout_options")
        .bind(&owner.id).bind(uuid::Uuid::new_v4().to_string()).bind(&plan.product_id).bind(url).bind(&checkout_options).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(json!({"url":url}))
}
pub async fn ensure_deletable(state: &State, owner: &str) -> Result<()> {
    if state.config.autumn_key.is_none() {
        return Ok(());
    }
    let mut conn = state.db.acquire().await?;
    if sync(state, &mut conn, owner)
        .await?
        .as_ref()
        .is_some_and(|s| {
            s["subscriptions"].as_array().is_some_and(|a| {
                a.iter()
                    .any(|s| s["status"] == "active" && s["canceled_at"].is_null())
            })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_current_account_entitlements_grant_access() {
        let now = Utc::now();
        let customer = json!({
            "flags":{"analytics":{"feature_id":"analytics"}},
            "subscriptions":[{"id":"sub","plan_id":"basic","status":"active",
                "current_period_start":now.timestamp_millis(),
                "current_period_end":(now+chrono::Duration::days(30)).timestamp_millis(),
                "trial_ends_at":(now+chrono::Duration::days(14)).timestamp_millis()}]
        });
        assert_eq!(subscriptions(&customer).unwrap()[0]["status"], "trialing");
        for (field, value) in [
            ("status", json!("scheduled")),
            ("past_due", json!(true)),
            ("scope", json!("entity")),
            ("current_period_end", Value::Null),
        ] {
            let mut revoked = customer.clone();
            revoked["subscriptions"][0][field] = value;
            assert_eq!(subscriptions(&revoked).unwrap(), json!([]));
        }
        let mut expires = customer.clone();
        expires["flags"]["analytics"]["expires_at"] =
            json!((now - chrono::Duration::seconds(1)).timestamp_millis());
        assert_eq!(subscriptions(&expires).unwrap(), json!([]));
        let future = now + chrono::Duration::hours(1);
        expires["flags"]["analytics"]["expires_at"] = json!(future.timestamp_millis());
        let normalized: Subscription =
            serde_json::from_value(subscriptions(&expires).unwrap()[0].clone()).unwrap();
        assert_eq!(
            normalized.ends_at.unwrap().timestamp_millis(),
            future.timestamp_millis()
        );
        let mut revoked = customer;
        revoked["flags"] = json!({});
        assert_eq!(subscriptions(&revoked).unwrap(), json!([]));
    }
}

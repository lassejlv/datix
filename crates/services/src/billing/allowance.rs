use chrono::{DateTime, Datelike, Months, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::LazyLock;

pub static CATALOG: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../../config/polar-catalog.json"))
        .expect("checked-in catalog")
});
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub id: String,
    pub product_id: String,
    pub status: String,
    pub current_period_start: Option<DateTime<Utc>>,
    pub current_period_end: DateTime<Utc>,
    pub trial_end: Option<DateTime<Utc>>,
    pub cancel_at_period_end: bool,
    pub ends_at: Option<DateTime<Utc>>,
}
#[derive(Clone, Debug, Serialize)]
pub struct Period {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
}
#[derive(Clone, Debug)]
pub struct Allowance {
    pub event_limit: i64,
    pub trial: bool,
    pub period: Period,
    pub subscription: Subscription,
}
pub fn period(subscription: &Subscription, now: DateTime<Utc>) -> Option<Period> {
    let origin = subscription.current_period_start?;
    let mut end = subscription.current_period_end;
    if subscription.status == "trialing"
        && let Some(trial) = subscription.trial_end
    {
        end = end.min(trial)
    }
    if let Some(ends) = subscription.ends_at {
        end = end.min(ends)
    }
    if now < origin || now >= end {
        return None;
    }
    let mut months = (now.year() - origin.year()) * 12 + now.month() as i32 - origin.month() as i32;
    if origin.checked_add_months(Months::new(months as u32))? > now {
        months -= 1;
    }
    let start = origin.checked_add_months(Months::new(months as u32))?;
    let end = origin
        .checked_add_months(Months::new(months as u32 + 1))?
        .min(end);
    Some(Period { start, end })
}
pub fn active(subscriptions: Vec<Subscription>, now: DateTime<Utc>) -> Option<Allowance> {
    let products = CATALOG["products"].as_array()?;
    subscriptions
        .into_iter()
        .filter_map(|subscription| {
            if !["active", "trialing"].contains(&subscription.status.as_str()) {
                return None;
            }
            let product = products.iter().find(|p| {
                p["id"] == subscription.product_id
                    && p["is_archived"] == false
                    && p["metadata"]["plan"] == "pro"
            })?;
            let period = period(&subscription, now)?;
            Some(Allowance {
                event_limit: product["metadata"]["monthly_events"].as_i64()?,
                trial: subscription.status == "trialing",
                period,
                subscription,
            })
        })
        .max_by(|a, b| {
            a.event_limit
                .cmp(&b.event_limit)
                .then(a.period.start.cmp(&b.period.start))
        })
}

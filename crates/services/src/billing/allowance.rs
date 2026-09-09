use chrono::{DateTime, Datelike, Months, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::LazyLock;

pub static CATALOG: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../../config/autumn-catalog.json"))
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
    #[serde(default)]
    pub entitlements: Option<Entitlements>,
}
/// Customer balances, never the public plan template. Amounts use hundredths of a credit.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entitlements {
    pub name: String,
    pub event_limit: Option<i64>,
    pub website_limit: Option<i64>,
    pub used: i64,
    pub remaining: Option<i64>,
    pub local_baseline: i64,
    pub pending: i64,
    pub period_start: DateTime<Utc>,
    pub period_end: DateTime<Utc>,
}
#[derive(Clone, Debug, Serialize)]
pub struct Period {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
}
#[derive(Clone, Debug)]
pub struct Allowance {
    pub event_limit: Option<i64>,
    pub website_limit: Option<i64>,
    pub trial: bool,
    pub period: Period,
    pub subscription: Subscription,
}
pub fn period(subscription: &Subscription, now: DateTime<Utc>) -> Option<Period> {
    if let Some(e) = &subscription.entitlements {
        let end = e
            .period_end
            .min(subscription.current_period_end)
            .min(subscription.ends_at.unwrap_or(e.period_end))
            .min(
                subscription
                    .trial_end
                    .filter(|_| subscription.status == "trialing")
                    .unwrap_or(e.period_end),
            );
        return (now >= e.period_start && now < end).then_some(Period {
            start: e.period_start,
            end,
        });
    }
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
    subscriptions
        .into_iter()
        .filter_map(|subscription| {
            if !["active", "trialing"].contains(&subscription.status.as_str()) {
                return None;
            }
            let e = subscription.entitlements.as_ref()?;
            if e.name.trim().is_empty()
                || e.event_limit.is_some_and(|v| v < 0)
                || e.website_limit.is_some_and(|v| v < 0)
                || e.used < 0
                || e.pending < 0
                || e.local_baseline < 0
                || e.event_limit.is_some() != e.remaining.is_some()
            {
                return None;
            }
            let period = period(&subscription, now)?;
            Some(Allowance {
                event_limit: e.event_limit,
                website_limit: e.website_limit,
                trial: subscription.status == "trialing",
                period,
                subscription,
            })
        })
        .max_by(|a, b| {
            a.event_limit
                .unwrap_or(i64::MAX)
                .cmp(&b.event_limit.unwrap_or(i64::MAX))
                .then(a.period.start.cmp(&b.period.start))
        })
}

impl Allowance {
    pub fn used(&self, local: i64) -> i64 {
        let e = self
            .subscription
            .entitlements
            .as_ref()
            .expect("active entitlement");
        e.used.saturating_add(self.reserved(local))
    }
    fn reserved(&self, local: i64) -> i64 {
        let e = self
            .subscription
            .entitlements
            .as_ref()
            .expect("active entitlement");
        e.pending
            .saturating_add(local.saturating_sub(e.local_baseline).max(0))
    }
    pub fn remaining(&self, local: i64) -> Option<i64> {
        self.subscription
            .entitlements
            .as_ref()
            .expect("active entitlement")
            .remaining
            .map(|v| v.saturating_sub(self.reserved(local)).max(0))
    }
    pub fn permits_website(&self, position: i64) -> bool {
        self.website_limit.is_none_or(|limit| position < limit)
    }
}

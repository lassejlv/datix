//! The collection endpoint needs one admission snapshot, not a serialized account dashboard.
use super::allowance;
use analytics_core::{Error, Result, State};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

#[derive(sqlx::FromRow)]
pub struct Admission {
    pub tracking_mode: String,
    pub tracking_settings: Value,
    pub domain: String,
    pub allow_localhost: bool,
    credit_budget: Option<String>,
    site_position: i64,
    subscriptions: Value,
    usage: Value,
}
#[derive(Deserialize)]
struct Usage {
    site: Uuid,
    start: DateTime<Utc>,
    units: i64,
}

pub async fn load(state: &State, site: Uuid, environment: Uuid) -> Result<Admission> {
    let mut conn = state.acquire().await?;
    sqlx::query_as::<_, Admission>(include_str!("sql/admission.sql"))
        .bind(site)
        .bind(environment)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| Error::new(404, "site_not_found", "Website is unavailable."))
}
impl Admission {
    pub fn pause_reason(&self, site: Uuid, now: DateTime<Utc>) -> Result<Option<&'static str>> {
        let subscriptions =
            serde_json::from_value(self.subscriptions.clone()).map_err(|_| Error::unavailable())?;
        let Some(active) = allowance::active(subscriptions, now) else {
            return Ok(Some("subscription_required"));
        };
        let rows: Vec<Usage> =
            serde_json::from_value(self.usage.clone()).map_err(|_| Error::unavailable())?;
        let mut total = 0;
        let mut site_used = 0;
        for row in rows
            .into_iter()
            .filter(|row| row.start == active.period.start)
        {
            total += row.units;
            if row.site == site {
                site_used += row.units;
            }
        }
        Ok(if active.remaining(total).is_some_and(|r| r < 15) {
            Some("event_limit")
        } else if !active.permits_website(self.site_position) {
            Some("website_limit")
        } else if super::usage::budget_units(&self.credit_budget)
            .is_some_and(|budget| budget - site_used < 15)
        {
            Some("website_budget")
        } else {
            None
        })
    }
}

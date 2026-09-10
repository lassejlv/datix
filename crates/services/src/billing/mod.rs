pub mod admission;
pub mod allowance;
pub mod catalog;
pub mod delivery;
pub mod provider;
pub mod usage;
pub mod webhook;
pub use usage::account_usage;

pub fn subscription_required() -> analytics_core::Error {
    analytics_core::Error::new(402, "subscription_required", "Choose a plan to continue.")
}

pub async fn require_subscription(
    state: &analytics_core::State,
    owner: &str,
) -> analytics_core::Result<()> {
    provider::refresh_if_due(state, owner).await?;
    let mut conn = state.db.acquire().await?;
    usage::active_allowance(&mut conn, owner, chrono::Utc::now())
        .await?
        .ok_or_else(subscription_required)?;
    Ok(())
}

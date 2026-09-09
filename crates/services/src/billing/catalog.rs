use serde::Deserialize;
use std::sync::LazyLock;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub organization_id: Uuid,
    pub currency: String,
    pub api_version: String,
    pub meter: Meter,
    pub analytics_benefit_id: Uuid,
    pub websites_benefit_id: Uuid,
    pub plans: Vec<Plan>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meter {
    pub id: Uuid,
    pub event_name: String,
    pub quantity_property: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub name: String,
    pub product_id: Uuid,
    pub events: i64,
    pub websites: i64,
    pub interval: String,
    pub price: i64,
    pub trial_days: u32,
    pub checkout_enabled: bool,
    pub events_benefit_id: Uuid,
}

pub static CATALOG: LazyLock<Catalog> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../../config/polar-catalog.json"))
        .expect("checked-in Polar catalog")
});

use crate::error::ApiError;
use serde::Deserialize;
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Clone, Deserialize)]
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

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meter {
    pub id: Uuid,
    pub event_name: String,
    pub quantity_property: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub name: String,
    pub product_id: Uuid,
    pub events: i64,
    pub interval: String,
    pub trial_days: u32,
    pub checkout_enabled: bool,
    pub events_benefit_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SandboxIds {
    organization_id: Uuid,
    meter_id: Uuid,
    analytics_benefit_id: Uuid,
    websites_benefit_id: Uuid,
    plans: HashMap<String, SandboxPlan>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SandboxPlan {
    product_id: Uuid,
    events_benefit_id: Uuid,
}

impl Catalog {
    pub fn load(mapping: Option<&str>, snapshot: bool) -> Result<Self, ApiError> {
        let mut catalog: Self =
            serde_json::from_str(include_str!("../../../../config/polar-catalog.json"))
                .map_err(|_| super::unconfigured())?;
        if let Some(mapping) = mapping {
            if snapshot {
                return Err(super::unconfigured());
            }
            let ids: SandboxIds =
                serde_json::from_str(mapping).map_err(|_| super::unconfigured())?;
            if ids.organization_id == catalog.organization_id {
                return Err(super::unconfigured());
            }
            catalog.organization_id = ids.organization_id;
            catalog.meter.id = ids.meter_id;
            catalog.analytics_benefit_id = ids.analytics_benefit_id;
            catalog.websites_benefit_id = ids.websites_benefit_id;
            for plan in &mut catalog.plans {
                let ids = ids.plans.get(&plan.id).ok_or_else(super::unconfigured)?;
                plan.product_id = ids.product_id;
                plan.events_benefit_id = ids.events_benefit_id;
            }
        }
        Ok(catalog)
    }
}

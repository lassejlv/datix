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
    /// Fixed price in cents; zero marks the free plan.
    pub price: i64,
    /// Metered price per event in cents. Plans with overage are not capped locally.
    pub overage_unit_amount: Option<String>,
    /// Legacy plans still grant access to existing subscriptions but are not sold.
    pub legacy: bool,
    /// Whether websites may use environments beyond their default one.
    pub environments: bool,
    pub events_benefit_id: Uuid,
    pub websites_benefit_id: Uuid,
}

impl Plan {
    pub fn free(&self) -> bool {
        self.price == 0
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SandboxIds {
    organization_id: Uuid,
    meter_id: Uuid,
    analytics_benefit_id: Uuid,
    plans: HashMap<String, SandboxPlan>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SandboxPlan {
    product_id: Uuid,
    events_benefit_id: Uuid,
    websites_benefit_id: Uuid,
}

impl Catalog {
    pub fn load(mapping: Option<&str>, snapshot: bool) -> Result<Self, ApiError> {
        let mut catalog: Self =
            serde_json::from_str(include_str!("../../../../polar-catalog.json"))
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
            // Sandboxes need every plan that is sold; legacy plans are optional.
            let mut plans = Vec::new();
            for mut plan in catalog.plans {
                let Some(mapped) = ids.plans.get(&plan.id) else {
                    if plan.legacy {
                        continue;
                    }
                    return Err(super::unconfigured());
                };
                plan.product_id = mapped.product_id;
                plan.events_benefit_id = mapped.events_benefit_id;
                plan.websites_benefit_id = mapped.websites_benefit_id;
                plans.push(plan);
            }
            catalog.plans = plans;
        }
        Ok(catalog)
    }
}

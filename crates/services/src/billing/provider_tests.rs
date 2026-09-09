use super::*;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../web/tests/fixtures/polar-customer-state.json"
    ))
    .unwrap()
}
fn now() -> DateTime<Utc> {
    "2026-09-09T12:00:00Z".parse().unwrap()
}
fn normalized(value: &Value) -> Vec<Subscription> {
    serde_json::from_value(subscriptions(value, now()).unwrap()).unwrap()
}
#[test]
fn polar_grants_and_local_ledger_control_access() {
    let mut customer = fixture();
    let sub = normalized(&customer).remove(0);
    assert_eq!(sub.product_id, CATALOG.plans[0].product_id.to_string());
    let active = allowance::active(vec![sub], now()).unwrap();
    assert_eq!(active.event_limit, Some(10000000));
    assert_eq!(active.website_limit, Some(10));
    assert_eq!(active.used(150), 150);
    assert_eq!(active.remaining(150), Some(9999850));
    // Provider usage can lag or reset. Neither may reset local consumption or count it twice.
    customer["active_meters"][0]["consumed_units"] = json!(100000);
    customer["active_meters"][0]["balance"] = json!(0);
    let active = allowance::active(normalized(&customer), now()).unwrap();
    assert_eq!(active.used(10000000), 10000000);
    assert_eq!(active.remaining(10000000), Some(0));
    customer["active_meters"] = json!([]);
    assert_eq!(
        allowance::active(normalized(&customer), now())
            .unwrap()
            .remaining(10000000),
        Some(0)
    );
    // Exact grant quantities are honored, including an operator-adjusted benefit.
    customer["granted_benefits"][2]["properties"]["last_credited_units"] = json!(200000);
    customer["granted_benefits"][1]["benefit_metadata"]["included"] = json!(23);
    let active = allowance::active(normalized(&customer), now()).unwrap();
    assert_eq!(active.event_limit, Some(20000000));
    assert_eq!(active.website_limit, Some(23));
}
#[test]
fn missing_revoked_and_foreign_entitlements_fail_closed() {
    let customer = fixture();
    for index in 0..3 {
        let mut missing = customer.clone();
        missing["granted_benefits"]
            .as_array_mut()
            .unwrap()
            .remove(index);
        assert!(normalized(&missing).is_empty());
    }
    for (field, value) in [
        ("product_id", json!(Uuid::new_v4())),
        ("status", json!("past_due")),
        ("status", json!("canceled")),
        ("status", json!("paused")),
        ("current_period_end", json!("2026-09-08T00:00:00Z")),
        ("current_period_start", json!("2026-09-10T00:00:00Z")),
        ("ends_at", json!("2026-09-08T00:00:00Z")),
        ("ends_at", json!("invalid")),
        ("currency", json!("gbp")),
        ("recurring_interval", json!("year")),
        ("cancel_at_period_end", Value::Null),
    ] {
        let mut invalid = customer.clone();
        invalid["active_subscriptions"][0][field] = value;
        assert!(normalized(&invalid).is_empty(), "{field}");
    }
    let mut invalid = customer.clone();
    invalid["granted_benefits"][2]["properties"]["last_credited_meter_id"] = json!(Uuid::new_v4());
    assert!(normalized(&invalid).is_empty());
    for units in [0, -1, i64::MAX] {
        let mut invalid = customer.clone();
        invalid["granted_benefits"][2]["properties"]["last_credited_units"] = json!(units);
        assert!(normalized(&invalid).is_empty());
    }
    let mut invalid = customer.clone();
    invalid["deleted_at"] = json!(now());
    assert!(normalized(&invalid).is_empty());
    invalid = customer.clone();
    invalid["organization_id"] = json!(Uuid::new_v4());
    assert!(subscriptions(&invalid, now()).is_err());
    assert!(verify_customer(&invalid, "polar-test-owner").is_err());
    assert!(verify_customer(&customer, "different-owner").is_err());
    invalid = customer;
    invalid["active_subscriptions"] = Value::Null;
    assert!(subscriptions(&invalid, now()).is_err());
}
#[test]
fn trials_expire_and_scheduled_cancellations_keep_remaining_access() {
    let mut customer = fixture();
    customer["active_subscriptions"][0]["cancel_at_period_end"] = json!(true);
    assert_eq!(normalized(&customer).len(), 1);
    customer["active_subscriptions"][0]["status"] = json!("trialing");
    customer["active_subscriptions"][0]["trial_end"] = json!(now() + chrono::Duration::days(1));
    assert!(
        allowance::active(normalized(&customer), now())
            .unwrap()
            .trial
    );
    customer["active_subscriptions"][0]["trial_end"] = json!(now());
    assert!(normalized(&customer).is_empty());
    customer["active_subscriptions"][0]["trial_end"] = Value::Null;
    assert!(normalized(&customer).is_empty());
}
#[test]
fn checkout_selection_is_usd_only_and_rejects_draft_annual_products() {
    assert_eq!(CATALOG.currency, "usd");
    for locale in ["en", "da", "de"] {
        for p in &CATALOG.plans {
            let selected = select(json!({"events":p.events,"interval":p.interval,"locale":locale}));
            if p.interval == "year" {
                assert_eq!(selected.err().unwrap().code, "plan_unavailable");
            } else {
                let selected = selected.unwrap();
                assert_eq!(selected.product_id, p.product_id);
                assert_eq!(selected.allow_trial, p.id == "basic");
            }
        }
    }
    for invalid in [
        json!({"events":1,"interval":"month"}),
        json!({"events":100000,"interval":"month","currency":"usd"}),
        json!({"events":100000,"interval":"month","locale":"xx"}),
        json!({"events":100000,"interval":"month","product_id":"anything"}),
    ] {
        assert!(select(invalid).is_err());
    }
}

#[test]
fn public_customer_state_accepts_empty_credit_properties_without_using_meter_balance() {
    let mut customer = fixture();
    customer["granted_benefits"][2]["properties"] = json!({});
    customer["active_meters"][0]["credited_units"] = json!(9000000);
    customer["active_meters"][0]["balance"] = json!(0);
    let sub = normalized(&customer).remove(0);
    assert_eq!(sub.entitlements.unwrap().event_limit, Some(10000000));
    customer["active_subscriptions"][0]["status"] = json!("trialing");
    customer["active_subscriptions"][0]["trial_end"] = json!(now() + chrono::Duration::days(14));
    assert_eq!(normalized(&customer).len(), 1);
    customer["granted_benefits"][2]["benefit_id"] = json!(Uuid::new_v4());
    assert!(normalized(&customer).is_empty());
}

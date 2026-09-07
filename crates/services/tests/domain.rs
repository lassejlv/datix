use analytics_core::crypto;
use analytics_services::{
    abuse::{self, Baseline, Day, Source, Traffic},
    auth,
    billing::allowance::{self, Subscription},
    collect,
    tracking::{self, Event},
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
fn date(s: &str) -> DateTime<Utc> {
    s.parse().unwrap()
}
fn subscription() -> Subscription {
    serde_json::from_value(json!({"id":"test","productId":"a0de3cc9-ea92-4e95-b23e-b8d9240685aa","status":"active","currentPeriodStart":"2026-01-31T12:00:00Z","currentPeriodEnd":"2027-01-31T12:00:00Z","trialEnd":null,"cancelAtPeriodEnd":false,"endsAt":null})).unwrap()
}
#[tokio::test]
async fn legacy_passwords_and_cookie_signatures_are_compatible() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../web/tests/fixtures/legacy-crypto.json"
    ))
    .unwrap();
    let encoded = fixture["hash"].as_str().unwrap().to_string();
    assert!(
        auth::verify_password(
            fixture["password"].as_str().unwrap().into(),
            encoded.clone()
        )
        .await
        .unwrap()
    );
    assert!(
        auth::verify_password(
            fixture["normalized"].as_str().unwrap().into(),
            encoded.clone()
        )
        .await
        .unwrap()
    );
    assert!(
        !auth::verify_password("incorrect password".into(), encoded)
            .await
            .unwrap()
    );
    let secret = fixture["secret"].as_str().unwrap();
    let token = fixture["token"].as_str().unwrap();
    let cookie = fixture["cookie"].as_str().unwrap();
    assert_eq!(crypto::sign_cookie(secret, token), cookie);
    assert_eq!(crypto::verify_cookie(secret, cookie), Some(token.into()));
    assert!(crypto::verify_cookie("wrong secret", cookie).is_none());
}
#[test]
fn annual_billing_keeps_month_end_anchor() {
    let s = subscription();
    for (now, start, end) in [
        (
            "2026-02-28T11:59:59Z",
            "2026-01-31T12:00:00Z",
            "2026-02-28T12:00:00Z",
        ),
        (
            "2026-02-28T12:00:00Z",
            "2026-02-28T12:00:00Z",
            "2026-03-31T12:00:00Z",
        ),
        (
            "2026-03-31T12:00:00Z",
            "2026-03-31T12:00:00Z",
            "2026-04-30T12:00:00Z",
        ),
    ] {
        let p = allowance::period(&s, date(now)).unwrap();
        assert_eq!(p.start, date(start));
        assert_eq!(p.end, date(end));
    }
}
#[test]
fn expired_trials_unknown_products_and_inactive_plans_cannot_grant_usage() {
    let now = date("2026-02-01T00:00:00Z");
    let s = subscription();
    assert_eq!(
        allowance::active(vec![s.clone()], now).unwrap().event_limit,
        100000
    );
    for status in ["past_due", "canceled", "unpaid", "incomplete", "paused"] {
        let mut invalid = s.clone();
        invalid.status = status.into();
        assert!(allowance::active(vec![invalid], now).is_none());
    }
    for product in [
        "unknown",
        "cc71df7e-5ecf-41e6-973d-04f89d404b87",
        "cb2ad4c0-aa8f-47df-815f-aff8796f95cc",
    ] {
        let mut invalid = s.clone();
        invalid.product_id = product.into();
        assert!(allowance::active(vec![invalid], now).is_none());
    }
    let mut trial = s.clone();
    trial.status = "trialing".into();
    trial.trial_end = Some(now);
    assert!(allowance::active(vec![trial], now).is_none());
    assert!(allowance::active(vec![s.clone()], s.current_period_end).is_none());
    let mut canceled = s;
    canceled.cancel_at_period_end = true;
    assert!(allowance::active(vec![canceled], now).is_some());
}
#[test]
fn exact_origin_validation_rejects_spoofs_and_keeps_only_path() {
    assert_eq!(
        collect::page_url(
            "https://example.com/pricing?private=yes#secret",
            "example.com",
            "https://example.com",
            false
        )
        .unwrap()
        .path(),
        "/pricing"
    );
    for origin in [
        "",
        "null",
        "https://attacker.example",
        "https://www.example.com",
    ] {
        assert!(collect::page_url("https://example.com/", "example.com", origin, false).is_err());
    }
    for host in ["localhost", "127.0.0.1", "[::1]"] {
        let origin = format!("http://{host}:5173");
        let page = format!("{origin}/test");
        assert!(collect::page_url(&page, "example.com", &origin, false).is_err());
        assert!(collect::page_url(&page, "example.com", &origin, true).is_ok());
    }
    for host in [
        "localhost.attacker.com",
        "app.localhost",
        "192.168.1.2",
        "0.0.0.0",
        "[::2]",
    ] {
        let origin = format!("http://{host}");
        assert!(collect::page_url(&origin, "example.com", &origin, true).is_err());
    }
    assert!(
        collect::page_url(
            "http://user:pass@localhost/",
            "example.com",
            "http://localhost",
            true
        )
        .is_err()
    );
    assert!(
        collect::page_url(
            &format!("https://example.com/{}", "😀".repeat(180)),
            "example.com",
            "https://example.com",
            false
        )
        .is_err()
    );
}
#[test]
fn bot_and_device_classification_preserve_existing_rules() {
    assert!(collect::is_bot("Googlebot"));
    assert!(collect::is_bot("HeadlessChrome"));
    assert!(!collect::is_bot("Robotica Browser"));
    assert_eq!(collect::device("Mozilla iPad"), "tablet");
    assert_eq!(collect::device("Mozilla iPhone Mobile"), "mobile");
}
#[test]
fn repeated_activity_is_limited_even_with_fresh_event_ids() {
    let now = 1788782401000;
    let mut previous = Source::default();
    for i in 0..21 {
        let (next, _, reason) = abuse::detect(
            now + i * 100,
            true,
            "same-page",
            &previous,
            &Traffic::default(),
            &Baseline::default(),
        );
        assert_eq!(
            reason,
            if i < 20 {
                None
            } else {
                Some("repeated_activity")
            }
        );
        previous = next;
    }
    assert!(
        abuse::detect(
            now + 60000,
            true,
            "same-page",
            &previous,
            &Traffic::default(),
            &Baseline::default()
        )
        .2
        .is_none()
    );
}
#[test]
fn old_arrivals_cannot_rewind_source_counters() {
    let now = 1788782401000;
    let (mut recent, _, _) = abuse::detect(
        now + 60000,
        false,
        "next",
        &Source::default(),
        &Traffic::default(),
        &Baseline::default(),
    );
    recent.minute_events = 180;
    let (older, _, reason) = abuse::detect(
        now,
        false,
        "older",
        &recent,
        &Traffic::default(),
        &Baseline::default(),
    );
    assert_eq!(reason, Some("source_limit"));
    assert_eq!(older.minute, recent.minute);
}
#[test]
fn clean_baselines_ignore_attacks_and_spikes_alone_are_accepted() {
    let days = vec![
        Day {
            pageviews: 900,
            custom_events: 100,
            visitors: 400,
            blocked: 0,
        },
        Day {
            pageviews: 1000,
            custom_events: 100,
            visitors: 500,
            blocked: 0,
        },
        Day {
            pageviews: 999999,
            custom_events: 999999,
            visitors: 1,
            blocked: 99,
        },
    ];
    let learned = abuse::learn(&days);
    assert_eq!(learned.days, 2);
    assert_eq!(learned.daily_events, 1050.0);
    let baseline = Baseline {
        days: 7,
        daily_events: 1000.0,
        events_per_visitor: 2.5,
        custom_share: 0.1,
    };
    let now = 1788782401000;
    let mut traffic = Traffic {
        start: now / 300000,
        events: 350,
        custom: 0,
    };
    for _ in 0..1000 {
        let (_, next, reason) = abuse::detect(
            now,
            true,
            "landing",
            &Source::default(),
            &traffic,
            &baseline,
        );
        assert!(reason.is_none());
        traffic = next;
    }
}
fn event() -> Event {
    serde_json::from_value(json!({"version":3,"siteId":"11111111-1111-4111-8111-111111111111","environmentId":"11111111-1111-4111-8111-111111111111","id":"22222222-2222-4222-8222-222222222222","receivedAt":"2026-09-07T12:00:00Z","day":"2026-09-07","type":"event","name":"click","path":"/","referrer":"search.example","country":"DK","device":"desktop","visitor":"a".repeat(64),"activity":{"sessionKey":"b".repeat(64),"visitorKey":"c".repeat(64),"kind":"click","browser":"Chrome","os":"macOS","details":{"viewportWidth":1000,"viewportHeight":800,"screenWidth":1000,"screenHeight":800,"language":"da","x":20,"y":40}}})).unwrap()
}
#[test]
fn tracking_policy_removes_disabled_metadata_and_actions() {
    let e = event();
    let clean=e.apply_policy(&json!({"country":false,"device":false,"dimensions":false,"language":false,"coordinates":false})).unwrap();
    assert_eq!(clean.country, "");
    let activity = clean.activity.unwrap();
    assert_eq!(activity.browser, "");
    assert_eq!(activity.details.viewport_width, 0);
    assert_eq!(activity.details.language, "");
    assert!(activity.details.x.is_none());
    assert!(e.apply_policy(&json!({"click":false})).is_none());
    assert!(tracking::validate_settings(&json!({"click":false})).is_err());
}
#[test]
fn fractional_credits_are_exact_and_heartbeats_free() {
    let mut e = event();
    assert_eq!(e.units(), 50);
    e.localhost = true;
    assert_eq!(e.units(), 15);
    e.event_type = "pageview".into();
    assert_eq!(e.units(), 30);
    e.localhost = false;
    assert_eq!(e.units(), 100);
    e.activity.as_mut().unwrap().kind = "engagement".into();
    assert_eq!(e.units(), 0);
}

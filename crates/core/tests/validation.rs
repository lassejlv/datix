use analytics_core::validation::{DateRange, domain};
use std::collections::HashMap;
#[test]
fn domain_validation_preserves_hostname_contract() {
    assert_eq!(domain(" Example.COM. ").unwrap(), "example.com");
    for bad in [
        "https://example.com",
        "*.example.com",
        "example.com:3000",
        "example.com/path",
        "localhost",
        "-bad.com",
    ] {
        assert!(domain(bad).is_err(), "{bad}");
    }
}
#[test]
fn date_ranges_reject_rollovers_future_and_excessive_history() {
    for date in [
        "2026-02-30",
        "2026-2-01",
        "2026-13-01",
        "not-a-date",
        "3026-01-01",
    ] {
        let params = HashMap::from([("from".into(), date.into()), ("to".into(), date.into())]);
        assert!(DateRange::parse(&params).is_err());
    }
    assert_eq!(DateRange::parse(&HashMap::new()).unwrap().days, 30);
}

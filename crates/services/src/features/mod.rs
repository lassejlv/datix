//! Optional environment features, independent of the switches for individual traffic events.
use analytics_core::{Error, Result};
use serde_json::{Value, json};

pub const KEYS: [&str; 5] = ["goals", "errors", "webVitals", "geography", "pulse"];
pub fn settings(raw: &Value) -> Value {
    let mut result = json!({});
    for key in KEYS {
        result[key] = json!(
            raw.get(key)
                .and_then(Value::as_bool)
                .unwrap_or(key == "webVitals")
        );
    }
    result
}
pub fn enabled(raw: &Value, feature: &str) -> bool {
    settings(raw)[feature] == true
}
pub fn validate(raw: &Value) -> Result<()> {
    let object = raw
        .as_object()
        .ok_or_else(|| Error::invalid("Invalid feature settings."))?;
    if object.len() != KEYS.len()
        || KEYS
            .iter()
            .any(|key| !object.get(*key).is_some_and(Value::is_boolean))
    {
        return Err(Error::invalid(
            "Provide every feature setting as a boolean.",
        ));
    }
    Ok(())
}

pub mod diagnostics;
pub mod geography;
pub mod goals;
pub mod pulse;

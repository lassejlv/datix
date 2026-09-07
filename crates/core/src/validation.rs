use crate::{Error, Result};
use chrono::{Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
#[derive(Clone, Debug, Serialize)]
pub struct DateRange {
    pub from: NaiveDate,
    pub to: NaiveDate,
    pub days: i64,
    pub timezone: &'static str,
}
impl DateRange {
    pub fn parse(params: &HashMap<String, String>) -> Result<Self> {
        let today = Utc::now().date_naive();
        let parse = |key: &str, default| -> Result<NaiveDate> {
            match params.get(key) {
                None => Ok(default),
                Some(value) => NaiveDate::parse_from_str(value, "%Y-%m-%d")
                    .ok()
                    .filter(|d| d.to_string() == *value)
                    .ok_or_else(|| {
                        Error::new(
                            400,
                            "invalid_date",
                            "Dates must be real UTC calendar dates in YYYY-MM-DD format.",
                        )
                    }),
            }
        };
        let from = parse("from", today - Duration::days(29))?;
        let to = parse("to", today)?;
        let days = (to - from).num_days() + 1;
        if !(1..=366).contains(&days) || to > today || from < today - Duration::days(729) {
            return Err(Error::new(
                400,
                "invalid_range",
                "Choose 1–366 days within the last 730 days, ending no later than today.",
            ));
        }
        Ok(Self {
            from,
            to,
            days,
            timezone: "UTC",
        })
    }
}
pub fn name(value: &str, max: usize) -> Result<String> {
    let s = value.trim();
    if s.is_empty() || s.chars().count() > max || s.chars().any(char::is_control) {
        return Err(Error::invalid("Invalid name."));
    }
    Ok(s.into())
}
pub fn domain(value: &str) -> Result<String> {
    let s = value.trim().to_lowercase();
    let s = s.strip_suffix('.').unwrap_or(&s);
    let re = regex::Regex::new(r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
        .expect("constant regex");
    if s.len() > 253 || !re.is_match(s) {
        return Err(Error::invalid(
            "Use a hostname such as example.com, without a scheme, path, port or wildcard.",
        ));
    }
    Ok(s.into())
}
pub fn decode<T: for<'de> Deserialize<'de>>(value: serde_json::Value) -> Result<T> {
    serde_json::from_value(value).map_err(|_| Error::invalid("Request fields are invalid."))
}

/// Optional JSON fields must be omitted, not null, except explicitly nullable fields.
pub fn reject_nulls(value: &serde_json::Value, nullable: &[&str]) -> Result<()> {
    match value {
        serde_json::Value::Object(fields) => {
            for (key, value) in fields {
                if value.is_null() && nullable.contains(&key.as_str()) {
                    continue;
                }
                reject_nulls(value, &[])?;
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                reject_nulls(value, &[])?;
            }
        }
        serde_json::Value::Null => {
            return Err(Error::invalid(
                "Optional fields must be omitted instead of null.",
            ));
        }
        _ => {}
    }
    Ok(())
}

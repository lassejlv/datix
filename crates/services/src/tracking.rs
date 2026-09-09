use analytics_core::{Error, Result};
use serde_json::{Value, json};
pub const SETTING_KEYS: [&str; 14] = [
    "pageview",
    "custom",
    "click",
    "outbound",
    "download",
    "form_submit",
    "scroll",
    "engagement",
    "referrer",
    "country",
    "device",
    "dimensions",
    "language",
    "coordinates",
];
pub fn settings(raw: &Value) -> Value {
    let mut result = json!({});
    for key in SETTING_KEYS {
        result[key] = json!(
            raw.get(key)
                .and_then(Value::as_bool)
                .unwrap_or(!["click", "download", "scroll"].contains(&key))
        );
    }
    result
}
pub fn validate_settings(raw: &Value) -> Result<()> {
    let object = raw
        .as_object()
        .ok_or_else(|| Error::invalid("Invalid tracking settings."))?;
    if object.len() != SETTING_KEYS.len()
        || SETTING_KEYS
            .iter()
            .any(|key| !object.get(*key).is_some_and(Value::is_boolean))
    {
        return Err(Error::invalid(
            "Provide every tracking setting as a boolean.",
        ));
    }
    Ok(())
}

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Details {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_time: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sequence: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scroll_depth: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_seconds: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<i32>,
    pub viewport_width: i32,
    pub viewport_height: i32,
    pub screen_width: i32,
    pub screen_height: i32,
    pub language: String,
}
impl Details {
    pub fn validate(&self) -> Result<()> {
        if self
            .client_time
            .is_some_and(|n| !(0..=8640000000000000).contains(&n))
            || self.sequence.is_some_and(|n| n < 0)
            || [self.scroll_depth, self.x, self.y]
                .iter()
                .any(|n| n.is_some_and(|n| !(0..=100).contains(&n)))
            || self.active_seconds.is_some_and(|n| !(0..=30).contains(&n))
            || [
                self.viewport_width,
                self.viewport_height,
                self.screen_width,
                self.screen_height,
            ]
            .iter()
            .any(|n| !(0..=20000).contains(n))
            || self.language.len() > 35
            || !self
                .language
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
            || self.target.as_ref().is_some_and(|t| {
                t.len() > 160
                    || !t
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"_.:()> -".contains(&c))
            })
            || self
                .destination
                .as_ref()
                .is_some_and(|s| s.len() > 2048 || url::Url::parse(s).is_err())
        {
            return Err(Error::invalid("Invalid activity details."));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Activity {
    pub session_key: String,
    pub visitor_key: String,
    pub kind: String,
    pub browser: String,
    pub os: String,
    pub details: Details,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Event {
    pub version: u8,
    pub site_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment_id: Option<Uuid>,
    pub id: Uuid,
    pub received_at: DateTime<Utc>,
    pub day: NaiveDate,
    #[serde(rename = "type")]
    pub event_type: String,
    pub name: String,
    pub path: String,
    pub referrer: String,
    pub country: String,
    pub device: String,
    pub visitor: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub localhost: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity: Option<Activity>,
}
pub fn is_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub fn valid_kind(kind: &str) -> bool {
    SETTING_KEYS[..8].contains(&kind)
}
impl Event {
    pub fn environment(&self) -> Uuid {
        self.environment_id.unwrap_or(self.site_id)
    }
    pub fn validate(&self) -> Result<()> {
        let envelope = match self.version {
            1 => self.environment_id.is_none() && self.activity.is_none(),
            2 => self.environment_id.is_some() && self.activity.is_none(),
            3 => self.environment_id.is_some() && self.activity.is_some(),
            _ => false,
        };
        if !envelope
            || self.received_at.date_naive() != self.day
            || !["pageview", "event"].contains(&self.event_type.as_str())
            || self.name.len() > 64
            || self.path.len() > 2048
            || self.referrer.len() > 253
            || self.country.len() > 2
            || !["desktop", "mobile", "tablet", ""].contains(&self.device.as_str())
            || !is_hash(&self.visitor)
        {
            return Err(Error::invalid("Invalid event envelope."));
        }
        if let Some(a) = &self.activity {
            a.details.validate()?;
            if !is_hash(&a.session_key)
                || !is_hash(&a.visitor_key)
                || !valid_kind(&a.kind)
                || a.browser.len() > 32
                || a.os.len() > 32
            {
                return Err(Error::invalid("Invalid activity envelope."));
            }
        }
        Ok(())
    }
    pub fn units(&self) -> i64 {
        if self
            .activity
            .as_ref()
            .is_some_and(|a| a.kind == "engagement")
        {
            0
        } else if self.event_type == "pageview" {
            if self.localhost { 30 } else { 100 }
        } else if self.localhost {
            15
        } else {
            50
        }
    }
    pub fn apply_policy(&self, raw: &Value) -> Option<Self> {
        let policy = settings(raw);
        let kind = self.activity.as_ref().map(|a| a.kind.as_str()).unwrap_or(
            if self.event_type == "pageview" {
                "pageview"
            } else {
                "custom"
            },
        );
        if policy[kind] != true {
            return None;
        }
        let mut event = self.clone();
        if policy["referrer"] != true {
            event.referrer.clear()
        }
        if policy["country"] != true {
            event.country.clear()
        }
        if policy["device"] != true {
            event.device.clear()
        }
        if let Some(a) = &mut event.activity {
            if policy["device"] != true {
                a.browser.clear();
                a.os.clear()
            }
            if policy["dimensions"] != true {
                a.details.viewport_width = 0;
                a.details.viewport_height = 0;
                a.details.screen_width = 0;
                a.details.screen_height = 0;
            }
            if policy["language"] != true {
                a.details.language.clear()
            }
            if policy["coordinates"] != true {
                a.details.x = None;
                a.details.y = None;
            }
        }
        Some(event)
    }
}

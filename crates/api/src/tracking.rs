use crate::{AppState, error::ApiError, sites::identifier};
use axum::http::{HeaderMap, StatusCode};
use chrono::{DateTime, NaiveDate, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Sha256;
use url::Url;

const KEYS: [&str; 14] = [
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
    Value::Object(
        KEYS.into_iter()
            .map(|key| {
                (
                    key.into(),
                    json!(
                        raw.get(key)
                            .and_then(Value::as_bool)
                            .unwrap_or(!matches!(key, "click" | "download" | "scroll"))
                    ),
                )
            })
            .collect(),
    )
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Details {
    #[serde(skip_serializing_if = "Option::is_none")]
    client_time: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sequence: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    destination: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    scroll_depth: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active_seconds: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    x: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    y: Option<u32>,
    viewport_width: u32,
    viewport_height: u32,
    screen_width: u32,
    screen_height: u32,
    language: String,
}

impl Details {
    fn validate(&self) -> Result<(), ApiError> {
        if self
            .client_time
            .is_some_and(|v| !(0..=8_640_000_000_000_000).contains(&v))
            || self.sequence.is_some_and(|v| v > i32::MAX as u32)
            || self.target.as_ref().is_some_and(|v| {
                v.len() > 160
                    || !v
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"_.:()> -".contains(&c))
            })
            || self
                .destination
                .as_ref()
                .is_some_and(|v| v.encode_utf16().count() > 2048)
            || [self.scroll_depth, self.x, self.y]
                .into_iter()
                .flatten()
                .any(|v| v > 100)
            || self.active_seconds.is_some_and(|v| v > 30)
            || [
                self.viewport_width,
                self.viewport_height,
                self.screen_width,
                self.screen_height,
            ]
            .into_iter()
            .any(|v| v > 20000)
            || self.language.len() > 35
            || !self
                .language
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err(ApiError::invalid());
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivityInput {
    kind: String,
    details: Details,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Session {
    kind: String,
    details: Details,
    visitor_id: String,
    session_id: String,
    #[serde(rename = "consent")]
    _consent: Option<bool>,
    storage: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    pub site_id: String,
    pub environment_id: Option<String>,
    pub id: String,
    #[serde(rename = "type")]
    kind: String,
    name: Option<String>,
    url: String,
    referrer: Option<String>,
    session: Option<Session>,
    activity: Option<ActivityInput>,
}

impl Input {
    pub fn environment(&self) -> &str {
        self.environment_id.as_deref().unwrap_or(&self.site_id)
    }
    pub fn validate(&self) -> Result<(), ApiError> {
        identifier(&self.site_id)?;
        identifier(&self.id)?;
        identifier(self.environment())?;
        if !matches!(self.kind.as_str(), "pageview" | "event")
            || self.url.encode_utf16().count() > 2048
            || self
                .referrer
                .as_ref()
                .is_some_and(|s| s.encode_utf16().count() > 2048)
            || self.name.as_ref().is_some_and(|n| {
                n.is_empty()
                    || n.len() > 64
                    || !n.as_bytes()[0].is_ascii_alphabetic()
                    || !n
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
            })
        {
            return Err(ApiError::invalid());
        }
        if let Some(session) = &self.session {
            identifier(&session.visitor_id)?;
            identifier(&session.session_id)?;
            if session
                .storage
                .as_ref()
                .is_some_and(|v| !matches!(v.as_str(), "cookie" | "local"))
            {
                return Err(ApiError::invalid());
            }
            session.details.validate()?;
            if !KEYS[..8].contains(&session.kind.as_str()) {
                return Err(ApiError::invalid());
            }
        }
        if let Some(activity) = &self.activity {
            activity.details.validate()?;
            if !KEYS[..8].contains(&activity.kind.as_str()) {
                return Err(ApiError::invalid());
            }
        }
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    version: u32,
    pub site_id: String,
    pub environment_id: String,
    pub id: String,
    pub received_at: DateTime<Utc>,
    pub day: NaiveDate,
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    pub path: String,
    pub referrer: String,
    pub country: String,
    pub device: String,
    pub visitor: String,
    pub localhost: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity: Option<Activity>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub session_key: String,
    pub visitor_key: String,
    pub kind: String,
    pub browser: String,
    pub os: String,
    pub details: Details,
}

pub struct Environment<'a> {
    pub domain: &'a str,
    pub allow_localhost: bool,
    pub tracking_mode: &'a str,
    pub tracking_settings: &'a Value,
}

pub fn hash(secret: &str, value: &Value) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(value.to_string().as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

pub fn excluded(headers: &HeaderMap) -> bool {
    headers.get("dnt").is_some_and(|v| v == "1")
        || [
            "bot",
            "crawler",
            "spider",
            "headless",
            "lighthouse",
            "curl",
            "wget",
        ]
        .iter()
        .any(|s| user_agent(headers).to_lowercase().contains(s))
}
pub fn user_agent(headers: &HeaderMap) -> String {
    headers
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .chars()
        .take(512)
        .collect()
}
pub fn origin(headers: &HeaderMap) -> &str {
    headers
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
}
pub fn client_ip(headers: &HeaderMap) -> &str {
    headers
        .get("x-datix-client-ip")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
}
pub fn device(ua: &str) -> &'static str {
    let ua = ua.to_lowercase();
    if ua.contains("ipad") || ua.contains("tablet") {
        "tablet"
    } else if ["mobile", "iphone", "android"]
        .iter()
        .any(|s| ua.contains(s))
    {
        "mobile"
    } else {
        "desktop"
    }
}

pub fn page_url(
    value: &str,
    origin: &str,
    domain: &str,
    allow_localhost: bool,
) -> Result<(Url, bool), ApiError> {
    let url = Url::parse(value).map_err(|_| ApiError::invalid())?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.origin().ascii_serialization() != origin
        || (url.host_str() != Some(domain) && !(local && allow_localhost))
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "The event URL and Origin must match an allowed host for this website.",
        ));
    }
    Ok((url, local))
}

pub fn normalize(
    input: Input,
    headers: &HeaderMap,
    country: &str,
    secret: &str,
    env: Environment<'_>,
    now: DateTime<Utc>,
) -> Result<Option<Event>, ApiError> {
    input.validate()?;
    if (input.kind == "pageview") == input.name.is_some() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Invalid event name.",
        ));
    }
    let (url, local) = page_url(&input.url, origin(headers), env.domain, env.allow_localhost)?;
    if (env.tracking_mode != "cookieless") != input.session.is_some()
        || (input.activity.is_some() && env.tracking_mode != "cookieless")
        || input.session.as_ref().is_some_and(|s| {
            s.storage.as_deref().unwrap_or("cookie")
                != if env.tracking_mode == "local" {
                    "local"
                } else {
                    "cookie"
                }
        })
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Use the current environment script for this environment's tracking mode.",
        ));
    }
    let environment = input.environment().to_owned();
    let day = now.date_naive();
    let ua = user_agent(headers);
    let visitor = hash(
        secret,
        &input.session.as_ref().map_or_else(
            || json!([environment, day, client_ip(headers), ua]),
            |s| json!([environment, day, s.visitor_id]),
        ),
    );
    let raw = input
        .session
        .as_ref()
        .map(|s| (s.kind.as_str(), s.details.clone()))
        .or_else(|| {
            input
                .activity
                .as_ref()
                .map(|a| (a.kind.as_str(), a.details.clone()))
        });
    let activity = if let Some((kind, mut details)) = raw {
        if (input.kind == "pageview") != (kind == "pageview") {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "Activity kind does not match the event.",
            ));
        }
        details.client_time = Some(
            details
                .client_time
                .filter(|v| *v != 0 && v.abs_diff(now.timestamp_millis()) <= 300_000)
                .unwrap_or(now.timestamp_millis()),
        );
        details.active_seconds = Some(if kind == "engagement" {
            details.active_seconds.unwrap_or(0)
        } else {
            0
        });
        if let Some(destination) = details.destination.as_mut().filter(|s| !s.is_empty()) {
            let mut target = Url::parse(destination).map_err(|_| ApiError::invalid())?;
            if !matches!(target.scheme(), "http" | "https")
                || !target.username().is_empty()
                || target.password().is_some()
            {
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "Use an HTTP destination.",
                ));
            }
            target.set_query(None);
            target.set_fragment(None);
            *destination = target.to_string();
        }
        Some(Activity {
            session_key: input.session.as_ref().map_or_else(
                || visitor.clone(),
                |s| hash(secret, &json!([environment, s.visitor_id, s.session_id])),
            ),
            visitor_key: input.session.as_ref().map_or_else(
                || visitor.clone(),
                |s| hash(secret, &json!([environment, s.visitor_id])),
            ),
            kind: kind.into(),
            browser: if ua.contains("Edg/") {
                "Edge"
            } else if ua.contains("Firefox/") {
                "Firefox"
            } else if ua.contains("Chrome/") {
                "Chrome"
            } else if ua.contains("Safari/") {
                "Safari"
            } else {
                "Other"
            }
            .into(),
            os: if ua.contains("Android") {
                "Android"
            } else if ua.contains("iPhone") || ua.contains("iPad") {
                "iOS"
            } else if ua.contains("Windows") {
                "Windows"
            } else if ua.contains("Macintosh") {
                "macOS"
            } else if ua.contains("Linux") {
                "Linux"
            } else {
                "Other"
            }
            .into(),
            details,
        })
    } else {
        None
    };
    let referrer = input
        .referrer
        .and_then(|s| Url::parse(&s).ok())
        .filter(|u| matches!(u.scheme(), "http" | "https"))
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_default();
    Ok(apply_policy(
        Event {
            version: if activity.is_some() { 3 } else { 2 },
            site_id: input.site_id,
            environment_id: environment,
            id: input.id,
            received_at: now,
            day,
            kind: input.kind,
            name: input.name.unwrap_or_default(),
            path: url.path().into(),
            referrer,
            country: country.into(),
            device: device(&ua).into(),
            visitor,
            localhost: local,
            activity,
        },
        env.tracking_settings,
    ))
}

pub fn apply_policy(mut event: Event, raw: &Value) -> Option<Event> {
    let policy = settings(raw);
    let enabled = |key: &str| policy[key].as_bool().unwrap_or(false);
    if !enabled(event.activity.as_ref().map_or(
        if event.kind == "pageview" {
            "pageview"
        } else {
            "custom"
        },
        |a| a.kind.as_str(),
    )) {
        return None;
    }
    if !enabled("referrer") {
        event.referrer.clear();
    }
    if !enabled("country") {
        event.country.clear();
    }
    if !enabled("device") {
        event.device.clear();
    }
    if let Some(a) = event.activity.as_mut() {
        if !enabled("device") {
            a.browser.clear();
            a.os.clear();
        }
        if !enabled("dimensions") {
            a.details.viewport_width = 0;
            a.details.viewport_height = 0;
            a.details.screen_width = 0;
            a.details.screen_height = 0;
        }
        if !enabled("language") {
            a.details.language.clear();
        }
        if !enabled("coordinates") {
            a.details.x = None;
            a.details.y = None;
        }
    }
    Some(event)
}

pub fn units(event: &Event) -> i64 {
    if event
        .activity
        .as_ref()
        .is_some_and(|a| a.kind == "engagement")
    {
        0
    } else if event.kind == "pageview" {
        if event.localhost { 30 } else { 100 }
    } else if event.localhost {
        15
    } else {
        50
    }
}

pub async fn rate_limit(
    state: &AppState,
    kind: &str,
    ip: &str,
    limit: i64,
) -> Result<(), ApiError> {
    let key = format!(
        "{}:{kind}:{}",
        state.config.queue_prefix,
        hash(&state.config.visitor_secret, &json!(ip))
    );
    let count:i64=redis::cmd("EVAL").arg("local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],60) end;return n").arg(1).arg(key).query_async(&mut state.redis.clone()).await?;
    if count > limit {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "Too many requests. Try again in a minute.",
        ));
    }
    Ok(())
}

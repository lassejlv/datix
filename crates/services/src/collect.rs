use crate::{
    abuse, billing, queue,
    tracking::{Activity, Details, Event},
};
use analytics_core::{Error, Result, State, crypto, validation};
use axum::http::HeaderMap;
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionContext {
    consent: bool,
    storage: Option<String>,
    visitor_id: Uuid,
    session_id: Uuid,
    kind: String,
    details: Details,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Anonymous {
    kind: String,
    details: Details,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    site_id: Uuid,
    environment_id: Option<Uuid>,
    id: Uuid,
    #[serde(rename = "type")]
    event_type: String,
    name: Option<String>,
    url: String,
    referrer: Option<String>,
    session: Option<SessionContext>,
    activity: Option<Anonymous>,
}
fn header<'a>(headers: &'a HeaderMap, key: &str) -> &'a str {
    headers.get(key).and_then(|v| v.to_str().ok()).unwrap_or("")
}
pub fn is_bot(ua: &str) -> bool {
    static BOT: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)bot\b|crawler|spider|headless|lighthouse|pagespeed|pingdom")
            .unwrap()
    });
    BOT.is_match(ua)
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
    domain: &str,
    origin: &str,
    allow_localhost: bool,
) -> Result<url::Url> {
    let url = url::Url::parse(value).map_err(|_| Error::invalid("Invalid page URL."))?;
    let local = allow_localhost && is_local(&url);
    if !["http", "https"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
        || (url.host_str() != Some(domain) && !local)
        || url.origin().ascii_serialization() != origin
    {
        return Err(Error::new(
            403,
            "invalid_site_origin",
            "The event URL and Origin must match an allowed host for this website.",
        ));
    }
    if url.path().len() > 2048 {
        return Err(Error::new(
            400,
            "invalid_path",
            "The encoded URL path must be at most 2048 characters.",
        ));
    }
    Ok(url)
}
fn is_local(url: &url::Url) -> bool {
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
}
fn referrer(value: Option<&str>) -> String {
    value
        .and_then(|s| url::Url::parse(s).ok())
        .filter(|u| ["http", "https"].contains(&u.scheme()))
        .and_then(|u| u.host_str().filter(|h| h.len() <= 253).map(str::to_owned))
        .unwrap_or_default()
}
fn browser(ua: &str) -> &'static str {
    if ua.contains("Edg/") {
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
}
fn os(ua: &str) -> &'static str {
    if ua.contains("Android") {
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
}
pub async fn collect(
    state: &State,
    headers: &HeaderMap,
    body: Value,
    ip: &str,
    country: &str,
) -> Result<Value> {
    validation::reject_nulls(&body, &[])?;
    let input: Input = validation::decode(body.clone())?;
    if !["pageview", "event"].contains(&input.event_type.as_str())
        || input.url.encode_utf16().count() > 2048
        || url::Url::parse(&input.url).is_err()
        || input
            .referrer
            .as_ref()
            .is_some_and(|r| r.encode_utf16().count() > 2048)
    {
        return Err(Error::invalid("Invalid event."));
    }
    if input.event_type == "pageview" && body.get("name").is_some() {
        return Err(Error::invalid("A pageview has no event name."));
    }
    static EVENT_NAME: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$").unwrap());
    if input.event_type == "event" && !EVENT_NAME.is_match(input.name.as_deref().unwrap_or("")) {
        return Err(Error::invalid("Invalid event name."));
    }
    if let Some(s) = &input.session {
        if !s.consent
            || s.storage
                .as_deref()
                .is_some_and(|s| !["cookie", "local"].contains(&s))
            || !crate::tracking::valid_kind(&s.kind)
        {
            return Err(Error::invalid(
                "Session tracking requires explicit consent.",
            ));
        }
        s.details.validate()?;
    }
    if let Some(a) = &input.activity {
        if !crate::tracking::valid_kind(&a.kind) {
            return Err(Error::invalid("Invalid activity kind."));
        }
        a.details.validate()?;
    }
    let ua: String = header(headers, "user-agent").chars().take(512).collect();
    if header(headers, "dnt") == "1" || is_bot(&ua) {
        return Ok(json!({"accepted":false,"reason":"excluded"}));
    }
    let now = Utc::now();
    let day = now.date_naive();
    let environment = input.environment_id.unwrap_or(input.site_id);
    let visitor = crypto::hash(
        &state.config.visitor_secret,
        &if let Some(s) = &input.session {
            json!([environment, day, s.visitor_id])
        } else {
            json!([environment, day, ip, ua])
        }
        .to_string(),
    );
    state
        .limit(
            "collect",
            &crypto::hash(&state.config.visitor_secret, ip),
            120,
        )
        .await?;
    let site = billing::admission::load(state, input.site_id, environment).await?;
    let url = page_url(
        &input.url,
        &site.domain,
        header(headers, "origin"),
        site.allow_localhost,
    )?;
    if let Some(reason) = site.pause_reason(input.site_id, now)? {
        return Ok(json!({"accepted":false,"reason":reason}));
    }
    if (site.tracking_mode != "cookieless") != input.session.is_some()
        || (input.activity.is_some() && site.tracking_mode != "cookieless")
        || input.session.as_ref().is_some_and(|s| {
            s.storage.as_deref().unwrap_or("cookie")
                != if site.tracking_mode == "local" {
                    "local"
                } else {
                    "cookie"
                }
        })
    {
        return Err(Error::new(
            400,
            "tracking_mode_mismatch",
            "Use the current environment script. Session mode requires explicit analytics consent.",
        ));
    }
    let mut activity = if let Some(s) = input.session {
        Some(Activity {
            session_key: crypto::hash(
                &state.config.visitor_secret,
                &json!([environment, s.visitor_id, s.session_id]).to_string(),
            ),
            visitor_key: crypto::hash(
                &state.config.visitor_secret,
                &json!([environment, s.visitor_id]).to_string(),
            ),
            kind: s.kind,
            browser: browser(&ua).into(),
            os: os(&ua).into(),
            details: s.details,
        })
    } else {
        input.activity.map(|a| Activity {
            session_key: visitor.clone(),
            visitor_key: visitor.clone(),
            kind: a.kind,
            browser: browser(&ua).into(),
            os: os(&ua).into(),
            details: a.details,
        })
    };
    if let Some(a) = &mut activity {
        if (input.event_type == "pageview") != (a.kind == "pageview") {
            return Err(Error::new(
                400,
                "invalid_activity",
                "Activity kind does not match the event.",
            ));
        }
        if a.details
            .client_time
            .is_none_or(|t| t.abs_diff(now.timestamp_millis()) > 300000)
        {
            a.details.client_time = Some(now.timestamp_millis())
        }
        a.details.active_seconds = Some(if a.kind == "engagement" {
            a.details.active_seconds.unwrap_or(0)
        } else {
            0
        });
        if let Some(destination) = &a.details.destination {
            let mut destination =
                url::Url::parse(destination).map_err(|_| Error::invalid("Invalid destination."))?;
            if !["http", "https"].contains(&destination.scheme())
                || !destination.username().is_empty()
                || destination.password().is_some()
            {
                return Err(Error::new(
                    400,
                    "invalid_destination",
                    "Use an HTTP destination.",
                ));
            }
            destination.set_query(None);
            destination.set_fragment(None);
            a.details.destination = Some(destination.to_string());
        }
    }
    let kind = activity.as_ref().map(|a| a.kind.clone());
    let event = Event {
        version: if activity.is_some() {
            3
        } else if environment == input.site_id {
            1
        } else {
            2
        },
        environment_id: if activity.is_some() || environment != input.site_id {
            Some(environment)
        } else {
            None
        },
        localhost: is_local(&url),
        site_id: input.site_id,
        id: input.id,
        received_at: now,
        day,
        event_type: input.event_type,
        name: input.name.unwrap_or_default(),
        path: url.path().into(),
        referrer: referrer(input.referrer.as_deref()),
        country: if country.len() == 2 && country.bytes().all(|c| c.is_ascii_uppercase()) {
            country.into()
        } else {
            String::new()
        },
        device: device(&ua).into(),
        visitor,
        activity,
    };
    let Some(filtered) = event.apply_policy(&site.tracking_settings) else {
        return Ok(json!({"accepted":false,"reason":"event_disabled"}));
    };
    let source = crypto::hash(
        &state.config.visitor_secret,
        &json!(["abuse-source", environment, day, ip]).to_string(),
    );
    let signature = crypto::hash(
        &state.config.visitor_secret,
        &json!([
            "abuse-pattern",
            environment,
            event.event_type,
            kind,
            event.name,
            event.path
        ])
        .to_string(),
    );
    if abuse::guard(
        state,
        environment,
        &source,
        &signature,
        event.event_type == "pageview",
        now,
    )
    .await?
    .is_some()
    {
        return Ok(json!({"accepted":false,"reason":"spam_detected"}));
    }
    queue::enqueue(state, &filtered).await?;
    Ok(json!({"accepted":true}))
}

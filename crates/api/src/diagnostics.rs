use crate::{AppState, billing, error::ApiError, http::json_body, sites::identifier, tracking};
use axum::{
    Json, Router,
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    routing::post,
};
use chrono::{DateTime, Duration, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;
use std::sync::LazyLock;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    site_id: String,
    environment_id: String,
    id: String,
    page_id: String,
    url: String,
    kind: String,
    payload: Value,
    consent: bool,
}

#[derive(Deserialize, Serialize)]
pub struct Diagnostic {
    site: Uuid,
    env: Uuid,
    id: Uuid,
    page: Uuid,
    at: DateTime<Utc>,
    kind: String,
    path: String,
    device: String,
    visitor: String,
    fingerprint: String,
    payload: Value,
    consent: bool,
}

fn truncate(value: &str, max: usize) -> String {
    let mut size = 0;
    value
        .chars()
        .take_while(|c| {
            size += c.len_utf16();
            size <= max
        })
        .collect()
}

fn sanitize(value: &str, max: usize) -> String {
    static URL: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"https?://[^\s)"']+"#).expect("constant regex"));
    static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}").expect("constant regex")
    });
    static SECRETS: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"["'][^"'\n]*["']|\b[A-Za-z0-9_-]{32,}\b"#).expect("constant regex")
    });
    let clean: String = value
        .chars()
        .filter(|c| !matches!(*c,'\x00'..='\x09'|'\x0b'..='\x1f'|'\x7f'))
        .collect();
    let short = truncate(&clean, max);
    let urls = URL.replace_all(&short, |captures: &regex::Captures<'_>| {
        url::Url::parse(&captures[0])
            .map(|mut url| {
                url.set_query(None);
                url.set_fragment(None);
                let _ = url.set_username("");
                let _ = url.set_password(None);
                url.to_string()
            })
            .unwrap_or_default()
    });
    let emails = EMAIL.replace_all(&urls, "[redacted]");
    truncate(&SECRETS.replace_all(&emails, "[redacted]"), max)
}

fn payload(kind: &str, value: Value) -> Result<Value, ApiError> {
    if kind == "vital" {
        #[derive(Deserialize, Serialize)]
        #[serde(deny_unknown_fields)]
        struct Vital {
            name: String,
            value: f64,
        }
        let input: Vital = serde_json::from_value(value).map_err(|_| ApiError::invalid())?;
        if !["CLS", "LCP", "INP"].contains(&input.name.as_str())
            || !input.value.is_finite()
            || !(0.0..=1_800_000.0).contains(&input.value)
            || (input.name == "CLS" && input.value > 100.0)
        {
            return Err(ApiError::invalid());
        }
        return Ok(json!(input));
    }
    if kind != "error" {
        return Err(ApiError::invalid());
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Error {
        message: String,
        source: Option<String>,
        stack: Option<String>,
        line: Option<i64>,
        column: Option<i64>,
    }
    let input: Error = serde_json::from_value(value).map_err(|_| ApiError::invalid())?;
    let message = sanitize(&input.message, 500);
    if message.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "An error needs a message.",
        ));
    }
    Ok(
        json!({"message":message,"source":sanitize(input.source.as_deref().unwrap_or(""),512),"stack":sanitize(input.stack.as_deref().unwrap_or(""),2000),"line":input.line.unwrap_or(0).clamp(0,1_000_000),"column":input.column.unwrap_or(0).clamp(0,1_000_000)}),
    )
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/telemetry", post(telemetry_route))
}
async fn telemetry_route(
    State(state): State<AppState>,
    request: Request,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let headers = request.headers().clone();
    Ok((
        StatusCode::ACCEPTED,
        Json(telemetry(&state, json_body(request).await?, &headers).await?),
    ))
}

async fn telemetry(state: &AppState, input: Input, headers: &HeaderMap) -> Result<Value, ApiError> {
    let site = identifier(&input.site_id)?;
    let environment = identifier(&input.environment_id)?;
    let id = identifier(&input.id)?;
    let page_id = identifier(&input.page_id)?;
    if !matches!(input.kind.as_str(), "error" | "vital") || input.url.encode_utf16().count() > 2048
    {
        return Err(ApiError::invalid());
    }
    if tracking::excluded(headers) {
        return Ok(json!({"accepted":false}));
    }
    let ip = tracking::client_ip(headers);
    tracking::rate_limit(state, "diagnostics", ip, 60).await?;
    let env=sqlx::query("SELECT e.*,s.owner_id FROM environments e JOIN sites s ON s.id=e.site_id WHERE e.id=$1 AND s.id=$2")
        .bind(environment).bind(site).fetch_optional(&state.pool).await?.ok_or_else(||ApiError::new(StatusCode::BAD_REQUEST,"invalid_request","Environment not found."))?;
    let features: Value = env.get("feature_settings");
    let mut connection = state.pool.acquire().await?;
    if !env.get::<bool, _>("enabled")
        || !features[if input.kind == "error" {
            "errors"
        } else {
            "webVitals"
        }]
        .as_bool()
        .unwrap_or(input.kind == "vital")
        || billing::allowance(
            &mut connection,
            env.get("owner_id"),
            state.billing.organization_id(),
            state.config.external_effects,
        )
        .await?
        .is_none()
    {
        return Ok(json!({"accepted":false}));
    }
    drop(connection);
    let (page, _) = tracking::page_url(
        &input.url,
        tracking::origin(headers),
        env.get("domain"),
        env.get("allow_localhost"),
    )?;
    let data = payload(&input.kind, input.payload)?;
    let at = Utc::now();
    let ua = tracking::user_agent(headers);
    let diagnostic = Diagnostic {
        site,
        env: environment,
        id,
        page: page_id,
        at,
        kind: input.kind,
        path: page.path().into(),
        device: if tracking::settings(&env.get::<Value, _>("tracking_settings"))["device"] == true {
            tracking::device(&ua).into()
        } else {
            String::new()
        },
        visitor: tracking::hash(
            &state.config.visitor_secret,
            &json!([environment, at.date_naive(), ip, ua]),
        ),
        fingerprint: tracking::hash(
            &state.config.visitor_secret,
            &json!([
                environment,
                data["name"],
                data["message"],
                data["source"],
                data["line"]
            ]),
        ),
        payload: data,
        consent: input.consent,
    };
    state.queue.enqueue(&diagnostic).await?;
    Ok(json!({"accepted":true}))
}

pub async fn ingest(state: &AppState, d: Diagnostic) -> Result<(), ApiError> {
    let now = Utc::now();
    if d.at < now - Duration::days(30) || d.at > now + Duration::seconds(60) {
        return Ok(());
    }
    let clean = payload(&d.kind, d.payload)?;
    let mut tx = state.pool.begin().await?;
    let owner:Option<String>=sqlx::query_scalar("SELECT s.owner_id FROM sites s JOIN environments e ON e.site_id=s.id WHERE s.id=$1 AND e.id=$2")
        .bind(d.site).bind(d.env).fetch_optional(&mut *tx).await?;
    let Some(owner) = owner else {
        return Ok(());
    };
    sqlx::query("SELECT id FROM public.\"user\" WHERE id=$1 FOR UPDATE")
        .bind(&owner)
        .execute(&mut *tx)
        .await?;
    let Some(active) = billing::allowance(
        &mut tx,
        &owner,
        state.billing.organization_id(),
        state.config.external_effects,
    )
    .await?
    else {
        return Ok(());
    };
    let sites: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM sites WHERE owner_id=$1 ORDER BY created_at,id")
            .bind(&owner)
            .fetch_all(&mut *tx)
            .await?;
    if active.entitlement.website_limit.is_some_and(|limit| {
        sites
            .iter()
            .position(|id| *id == d.site)
            .is_none_or(|i| i as i64 >= limit)
    }) {
        return Ok(());
    }
    let feature = if d.kind == "error" {
        "errors"
    } else {
        "webVitals"
    };
    let allowed:Option<bool>=sqlx::query_scalar("SELECT e.enabled AND s.enabled AND coalesce((e.feature_settings->>$1)::boolean,$1='webVitals') AND (e.tracking_mode='cookieless' OR $2) AND NOT EXISTS(SELECT 1 FROM user_suspensions WHERE user_id=s.owner_id) AND NOT EXISTS(SELECT 1 FROM site_suspensions WHERE site_id=s.id) AS allowed FROM environments e JOIN sites s ON s.id=e.site_id WHERE e.id=$3 AND s.id=$4 FOR KEY SHARE OF s,e")
        .bind(feature).bind(d.consent).bind(d.env).bind(d.site).fetch_optional(&mut *tx).await?;
    if allowed != Some(true) {
        return Ok(());
    }
    let previous=sqlx::query("SELECT * FROM diagnostic_events WHERE environment_id=$1 AND id=$2 ORDER BY received_at DESC LIMIT 1")
        .bind(d.env).bind(d.id).fetch_optional(&mut *tx).await?;
    if let Some(old) = previous {
        if old.get::<String, _>("kind") != "vital"
            || d.kind != "vital"
            || old.get::<Uuid, _>("page_id") != d.page
            || old.get::<Value, _>("payload")["name"] != clean["name"]
            || old.get::<DateTime<Utc>, _>("received_at") >= d.at
        {
            return Ok(());
        }
        sqlx::query(
            "DELETE FROM diagnostic_events WHERE environment_id=$1 AND id=$2 AND received_at=$3",
        )
        .bind(d.env)
        .bind(d.id)
        .bind(old.get::<DateTime<Utc>, _>("received_at"))
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("INSERT INTO diagnostic_events(environment_id,id,page_id,received_at,kind,path,device,visitor,fingerprint,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING")
        .bind(d.env).bind(d.id).bind(d.page).bind(d.at).bind(d.kind).bind(d.path).bind(d.device).bind(d.visitor).bind(d.fingerprint).bind(clean).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn telemetry_redacts_private_values_and_bounds_vitals() {
        let clean=payload("error",json!({"message":"failed at https://user:password@example.test/a?token=secret#hash for Alice@example.test 'private text' abcdefghijklmnopqrstuvwxyz0123456789","line":-10,"column":2_000_000})).unwrap();
        let message = clean["message"].as_str().unwrap();
        assert!(message.contains("https://example.test/a"));
        for private in ["password", "token", "Alice@", "private text", "abcdef"] {
            assert!(!message.contains(private));
        }
        assert_eq!(clean["line"], 0);
        assert_eq!(clean["column"], 1_000_000);
        assert!(payload("vital", json!({"name":"CLS","value":100.1})).is_err());
        assert!(payload("vital", json!({"name":"LCP","value":10})).is_ok());
    }
}

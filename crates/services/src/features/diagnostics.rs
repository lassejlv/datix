use crate::{billing, collect, sites};
use analytics_core::{
    Error, Result, State, crypto,
    validation::{self, DateRange},
};
use axum::http::HeaderMap;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    site_id: Uuid,
    environment_id: Uuid,
    id: Uuid,
    page_id: Uuid,
    url: String,
    kind: String,
    payload: Value,
    consent: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub diagnostic: Diagnostic,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
fn header<'a>(h: &'a HeaderMap, k: &str) -> &'a str {
    h.get(k).and_then(|v| v.to_str().ok()).unwrap_or("")
}
/// Remove URL parameters and common personal values before anything enters the queue.
pub fn sanitize(value: &str, max: usize) -> String {
    let text: String = value
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(max)
        .collect();
    let urls = regex::Regex::new(r#"https?://[^\s)\"']+"#).unwrap();
    let text = urls.replace_all(&text, |c: &regex::Captures| {
        url::Url::parse(&c[0])
            .ok()
            .map(|mut u| {
                u.set_query(None);
                u.set_fragment(None);
                let _ = u.set_username("");
                let _ = u.set_password(None);
                u.to_string()
            })
            .unwrap_or_default()
    });
    let emails = regex::Regex::new(r"(?i)[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}").unwrap();
    let text = emails.replace_all(&text, "[redacted]");
    let secrets = regex::Regex::new(r#"[\"'][^\"'\n]*[\"']|\b[A-Za-z0-9_-]{32,}\b"#).unwrap();
    secrets
        .replace_all(&text, "[redacted]")
        .chars()
        .take(max)
        .collect()
}
pub fn payload(kind: &str, raw: &Value) -> Result<Value> {
    if kind == "vital" {
        let name = raw["name"].as_str().unwrap_or("");
        let value = raw["value"].as_f64().unwrap_or(-1.);
        let limit = if name == "CLS" { 100. } else { 1_800_000. };
        if !["CLS", "LCP", "INP"].contains(&name)
            || !value.is_finite()
            || !(0. ..=limit).contains(&value)
        {
            return Err(Error::invalid("Invalid Web Vital."));
        }
        Ok(json!({"name":name,"value":value}))
    } else if kind == "error" {
        let message = sanitize(raw["message"].as_str().unwrap_or(""), 500);
        if message.trim().is_empty() {
            return Err(Error::invalid("An error needs a message."));
        }
        Ok(
            json!({"message":message,"source":sanitize(raw["source"].as_str().unwrap_or(""),512),"stack":sanitize(raw["stack"].as_str().unwrap_or(""),2000),"line":raw["line"].as_u64().unwrap_or(0).min(1_000_000),"column":raw["column"].as_u64().unwrap_or(0).min(1_000_000)}),
        )
    } else {
        Err(Error::invalid("Invalid diagnostic type."))
    }
}
pub async fn collect(state: &State, h: &HeaderMap, body: Value, ip: &str) -> Result<Value> {
    let input: Input = validation::decode(body)?;
    let ua = header(h, "user-agent");
    if header(h, "dnt") == "1" || collect::is_bot(ua) {
        return Ok(json!({"accepted":false}));
    }
    state
        .limit(
            "diagnostics",
            &crypto::hash(&state.config.visitor_secret, ip),
            60,
        )
        .await?;
    let policy = billing::admission::load(state, input.site_id, input.environment_id).await?;
    if matches!(
        policy.pause_reason(input.site_id, Utc::now())?,
        Some("subscription_required" | "website_limit")
    ) {
        return Ok(json!({"accepted":false}));
    }
    let env = sites::environment(state, input.site_id, input.environment_id).await?;
    let feature = if input.kind == "error" {
        "errors"
    } else {
        "webVitals"
    };
    if !env.enabled
        || !super::enabled(&env.feature_settings, feature)
        || policy.tracking_mode != "cookieless" && !input.consent
    {
        return Ok(json!({"accepted":false}));
    }
    let page = collect::page_url(
        &input.url,
        &env.domain,
        header(h, "origin"),
        env.allow_localhost,
    )?;
    let data = payload(&input.kind, &input.payload)?;
    let at = Utc::now();
    let fingerprint = crypto::hash(
        &state.config.visitor_secret,
        &json!([
            env.id,
            data["name"],
            data["message"],
            data["source"],
            data["line"]
        ])
        .to_string(),
    );
    let diagnostic = Diagnostic {
        site: input.site_id,
        env: env.id,
        id: input.id,
        page: input.page_id,
        at,
        kind: input.kind,
        path: page.path().into(),
        device: if crate::tracking::settings(&env.tracking_settings)["device"] == true {
            collect::device(ua).into()
        } else {
            String::new()
        },
        visitor: crypto::hash(
            &state.config.visitor_secret,
            &json!([env.id, at.date_naive(), ip, ua]).to_string(),
        ),
        fingerprint,
        payload: data,
        consent: input.consent,
    };
    crate::queue::enqueue_value(state, &Envelope { diagnostic }).await?;
    Ok(json!({"accepted":true}))
}
pub async fn ingest(state: &State, d: &Diagnostic) -> Result<()> {
    if d.at < Utc::now() - Duration::days(30) || d.at > Utc::now() + Duration::seconds(60) {
        return Ok(());
    }
    let clean = payload(&d.kind, &d.payload)?;
    if d.path.len() > 2048 || d.visitor.len() > 128 || d.fingerprint.len() > 128 {
        return Err(Error::invalid("Invalid diagnostic envelope."));
    }
    let policy = match billing::admission::load(state, d.site, d.env).await {
        Ok(p) => p,
        Err(e) if e.status == 404 => return Ok(()),
        Err(e) => return Err(e),
    };
    if matches!(
        policy.pause_reason(d.site, Utc::now())?,
        Some("subscription_required" | "website_limit")
    ) {
        return Ok(());
    }
    let feature = if d.kind == "error" {
        "errors"
    } else {
        "webVitals"
    };
    sqlx::query("INSERT INTO diagnostic_events(environment_id,id,page_id,received_at,kind,path,device,visitor,fingerprint,payload) SELECT e.id,$2,$3,$4,$5,$6,$7,$8,$9,$10 FROM environments e JOIN sites s ON s.id=e.site_id WHERE e.id=$1 AND e.site_id=$11 AND e.enabled AND s.enabled AND coalesce((e.feature_settings->>$12)::boolean,$12='webVitals') AND (e.tracking_mode='cookieless' OR $13) ON CONFLICT(environment_id,id) DO UPDATE SET payload=excluded.payload,received_at=excluded.received_at WHERE diagnostic_events.kind='vital' AND excluded.kind='vital' AND diagnostic_events.page_id=excluded.page_id AND diagnostic_events.payload->>'name'=excluded.payload->>'name' AND diagnostic_events.received_at<excluded.received_at")
        .bind(d.env).bind(d.id).bind(d.page).bind(d.at).bind(&d.kind).bind(&d.path).bind(&d.device).bind(&d.visitor).bind(&d.fingerprint).bind(clean).bind(d.site).bind(feature).bind(d.consent).execute(&state.db).await?;
    Ok(())
}
pub async fn report(state: &State, env: Uuid, kind: &str, r: &DateRange) -> Result<Value> {
    let sql = if kind == "vital" {
        "SELECT jsonb_build_object('name',payload->>'name','device',device,'samples',count(*),'p75',percentile_cont(0.75) WITHIN GROUP(ORDER BY (payload->>'value')::double precision)) FROM diagnostic_events WHERE environment_id=$1 AND kind='vital' AND received_at >= $2::date AND received_at < $3::date+interval '1 day' GROUP BY payload->>'name',device ORDER BY payload->>'name',device"
    } else {
        "SELECT jsonb_build_object('fingerprint',d.fingerprint,'message',(array_agg(d.payload->>'message' ORDER BY d.received_at DESC))[1],'source',(array_agg(d.payload->>'source' ORDER BY d.received_at DESC))[1],'stack',(array_agg(d.payload->>'stack' ORDER BY d.received_at DESC))[1],'path',(array_agg(d.path ORDER BY d.received_at DESC))[1],'occurrences',count(*),'visitors',count(DISTINCT (d.received_at::date,d.visitor)),'lastSeen',max(d.received_at),'resolved',coalesce(max(r.resolved_at)>=max(d.received_at),false)) FROM diagnostic_events d LEFT JOIN error_resolutions r ON r.environment_id=d.environment_id AND r.fingerprint=d.fingerprint WHERE d.environment_id=$1 AND d.kind='error' AND d.received_at >= $2::date AND d.received_at < $3::date+interval '1 day' GROUP BY d.fingerprint ORDER BY max(d.received_at) DESC LIMIT 100"
    };
    let rows: Vec<Value> = sqlx::query_scalar(sql)
        .bind(env)
        .bind(r.from)
        .bind(r.to)
        .fetch_all(&state.db)
        .await?;
    Ok(json!({"items":rows}))
}
pub async fn resolve(state: &State, env: Uuid, fingerprint: &str) -> Result<Value> {
    if fingerprint.len() != 64 || !fingerprint.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::invalid("Invalid error fingerprint."));
    }
    sqlx::query("INSERT INTO error_resolutions(environment_id,fingerprint) SELECT $1,$2 WHERE EXISTS(SELECT 1 FROM diagnostic_events WHERE environment_id=$1 AND fingerprint=$2 AND kind='error') ON CONFLICT(environment_id,fingerprint) DO UPDATE SET resolved_at=now()")
        .bind(env).bind(fingerprint).execute(&state.db).await?;
    Ok(json!({"resolved":true}))
}

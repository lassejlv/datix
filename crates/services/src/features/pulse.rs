use analytics_core::{Error, Result, State, validation};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    net::{IpAddr, SocketAddr},
    time::{Duration, Instant},
};
use url::Url;
use uuid::Uuid;

pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let [a, b, c, _] = v.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || a == 169 && b == 254
                || a == 172 && (16..=31).contains(&b)
                || a == 192 && (b == 168 || b == 0 || b == 2)
                || a == 100 && (64..=127).contains(&b)
                || a == 198 && (b == 18 || b == 19 || b == 51 && c == 100)
                || a == 203 && b == 0 && c == 113)
        }
        IpAddr::V6(v) => {
            let s = v.segments();
            // Public native global-unicast only; exclude transition, documentation and protocol blocks.
            (s[0] & 0xe000) == 0x2000
                && !(s[0] == 0x2001 && (s[1] <= 0x1ff || s[1] == 0xdb8))
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && s[1] <= 0xfff)
        }
    }
}
pub fn validate_url(value: &str) -> Result<Url> {
    let u = Url::parse(value).map_err(|_| Error::invalid("Use a public HTTPS URL."))?;
    if value.len() > 2048
        || u.scheme() != "https"
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
        || u.port_or_known_default() != Some(443)
        || u.host_str().is_none()
    {
        return Err(Error::invalid(
            "Use a public HTTPS URL on port 443 without credentials or a fragment.",
        ));
    }
    if u.host_str()
        .is_some_and(|h| h == "localhost" || h.ends_with(".localhost") || h.ends_with(".local"))
    {
        return Err(Error::invalid("Use a public HTTPS URL."));
    }
    if let Some(host) = u.host_str() {
        if let Ok(ip) = host.trim_matches(['[', ']']).parse::<IpAddr>() {
            if !public_ip(ip) {
                return Err(Error::invalid("Use a public HTTPS URL."));
            }
        }
    }
    Ok(u)
}
async fn client(u: &Url) -> Result<reqwest::Client> {
    let host = u.host_str().ok_or_else(Error::unavailable)?;
    let addresses: Vec<SocketAddr> = tokio::time::timeout(
        Duration::from_secs(3),
        tokio::net::lookup_host((host.trim_matches(['[', ']']), 443)),
    )
    .await
    .map_err(|_| Error::unavailable())?
    .map_err(|_| Error::unavailable())?
    .collect();
    if addresses.is_empty() || addresses.iter().any(|a| !public_ip(a.ip())) {
        return Err(Error::invalid(
            "The URL must resolve only to public IP addresses.",
        ));
    }
    // Pin the validated DNS result; automatic redirects and ambient proxy settings are disabled.
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(8))
        .connect_timeout(Duration::from_secs(4))
        .resolve_to_addrs(host, &addresses)
        .user_agent("DatixPulse/1.0 (+https://usedatix.com; availability bot)")
        .build()
        .map_err(|_| Error::unavailable())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    url: String,
    webhook_url: Option<String>,
    clear_webhook: Option<bool>,
}
pub async fn configure(state: &State, env: Uuid, domain: &str, body: Value) -> Result<Value> {
    let input: Input = validation::decode(body)?;
    let url = validate_url(&input.url)?;
    if url.host_str() != Some(domain) {
        return Err(Error::invalid(
            "The monitor URL must use this environment's domain.",
        ));
    }
    client(&url).await?;
    let webhook = match input
        .webhook_url
        .as_deref()
        .filter(|v| !v.trim().is_empty())
    {
        Some(value) => {
            let u = validate_url(value)?;
            client(&u).await?;
            Some(u.to_string())
        }
        None => None,
    };
    sqlx::query("INSERT INTO pulse_monitors(environment_id,url,webhook_url) VALUES($1,$2,$3) ON CONFLICT(environment_id) DO UPDATE SET url=excluded.url,webhook_url=CASE WHEN $4 THEN NULL ELSE coalesce(excluded.webhook_url,pulse_monitors.webhook_url) END,config_version=gen_random_uuid(),state='unknown',failures=0,checked_at=NULL,next_check_at=now(),last_status=NULL,last_latency_ms=NULL,last_error=NULL,changed_at=now()")
        .bind(env).bind(url.as_str()).bind(webhook).bind(input.clear_webhook.unwrap_or(false)).execute(&state.db).await?;
    report(state, env).await
}
pub async fn report(state: &State, env: Uuid) -> Result<Value> {
    let monitor:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('url',url,'hasWebhook',webhook_url IS NOT NULL,'state',state,'checkedAt',checked_at,'statusCode',last_status,'latencyMs',last_latency_ms,'error',last_error,'changedAt',changed_at) FROM pulse_monitors WHERE environment_id=$1").bind(env).fetch_optional(&state.db).await?;
    let checks:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('checkedAt',checked_at,'available',available,'statusCode',status_code,'latencyMs',latency_ms) FROM pulse_checks WHERE environment_id=$1 ORDER BY checked_at DESC LIMIT 120").bind(env).fetch_all(&state.db).await?;
    let summary:Value=sqlx::query_scalar("SELECT jsonb_build_object('checks',count(*),'uptime',100.0*count(*) FILTER(WHERE available)/nullif(count(*),0),'uptime24h',100.0*count(*) FILTER(WHERE available AND checked_at>now()-interval '24 hours')/nullif(count(*) FILTER(WHERE checked_at>now()-interval '24 hours'),0)) FROM pulse_checks WHERE environment_id=$1 AND checked_at>now()-interval '7 days'").bind(env).fetch_one(&state.db).await?;
    let alert:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('state',a.state,'createdAt',a.created_at,'deliveredAt',a.delivered_at,'attempts',a.attempts,'error',a.last_error) FROM pulse_alerts a JOIN pulse_monitors m ON m.environment_id=a.environment_id AND m.config_version=a.config_version WHERE a.environment_id=$1 ORDER BY a.created_at DESC LIMIT 1").bind(env).fetch_optional(&state.db).await?;
    Ok(json!({"monitor":monitor,"checks":checks,"summary":summary,"alert":alert}))
}
#[derive(sqlx::FromRow)]
struct Monitor {
    environment_id: Uuid,
    site_id: Uuid,
    url: String,
    config_version: Uuid,
}
struct Outcome {
    up: bool,
    status: Option<i32>,
    latency: i32,
    error: Option<&'static str>,
}
async fn check(value: &str) -> Outcome {
    let start = Instant::now();
    let request = async {
        let mut url = validate_url(value)?;
        let host = url.host_str().unwrap_or("").to_string();
        for _ in 0..4 {
            let response = client(&url)
                .await?
                .get(url.clone())
                .send()
                .await
                .map_err(|_| Error::unavailable())?;
            let status = response.status();
            if status.is_redirection() {
                let next = response
                    .headers()
                    .get("location")
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(Error::unavailable)?;
                url = validate_url(url.join(next).map_err(|_| Error::unavailable())?.as_str())?;
                if url.host_str() != Some(host.as_str()) {
                    return Err(Error::invalid("Redirect changed host."));
                }
            } else {
                return Ok(status.as_u16() as i32);
            }
        }
        Err(Error::unavailable())
    };
    let status = tokio::time::timeout(Duration::from_secs(10), request)
        .await
        .ok()
        .and_then(Result::ok);
    let up = status.is_some_and(|s| (200..400).contains(&s));
    Outcome {
        up,
        status,
        latency: start.elapsed().as_millis().min(i32::MAX as u128) as i32,
        error: if up {
            None
        } else if status.is_some() {
            Some("The website returned an error status.")
        } else {
            Some("The website could not be reached safely within 10 seconds.")
        },
    }
}
pub fn transition(previous: &str, failures: i32, up: bool) -> (&'static str, i32, bool) {
    let failures = if up { 0 } else { failures.saturating_add(1) };
    let next = if up {
        "up"
    } else if failures >= 2 {
        "down"
    } else if previous == "up" {
        "up"
    } else {
        "unknown"
    };
    (
        next,
        failures,
        next != previous && (next == "down" || next == "up" && previous == "down"),
    )
}
async fn save(state: &State, m: &Monitor, o: Outcome) -> Result<()> {
    let mut tx = state.db.begin().await?;
    let current:Option<(String,i32,bool)>=sqlx::query_as("SELECT m.state,m.failures,m.webhook_url IS NOT NULL FROM pulse_monitors m JOIN environments e ON e.id=m.environment_id JOIN sites s ON s.id=e.site_id WHERE m.environment_id=$1 AND m.config_version=$2 AND e.enabled AND s.enabled AND e.feature_settings->>'pulse'='true' FOR UPDATE OF m")
        .bind(m.environment_id).bind(m.config_version).fetch_optional(&mut *tx).await?;
    let Some((previous, failures, webhook)) = current else {
        return Ok(());
    };
    let (next, failures, notify) = transition(&previous, failures, o.up);
    sqlx::query("INSERT INTO pulse_checks(environment_id,available,status_code,latency_ms,error) VALUES($1,$2,$3,$4,$5)").bind(m.environment_id).bind(o.up).bind(o.status).bind(o.latency).bind(o.error).execute(&mut *tx).await?;
    sqlx::query("UPDATE pulse_monitors SET state=$2,failures=$3,checked_at=now(),last_status=$4,last_latency_ms=$5,last_error=$6,changed_at=CASE WHEN state<>$2 THEN now() ELSE changed_at END WHERE environment_id=$1")
        .bind(m.environment_id).bind(next).bind(failures).bind(o.status).bind(o.latency).bind(o.error).execute(&mut *tx).await?;
    if notify && webhook {
        sqlx::query(
            "INSERT INTO pulse_alerts(environment_id,config_version,state) VALUES($1,$2,$3)",
        )
        .bind(m.environment_id)
        .bind(m.config_version)
        .bind(next)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}
pub async fn tick(state: &State) -> Result<()> {
    let monitors:Vec<Monitor>=sqlx::query_as("WITH due AS (SELECT m.environment_id FROM pulse_monitors m JOIN environments e ON e.id=m.environment_id JOIN sites s ON s.id=e.site_id WHERE m.next_check_at<=now() AND e.enabled AND s.enabled AND e.feature_settings->>'pulse'='true' ORDER BY m.next_check_at LIMIT 5 FOR UPDATE OF m SKIP LOCKED) UPDATE pulse_monitors m SET next_check_at=now()+interval '60 seconds' FROM due,environments e WHERE m.environment_id=due.environment_id AND e.id=m.environment_id RETURNING m.environment_id,e.site_id,m.url,m.config_version")
        .fetch_all(&state.db).await?;
    for m in monitors {
        let policy = crate::billing::admission::load(state, m.site_id, m.environment_id).await?;
        if matches!(
            policy.pause_reason(m.site_id, chrono::Utc::now())?,
            Some("subscription_required" | "website_limit")
        ) {
            continue;
        }
        let result = check(&m.url).await;
        save(state, &m, result).await?;
    }
    deliver(state).await
}
#[derive(sqlx::FromRow)]
struct Alert {
    id: Uuid,
    environment_id: Uuid,
    config_version: Uuid,
    state: String,
    url: String,
    webhook_url: String,
    attempts: i32,
}
async fn deliver(state: &State) -> Result<()> {
    let alerts:Vec<Alert>=sqlx::query_as("WITH due AS (SELECT a.id FROM pulse_alerts a JOIN pulse_monitors m ON m.environment_id=a.environment_id AND m.config_version=a.config_version JOIN environments e ON e.id=a.environment_id WHERE a.delivered_at IS NULL AND a.attempts<5 AND a.available_at<=now() AND m.webhook_url IS NOT NULL AND e.enabled AND e.feature_settings->>'pulse'='true' ORDER BY a.available_at LIMIT 5 FOR UPDATE OF a SKIP LOCKED) UPDATE pulse_alerts a SET attempts=a.attempts+1,available_at=now()+interval '2 minutes' FROM due,pulse_monitors m WHERE a.id=due.id AND m.environment_id=a.environment_id RETURNING a.id,a.environment_id,a.config_version,a.state,m.url,m.webhook_url,a.attempts")
        .fetch_all(&state.db).await?;
    for a in alerts {
        // Recheck immediately before a side effect, including stale outbox records after reconfiguration.
        let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pulse_monitors m JOIN environments e ON e.id=m.environment_id JOIN sites s ON s.id=e.site_id WHERE m.environment_id=$1 AND m.config_version=$2 AND e.enabled AND s.enabled AND e.feature_settings->>'pulse'='true')").bind(a.environment_id).bind(a.config_version).fetch_one(&state.db).await?;
        if !active {
            continue;
        }
        let message = format!("{} is {}", a.url, a.state);
        let send = async {
            let u = validate_url(&a.webhook_url)?;
            let r=client(&u).await?.post(u).header("Idempotency-Key",a.id.to_string()).json(&json!({"id":a.id,"event":format!("pulse.{}",a.state),"url":a.url,"state":a.state,"text":message,"content":message})).send().await.map_err(|_|Error::unavailable())?;
            if !r.status().is_success() {
                return Err(Error::unavailable());
            }
            Ok(())
        };
        let delivered = matches!(
            tokio::time::timeout(Duration::from_secs(10), send).await,
            Ok(Ok(()))
        );
        sqlx::query("UPDATE pulse_alerts SET delivered_at=CASE WHEN $2 THEN now() ELSE NULL END,last_error=CASE WHEN $2 THEN NULL ELSE 'Webhook delivery failed.' END,available_at=now()+($3::bigint*interval '1 minute') WHERE id=$1")
            .bind(a.id).bind(delivered).bind(2_i64.pow(a.attempts as u32)).execute(&state.db).await?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocks_private_and_transition_addresses() {
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "192.168.1.1",
            "::1",
            "::ffff:127.0.0.1",
            "2002:7f00:1::",
            "2001:db8::1",
            "fc00::1",
        ] {
            assert!(!public_ip(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
            assert!(public_ip(ip.parse().unwrap()));
        }
    }
    #[test]
    fn confirms_outage_and_notifies_once() {
        assert_eq!(transition("unknown", 0, true), ("up", 0, false));
        assert_eq!(transition("up", 0, false), ("up", 1, false));
        assert_eq!(transition("up", 1, false), ("down", 2, true));
        assert_eq!(transition("down", 2, false), ("down", 3, false));
        assert_eq!(transition("down", 3, true), ("up", 0, true));
    }
    #[test]
    fn rejects_unsafe_urls() {
        for url in [
            "http://example.com",
            "https://user:pass@example.com",
            "https://example.com:8443",
            "https://127.0.0.1",
            "https://[::1]",
            "https://localhost",
        ] {
            assert!(validate_url(url).is_err());
        }
    }
}

use std::{collections::HashSet, env};
use url::Url;

#[derive(Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Api,
    Worker,
    Combined,
}

#[derive(Clone)]
pub struct Config {
    pub app_url: String,
    pub database_url: String,
    pub redis_url: String,
    pub auth_secret: String,
    pub visitor_secret: String,
    pub queue_prefix: String,
    pub port: u16,
    pub max_connections: u32,
    pub external_effects: bool,
    pub cloudflare_origin_secret: Option<String>,
    pub metrics_token: Option<String>,
    pub admin_emails: HashSet<String>,
    pub role: Role,
    pub workers: usize,
    pub batch_size: i64,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let required = |key| {
            env::var(key)
                .ok()
                .filter(|v| !v.trim().is_empty())
                .ok_or_else(|| anyhow::anyhow!("{key} is required"))
        };
        let app_url =
            Url::parse(&required("APP_URL")?).map_err(|_| anyhow::anyhow!("Invalid APP_URL"))?;
        anyhow::ensure!(
            matches!(app_url.scheme(), "http" | "https")
                && app_url.username().is_empty()
                && app_url.password().is_none(),
            "Invalid APP_URL"
        );
        let auth_secret = required("BETTER_AUTH_SECRET")?;
        anyhow::ensure!(
            auth_secret.len() >= 32,
            "BETTER_AUTH_SECRET must have at least 32 bytes"
        );
        let visitor_secret =
            env::var("VISITOR_HASH_SECRET").unwrap_or_else(|_| auth_secret.clone());
        let queue_prefix = env::var("QUEUE_PREFIX").unwrap_or_else(|_| "datix-rust-v1".into());
        anyhow::ensure!(
            !queue_prefix.is_empty()
                && queue_prefix.len() <= 64
                && queue_prefix
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
            "Invalid QUEUE_PREFIX"
        );
        let effects = env::var("EXTERNAL_EFFECTS").unwrap_or_else(|_| "disabled".into());
        let mode = env::var("BILLING_STATE_MODE").unwrap_or_else(|_| "live".into());
        anyhow::ensure!(
            matches!(effects.as_str(), "enabled" | "disabled")
                && matches!(mode.as_str(), "live" | "snapshot")
                && !(effects == "enabled" && mode == "snapshot"),
            "Invalid external effects or billing mode"
        );
        let database_url = required("DATABASE_URL")?;
        datix_db::identity(&database_url)?;
        let redis_url = required("REDIS_URL")?;
        let parsed = Url::parse(&redis_url).map_err(|_| anyhow::anyhow!("Invalid REDIS_URL"))?;
        anyhow::ensure!(
            matches!(parsed.scheme(), "redis" | "rediss"),
            "Invalid REDIS_URL"
        );
        Ok(Self {
            role: match env::var("SERVICE_ROLE").as_deref().unwrap_or("combined") {
                "api" => Role::Api,
                "worker" => Role::Worker,
                "combined" => Role::Combined,
                _ => anyhow::bail!("Invalid SERVICE_ROLE"),
            },
            workers: integer("EVENT_WORKERS", 2, 32)? as usize,
            batch_size: integer("EVENT_BATCH_SIZE", 64, 1000)?,
            app_url: app_url.origin().ascii_serialization(),
            database_url,
            redis_url,
            auth_secret,
            visitor_secret,
            queue_prefix,
            port: env::var("PORT")
                .unwrap_or_else(|_| "3001".into())
                .parse()
                .map_err(|_| anyhow::anyhow!("Invalid PORT"))?,
            max_connections: env::var("DB_MAX_CONNECTIONS")
                .unwrap_or_else(|_| "8".into())
                .parse()
                .map_err(|_| anyhow::anyhow!("Invalid DB_MAX_CONNECTIONS"))?,
            external_effects: effects == "enabled",
            cloudflare_origin_secret: env::var("CLOUDFLARE_ORIGIN_SECRET")
                .ok()
                .filter(|v| !v.is_empty()),
            metrics_token: env::var("METRICS_TOKEN").ok().filter(|v| !v.is_empty()),
            admin_emails: env::var("ADMIN_EMAILS")
                .unwrap_or_default()
                .split(',')
                .map(|e| e.trim().to_lowercase())
                .filter(|e| !e.is_empty())
                .collect(),
        })
    }
}

fn integer(key: &str, fallback: i64, max: i64) -> anyhow::Result<i64> {
    let value = env::var(key)
        .ok()
        .map(|v| v.parse::<i64>())
        .transpose()
        .map_err(|_| anyhow::anyhow!("Invalid {key}"))?
        .unwrap_or(fallback);
    anyhow::ensure!((1..=max).contains(&value), "Invalid {key}");
    Ok(value)
}

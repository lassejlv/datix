use crate::{Error, Result};
use sqlx::{
    PgPool,
    postgres::{PgConnectOptions, PgPoolOptions, PgSslMode},
};
use std::{sync::Arc, time::Duration};
#[derive(Clone)]
pub struct Config {
    pub app_url: url::Url,
    pub auth_secret: String,
    pub visitor_secret: String,
    pub origin_secret: Option<String>,
    pub polar_token: Option<String>,
    pub polar_webhook_secret: Option<String>,
    pub polar_url: String,
    pub railway: bool,
    pub port: u16,
    pub static_dir: String,
    pub event_stream: String,
}
#[derive(Clone)]
pub struct State {
    pub db: PgPool,
    pub redis: redis::aio::ConnectionManager,
    pub http: reqwest::Client,
    pub config: Arc<Config>,
}
impl Config {
    pub fn from_env() -> std::result::Result<Self, String> {
        let required =
            |key: &str| std::env::var(key).map_err(|_| format!("Missing required variable: {key}"));
        let railway = std::env::var_os("RAILWAY_ENVIRONMENT_ID").is_some();
        let origin_secret = if railway {
            Some(required("CLOUDFLARE_ORIGIN_SECRET")?)
        } else {
            std::env::var("CLOUDFLARE_ORIGIN_SECRET").ok()
        };
        Ok(Self {
            app_url: url::Url::parse(&required("APP_URL")?).map_err(|_| "Invalid APP_URL")?,
            auth_secret: required("BETTER_AUTH_SECRET")?,
            visitor_secret: required("VISITOR_HASH_SECRET")?,
            origin_secret,
            polar_token: std::env::var("POLAR_ACCESS_TOKEN")
                .ok()
                .filter(|v| !v.trim().is_empty()),
            polar_webhook_secret: std::env::var("POLAR_WEBHOOK_SECRET")
                .ok()
                .filter(|v| !v.trim().is_empty()),
            polar_url: std::env::var("POLAR_API_URL")
                .unwrap_or_else(|_| "https://api.polar.sh".into()),
            railway,
            port: std::env::var("PORT")
                .unwrap_or_else(|_| "3000".into())
                .parse()
                .map_err(|_| "Invalid PORT")?,
            static_dir: std::env::var("STATIC_DIR").unwrap_or_else(|_| "web/dist/client".into()),
            event_stream: std::env::var("EVENT_STREAM")
                .unwrap_or_else(|_| "analytics:events:v2".into()),
        })
    }
}
impl State {
    pub async fn connect(config: Config, database_url: &str, redis_url: &str) -> Result<Self> {
        let db = connect_database(database_url).await?;
        let redis = redis::Client::open(redis_url)?
            .get_connection_manager()
            .await?;
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()
            .map_err(|_| Error::unavailable())?;
        Ok(Self {
            db,
            redis,
            http,
            config: Arc::new(config),
        })
    }
    pub async fn limit(&self, namespace: &str, key: &str, max: i64) -> Result<()> {
        let mut conn = self.redis.clone();
        let count: i64 = redis::Script::new("local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('PEXPIRE', KEYS[1], 60000) end; return n")
   .key(format!("analytics:rate:{namespace}:{key}")).invoke_async(&mut conn).await?;
        if count > max {
            return Err(Error::new(429, "rate_limited", "Too many requests."));
        }
        Ok(())
    }
}

pub async fn connect_database(database_url: &str) -> Result<PgPool> {
    let mut url = url::Url::parse(database_url).map_err(|_| Error::unavailable())?;
    let params: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| k != "channel_binding")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    url.query_pairs_mut().clear().extend_pairs(params);
    let options: PgConnectOptions = url.as_str().parse().map_err(|_| Error::unavailable())?;
    // Verify the Neon server certificate and hostname; never silently downgrade TLS.
    let options = options.ssl_mode(PgSslMode::VerifyFull);
    PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(15))
        .after_connect(|conn, _| {
            Box::pin(async move {
                sqlx::query("SET statement_timeout = '15s'")
                    .execute(&mut *conn)
                    .await?;
                sqlx::query("SET timezone = 'UTC'").execute(conn).await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .map_err(Error::from)
}

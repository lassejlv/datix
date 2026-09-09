use crate::{Error, Result};
use sqlx::{
    PgPool,
    postgres::{PgConnectOptions, PgPoolOptions, PgSslMode},
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Combined,
    Api,
    Worker,
}
impl Role {
    pub fn name(self) -> &'static str {
        match self {
            Self::Combined => "combined",
            Self::Api => "api",
            Self::Worker => "worker",
        }
    }
}
#[derive(Clone)]
pub struct Runtime {
    pub role: Role,
    pub db_connections: u32,
    pub db_acquire_timeout_ms: u64,
    pub statement_timeout_ms: u64,
    pub event_workers: usize,
    pub event_batch_size: usize,
    pub event_block_ms: u64,
    pub queue_max_pending: usize,
    pub report_cache_seconds: u64,
    pub billing_interval_ms: u64,
    pub billing_drain_seconds: u64,
    pub retention_batch_size: i64,
    pub retention_drain_seconds: u64,
    pub retention_max_rows: u64,
}
impl Default for Runtime {
    fn default() -> Self {
        Self {
            role: Role::Combined,
            db_connections: 10,
            db_acquire_timeout_ms: 5000,
            statement_timeout_ms: 15000,
            event_workers: 4,
            event_batch_size: 64,
            event_block_ms: 1000,
            queue_max_pending: 100000,
            report_cache_seconds: 5,
            billing_interval_ms: 1000,
            billing_drain_seconds: 10,
            retention_batch_size: 10000,
            retention_drain_seconds: 20,
            retention_max_rows: 250000,
        }
    }
}
impl Runtime {
    pub fn from_env() -> std::result::Result<Self, String> {
        fn number(
            name: &str,
            default: u64,
            min: u64,
            max: u64,
        ) -> std::result::Result<u64, String> {
            let value = std::env::var(name)
                .unwrap_or_else(|_| default.to_string())
                .parse::<u64>()
                .map_err(|_| format!("Invalid {name}"))?;
            if !(min..=max).contains(&value) {
                return Err(format!("{name} must be between {min} and {max}"));
            }
            Ok(value)
        }
        let mut r = Self::default();
        r.role = match std::env::var("SERVICE_ROLE")
            .as_deref()
            .unwrap_or("combined")
        {
            "combined" => Role::Combined,
            "api" => Role::Api,
            "worker" => Role::Worker,
            _ => return Err("SERVICE_ROLE must be api, worker, or combined".into()),
        };
        r.db_connections = number("DB_MAX_CONNECTIONS", r.db_connections as u64, 2, 100)? as u32;
        r.db_acquire_timeout_ms =
            number("DB_ACQUIRE_TIMEOUT_MS", r.db_acquire_timeout_ms, 100, 30000)?;
        r.statement_timeout_ms = number(
            "DB_STATEMENT_TIMEOUT_MS",
            r.statement_timeout_ms,
            1000,
            60000,
        )?;
        r.event_workers = number("EVENT_WORKERS", r.event_workers as u64, 1, 32)? as usize;
        r.event_batch_size =
            number("EVENT_BATCH_SIZE", r.event_batch_size as u64, 1, 128)? as usize;
        r.event_block_ms = number("EVENT_BLOCK_MS", r.event_block_ms, 100, 5000)?;
        r.queue_max_pending = number(
            "QUEUE_MAX_PENDING",
            r.queue_max_pending as u64,
            1000,
            1000000,
        )? as usize;
        r.report_cache_seconds = number("REPORT_CACHE_SECONDS", r.report_cache_seconds, 0, 30)?;
        r.billing_interval_ms = number("BILLING_INTERVAL_MS", r.billing_interval_ms, 100, 60000)?;
        r.billing_drain_seconds = number("BILLING_DRAIN_SECONDS", r.billing_drain_seconds, 1, 30)?;
        r.retention_batch_size = number(
            "RETENTION_BATCH_SIZE",
            r.retention_batch_size as u64,
            100,
            10000,
        )? as i64;
        r.retention_drain_seconds =
            number("RETENTION_DRAIN_SECONDS", r.retention_drain_seconds, 1, 30)?;
        r.retention_max_rows = number(
            "RETENTION_MAX_ROWS_PER_PASS",
            r.retention_max_rows,
            100,
            10000000,
        )?;
        Ok(r)
    }
}
#[derive(Clone)]
pub struct Config {
    pub app_url: url::Url,
    pub app_origins: Vec<String>,
    pub auth_secret: String,
    pub visitor_secret: String,
    pub origin_secret: Option<String>,
    pub polar_token: Option<String>,
    pub polar_url: String,
    pub polar_webhook_secret: Option<String>,
    pub railway: bool,
    pub port: u16,
    pub static_dir: String,
    pub event_stream: String,
    pub runtime: Runtime,
    pub metrics_token: Option<String>,
}
#[derive(Clone)]
pub struct State {
    pub db: PgPool,
    pub redis: redis::aio::ConnectionManager,
    pub redis_client: redis::Client,
    pub http: reqwest::Client,
    pub config: Arc<Config>,
    pub metrics: Arc<crate::metrics::Metrics>,
    pub report_cache: Arc<crate::cache::ReportCache>,
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
        let app_url = url::Url::parse(&required("APP_URL")?).map_err(|_| "Invalid APP_URL")?;
        let app_origins = app_origins_from(
            &app_url,
            std::env::var("APP_LEGACY_URL")
                .ok()
                .filter(|v| !v.trim().is_empty())
                .as_deref(),
        )?;
        Ok(Self {
            app_url,
            app_origins,
            auth_secret: required("BETTER_AUTH_SECRET")?,
            visitor_secret: required("VISITOR_HASH_SECRET")?,
            origin_secret,
            polar_token: std::env::var("POLAR_ACCESS_TOKEN")
                .ok()
                .filter(|v| !v.trim().is_empty()),
            polar_url: std::env::var("POLAR_API_URL")
                .unwrap_or_else(|_| "https://api.polar.sh".into()),
            polar_webhook_secret: std::env::var("POLAR_WEBHOOK_SECRET")
                .ok()
                .filter(|v| !v.trim().is_empty()),
            railway,
            port: std::env::var("PORT")
                .unwrap_or_else(|_| "3000".into())
                .parse()
                .map_err(|_| "Invalid PORT")?,
            static_dir: std::env::var("STATIC_DIR").unwrap_or_else(|_| "web/dist/client".into()),
            event_stream: std::env::var("EVENT_STREAM")
                .unwrap_or_else(|_| "analytics:events:v2".into()),
            runtime: Runtime::from_env()?,
            metrics_token: std::env::var("METRICS_TOKEN")
                .ok()
                .filter(|v| !v.is_empty()),
        })
    }
    pub fn allows_origin(&self, origin: Option<&str>) -> bool {
        origin.is_some_and(|received| self.app_origins.iter().any(|allowed| allowed == received))
    }
}
fn app_origins_from(
    app_url: &url::Url,
    legacy: Option<&str>,
) -> std::result::Result<Vec<String>, String> {
    let mut origins = vec![app_url.origin().ascii_serialization()];
    if let Some(value) = legacy {
        let url = url::Url::parse(value).map_err(|_| "Invalid APP_LEGACY_URL")?;
        let origin = url.origin().ascii_serialization();
        if !origins.contains(&origin) {
            origins.push(origin);
        }
    }
    Ok(origins)
}
impl State {
    pub async fn connect(config: Config, database_url: &str, redis_url: &str) -> Result<Self> {
        let db = connect_database_with(database_url, &config.runtime).await?;
        let redis_client = redis::Client::open(redis_url)?;
        let redis = redis_client.get_connection_manager().await?;
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()
            .map_err(|_| Error::unavailable())?;
        Ok(Self {
            db,
            redis,
            redis_client,
            http,
            config: Arc::new(config),
            metrics: Arc::new(crate::metrics::Metrics::default()),
            report_cache: Arc::new(crate::cache::ReportCache::default()),
        })
    }
    pub async fn acquire(&self) -> Result<sqlx::pool::PoolConnection<sqlx::Postgres>> {
        let started = Instant::now();
        let result = self.db.acquire().await;
        self.metrics
            .pool_wait_seconds
            .observe(started.elapsed().as_secs_f64());
        result.map_err(Error::from)
    }
    pub async fn begin(&self) -> Result<sqlx::Transaction<'static, sqlx::Postgres>> {
        let started = Instant::now();
        let result = self.db.begin().await;
        self.metrics
            .transaction_start_seconds
            .observe(started.elapsed().as_secs_f64());
        result.map_err(Error::from)
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
    connect_database_with(database_url, &Runtime::default()).await
}
pub async fn connect_database_with(database_url: &str, runtime: &Runtime) -> Result<PgPool> {
    let mut url = url::Url::parse(database_url).map_err(|_| Error::unavailable())?;
    let params: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| k != "channel_binding")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    url.query_pairs_mut().clear().extend_pairs(params);
    let options: PgConnectOptions = url.as_str().parse().map_err(|_| Error::unavailable())?;
    // Verify the Neon server certificate and hostname; never silently downgrade TLS.
    let pooled = url.host_str().is_some_and(|host| host.contains("-pooler."));
    // TimeZone is tracked by PgBouncer. statement_timeout must be a role default there.
    let mut options = options
        .ssl_mode(PgSslMode::VerifyFull)
        .options([("timezone", "UTC")]);
    if !pooled {
        options = options.options([(
            "statement_timeout",
            runtime.statement_timeout_ms.to_string(),
        )]);
    }
    let max_statement_ms = runtime.statement_timeout_ms;
    PgPoolOptions::new()
        .max_connections(runtime.db_connections)
        .acquire_timeout(Duration::from_millis(runtime.db_acquire_timeout_ms))
        .after_connect(move |conn, _| Box::pin(async move {
            if pooled {
                let timeout: i64 = sqlx::query_scalar("SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'")
                    .fetch_one(conn).await?;
                if timeout <= 0 || timeout as u64 > max_statement_ms {
                    return Err(sqlx::Error::Protocol("Set a bounded statement_timeout on the database role before using transaction pooling".into()));
                }
            }
            Ok(())
        }))
        .connect_with(options)
        .await
        .map_err(Error::from)
}

#[cfg(test)]
mod origin_tests {
    use super::app_origins_from;
    #[test]
    fn primary_and_legacy_origins_are_both_trusted() {
        let app = url::Url::parse("https://usedatix.com").unwrap();
        let origins = app_origins_from(&app, Some("https://analytics.beer")).unwrap();
        assert_eq!(origins, ["https://usedatix.com", "https://analytics.beer"]);
        assert_eq!(
            app_origins_from(&app, Some("https://usedatix.com/")).unwrap(),
            ["https://usedatix.com"]
        );
        assert!(app_origins_from(&app, Some("not a url")).is_err());
    }
}

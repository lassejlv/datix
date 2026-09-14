//! Datix HTTP API and background analytics services.

mod abuse;
mod admin;
mod analytics;
mod auth_hooks;
mod billing;
pub mod config;
mod diagnostics;
mod email;
pub mod error;
mod http;
mod imports;
mod ingestion;
#[cfg(test)]
mod ingestion_tests;
mod maintenance;
mod queue;
mod sites;
mod storage;
mod tracking;
pub mod workers;

use config::Config;
use datix_auth::{Auth, SocialProvider};
use redis::aio::ConnectionManager;
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub pool: PgPool,
    pub redis: ConnectionManager,
    pub auth: Auth,
    pub billing: billing::Billing,
    pub queue: queue::Queue,
    pub health: Arc<workers::Health>,
    pub storage: storage::Storage,
}

impl AppState {
    pub async fn connect(config: Config) -> anyhow::Result<Self> {
        let pool = datix_db::connect_runtime(&config.database_url, config.max_connections).await?;
        let redis = redis::Client::open(config.redis_url.as_str())
            .map_err(|_| anyhow::anyhow!("Invalid Redis connection"))?;
        let redis = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            ConnectionManager::new(redis),
        )
        .await
        .map_err(|_| anyhow::anyhow!("Redis connection timeout"))?
        .map_err(|_| anyhow::anyhow!("Redis connection failed"))?;
        let config = Arc::new(config);
        let queue = queue::Queue::new(redis.clone(), &config.queue_prefix);
        queue.initialize().await?;
        let billing = billing::Billing::from_env(pool.clone(), &config)?;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let hooks = Arc::new(auth_hooks::Hooks {
            billing: billing.clone(),
            config: config.clone(),
            mailer: if config.external_effects {
                Some(email::Mailer::from_env(client)?)
            } else {
                None
            },
        });
        let mut providers = Vec::new();
        for (id, construct) in [
            (
                "GITHUB",
                SocialProvider::github
                    as fn(String, String) -> Result<SocialProvider, datix_auth::AuthError>,
            ),
            ("GOOGLE", SocialProvider::google),
        ] {
            if let (Ok(client_id), Ok(client_secret)) = (
                std::env::var(format!("{id}_CLIENT_ID")),
                std::env::var(format!("{id}_CLIENT_SECRET")),
            ) {
                providers.push(construct(client_id, client_secret)?);
            }
        }
        let auth = Auth::new(
            pool.clone(),
            config.auth_secret.clone(),
            &config.app_url,
            hooks,
        )?
        .with_social_providers(providers);
        let health = Arc::new(workers::Health::new(config.workers));
        let storage = storage::Storage::from_env(config.external_effects)?;
        Ok(Self {
            config,
            pool,
            redis,
            auth,
            billing,
            queue,
            health,
            storage,
        })
    }
}

pub fn router(state: AppState) -> axum::Router {
    http::router(state)
}

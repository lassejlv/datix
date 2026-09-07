use analytics_core::{Config, State};
use analytics_server::{http, jobs::Jobs};
use tracing_subscriber::EnvFilter;
#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                EnvFilter::new("analytics_server=info,analytics_services=info")
            }),
        )
        .json()
        .init();
    if let Err(message) = run().await {
        tracing::error!(reason=%message,"startup or runtime failed");
        std::process::exit(1)
    }
}
async fn run() -> Result<(), String> {
    let config = Config::from_env()?;
    let port = config.port;
    let database = std::env::var("DATABASE_URL").map_err(|_| "Missing DATABASE_URL")?;
    let redis = std::env::var("REDIS_URL").map_err(|_| "Missing REDIS_URL")?;
    let state = State::connect(config, &database, &redis)
        .await
        .map_err(|_| "Failed to connect to database or Redis")?;
    analytics_core::database::check(&state.db)
        .await
        .map_err(|_| "Database schema is incompatible with this release")?;
    let jobs = Jobs::start(state.clone())
        .await
        .map_err(|_| "Failed to start background jobs")?;
    let app = http::router(state.clone(), jobs.ready.clone());
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .map_err(|_| "Failed to bind HTTP listener")?;
    tracing::info!(
        port,
        runtime = "rust",
        framework = "axum",
        role = state.config.runtime.role.name(),
        db_max_connections = state.config.runtime.db_connections,
        event_workers = state.config.runtime.event_workers,
        event_batch_size = state.config.runtime.event_batch_size,
        "server started"
    );
    let ready = jobs.ready.clone();
    let result = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown().await;
        ready.store(false, std::sync::atomic::Ordering::Release);
    })
    .await;
    jobs.close().await;
    state.db.close().await;
    result.map_err(|_| "HTTP server failed".into())
}
async fn shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {_=ctrl_c=>{},_=terminate=>{}}
}

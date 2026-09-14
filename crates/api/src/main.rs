use datix_api::{AppState, config::Config};

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    if let Some(argument) = args.next() {
        anyhow::ensure!(
            argument == "--env-file",
            "Use --env-file PATH for local development"
        );
        let path = args
            .next()
            .ok_or_else(|| anyhow::anyhow!("Missing environment file path"))?;
        anyhow::ensure!(args.next().is_none(), "Unexpected argument");
        dotenvy::from_path_override(path)
            .map_err(|_| anyhow::anyhow!("Cannot load environment file"))?;
    }
    tracing_subscriber::fmt()
        .with_env_filter("datix_api=info,tower_http=warn")
        .init();
    let config = Config::from_env()?;
    let port = config.port;
    let state = AppState::connect(config).await?;
    let pool = state.pool.clone();
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    let workers = datix_api::workers::Workers::start(state.clone());
    let stop = workers.shutdown_trigger();
    tracing::info!(port, "Datix Rust API listening");
    let result = axum::serve(
        listener,
        datix_api::router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown().await;
        stop();
    })
    .await;
    // The platform must allow at least 90 seconds for active transactions and
    // external acknowledgments to finish. Do not force-abort in-flight tasks.
    workers.shutdown().await;
    pool.close().await;
    result?;
    Ok(())
}

async fn shutdown() {
    let interrupt = async {
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
    tokio::select! {_=interrupt=>{},_=terminate=>{}}
    tracing::info!("Draining requests");
}

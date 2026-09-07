use analytics_core::{Config, State};
use analytics_services::queue;
#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();
    let command = std::env::args().nth(1).unwrap_or_else(|| "inspect".into());
    if !["inspect", "migrate-legacy"].contains(&command.as_str()) {
        eprintln!("Usage: analytics-queue [inspect|migrate-legacy]");
        std::process::exit(2)
    }
    let result = async {
        let config = Config::from_env()?;
        let database = std::env::var("DATABASE_URL").map_err(|_| "Missing DATABASE_URL")?;
        let redis = std::env::var("REDIS_URL").map_err(|_| "Missing REDIS_URL")?;
        let state = State::connect(config, &database, &redis)
            .await
            .map_err(|_| "Failed to connect to database or Redis")?;
        let report = if command == "inspect" {
            queue::inspect(&state).await
        } else {
            queue::migrate_legacy(&state).await
        }
        .map_err(|_| "Queue operation failed")?;
        println!("{report}");
        state.db.close().await;
        if report["invalidRetained"].as_i64().is_some_and(|n| n > 0) {
            return Err(
                "Legacy queue contains invalid envelopes; original records were preserved."
                    .to_string(),
            );
        }
        Ok::<_, String>(())
    }
    .await;
    if let Err(message) = result {
        eprintln!("{message}");
        std::process::exit(1)
    }
}

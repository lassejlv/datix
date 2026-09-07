use analytics_core::{config::connect_database, database};
#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();
    let command = std::env::args().nth(1).unwrap_or_else(|| "check".into());
    if !["check", "init-empty", "upgrade"].contains(&command.as_str()) {
        eprintln!("Usage: analytics-db [check|init-empty|upgrade]");
        std::process::exit(2)
    }
    let result = async {
        let url = std::env::var("DATABASE_URL").map_err(|_| "Missing DATABASE_URL".to_owned())?;
        let db = connect_database(&url)
            .await
            .map_err(|_| "Database connection failed".to_owned())?;
        if command == "init-empty" {
            database::initialize_empty(&db)
                .await
                .map_err(|e| e.message)?;
        }
        if command == "upgrade" {
            database::upgrade(&db).await.map_err(|e| e.message)?;
        }
        let report = database::check(&db).await.map_err(|e| e.message)?;
        println!("{report}");
        db.close().await;
        Ok::<_, String>(())
    }
    .await;
    if let Err(message) = result {
        eprintln!("{message}");
        std::process::exit(1)
    }
}

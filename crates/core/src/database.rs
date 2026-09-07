//! Existing databases are inspected, never automatically recreated or migrated at server startup.
use crate::{Error, Result};
use serde_json::{Value, json};
use sqlx::PgPool;
pub static MIGRATIONS: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
pub async fn check(pool: &PgPool) -> Result<Value> {
    let expected: Value =
        serde_json::from_str(include_str!("../../../docs/database/live-schema.json"))
            .map_err(|_| Error::unavailable())?;
    let columns:Vec<(String,String,String,bool)>=sqlx::query_as("SELECT table_name,column_name,udt_name,is_nullable='YES' FROM information_schema.columns WHERE table_schema='public'").fetch_all(pool).await?;
    let mut missing = vec![];
    for column in expected["columns"]
        .as_array()
        .ok_or_else(Error::unavailable)?
    {
        let table = column["table_name"]
            .as_str()
            .ok_or_else(Error::unavailable)?;
        let name = column["column_name"]
            .as_str()
            .ok_or_else(Error::unavailable)?;
        let kind = column["udt_name"].as_str().ok_or_else(Error::unavailable)?;
        let nullable = column["is_nullable"] == "YES";
        if !columns
            .iter()
            .any(|c| c.0 == table && c.1 == name && c.2 == kind && c.3 == nullable)
        {
            missing.push(format!("{table}.{name}"));
        }
    }
    let trigger:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.sites'::regclass AND tgname='sites_default_environment' AND tgenabled<>'D')").fetch_one(pool).await?;
    if !missing.is_empty() || !trigger {
        return Err(Error::new(
            503,
            "schema_incompatible",
            format!(
                "Database schema differs from the inspected baseline: {}{}",
                missing.join(", "),
                if !trigger {
                    "; default environment trigger missing"
                } else {
                    ""
                }
            ),
        ));
    }
    Ok(
        json!({"compatible":true,"columnsChecked":expected["columns"].as_array().unwrap().len(),"defaultEnvironmentTrigger":true}),
    )
}
pub async fn initialize_empty(pool: &PgPool) -> Result<()> {
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name<>'_sqlx_migrations'").fetch_one(pool).await?;
    if count != 0 {
        return Err(Error::new(
            409,
            "database_not_empty",
            "The schema baseline is only for a new empty database. Existing databases require only a compatibility check.",
        ));
    }
    MIGRATIONS
        .run(pool)
        .await
        .map_err(|_| Error::new(503, "migration_failed", "Database initialization failed."))?;
    Ok(())
}

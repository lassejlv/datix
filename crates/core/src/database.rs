//! Existing databases are inspected, never automatically recreated or migrated at server startup.
use crate::{Error, Result};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
pub static MIGRATIONS: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
static UPGRADES: &[(i64, &str)] = &[
    (2, include_str!("../upgrades/0002_scaling.sql")),
    (3, include_str!("../upgrades/0003_partition_events.sql")),
    (4, include_str!("../upgrades/0004_imports.sql")),
    (5, include_str!("../upgrades/0005_autumn.sql")),
    (
        6,
        include_str!("../upgrades/0006_billing_provider_defaults.sql"),
    ),
    (7, include_str!("../upgrades/0007_checkout_options.sql")),
    (8, include_str!("../upgrades/0008_features.sql")),
    (9, include_str!("../upgrades/0009_polar_datix.sql")),
    (
        10,
        include_str!("../upgrades/0010_polar_usage_compatibility.sql"),
    ),
];

pub async fn check(pool: &PgPool) -> Result<Value> {
    let mut report = check_base(pool, true).await?;
    let exists: bool =
        sqlx::query_scalar("SELECT to_regclass('public.analytics_schema_migrations') IS NOT NULL")
            .fetch_one(pool)
            .await?;
    if !exists {
        return Err(Error::new(
            503,
            "schema_upgrade_required",
            "Apply analytics-db upgrade under the database owner before deploying this release.",
        ));
    }
    let versions: Vec<(i64, String)> =
        sqlx::query_as("SELECT version,checksum FROM analytics_schema_migrations")
            .fetch_all(pool)
            .await?;
    for (version, sql) in UPGRADES {
        let checksum = hex::encode(Sha256::digest(sql.as_bytes()));
        if !versions
            .iter()
            .any(|(v, hash)| v == version && hash == &checksum)
        {
            return Err(Error::new(
                503,
                "schema_upgrade_required",
                format!("Schema upgrade {version} is missing or has a different checksum."),
            ));
        }
    }
    report["schemaVersion"] = json!(UPGRADES.last().unwrap().0);
    let partitioned: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_class WHERE oid IN('public.events'::regclass,'public.activity_events'::regclass) AND relkind='p'").fetch_one(pool).await?;
    if partitioned != 2 {
        return Err(Error::new(
            503,
            "schema_incompatible",
            "Event tables must be partitioned for this release.",
        ));
    }
    report["partitionedEventTables"] = json!(partitioned);
    Ok(report)
}

async fn check_base(pool: &PgPool, include_upgrades: bool) -> Result<Value> {
    let expected: Value =
        serde_json::from_str(include_str!("../../../docs/database/live-schema.json"))
            .map_err(|_| Error::unavailable())?;
    let columns:Vec<(String,String,String,bool)>=sqlx::query_as("SELECT table_name,column_name,udt_name,is_nullable='YES' FROM information_schema.columns WHERE table_schema='public'").fetch_all(pool).await?;
    let mut missing = vec![];
    for column in expected["columns"]
        .as_array()
        .ok_or_else(Error::unavailable)?
    {
        if !include_upgrades && column["since_version"].as_i64().is_some() {
            continue;
        }
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
    upgrade(pool).await?;
    Ok(())
}

/// Explicit owner-only, atomic expansion. Existing schema is checked before recording any upgrades.
pub async fn upgrade(pool: &PgPool) -> Result<()> {
    check_base(pool, false).await?;
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(732806230)")
        .execute(&mut *tx)
        .await?;
    sqlx::raw_sql("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='120s'; CREATE TABLE IF NOT EXISTS analytics_schema_migrations(version bigint PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())")
        .execute(&mut *tx).await?;
    for (version, sql) in UPGRADES {
        let checksum = hex::encode(Sha256::digest(sql.as_bytes()));
        let previous: Option<String> =
            sqlx::query_scalar("SELECT checksum FROM analytics_schema_migrations WHERE version=$1")
                .bind(version)
                .fetch_optional(&mut *tx)
                .await?;
        if let Some(previous) = previous {
            if previous != checksum {
                return Err(Error::new(
                    409,
                    "migration_changed",
                    format!("Applied migration {version} must not be modified."),
                ));
            }
            continue;
        }
        // Block writes while backfilling; lock acquisition fails quickly instead of waiting behind traffic.
        sqlx::raw_sql("LOCK TABLE \"user\",sites,environments,events,activity_events IN SHARE ROW EXCLUSIVE MODE").execute(&mut *tx).await?;
        sqlx::raw_sql(sql)
            .execute(&mut *tx)
            .await
            .map_err(|error| {
                Error::new(
                    503,
                    "migration_failed",
                    format!("Schema upgrade {version} failed: {error}"),
                )
            })?;
        sqlx::query("INSERT INTO analytics_schema_migrations(version,checksum) VALUES($1,$2)")
            .bind(version)
            .bind(checksum)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

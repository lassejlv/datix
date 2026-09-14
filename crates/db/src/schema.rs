//! Catalog snapshots contain schema metadata only, never application rows.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Connection, PgConnection, PgPool};

use crate::{
    DbError,
    migrations::{self, Applied, Migration},
};

#[derive(Debug, Serialize, Deserialize)]
pub struct Snapshot {
    pub format: u32,
    pub schema: Value,
    pub migrations: Vec<Applied>,
}

pub async fn snapshot(connection: &mut PgConnection) -> Result<Snapshot, DbError> {
    let mut tx = connection.begin().await?;
    sqlx::raw_sql("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    let schema = sqlx::query_scalar(include_str!("schema.sql"))
        .fetch_one(&mut *tx)
        .await?;
    let migrations = migrations::applied(&mut tx).await?;
    tx.commit().await?;
    Ok(Snapshot {
        format: 2,
        schema,
        migrations,
    })
}

/// Restore only migration metadata on a schema-only branch after exact schema comparison.
pub async fn baseline(
    connection: &mut PgConnection,
    expected: &Snapshot,
    migrations: &[Migration],
    apply: bool,
) -> Result<(), DbError> {
    if expected.format != 2 || expected.migrations.len() != migrations.len() {
        return Err(DbError::Invalid(
            "Baseline must contain the complete reviewed migration history".into(),
        ));
    }
    migrations::validate(migrations, &expected.migrations)?;
    let mut tx = connection.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(791343524)")
        .execute(&mut *tx)
        .await?;
    let actual: Value = sqlx::query_scalar(include_str!("schema.sql"))
        .fetch_one(&mut *tx)
        .await?;
    if actual != expected.schema {
        return Err(DbError::Invalid(
            "Schema differs from the reviewed production snapshot; refusing to baseline".into(),
        ));
    }
    let history = migrations::applied(&mut tx).await?;
    migrations::validate(migrations, &history)?;
    if !history.is_empty() && history != expected.migrations {
        return Err(DbError::Invalid(
            "Cannot baseline partially applied history".into(),
        ));
    }
    if apply && history.is_empty() {
        for migration in &expected.migrations {
            sqlx::query("INSERT INTO public.datix_schema_migrations(name,checksum) VALUES($1,$2)")
                .bind(&migration.name)
                .bind(&migration.checksum)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

/// Check operational invariants on a restricted runtime connection without writing.
pub async fn check_runtime(pool: &PgPool) -> Result<(), DbError> {
    let mut connection = pool.acquire().await?;
    let migrations = migrations::bundled();
    let history = migrations::applied(&mut connection).await?;
    migrations::validate(&migrations, &history)?;
    if history.len() != migrations.len() {
        return Err(DbError::Invalid("Schema upgrade required".into()));
    }
    let valid: bool = sqlx::query_scalar("SELECT current_setting('server_version_num')::int >= 180000 AND EXISTS(SELECT 1 FROM pg_extension WHERE extname='timescaledb') AND current_setting('TimeZone')='UTC' AND current_setting('statement_timeout')::interval > interval '0s' AND current_setting('statement_timeout')::interval <= interval '15s' AND current_setting('lock_timeout')::interval > interval '0s' AND current_setting('lock_timeout')::interval <= interval '3s'").fetch_one(&mut *connection).await?;
    if !valid {
        return Err(DbError::Invalid(
            "PostgreSQL 18, TimescaleDB, UTC and bounded runtime timeouts are required".into(),
        ));
    }
    let privileged: bool = sqlx::query_scalar("SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR has_schema_privilege(current_user,'public','CREATE') OR has_table_privilege(current_user,'public.datix_schema_migrations','INSERT,UPDATE,DELETE,TRUNCATE') OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid) FROM pg_roles WHERE rolname=current_user").fetch_one(&mut *connection).await?;
    if privileged {
        return Err(DbError::Invalid(
            "Use a restricted runtime role without memberships".into(),
        ));
    }
    let hypertables: Vec<String> = sqlx::query_scalar("SELECT hypertable_name FROM timescaledb_information.hypertables WHERE hypertable_schema='public'").fetch_all(&mut *connection).await?;
    for required in [
        "events",
        "activity_events",
        "diagnostic_events",
        "goal_conversions",
        "daily_stats",
        "daily_visitors",
    ] {
        if !hypertables.iter().any(|name| name == required) {
            return Err(DbError::Invalid(format!("Missing hypertable: {required}")));
        }
    }
    let triggers: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND tgname IN('sites_default_environment','environments_analytics_cleanup','datix_session_access')").fetch_one(&mut *connection).await?;
    if triggers != 3 {
        return Err(DbError::Invalid(
            "Required lifecycle triggers missing".into(),
        ));
    }
    Ok(())
}

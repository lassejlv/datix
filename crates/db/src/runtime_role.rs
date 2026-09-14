//! Explicit grants for the existing, non-owner runtime role.

use crate::{DbError, migrations};
use sqlx::{Connection, PgConnection};

pub async fn configure(connection: &mut PgConnection, apply: bool) -> Result<(), DbError> {
    let expected = migrations::bundled();
    let history = migrations::applied(connection).await?;
    migrations::validate(&expected, &history)?;
    if history.len() != expected.len() {
        return Err(DbError::Invalid(
            "Apply all migrations before configuring the runtime role".into(),
        ));
    }
    let valid: Option<bool> = sqlx::query_scalar("SELECT NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid)) FROM pg_roles WHERE rolname='datix_runtime'").fetch_optional(&mut *connection).await?;
    if valid != Some(true) {
        return Err(DbError::Invalid(
            "Create datix_runtime as an unprivileged login with no role memberships first".into(),
        ));
    }
    if !apply {
        return Ok(());
    }
    let mut tx = connection.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(791343524)")
        .execute(&mut *tx)
        .await?;
    let database: String = sqlx::query_scalar("SELECT current_database()")
        .fetch_one(&mut *tx)
        .await?;
    let tables: Vec<String> = sqlx::query_scalar("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'datix_schema_migrations' ORDER BY tablename").fetch_all(&mut *tx).await?;
    let quote = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
    sqlx::raw_sql(&format!(
        "GRANT CONNECT ON DATABASE {} TO datix_runtime",
        quote(&database)
    ))
    .execute(&mut *tx)
    .await?;
    sqlx::raw_sql("REVOKE CREATE ON SCHEMA public FROM PUBLIC,datix_runtime; GRANT USAGE ON SCHEMA public TO datix_runtime; REVOKE ALL ON ALL TABLES IN SCHEMA public FROM datix_runtime;").execute(&mut *tx).await?;
    for table in tables {
        sqlx::raw_sql(&format!(
            "GRANT SELECT,INSERT,UPDATE,DELETE ON public.{} TO datix_runtime",
            quote(&table)
        ))
        .execute(&mut *tx)
        .await?;
    }
    sqlx::raw_sql("GRANT SELECT ON public.datix_schema_migrations TO datix_runtime; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO datix_runtime; GRANT EXECUTE ON FUNCTION public.datix_retention() TO datix_runtime; ALTER ROLE datix_runtime SET timezone='UTC'; ALTER ROLE datix_runtime SET statement_timeout='15s'; ALTER ROLE datix_runtime SET lock_timeout='3s'; ALTER ROLE datix_runtime SET idle_in_transaction_session_timeout='30s'").execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

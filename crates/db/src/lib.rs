//! PostgreSQL connections, immutable migrations, and production schema validation.

pub mod migrations;
pub mod runtime_role;
pub mod schema;

use std::{str::FromStr, time::Duration};

use sqlx::{
    ConnectOptions, Connection, PgConnection, PgPool,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use thiserror::Error;
use url::Url;

/// Database failures deliberately omit SQL arguments and connection credentials.
#[derive(Debug, Error)]
pub enum DbError {
    #[error("{0}")]
    Invalid(String),
    #[error("Database operation failed")]
    Sql(#[from] sqlx::Error),
    #[error("Database file could not be read")]
    Io(#[from] std::io::Error),
    #[error("Invalid schema snapshot")]
    Json(#[from] serde_json::Error),
}

/// Independently reviewable connection identity; contains no password.
#[derive(Debug, serde::Serialize)]
pub struct Identity {
    pub host: String,
    pub database: String,
    pub role: String,
}

/// Parse the target without ever including the input URL in an error.
pub fn identity(url: &str) -> Result<Identity, DbError> {
    let url = Url::parse(url).map_err(|_| DbError::Invalid("Invalid database URL".into()))?;
    let host = url
        .host_str()
        .ok_or_else(|| DbError::Invalid("Database host is required".into()))?;
    if !matches!(url.scheme(), "postgres" | "postgresql") {
        return Err(DbError::Invalid("PostgreSQL URL required".into()));
    }
    let options = connection_options(url.as_str())?;
    if !matches!(host, "localhost" | "127.0.0.1" | "::1")
        && !url.query_pairs().any(|(k, v)| {
            k == "sslmode" && matches!(v.as_ref(), "require" | "verify-ca" | "verify-full")
        })
    {
        return Err(DbError::Invalid("Remote databases require TLS".into()));
    }
    Ok(Identity {
        host: host.into(),
        database: options
            .get_database()
            .ok_or_else(|| DbError::Invalid("Database name is required".into()))?
            .into(),
        role: options.get_username().into(),
    })
}

fn connection_options(url: &str) -> Result<PgConnectOptions, DbError> {
    Ok(PgConnectOptions::from_str(url)
        .map_err(|_| DbError::Invalid("Invalid PostgreSQL connection options".into()))?
        .disable_statement_logging())
}

/// Open the bounded, restricted runtime pool. Role defaults must work through PgBouncer.
pub async fn connect_runtime(url: &str, max_connections: u32) -> Result<PgPool, DbError> {
    identity(url)?;
    if !(1..=30).contains(&max_connections) {
        return Err(DbError::Invalid(
            "DB_MAX_CONNECTIONS must be between 1 and 30".into(),
        ));
    }
    let pool = PgPoolOptions::new()
        .max_connections(max_connections)
        .min_connections(0)
        .acquire_timeout(Duration::from_secs(10))
        .idle_timeout(Duration::from_secs(60))
        .max_lifetime(Duration::from_secs(300))
        .connect_with(connection_options(url)?)
        .await?;
    schema::check_runtime(&pool).await?;
    Ok(pool)
}

/// Open one direct connection after checking the independently supplied target.
pub async fn connect_owner(
    url: &str,
    host: &str,
    database: &str,
) -> Result<(PgConnection, Identity), DbError> {
    let expected = identity(url)?;
    if expected.host != host || expected.database != database || expected.host.contains("-pooler.")
    {
        return Err(DbError::Invalid(
            "Pass the exact direct endpoint and database with --expect-host and --expect-database"
                .into(),
        ));
    }
    let mut connection = PgConnection::connect_with(&connection_options(url)?).await?;
    let actual: (String, String) = sqlx::query_as("SELECT current_database(),current_user")
        .fetch_one(&mut connection)
        .await?;
    if actual != (expected.database.clone(), expected.role.clone()) {
        return Err(DbError::Invalid("Database identity mismatch".into()));
    }
    sqlx::raw_sql("SET timezone='UTC'; SET lock_timeout='3s'; SET statement_timeout='120s'; SET idle_in_transaction_session_timeout='30s'").execute(&mut connection).await?;
    Ok((connection, expected))
}

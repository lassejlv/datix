//! Retains the existing Bun migration ledger and advisory lock during the transition.

use sha2::{Digest, Sha256};
use sqlx::{Connection, PgConnection};
use std::path::Path;

use crate::DbError;

include!(concat!(env!("OUT_DIR"), "/migrations.rs"));

/// SQL is embedded so the runtime binary does not depend on a source checkout.
pub fn bundled() -> Vec<Migration> {
    BUNDLED
        .iter()
        .map(|(name, sql)| Migration {
            name: (*name).into(),
            sql: (*sql).into(),
            checksum: hex::encode(Sha256::digest(sql.as_bytes())),
        })
        .collect()
}

/// Immutable migration read from the reviewed SQL directory.
#[derive(Clone, Debug)]
pub struct Migration {
    pub name: String,
    pub checksum: String,
    pub sql: String,
}

/// Applied migration metadata shared with the previous backend.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize, sqlx::FromRow)]
pub struct Applied {
    pub name: String,
    pub checksum: String,
}

pub fn read(directory: &Path) -> Result<Vec<Migration>, DbError> {
    let mut result = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".sql") {
            continue;
        }
        let Some((version, description)) = name.trim_end_matches(".sql").split_once('_') else {
            return Err(DbError::Invalid(format!(
                "Invalid migration filename: {name}"
            )));
        };
        if version.is_empty()
            || !version.bytes().all(|b| b.is_ascii_digit())
            || description.is_empty()
            || !description
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        {
            return Err(DbError::Invalid(format!(
                "Invalid migration filename: {name}"
            )));
        }
        let sql = std::fs::read_to_string(entry.path())?;
        result.push(Migration {
            name,
            checksum: hex::encode(Sha256::digest(sql.as_bytes())),
            sql,
        });
    }
    result.sort_by(|a, b| a.name.cmp(&b.name));
    if result.is_empty() {
        return Err(DbError::Invalid("No migrations found".into()));
    }
    for pair in result.windows(2) {
        let version = |m: &Migration| m.name.split('_').next().and_then(|n| n.parse::<u64>().ok());
        if version(&pair[0]) >= version(&pair[1]) {
            return Err(DbError::Invalid(
                "Migration versions must be unique and increase in filename order".into(),
            ));
        }
    }
    Ok(result)
}

pub async fn applied(connection: &mut PgConnection) -> Result<Vec<Applied>, DbError> {
    let exists: bool =
        sqlx::query_scalar("SELECT to_regclass('public.datix_schema_migrations') IS NOT NULL")
            .fetch_one(&mut *connection)
            .await?;
    if !exists {
        return Ok(Vec::new());
    }
    Ok(
        sqlx::query_as("SELECT name,checksum FROM public.datix_schema_migrations ORDER BY name")
            .fetch_all(connection)
            .await?,
    )
}

/// Every applied migration must be an unchanged prefix; no removed or inserted history.
pub fn validate(expected: &[Migration], applied: &[Applied]) -> Result<(), DbError> {
    if applied.len() > expected.len()
        || applied
            .iter()
            .zip(expected)
            .any(|(a, e)| a.name != e.name || a.checksum != e.checksum)
    {
        return Err(DbError::Invalid(
            "Applied migration was changed, removed, or reordered".into(),
        ));
    }
    Ok(())
}

/// Plan is read-only. Apply locks and commits all pending SQL with its ledger atomically.
pub async fn run(
    connection: &mut PgConnection,
    migrations: &[Migration],
    apply: bool,
) -> Result<Vec<String>, DbError> {
    if !apply {
        let history = applied(connection).await?;
        validate(migrations, &history)?;
        return Ok(migrations
            .iter()
            .skip(history.len())
            .map(|m| m.name.clone())
            .collect());
    }
    let mut tx = connection.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(791343524)")
        .execute(&mut *tx)
        .await?;
    sqlx::raw_sql("CREATE TABLE IF NOT EXISTS public.datix_schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())").execute(&mut *tx).await?;
    let history = applied(&mut tx).await?;
    validate(migrations, &history)?;
    let mut names = Vec::new();
    for migration in migrations.iter().skip(history.len()) {
        sqlx::raw_sql(&migration.sql).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO public.datix_schema_migrations(name,checksum) VALUES($1,$2)")
            .bind(&migration.name)
            .bind(&migration.checksum)
            .execute(&mut *tx)
            .await?;
        names.push(migration.name.clone());
    }
    tx.commit().await?;
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_insertions_before_applied_history() {
        let migrations = vec![Migration {
            name: "0000_baseline.sql".into(),
            checksum: "a".into(),
            sql: String::new(),
        }];
        let history = vec![Applied {
            name: "0001_other.sql".into(),
            checksum: "a".into(),
        }];
        assert!(validate(&migrations, &history).is_err());
    }

    #[test]
    fn rejects_edited_sql() {
        let migrations = vec![Migration {
            name: "0000_baseline.sql".into(),
            checksum: "new".into(),
            sql: String::new(),
        }];
        let history = vec![Applied {
            name: "0000_baseline.sql".into(),
            checksum: "old".into(),
        }];
        assert!(validate(&migrations, &history).is_err());
    }
}

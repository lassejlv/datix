use std::path::PathBuf;

use clap::{Parser, Subcommand};
use datix_db::{DbError, connect_owner, migrations, runtime_role, schema};

#[derive(Parser)]
#[command(about = "Review and apply immutable Datix PostgreSQL migrations")]
struct Cli {
    #[arg(long)]
    env_file: Option<PathBuf>,
    #[arg(long, env = "MIGRATION_EXPECT_HOST")]
    expect_host: String,
    #[arg(long, env = "MIGRATION_EXPECT_DATABASE")]
    expect_database: String,
    /// Override embedded migrations for explicit database tooling only.
    #[arg(long)]
    migrations: Option<PathBuf>,
    /// Explicitly permit writes to the configured production database.
    #[arg(long)]
    allow_production: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Apply embedded migrations, refresh grants, and verify the runtime connection.
    Deploy,
    /// Review or grant minimal table permissions to the existing datix_runtime role.
    RuntimeRole {
        #[arg(long)]
        apply: bool,
    },
    /// Inspect pending migrations; writes require --apply.
    Migrate {
        #[arg(long)]
        apply: bool,
    },
    /// Export schema and migration metadata; never reads application rows.
    Snapshot {
        #[arg(long)]
        output: PathBuf,
    },
    /// Restore migration metadata only after comparing the complete schema snapshot.
    Baseline {
        #[arg(long)]
        schema: PathBuf,
        #[arg(long)]
        apply: bool,
    },
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), DbError> {
    let cli = Cli::parse();
    if let Some(path) = &cli.env_file {
        dotenvy::from_path_override(path)
            .map_err(|_| DbError::Invalid("Cannot load environment file".into()))?;
    }
    let url = std::env::var("DATABASE_URL_UNPOOLED")
        .map_err(|_| DbError::Invalid("DATABASE_URL_UNPOOLED is required".into()))?;
    let identity = datix_db::identity(&url)?;
    let mutations = matches!(
        cli.command,
        Command::Deploy
            | Command::Migrate { apply: true }
            | Command::Baseline { apply: true, .. }
            | Command::RuntimeRole { apply: true }
    );
    if mutations && identity.host == "ep-morning-voice-assxbb3l.c-4.eu-central-1.aws.neon.tech" {
        return Err(DbError::Invalid(
            "The unrelated legacy database is not a Datix migration target".into(),
        ));
    }
    if mutations
        && identity.host == "ep-red-shape-b1wifxvx.c-5.eu-central-1.aws.neon.tech"
        && !cli.allow_production
    {
        return Err(DbError::Invalid(
            "Production writes require --allow-production and the exact expected target".into(),
        ));
    }
    let runtime_url = if matches!(cli.command, Command::Deploy) {
        if cli.migrations.is_some() {
            return Err(DbError::Invalid(
                "Deploy must use the migrations embedded in the release".into(),
            ));
        }
        let runtime_url = std::env::var("DATABASE_URL")
            .map_err(|_| DbError::Invalid("DATABASE_URL is required".into()))?;
        validate_runtime_target(&identity, &datix_db::identity(&runtime_url)?)?;
        Some(runtime_url)
    } else {
        None
    };
    let migrations = match &cli.migrations {
        Some(path) => migrations::read(path)?,
        None => migrations::bundled(),
    };
    let (mut connection, identity) =
        connect_owner(&url, &cli.expect_host, &cli.expect_database).await?;
    match cli.command {
        Command::Deploy => {
            let applied = migrations::run(&mut connection, &migrations, true).await?;
            runtime_role::configure(&mut connection, true).await?;
            let pool = datix_db::connect_runtime(runtime_url.as_deref().unwrap(), 1).await?;
            pool.close().await;
            println!(
                "{}",
                serde_json::json!({"target":identity,"migrations":applied,"runtime_role":"datix_runtime","runtime_verified":true})
            );
        }
        Command::RuntimeRole { apply } => {
            runtime_role::configure(&mut connection, apply).await?;
            println!(
                "{}",
                serde_json::json!({"target":identity,"runtime_role":"datix_runtime","applied":apply})
            );
        }
        Command::Migrate { apply } => {
            let pending = migrations::run(&mut connection, &migrations, apply).await?;
            println!(
                "{}",
                serde_json::json!({"target":identity,"applied":apply,"migrations":pending})
            );
        }
        Command::Snapshot { output } => {
            let snapshot = schema::snapshot(&mut connection).await?;
            migrations::validate(&migrations, &snapshot.migrations)?;
            std::fs::write(output, serde_json::to_string_pretty(&snapshot)? + "\n")?;
            println!(
                "{}",
                serde_json::json!({"target":identity,"schema_exported":true})
            );
        }
        Command::Baseline {
            schema: path,
            apply,
        } => {
            let expected = serde_json::from_slice(&std::fs::read(path)?)?;
            schema::baseline(&mut connection, &expected, &migrations, apply).await?;
            println!(
                "{}",
                serde_json::json!({"target":identity,"schema_matches":true,"baseline_applied":apply})
            );
        }
    }
    Ok(())
}

fn validate_runtime_target(
    owner: &datix_db::Identity,
    runtime: &datix_db::Identity,
) -> Result<(), DbError> {
    if runtime.host.replace("-pooler.", ".") != owner.host
        || runtime.database != owner.database
        || runtime.role != "datix_runtime"
        || owner.role == runtime.role
    {
        return Err(DbError::Invalid(
            "Migration and restricted runtime URLs must target the same database".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deployment_rejects_wrong_database_endpoint_and_privileged_runtime() {
        let owner = datix_db::Identity {
            host: "ep-datix.neon.tech".into(),
            database: "datix".into(),
            role: "datix_owner".into(),
        };
        let mut runtime = datix_db::Identity {
            host: "ep-datix-pooler.neon.tech".into(),
            database: "datix".into(),
            role: "datix_runtime".into(),
        };
        assert!(validate_runtime_target(&owner, &runtime).is_ok());
        runtime.host = "ep-other-pooler.neon.tech".into();
        assert!(validate_runtime_target(&owner, &runtime).is_err());
        runtime.host.clone_from(&owner.host);
        runtime.database = "other".into();
        assert!(validate_runtime_target(&owner, &runtime).is_err());
        runtime.database.clone_from(&owner.database);
        runtime.role.clone_from(&owner.role);
        assert!(validate_runtime_target(&owner, &runtime).is_err());
    }
}

use std::path::PathBuf;

use clap::{Parser, Subcommand};
use datix_db::{DbError, connect_owner, migrations, runtime_role, schema};

#[derive(Parser)]
#[command(about = "Review and apply immutable Datix PostgreSQL migrations")]
struct Cli {
    #[arg(long)]
    env_file: Option<PathBuf>,
    #[arg(long)]
    expect_host: String,
    #[arg(long)]
    expect_database: String,
    #[arg(long, default_value = "crates/db/migrations")]
    migrations: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
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
    let (mut connection, identity) =
        connect_owner(&url, &cli.expect_host, &cli.expect_database).await?;
    let mutations = matches!(
        cli.command,
        Command::Migrate { apply: true }
            | Command::Baseline { apply: true, .. }
            | Command::RuntimeRole { apply: true }
    );
    if mutations
        && matches!(
            identity.host.as_str(),
            "ep-red-shape-b1wifxvx.c-5.eu-central-1.aws.neon.tech"
                | "ep-morning-voice-assxbb3l.c-4.eu-central-1.aws.neon.tech"
        )
    {
        return Err(DbError::Invalid(
            "Production writes are disabled during the Rust migration".into(),
        ));
    }
    let migrations = migrations::read(&cli.migrations)?;
    match cli.command {
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

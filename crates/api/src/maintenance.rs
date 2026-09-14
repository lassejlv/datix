use crate::{AppState, error::ApiError};
use std::time::{Duration, Instant};
use uuid::Uuid;

const ANALYTICS: [(&str, &str); 9] = [
    ("imported_breakdowns", "environment_id"),
    ("imported_daily_stats", "environment_id"),
    ("analytics_imports", "environment_id"),
    ("diagnostic_events", "environment_id"),
    ("goal_conversions", "environment_id"),
    ("activity_events", "environment_id"),
    ("events", "site_id"),
    ("daily_visitors", "site_id"),
    ("daily_stats", "site_id"),
];

pub async fn clean_deleted(state: &AppState) -> Result<(), ApiError> {
    let deadline = Instant::now() + Duration::from_secs(8);
    let environments: Vec<Uuid> = sqlx::query_scalar(
        "SELECT environment_id FROM analytics_deletions ORDER BY created_at LIMIT 16",
    )
    .fetch_all(&state.pool)
    .await?;
    for environment in environments {
        if Instant::now() > deadline {
            break;
        }
        let mut tx = state.pool.begin().await?;
        let present:Option<Uuid>=sqlx::query_scalar("SELECT environment_id FROM analytics_deletions WHERE environment_id=$1 FOR UPDATE SKIP LOCKED").bind(environment).fetch_optional(&mut *tx).await?;
        if present.is_none() {
            continue;
        }
        let mut complete = true;
        for (table, column) in ANALYTICS {
            if Instant::now() > deadline {
                complete = false;
                break;
            }
            let count=sqlx::query(&format!("DELETE FROM {table} WHERE (tableoid,ctid) IN(SELECT tableoid,ctid FROM {table} WHERE {column}=$1 LIMIT 5000)"))
                .bind(environment).execute(&mut *tx).await?.rows_affected();
            if count == 5000 {
                complete = false;
                break;
            }
        }
        if complete {
            let count=sqlx::query("DELETE FROM ingestion_receipts WHERE ctid IN(SELECT ctid FROM ingestion_receipts WHERE environment_id=$1 LIMIT 5000)")
                .bind(environment).execute(&mut *tx).await?.rows_affected();
            complete = count < 5000;
        }
        if complete
            && state
                .storage
                .remove_environment(environment, deadline)
                .await?
        {
            sqlx::query("DELETE FROM analytics_deletions WHERE environment_id=$1")
                .bind(environment)
                .execute(&mut *tx)
                .await?;
        }
        // Commit every bounded deletion even when this environment needs another pass.
        tx.commit().await?;
    }
    Ok(())
}

pub async fn retain(state: &AppState) -> Result<(), ApiError> {
    let expired:Vec<(Uuid,Uuid)>=sqlx::query_as("SELECT id,environment_id FROM analytics_imports WHERE (summary->>'from')::date<current_date-729 AND NOT coalesce((summary->>'archiveDeleted')::boolean,false) ORDER BY created_at LIMIT 50")
        .fetch_all(&state.pool).await?;
    for (id, environment) in expired {
        state.storage.remove_archive(environment, id).await?;
        sqlx::query("UPDATE analytics_imports SET summary=summary||'{\"archiveDeleted\":true}'::jsonb WHERE id=$1").bind(id).execute(&state.pool).await?;
    }
    sqlx::query("SELECT public.datix_retention()")
        .execute(&state.pool)
        .await?;
    for (table, predicate) in [
        ("imported_breakdowns", "day < current_date-729"),
        (
            "imported_daily_stats",
            "day < current_date-729 AND NOT EXISTS(SELECT 1 FROM imported_breakdowns b WHERE b.environment_id=imported_daily_stats.environment_id AND b.day=imported_daily_stats.day)",
        ),
        (
            "analytics_imports",
            "NOT EXISTS(SELECT 1 FROM imported_daily_stats d WHERE d.import_id=analytics_imports.id)",
        ),
        (
            "error_resolutions",
            "resolved_at < now()-interval '30 days'",
        ),
        (
            "ingestion_receipts",
            "state<>'pending' AND created_at < now()-interval '731 days'",
        ),
        (
            "rate_limit",
            "last_request < (extract(epoch FROM now())*1000)::bigint-86400000",
        ),
        ("session", "expires_at < now() AT TIME ZONE 'UTC'"),
        ("verification", "expires_at < now() AT TIME ZONE 'UTC'"),
        ("abuse_sources", "updated_at < now()-interval '2 days'"),
        ("abuse_daily", "day < current_date-90"),
    ] {
        sqlx::query(&format!("DELETE FROM {table} WHERE ctid IN(SELECT ctid FROM {table} WHERE {predicate} LIMIT 1000)")).execute(&state.pool).await?;
    }
    Ok(())
}

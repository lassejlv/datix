use analytics_core::{Result, State};
use serde_json::{Value, json};
/// Bounded deletions preserve the existing privacy and reporting retention windows.
pub async fn retain(state: &State) -> Result<Value> {
    let partitions: Value = sqlx::query_scalar("SELECT analytics_partition_maintenance()")
        .fetch_one(&state.db)
        .await?;
    let predicates = [
        (
            "diagnostic_events",
            "received_at < now()-interval '30 days'",
        ),
        ("goal_conversions", "received_at < now()-interval '30 days'"),
        ("pulse_checks", "checked_at < now()-interval '30 days'"),
        ("pulse_alerts", "created_at < now()-interval '30 days'"),
        (
            "error_resolutions",
            "resolved_at < now()-interval '30 days'",
        ),
        ("activity_events", "received_at < now()-interval '30 days'"),
        ("events", "received_at < now()-interval '30 days'"),
        (
            "events_unpartitioned_backup",
            "received_at < now()-interval '30 days'",
        ),
        (
            "activity_events_unpartitioned_backup",
            "received_at < now()-interval '30 days'",
        ),
        ("event_receipts", "received_at < now()-interval '31 days'"),
        (
            "session_days",
            "day < (now()-interval '30 days')::date + ((now()-interval '30 days')<>date_trunc('day',now()-interval '30 days'))::integer",
        ),
        ("daily_visitors", "day < (now()-interval '30 days')::date"),
        ("daily_stats", "day < (now()-interval '729 days')::date"),
        (
            "imported_breakdowns",
            "day < (now()-interval '729 days')::date",
        ),
        (
            "imported_daily_stats",
            "day < (now()-interval '729 days')::date AND NOT EXISTS(SELECT 1 FROM imported_breakdowns b WHERE b.environment_id=imported_daily_stats.environment_id AND b.day=imported_daily_stats.day)",
        ),
        (
            "analytics_imports",
            "NOT EXISTS(SELECT 1 FROM imported_daily_stats d WHERE d.import_id=analytics_imports.id)",
        ),
        (
            "rate_limit",
            "last_request < (extract(epoch FROM now())*1000)::bigint-86400000",
        ),
        ("session", "expires_at < now() AT TIME ZONE 'UTC'"),
        ("verification", "expires_at < now() AT TIME ZONE 'UTC'"),
        ("abuse_sources", "updated_at < now()-interval '2 days'"),
        ("abuse_daily", "day < (now()-interval '90 days')::date"),
    ];
    let mut totals = json!({});
    let mut pending = vec![true; predicates.len()];
    let mut deleted = 0;
    let deadline = std::time::Instant::now()
        + std::time::Duration::from_secs(state.config.runtime.retention_drain_seconds);
    let mut redis = state.redis.clone();
    let rotation: usize = redis::cmd("INCR")
        .arg(format!("{}:retention-cursor", state.config.event_stream))
        .query_async(&mut redis)
        .await?;
    while pending.iter().any(|value| *value)
        && std::time::Instant::now() < deadline
        && deleted < state.config.runtime.retention_max_rows
    {
        for step in 0..predicates.len() {
            let index = (step + rotation) % predicates.len();
            if !pending[index]
                || std::time::Instant::now() >= deadline
                || deleted >= state.config.runtime.retention_max_rows
            {
                continue;
            }
            let (table, predicate) = predicates[index];
            let limit = (state.config.runtime.retention_batch_size as u64)
                .min(state.config.runtime.retention_max_rows - deleted);
            // ctid alone is not unique across partitions. Match the physical table as well.
            let rows=sqlx::query(&format!("DELETE FROM {table} WHERE {predicate} AND (tableoid,ctid) IN(SELECT tableoid,ctid FROM {table} WHERE {predicate} LIMIT $1)"))
                .bind(limit as i64).execute(&state.db).await?.rows_affected();
            deleted += rows;
            totals[table] = json!(totals[table].as_u64().unwrap_or(0) + rows);
            pending[index] = rows >= limit;
            // Rotation can visit a parent before its children. Revisit it after child progress,
            // without using cascades to bypass the retention row/time budget.
            if rows > 0 {
                let parent = match table {
                    "imported_breakdowns" => Some("imported_daily_stats"),
                    "imported_daily_stats" => Some("analytics_imports"),
                    _ => None,
                };
                if let Some(parent) = parent {
                    pending[predicates
                        .iter()
                        .position(|(table, _)| *table == parent)
                        .unwrap()] = true;
                }
            }
        }
    }
    let backlog = pending.iter().any(|value| *value);
    state
        .metrics
        .retention_backlog
        .store(backlog as u64, std::sync::atomic::Ordering::Relaxed);
    Ok(json!({"deleted":totals,"backlogPossible":backlog,"partitions":partitions}))
}

use analytics_core::{Result, State};
use serde_json::{Value, json};
/// Bounded deletions preserve the existing privacy and reporting retention windows.
pub async fn retain(state: &State) -> Result<Value> {
    let predicates = [
        ("activity_events", "received_at < now()-interval '30 days'"),
        ("events", "received_at < now()-interval '30 days'"),
        ("daily_visitors", "day < (now()-interval '30 days')::date"),
        ("daily_stats", "day < (now()-interval '729 days')::date"),
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
    let mut backlog = false;
    for (table, predicate) in predicates {
        let mut total = 0;
        for _ in 0..10 {
            let rows=sqlx::query(&format!("DELETE FROM {table} WHERE ctid IN(SELECT ctid FROM {table} WHERE {predicate} LIMIT 10000)")).execute(&state.db).await?.rows_affected();
            total += rows;
            if rows < 10000 {
                break;
            }
        }
        totals[table] = json!(total);
        backlog |= total >= 100000;
    }
    Ok(json!({"deleted":totals,"backlogPossible":backlog}))
}

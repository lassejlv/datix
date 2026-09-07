//! Redis Streams retain accepted events until a worker commits them to PostgreSQL.
use crate::tracking::Event;
use analytics_core::{Result, State};
pub const GROUP: &str = "analytics-rust";
pub fn stream(state: &State) -> &str {
    &state.config.event_stream
}

pub async fn enqueue(state: &State, event: &Event) -> Result<()> {
    let data = serde_json::to_string(event).expect("event serialization");
    let mut conn = state.redis.clone();
    let accepted: i64 = redis::Script::new("if redis.call('XLEN',KEYS[1]) >= tonumber(ARGV[1]) then return 0 end; redis.call('XADD',KEYS[1],'*','data',ARGV[2]); return 1")
        .key(stream(state)).arg(state.config.runtime.queue_max_pending).arg(data)
        .invoke_async(&mut conn).await?;
    if accepted == 0 {
        return Err(analytics_core::Error::unavailable());
    }
    state
        .metrics
        .collect_accepted
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}
pub async fn initialize(state: &State) -> Result<()> {
    let mut conn = state.redis.clone();
    let result: std::result::Result<String, redis::RedisError> = redis::cmd("XGROUP")
        .arg("CREATE")
        .arg(stream(state))
        .arg(GROUP)
        .arg("0")
        .arg("MKSTREAM")
        .query_async(&mut conn)
        .await;
    match result {
        Ok(_) => Ok(()),
        Err(e) if e.code() == Some("BUSYGROUP") => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Copy unfinished BullMQ envelopes durably; keep the original records available for rollback.
pub async fn migrate_legacy(state: &State) -> Result<serde_json::Value> {
    let mut connection = state.redis.clone();
    let mut ids = std::collections::BTreeSet::<String>::new();
    for suffix in ["wait", "paused", "active"] {
        let entries: Vec<String> = redis::cmd("LRANGE")
            .arg(format!("bull:analytics-events:{suffix}"))
            .arg(0)
            .arg(-1)
            .query_async(&mut connection)
            .await?;
        ids.extend(entries);
    }
    for suffix in ["delayed", "failed"] {
        let entries: Vec<String> = redis::cmd("ZRANGE")
            .arg(format!("bull:analytics-events:{suffix}"))
            .arg(0)
            .arg(-1)
            .query_async(&mut connection)
            .await?;
        ids.extend(entries);
    }
    let mut transferred = 0;
    let mut invalid = 0;
    let mut previously_transferred = 0;
    for id in &ids {
        let data: Option<String> = redis::cmd("HGET")
            .arg(format!("bull:analytics-events:{id}"))
            .arg("data")
            .query_async(&mut connection)
            .await?;
        let Some(data) = data else {
            invalid += 1;
            continue;
        };
        if serde_json::from_str::<Event>(&data)
            .ok()
            .is_none_or(|event| event.validate().is_err())
        {
            invalid += 1;
            continue;
        }
        // The marker and stream insertion commit together, so interrupted reruns do not duplicate transfers.
        let copied:i64=redis::Script::new("if redis.call('EXISTS',KEYS[2])==1 then return 0 end; local id=redis.call('XADD',KEYS[1],'*','data',ARGV[1]); redis.call('SET',KEYS[2],id); return 1")
            .key(stream(state)).key(format!("analytics:queue-migration:bullmq:{id}")).arg(data).invoke_async(&mut connection).await?;
        if copied == 1 {
            transferred += 1
        } else {
            previously_transferred += 1
        }
    }
    Ok(
        serde_json::json!({"found":ids.len(),"transferred":transferred,"previouslyTransferred":previously_transferred,"invalidRetained":invalid,"legacyRecordsPreserved":true}),
    )
}
pub async fn inspect(state: &State) -> Result<serde_json::Value> {
    let mut connection = state.redis.clone();
    let mut result = serde_json::json!({});
    for (name, key) in [
        ("stream", stream(state).to_owned()),
        ("failed", format!("{}:failed", stream(state))),
    ] {
        let size: i64 = redis::cmd("XLEN")
            .arg(&key)
            .query_async(&mut connection)
            .await?;
        result[name] = serde_json::json!(size);
    }
    for suffix in ["wait", "paused", "active"] {
        let size: i64 = redis::cmd("LLEN")
            .arg(format!("bull:analytics-events:{suffix}"))
            .query_async(&mut connection)
            .await?;
        result[format!("legacy_{suffix}")] = serde_json::json!(size);
    }
    for suffix in ["delayed", "failed"] {
        let size: i64 = redis::cmd("ZCARD")
            .arg(format!("bull:analytics-events:{suffix}"))
            .query_async(&mut connection)
            .await?;
        result[format!("legacy_{suffix}")] = serde_json::json!(size);
    }
    Ok(result)
}

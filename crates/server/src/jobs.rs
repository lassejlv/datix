use analytics_core::config::Role;
use analytics_core::{Error, Result, State};
use analytics_services::{billing, ingest, queue, retention, tracking::Event};
use chrono::{Timelike, Utc};
use redis::streams::{StreamAutoClaimReply, StreamId, StreamPendingCountReply, StreamReadReply};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{sync::watch, task::JoinHandle};
use uuid::Uuid;

pub struct Jobs {
    pub ready: Arc<AtomicBool>,
    stop: watch::Sender<bool>,
    handles: Vec<JoinHandle<()>>,
}
struct Running(Arc<AtomicBool>);
impl Drop for Running {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl Jobs {
    pub async fn start(state: State) -> Result<Self> {
        if state.config.runtime.role == Role::Api {
            let (stop, _) = watch::channel(false);
            return Ok(Self {
                ready: Arc::new(AtomicBool::new(true)),
                stop,
                handles: vec![],
            });
        }
        Self::start_with_maintenance(state, true).await
    }
    pub async fn start_events(state: State) -> Result<Self> {
        Self::start_with_maintenance(state, false).await
    }
    async fn start_with_maintenance(state: State, maintenance_enabled: bool) -> Result<Self> {
        queue::initialize(&state).await?;
        let ready = Arc::new(AtomicBool::new(true));
        let (stop, rx) = watch::channel(false);
        let mut handles = vec![];
        for _ in 0..state.config.runtime.event_workers {
            let state = state.clone();
            let rx = rx.clone();
            let ready = ready.clone();
            handles.push(tokio::spawn(async move {
                let _running = Running(ready);
                event_loop(state, rx).await;
            }));
        }
        if maintenance_enabled {
            for job in 0..3 {
                let state = state.clone();
                let live = ready.clone();
                let rx = rx.clone();
                handles.push(tokio::spawn(async move {
                    let _running = Running(live);
                    match job {
                        0 => billing_loop(state, rx).await,
                        1 => maintenance_loop(state, rx).await,
                        _ => observation_loop(state, rx).await,
                    }
                }));
            }
        }
        Ok(Self {
            ready,
            stop,
            handles,
        })
    }
    pub async fn close(self) {
        self.ready.store(false, Ordering::Release);
        let _ = self.stop.send(true);
        for handle in self.handles {
            if handle.await.is_err() {
                tracing::error!("background task terminated unexpectedly");
            }
        }
    }
}
async fn acknowledge(state: &State, ids: &[String]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let mut conn = state.redis.clone();
    let _: () = redis::pipe()
        .atomic()
        .cmd("XACK")
        .arg(queue::stream(state))
        .arg(queue::GROUP)
        .arg(ids)
        .ignore()
        .cmd("XDEL")
        .arg(queue::stream(state))
        .arg(ids)
        .ignore()
        .query_async(&mut conn)
        .await?;
    Ok(())
}
async fn dead_letter(state: &State, item: &StreamId, data: &str, reason: &str) -> Result<()> {
    let mut conn = state.redis.clone();
    let _: () = redis::pipe()
        .atomic()
        .cmd("XADD")
        .arg(format!("{}:failed", queue::stream(state)))
        .arg("*")
        .arg("sourceId")
        .arg(&item.id)
        .arg("data")
        .arg(data)
        .arg("reason")
        .arg(reason)
        .ignore()
        .cmd("XACK")
        .arg(queue::stream(state))
        .arg(queue::GROUP)
        .arg(&item.id)
        .ignore()
        .cmd("XDEL")
        .arg(queue::stream(state))
        .arg(&item.id)
        .ignore()
        .query_async(&mut conn)
        .await?;
    tracing::error!(message_id=%item.id,reason,"event retained in failed stream");
    Ok(())
}
async fn retry(state: &State, item: &StreamId, data: &str) -> Result<()> {
    state.metrics.retries.fetch_add(1, Ordering::Relaxed);
    let mut conn = state.redis.clone();
    let pending: StreamPendingCountReply = redis::cmd("XPENDING")
        .arg(queue::stream(state))
        .arg(queue::GROUP)
        .arg(&item.id)
        .arg(&item.id)
        .arg(1)
        .query_async(&mut conn)
        .await?;
    if pending.ids.first().is_some_and(|p| p.times_delivered >= 10) {
        dead_letter(state, item, data, "retry_limit").await?;
    }
    Ok(())
}
async fn process_batch(state: &State, items: Vec<StreamId>) -> Result<()> {
    let mut envelopes = vec![];
    let mut events = vec![];
    for item in items {
        let data = item.get::<String>("data").unwrap_or_default();
        match serde_json::from_str::<Event>(&data)
            .ok()
            .filter(|e| e.validate().is_ok())
        {
            Some(event) => {
                events.push(event);
                envelopes.push((item, data));
            }
            None => {
                dead_letter(state, &item, &data, "invalid_envelope").await?;
            }
        }
    }
    // Bound total processing below the reclaim age. Cancellation rolls back any open transaction.
    let results = tokio::time::timeout(
        Duration::from_secs(45),
        ingest::ingest_batch(state, &events, Utc::now()),
    )
    .await
    .unwrap_or_else(|_| events.iter().map(|_| Err(Error::unavailable())).collect());
    let mut acknowledged = vec![];
    for ((item, data), result) in envelopes.into_iter().zip(results) {
        match result {
            Ok(_) => acknowledged.push(item.id),
            Err(_) => {
                retry(state, &item, &data).await?;
            }
        }
    }
    acknowledge(state, &acknowledged).await?;
    if !acknowledged.is_empty() {
        tracing::debug!(count = acknowledged.len(), "event batch acknowledged");
    }
    Ok(())
}
async fn event_loop(state: State, mut stop: watch::Receiver<bool>) {
    let consumer = Uuid::new_v4().to_string();
    let mut scan = String::from("0-0");
    let mut next_reclaim = Instant::now();
    // Blocking reads have their own connection; API rate limits and enqueue never wait behind them.
    let mut reader = None;
    loop {
        if *stop.borrow() {
            break;
        }
        if reader.is_none() {
            match state.redis_client.get_multiplexed_async_connection().await {
                Ok(connection) => reader = Some(connection),
                Err(_) => {
                    tokio::select! { _ = stop.changed() => break, _ = tokio::time::sleep(Duration::from_secs(1)) => {} }
                    continue;
                }
            }
        }
        let work = async {
            let mut pending = vec![];
            if Instant::now() >= next_reclaim {
                let mut conn = state.redis.clone();
                let claimed: StreamAutoClaimReply = redis::cmd("XAUTOCLAIM")
                    .arg(queue::stream(&state))
                    .arg(queue::GROUP)
                    .arg(&consumer)
                    .arg(60000)
                    .arg(&scan)
                    .arg("COUNT")
                    .arg(state.config.runtime.event_batch_size)
                    .query_async(&mut conn)
                    .await?;
                scan = claimed.next_stream_id;
                pending = claimed.claimed;
                next_reclaim = Instant::now() + Duration::from_secs(5);
            }
            if pending.is_empty() {
                let reply: StreamReadReply = redis::cmd("XREADGROUP")
                    .arg("GROUP")
                    .arg(queue::GROUP)
                    .arg(&consumer)
                    .arg("COUNT")
                    .arg(state.config.runtime.event_batch_size)
                    .arg("BLOCK")
                    .arg(state.config.runtime.event_block_ms)
                    .arg("STREAMS")
                    .arg(queue::stream(&state))
                    .arg(">")
                    .query_async(reader.as_mut().expect("dedicated reader"))
                    .await?;
                pending = reply.keys.into_iter().flat_map(|s| s.ids).collect();
            }
            Ok::<_, Error>(pending)
        };
        tokio::select! {
            _ = stop.changed() => break,
            result = work => {
                // Once delivered, finish this bounded batch before honoring shutdown.
                let result = match result {
                    Ok(pending) => process_batch(&state, pending).await,
                    Err(error) => Err(error),
                };
                if result.is_err() {
                    reader = None;
                    tracing::error!("event batch failed; unacknowledged events remain available for retry");
                    tokio::select! { _ = stop.changed() => break, _ = tokio::time::sleep(Duration::from_secs(1)) => {} }
                }
            }
        }
    }
    // DELCONSUMER would destroy pending delivery bookkeeping; leave it until it has been reclaimed.
    tracing::info!("event worker stopped");
}
async fn lease(state: &State, key: &str, seconds: u64) -> Result<Option<String>> {
    let mut conn = state.redis.clone();
    let token = Uuid::new_v4().to_string();
    let acquired: Option<String> = redis::cmd("SET")
        .arg(key)
        .arg(&token)
        .arg("NX")
        .arg("EX")
        .arg(seconds)
        .query_async(&mut conn)
        .await?;
    Ok(acquired.map(|_| token))
}
async fn release(state: &State, key: &str, token: &str) -> Result<()> {
    let mut conn = state.redis.clone();
    let _:i64=redis::Script::new("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end").key(key).arg(token).invoke_async(&mut conn).await?;
    Ok(())
}
async fn maintenance_loop(state: State, mut stop: watch::Receiver<bool>) {
    let mut tick = tokio::time::interval(Duration::from_secs(60));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {_=stop.changed()=>break,_=tick.tick()=>{}}
        if *stop.borrow() {
            break;
        }
        if let Err(_error) = maintenance(&state).await {
            tracing::error!("maintenance failed; durable work remains available for retry");
        }
    }
}
async fn maintenance(state: &State) -> Result<()> {
    let now = Utc::now();
    if now.hour() > 3 || (now.hour() == 3 && now.minute() >= 17) {
        retention_pass(state).await?;
    }
    Ok(())
}
pub async fn retention_pass(state: &State) -> Result<()> {
    let prefix = queue::stream(state);
    let done = format!("{prefix}:retention:{}", Utc::now().date_naive());
    let mut conn = state.redis.clone();
    let complete: bool = redis::cmd("EXISTS")
        .arg(&done)
        .query_async(&mut conn)
        .await?;
    if !complete {
        let key = format!("{prefix}:retention-lock");
        if let Some(token) = lease(state, &key, 600).await? {
            let result = retention::retain(state).await;
            if let Ok(summary) = &result
                && summary["backlogPossible"] == false
            {
                let _: () = redis::cmd("SET")
                    .arg(&done)
                    .arg("1")
                    .arg("EX")
                    .arg(172800)
                    .query_async(&mut conn)
                    .await?;
                tracing::info!(summary=%summary,"retention complete");
            }
            release(state, &key, &token).await?;
            result?;
        }
    }
    Ok(())
}

async fn billing_loop(state: State, mut stop: watch::Receiver<bool>) {
    let mut tick = tokio::time::interval(Duration::from_millis(
        state.config.runtime.billing_interval_ms,
    ));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! { _ = stop.changed() => break, _ = tick.tick() => {} }
        if *stop.borrow() {
            break;
        }
        if state.config.polar_token.is_none() {
            continue;
        }
        let work = async {
            let key = format!("{}:billing-lock", queue::stream(&state));
            if let Some(token) = lease(&state, &key, 120).await? {
                let result = billing::delivery::flush(&state).await;
                release(&state, &key, &token).await?;
                result?;
            }
            Ok::<_, Error>(())
        }
        .await;
        if work.is_err() {
            tracing::error!("billing delivery failed; durable work remains available for retry");
        }
    }
}
async fn observation_loop(state: State, mut stop: watch::Receiver<bool>) {
    let mut tick = tokio::time::interval(Duration::from_secs(15));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! { _ = stop.changed() => break, _ = tick.tick() => {} }
        if *stop.borrow() {
            break;
        }
        if observe(&state).await.is_err() {
            tracing::warn!("operational metrics refresh failed");
        }
    }
}
pub async fn observe(state: &State) -> Result<()> {
    let mut conn = state.redis.clone();
    let (depth, failed, first): (u64, u64, redis::streams::StreamRangeReply) = redis::pipe()
        .cmd("XLEN")
        .arg(queue::stream(state))
        .cmd("XLEN")
        .arg(format!("{}:failed", queue::stream(state)))
        .cmd("XRANGE")
        .arg(queue::stream(state))
        .arg("-")
        .arg("+")
        .arg("COUNT")
        .arg(1)
        .query_async(&mut conn)
        .await?;
    let oldest_ms = first
        .ids
        .first()
        .and_then(|v| v.id.split('-').next())
        .and_then(|s| s.parse::<i64>().ok());
    let (billing, billing_age): (i64, i64) = sqlx::query_as("SELECT count(*)::bigint,coalesce(greatest(extract(epoch FROM now()-min(occurred_at)),0)::bigint,0) FROM billing_outbox")
        .fetch_one(&state.db).await?;
    let m = &state.metrics;
    m.queue_depth.store(depth, Ordering::Relaxed);
    m.queue_failed.store(failed, Ordering::Relaxed);
    m.queue_oldest_seconds.store(
        oldest_ms.map_or(0, |ms| {
            (Utc::now().timestamp_millis() - ms).max(0) as u64 / 1000
        }),
        Ordering::Relaxed,
    );
    m.billing_pending.store(billing as u64, Ordering::Relaxed);
    m.billing_oldest_seconds
        .store(billing_age as u64, Ordering::Relaxed);
    m.last_observation
        .store(Utc::now().timestamp() as u64, Ordering::Relaxed);
    Ok(())
}

use analytics_core::{Error, Result, State};
use analytics_services::{billing, ingest, queue, retention, tracking::Event};
use chrono::{Timelike, Utc};
use redis::streams::{StreamAutoClaimReply, StreamId, StreamPendingCountReply, StreamReadReply};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
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
        for _ in 0..4 {
            let state = state.clone();
            let rx = rx.clone();
            let ready = ready.clone();
            handles.push(tokio::spawn(async move {
                let _running = Running(ready);
                event_loop(state, rx).await;
            }));
        }
        if maintenance_enabled {
            let maintenance = state.clone();
            let live = ready.clone();
            handles.push(tokio::spawn(async move {
                let _running = Running(live);
                maintenance_loop(maintenance, rx).await;
            }));
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
async fn acknowledge(state: &State, id: &str) -> Result<()> {
    let mut conn = state.redis.clone();
    let _: () = redis::pipe()
        .atomic()
        .cmd("XACK")
        .arg(queue::stream(state))
        .arg(queue::GROUP)
        .arg(id)
        .ignore()
        .cmd("XDEL")
        .arg(queue::stream(state))
        .arg(id)
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
async fn process(state: &State, item: StreamId) -> Result<()> {
    let data = item.get::<String>("data").unwrap_or_default();
    let event = serde_json::from_str::<Event>(&data)
        .ok()
        .filter(|e| e.validate().is_ok());
    let Some(event) = event else {
        return dead_letter(state, &item, &data, "invalid_envelope").await;
    };
    match ingest::ingest(state, &event, Utc::now()).await {
        Ok(inserted) => {
            acknowledge(state, &item.id).await?;
            tracing::info!(inserted, "event processed");
            Ok(())
        }
        Err(error) => {
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
                dead_letter(state, &item, &data, "retry_limit").await?;
            }
            Err(error)
        }
    }
}
async fn event_loop(state: State, mut stop: watch::Receiver<bool>) {
    let consumer = Uuid::new_v4().to_string();
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut scan = String::from("0-0");
    let mut reclaim_tick = 0u8;
    loop {
        tokio::select! {_ = stop.changed()=>break,_=tick.tick()=>{}}
        if *stop.borrow() {
            break;
        }
        let work = async {
            let mut conn = state.redis.clone();
            let mut pending = vec![];
            if reclaim_tick == 0 {
                let claimed: StreamAutoClaimReply = redis::cmd("XAUTOCLAIM")
                    .arg(queue::stream(&state))
                    .arg(queue::GROUP)
                    .arg(&consumer)
                    .arg(60000)
                    .arg(&scan)
                    .arg("COUNT")
                    .arg(1)
                    .query_async(&mut conn)
                    .await?;
                scan = claimed.next_stream_id;
                pending = claimed.claimed;
            }
            reclaim_tick = (reclaim_tick + 1) % 10;
            if pending.is_empty() {
                let reply: StreamReadReply = redis::cmd("XREADGROUP")
                    .arg("GROUP")
                    .arg(queue::GROUP)
                    .arg(&consumer)
                    .arg("COUNT")
                    .arg(1)
                    .arg("STREAMS")
                    .arg(queue::stream(&state))
                    .arg(">")
                    .query_async(&mut conn)
                    .await?;
                pending = reply.keys.into_iter().flat_map(|s| s.ids).collect();
            }
            for item in pending {
                process(&state, item).await?;
            }
            Ok::<_, Error>(())
        }
        .await;
        if work.is_err() {
            tracing::error!("event processing failed; unacknowledged events will be retried");
        }
    }
    // Pending messages must remain associated with the consumer until reclaimed.
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
    let prefix = queue::stream(state);
    let billing_key = format!("{prefix}:billing-lock");
    if let Some(token) = lease(state, &billing_key, 120).await? {
        let result = billing::delivery::flush(state).await;
        release(state, &billing_key, &token).await?;
        if result.is_err() {
            tracing::error!("billing delivery failed");
        }
    }
    let now = Utc::now();
    if now.hour() > 3 || (now.hour() == 3 && now.minute() >= 17) {
        let done = format!("{prefix}:retention:{}", now.date_naive());
        let mut conn = state.redis.clone();
        let complete: bool = redis::cmd("EXISTS")
            .arg(&done)
            .query_async(&mut conn)
            .await?;
        if !complete {
            let key = format!("{prefix}:retention-lock");
            if let Some(token) = lease(state, &key, 600).await? {
                let result = retention::retain(state).await;
                if let Ok(summary) = &result {
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
    }
    Ok(())
}

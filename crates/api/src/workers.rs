use crate::{AppState, config::Role, ingestion};
use chrono::Utc;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicI64, Ordering},
    },
    time::Duration,
};
use tokio::{sync::watch, task::JoinSet};

pub struct Health {
    draining: AtomicBool,
    recovered_at: AtomicI64,
    started: AtomicBool,
    ingestion: Vec<AtomicI64>,
}
impl Health {
    pub fn new(workers: usize) -> Self {
        Self {
            draining: AtomicBool::new(false),
            recovered_at: AtomicI64::new(0),
            started: AtomicBool::new(false),
            ingestion: (0..workers).map(|_| AtomicI64::new(0)).collect(),
        }
    }
    pub fn ready(&self, role: Role) -> bool {
        !self.draining.load(Ordering::Relaxed)
            && (role == Role::Api
                || (self.started.load(Ordering::Relaxed)
                    && Utc::now().timestamp() - self.recovered_at.load(Ordering::Relaxed) < 120
                    && self
                        .ingestion
                        .iter()
                        .all(|at| Utc::now().timestamp() - at.load(Ordering::Relaxed) < 120)))
    }
    pub fn drain(&self) {
        self.draining.store(true, Ordering::Relaxed);
    }
}

pub struct Workers {
    stop: watch::Sender<bool>,
    tasks: JoinSet<()>,
    health: Arc<Health>,
}
impl Workers {
    pub fn start(state: AppState) -> Self {
        let (stop, receiver) = watch::channel(false);
        let mut tasks = JoinSet::new();
        let health = state.health.clone();
        if state.config.role != Role::Api {
            for index in 0..state.config.workers {
                let state = state.clone();
                let mut receiver = receiver.clone();
                tasks.spawn(async move {
                    let consumer=uuid::Uuid::new_v4().to_string();let mut cursor="0-0".to_owned();
                    loop {
                        if *receiver.borrow() {break;}
                        // Finish each in-flight transaction before honoring shutdown.
                        let mut stage = "pending_receipts";
                        let result=async {
                            let owners:Vec<String>=sqlx::query_scalar("SELECT owner_id FROM ingestion_receipts WHERE state='pending' GROUP BY owner_id ORDER BY min(created_at) LIMIT 16")
                                .fetch_all(&state.pool).await?;
                            stage = "receipt_delivery";
                            for owner in owners {ingestion::deliver(&state,&owner,state.config.batch_size).await?;}
                            stage = "diagnostic_queue";
                            state.queue.consume(&state,&consumer,&mut cursor).await?;
                            Ok::<_,crate::error::ApiError>(())
                        }.await;
                        if let Err(error) = result {tracing::error!(stage, code = error.code, "Ingestion recovery failed; retrying");}
                        else {state.health.ingestion[index].store(Utc::now().timestamp(),Ordering::Relaxed);}
                        tokio::select! {_=receiver.changed()=>break,_=tokio::time::sleep(Duration::from_secs(1))=>{}}
                    }
                });
            }
            let state = state.clone();
            let mut receiver = receiver;
            tasks.spawn(async move {
                let mut refresh_at=std::time::Instant::now()-Duration::from_secs(61);
                loop {
                    if *receiver.borrow() {break;}
                    let result=async {
                        sqlx::query("SELECT 1").execute(&state.pool).await?;
                        state.queue.counts().await?;
                        crate::maintenance::clean_deleted(&state).await?;
                        state.health.recovered_at.store(Utc::now().timestamp(),Ordering::Relaxed);
                        state.health.started.store(true,Ordering::Relaxed);
                        state.billing.drain_outbox().await?;
                        if refresh_at.elapsed()>Duration::from_secs(60) {
                            state.billing.refresh_customers().await?;
                            crate::maintenance::retain(&state).await?;
                            refresh_at=std::time::Instant::now();
                        }
                        Ok::<_,crate::error::ApiError>(())
                    }.await;
                    if result.is_err() {tracing::error!("Background recovery failed; retrying");}
                    tokio::select! {_=receiver.changed()=>break,_=tokio::time::sleep(Duration::from_secs(10))=>{}}
                }
            });
        }
        Self {
            stop,
            tasks,
            health,
        }
    }

    pub async fn shutdown(mut self) {
        self.health.drain();
        let _ = self.stop.send(true);
        while let Some(result) = self.tasks.join_next().await {
            if result.is_err() {
                tracing::error!("Background worker stopped unexpectedly");
            }
        }
    }

    pub fn shutdown_trigger(&self) -> impl FnOnce() + Send + 'static {
        let health = self.health.clone();
        let stop = self.stop.clone();
        move || {
            health.drain();
            let _ = stop.send(true);
        }
    }
}

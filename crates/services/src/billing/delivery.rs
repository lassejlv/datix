use analytics_core::{Error, Result, State};
use chrono::{DateTime, Duration, Utc};
use serde_json::{Value, json};
use uuid::Uuid;
#[derive(sqlx::FromRow)]
struct Delivery {
    id: Uuid,
    owner_id: String,
    event_type: String,
    event_count: String,
    occurred_at: DateTime<Utc>,
    attempts: i64,
}
pub async fn deliver(state: &State) -> Result<usize> {
    let key = state
        .config
        .autumn_key
        .as_deref()
        .ok_or_else(Error::unavailable)?;
    let lease = Uuid::new_v4();
    let mut tx = state.begin().await?;
    // Autumn deduplicates for 24h. Hold unresolved older deliveries for reconciliation,
    // rather than risk counting them twice after the provider forgets their key.
    let rows=sqlx::query_as::<_,Delivery>("SELECT id,owner_id,event_type,event_count::text,occurred_at,attempts FROM billing_outbox WHERE provider='autumn' AND available_at<=now() AND (delivery_started_at IS NULL OR delivery_started_at>now()-interval '23 hours') ORDER BY available_at LIMIT 10 FOR UPDATE SKIP LOCKED").fetch_all(&mut *tx).await?;
    let ids: Vec<_> = rows.iter().map(|r| r.id).collect();
    sqlx::query("UPDATE billing_outbox SET lease_id=$1,available_at=now()+interval '120 seconds',attempts=attempts+1,delivery_started_at=coalesce(delivery_started_at,now()) WHERE id=ANY($2)").bind(lease).bind(&ids).execute(&mut *tx).await?;
    tx.commit().await?;
    let mut delivered = 0;
    for row in rows {
        // Serialize provider delivery and snapshot reads with ingestion for this owner.
        let mut tx = state.db.begin().await?;
        sqlx::query("SELECT id FROM \"user\" WHERE id=$1 FOR UPDATE").bind(&row.owner_id).fetch_optional(&mut *tx).await?;
        let leased: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM billing_outbox WHERE id=$1 AND lease_id=$2)").bind(row.id).bind(lease).fetch_one(&mut *tx).await?;
        if !leased { continue; }

        let value = row
            .event_count
            .parse::<f64>()
            .map_err(|_| Error::unavailable())?;
        let result=state.http.post(format!("{}/v1/balances.track",state.config.autumn_url.trim_end_matches('/')))
            .bearer_auth(key).header("x-api-version","2.2").header("Idempotency-Key",format!("analytics-usage-{}",row.id))
            .timeout(std::time::Duration::from_secs(5))
            .json(&json!({"customer_id":row.owner_id,"feature_id":"events","value":value,"timestamp":row.occurred_at.timestamp_millis(),"properties":{"event_type":row.event_type,"delivery_id":row.id},"overage_behavior":"cap"})).send().await;
        let complete = match result {
            Ok(response) if response.status().is_success() => true,
            Ok(response) if response.status() == reqwest::StatusCode::CONFLICT => response
                .json::<Value>()
                .await
                .ok()
                .is_some_and(|v| v["code"] == "duplicate_idempotency_key"),
            _ => false,
        };
        if complete {
            sqlx::query(
                "DELETE FROM billing_outbox WHERE id=$1 AND lease_id=$2 AND provider='autumn'",
            )
            .bind(row.id)
            .bind(lease)
            .execute(&mut *tx)
            .await?;
            delivered += 1;
        } else {
            let delay = (30 * (1_i64 << row.attempts.clamp(0, 7))).min(3600);
            sqlx::query("UPDATE billing_outbox SET lease_id=NULL,available_at=$1 WHERE id=$2 AND lease_id=$3").bind(Utc::now()+Duration::seconds(delay)).bind(row.id).bind(lease).execute(&mut *tx).await?;
        }
        tx.commit().await?;
    }
    state
        .metrics
        .billing_delivered
        .fetch_add(delivered as u64, std::sync::atomic::Ordering::Relaxed);
    Ok(delivered)
}
pub async fn flush(state: &State) -> Result<usize> {
    let mut delivered = 0;
    if state.config.autumn_key.is_some() {
        let deadline = std::time::Instant::now()
            + std::time::Duration::from_secs(state.config.runtime.billing_drain_seconds);
        while std::time::Instant::now() < deadline {
            let count = deliver(state).await?;
            delivered += count;
            if count < 10 {
                break;
            }
        }
    }
    Ok(delivered)
}

use super::provider;
use analytics_core::{Error, Result, State, models::BillingOutbox};
use chrono::{Duration, Utc};
use serde_json::json;
use uuid::Uuid;
pub async fn deliver(state: &State) -> Result<usize> {
    let lease = Uuid::new_v4();
    let mut tx = state.db.begin().await?;
    let rows=sqlx::query_as::<_,BillingOutbox>("SELECT id,owner_id,event_type,event_count::text,occurred_at,available_at,attempts,lease_id FROM billing_outbox WHERE available_at<=now() ORDER BY available_at LIMIT 100 FOR UPDATE SKIP LOCKED").fetch_all(&mut *tx).await?;
    if rows.is_empty() {
        return Ok(0);
    }
    let ids: Vec<Uuid> = rows.iter().map(|r| r.id).collect();
    sqlx::query("UPDATE billing_outbox SET lease_id=$1,available_at=now()+interval '120 seconds',attempts=attempts+1 WHERE id=ANY($2)").bind(lease).bind(&ids).execute(&mut *tx).await?;
    tx.commit().await?;
    let events:Vec<_>=rows.iter().map(|r|json!({"name":"analytics.events.v1","external_id":format!("analytics-usage-{}",r.id),"external_customer_id":r.owner_id,"timestamp":r.occurred_at,"metadata":{"event_type":r.event_type,"event_count":r.event_count.parse::<f64>().unwrap_or(0.0)}})).collect();
    let result = provider::request(
        state,
        reqwest::Method::POST,
        "/v1/events/ingest",
        Some(json!({"events":events})),
    )
    .await;
    let complete = result
        .as_ref()
        .ok()
        .and_then(|v| v.as_ref())
        .is_some_and(|v| {
            v["inserted"].as_u64().unwrap_or(0) + v["duplicates"].as_u64().unwrap_or(0)
                == rows.len() as u64
        });
    if complete {
        sqlx::query("DELETE FROM billing_outbox WHERE lease_id=$1 AND id=ANY($2)")
            .bind(lease)
            .bind(&ids)
            .execute(&state.db)
            .await?;
        return Ok(rows.len());
    }
    for row in rows {
        let delay = (30 * (1_i64 << row.attempts.clamp(0, 7))).min(3600);
        sqlx::query(
            "UPDATE billing_outbox SET lease_id=NULL,available_at=$1 WHERE id=$2 AND lease_id=$3",
        )
        .bind(Utc::now() + Duration::seconds(delay))
        .bind(row.id)
        .bind(lease)
        .execute(&state.db)
        .await?;
    }
    Err(Error::unavailable())
}
pub async fn flush(state: &State) -> Result<()> {
    if state.config.polar_token.is_some() {
        for _ in 0..5 {
            if deliver(state).await? < 100 {
                break;
            }
        }
    }
    Ok(())
}

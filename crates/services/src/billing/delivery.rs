use super::catalog::CATALOG;
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
        .polar_token
        .as_deref()
        .ok_or_else(Error::unavailable)?;
    let lease = Uuid::new_v4();
    let mut tx = state.begin().await?;
    let rows = sqlx::query_as::<_, Delivery>("SELECT id,owner_id,event_type,event_count::text,occurred_at,attempts FROM billing_outbox WHERE provider='polar' AND organization_id=$1 AND available_at<=now() ORDER BY available_at,id LIMIT 10 FOR UPDATE SKIP LOCKED")
        .bind(CATALOG.organization_id).fetch_all(&mut *tx).await?;
    let ids: Vec<_> = rows.iter().map(|r| r.id).collect();
    sqlx::query("UPDATE billing_outbox SET lease_id=$1,available_at=now()+interval '120 seconds',attempts=attempts+1,delivery_started_at=coalesce(delivery_started_at,now()) WHERE id=ANY($2)")
        .bind(lease).bind(&ids).execute(&mut *tx).await?;
    tx.commit().await?;
    let mut delivered = 0;
    let mut owners = std::collections::BTreeMap::<String, Vec<Delivery>>::new();
    for row in rows {
        owners.entry(row.owner_id.clone()).or_default().push(row);
    }
    for (owner, mut rows) in owners {
        // One owner lock protects a small batch against account deletion. Batching
        // avoids a database transaction and provider round trip for every event.
        let mut tx = state.db.begin().await?;
        sqlx::query("SELECT id FROM \"user\" WHERE id=$1 FOR UPDATE")
            .bind(&owner)
            .fetch_optional(&mut *tx)
            .await?;
        let ids: Vec<_> = rows.iter().map(|row| row.id).collect();
        let leased: Vec<Uuid> = sqlx::query_scalar(
            "SELECT id FROM billing_outbox WHERE id=ANY($1) AND lease_id=$2 FOR UPDATE",
        )
        .bind(&ids)
        .bind(lease)
        .fetch_all(&mut *tx)
        .await?;
        rows.retain(|row| leased.contains(&row.id));
        if rows.is_empty() {
            continue;
        }
        let mut events = Vec::with_capacity(rows.len());
        for row in &rows {
            let quantity = row
                .event_count
                .parse::<f64>()
                .map_err(|_| Error::unavailable())?;
            if !quantity.is_finite() || quantity <= 0.0 {
                return Err(Error::unavailable());
            }
            // IDs, quantity and receipt timestamp never change, even when a retry
            // batch contains a mix of previously accepted and undelivered events.
            events.push(json!({
                "external_id":format!("datix-usage-{}", row.id),
                "name":CATALOG.meter.event_name,
                "organization_id":CATALOG.organization_id,
                "external_customer_id":owner,
                "timestamp":row.occurred_at,
                "metadata":{&CATALOG.meter.quantity_property:quantity,"event_type":row.event_type},
            }));
        }
        let result = state
            .http
            .post(format!(
                "{}/v1/events/ingest",
                state.config.polar_url.trim_end_matches('/')
            ))
            .bearer_auth(key)
            .header("Polar-Version", &CATALOG.api_version)
            .timeout(std::time::Duration::from_secs(5))
            .json(&json!({"events":events}))
            .send()
            .await;
        let complete = match result {
            Ok(response) if response.status().is_success() => response
                .json::<Value>()
                .await
                .ok()
                .is_some_and(|v| acknowledged(&v, rows.len())),
            _ => false,
        };
        if complete {
            let deleted = sqlx::query("DELETE FROM billing_outbox WHERE id=ANY($1) AND lease_id=$2 AND provider='polar' AND organization_id=$3")
                .bind(&leased).bind(lease).bind(CATALOG.organization_id)
                .execute(&mut *tx).await?.rows_affected();
            delivered += deleted as usize;
        } else {
            // A partial/ambiguous acknowledgment retries the entire batch. Polar
            // reports accepted IDs as duplicates, so no usage is lost or doubled.
            let next: Vec<_> = rows
                .iter()
                .map(|row| {
                    let delay = (30 * (1_i64 << row.attempts.clamp(0, 7))).min(3600);
                    Utc::now() + Duration::seconds(delay)
                })
                .collect();
            let ids: Vec<_> = rows.iter().map(|row| row.id).collect();
            sqlx::query("UPDATE billing_outbox b SET lease_id=NULL,available_at=r.available_at FROM unnest($1::uuid[],$2::timestamptz[]) AS r(id,available_at) WHERE b.id=r.id AND b.lease_id=$3")
                .bind(&ids).bind(&next).bind(lease).execute(&mut *tx).await?;
        }
        tx.commit().await?;
    }
    state
        .metrics
        .billing_delivered
        .fetch_add(delivered as u64, std::sync::atomic::Ordering::Relaxed);
    Ok(delivered)
}
fn acknowledged(value: &Value, expected: usize) -> bool {
    let Some(inserted) = value["inserted"].as_u64() else {
        return false;
    };
    let duplicates = if value["duplicates"].is_null() {
        Some(0)
    } else {
        value["duplicates"].as_u64()
    };
    expected > 0 && duplicates.and_then(|n| inserted.checked_add(n)) == Some(expected as u64)
}
pub async fn flush(state: &State) -> Result<usize> {
    let mut delivered = 0;
    if state.config.polar_token.is_some() {
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_a_complete_provider_acknowledgment_removes_usage() {
        assert!(acknowledged(&json!({"inserted":1,"duplicates":0}), 1));
        assert!(acknowledged(&json!({"inserted":0,"duplicates":1}), 1));
        assert!(acknowledged(&json!({"inserted":3,"duplicates":7}), 10));
        assert!(!acknowledged(&json!({"inserted":3,"duplicates":6}), 10));
        assert!(!acknowledged(
            &json!({"inserted":u64::MAX,"duplicates":1}),
            10
        ));
        for invalid in [
            json!({}),
            json!({"inserted":0}),
            json!({"inserted":0,"duplicates":0}),
            json!({"inserted":1,"duplicates":1}),
            json!({"inserted":2,"duplicates":0}),
            json!({"inserted":-1,"duplicates":2}),
        ] {
            assert!(!acknowledged(&invalid, 1));
        }
    }
}

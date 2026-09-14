use super::Billing;
use crate::error::ApiError;
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::Row;
use std::collections::BTreeSet;
use uuid::Uuid;

fn acknowledged(value: &Value, count: usize) -> bool {
    let inserted = value.get("inserted").and_then(Value::as_u64);
    let duplicates = value
        .get("duplicates")
        .filter(|v| !v.is_null())
        .map_or(Some(0), Value::as_u64);
    count > 0
        && inserted.zip(duplicates).is_some_and(|(i, d)| {
            i <= 9_007_199_254_740_991
                && d <= 9_007_199_254_740_991
                && i.checked_add(d) == Some(count as u64)
        })
}

impl Billing {
    /// Stable event IDs make a lost or partial acknowledgment safe to retry.
    pub async fn drain_outbox(&self) -> Result<(), ApiError> {
        if !self.enabled {
            return Ok(());
        }
        let client = self.client()?;
        let lease = Uuid::new_v4();
        let mut tx = self.pool.begin().await?;
        let pending:Vec<(Uuid,String)>=sqlx::query_as("SELECT id,owner_id FROM billing_outbox WHERE provider='polar' AND organization_id=$1 AND available_at<=now() ORDER BY available_at,id LIMIT 10 FOR UPDATE SKIP LOCKED")
            .bind(self.organization_id()).fetch_all(&mut *tx).await?;
        for (id, _) in &pending {
            sqlx::query("UPDATE billing_outbox SET lease_id=$1,available_at=now()+interval '120 seconds',attempts=attempts+1,delivery_started_at=coalesce(delivery_started_at,now()) WHERE id=$2")
                .bind(lease).bind(id).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        for owner in pending
            .into_iter()
            .map(|(_, owner)| owner)
            .collect::<BTreeSet<_>>()
        {
            let mut tx = self.pool.begin().await?;
            let user: Option<String> =
                sqlx::query_scalar("SELECT id FROM public.\"user\" WHERE id=$1 FOR UPDATE")
                    .bind(&owner)
                    .fetch_optional(&mut *tx)
                    .await?;
            if user.is_none() {
                continue;
            }
            let batch=sqlx::query("SELECT id,event_type,event_count::text,occurred_at FROM billing_outbox WHERE owner_id=$1 AND lease_id=$2 AND provider='polar' AND organization_id=$3 FOR UPDATE")
                .bind(&owner).bind(lease).bind(self.organization_id()).fetch_all(&mut *tx).await?;
            if batch.is_empty() {
                continue;
            }
            let events=batch.iter().map(|row| {
                let quantity:Value=serde_json::from_str(row.get::<&str,_>("event_count")).map_err(|_|ApiError::unavailable())?;
                if !quantity.is_number() || quantity.as_f64().is_none_or(|n|!n.is_finite() || n<=0.0) {return Err(ApiError::unavailable());}
                Ok(json!({"external_id":format!("datix-usage-{}",row.get::<Uuid,_>("id")),"name":self.catalog.meter.event_name,"external_customer_id":owner,"timestamp":row.get::<DateTime<Utc>,_>("occurred_at"),
                    "metadata":{self.catalog.meter.quantity_property.clone():quantity,"event_type":row.get::<String,_>("event_type")}}))
            }).collect::<Result<Vec<_>,ApiError>>()?;
            let response = client
                .ingest(json!({"events":events}))
                .await
                .unwrap_or(Value::Null);
            if acknowledged(&response, batch.len()) {
                sqlx::query("DELETE FROM billing_outbox WHERE owner_id=$1 AND lease_id=$2 AND provider='polar' AND organization_id=$3")
                    .bind(&owner).bind(lease).bind(self.organization_id()).execute(&mut *tx).await?;
            } else {
                sqlx::query("UPDATE billing_outbox SET lease_id=NULL,available_at=now()+least(3600,30*power(2,least(7,greatest(0,attempts-1))))*interval '1 second' WHERE owner_id=$1 AND lease_id=$2 AND provider='polar' AND organization_id=$3")
                    .bind(&owner).bind(lease).bind(self.organization_id()).execute(&mut *tx).await?;
            }
            tx.commit().await?;
        }
        Ok(())
    }

    pub async fn refresh_customers(&self) -> Result<(), ApiError> {
        if !self.enabled {
            return Ok(());
        }
        let owners:Vec<String>=sqlx::query_scalar("SELECT owner_id FROM billing_customers WHERE owner_id IS NOT NULL AND provider='polar' AND organization_id=$1 AND deleted=false AND sync_attempted_at<now()-interval '60 seconds' ORDER BY sync_attempted_at LIMIT 16")
            .bind(self.organization_id()).fetch_all(&self.pool).await?;
        for owner in owners {
            sqlx::query("UPDATE billing_customers SET sync_attempted_at=now() WHERE owner_id=$1 AND provider='polar' AND organization_id=$2")
                .bind(&owner).bind(self.organization_id()).execute(&self.pool).await?;
            if self.sync(&owner).await.is_err() {
                tracing::error!("Billing refresh failed");
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_complete_inserted_or_duplicate_acknowledgments_release_a_batch() {
        for valid in [
            json!({"inserted":2}),
            json!({"inserted":1,"duplicates":1}),
            json!({"inserted":0,"duplicates":2}),
        ] {
            assert!(acknowledged(&valid, 2));
        }
        for invalid in [
            Value::Null,
            json!({"inserted":1}),
            json!({"inserted":3}),
            json!({"inserted":0,"duplicates":-1}),
            json!({"inserted":2.5}),
            json!({"inserted":"2"}),
            json!({"inserted":9_007_199_254_740_992_u64}),
        ] {
            assert!(!acknowledged(&invalid, 2));
        }
        assert!(!acknowledged(&json!({"inserted":0}), 0));
    }
}

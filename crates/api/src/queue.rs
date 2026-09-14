use crate::{AppState, diagnostics, error::ApiError};
use redis::{
    aio::ConnectionManager,
    streams::{StreamAutoClaimReply, StreamReadReply},
};
use serde::Serialize;

const GROUP: &str = "datix-rust-v1";

#[derive(Clone)]
pub struct Queue {
    redis: ConnectionManager,
    key: String,
}

impl Queue {
    pub fn new(redis: ConnectionManager, prefix: &str) -> Self {
        Self {
            redis,
            key: format!("{prefix}:diagnostic-stream"),
        }
    }

    pub async fn initialize(&self) -> Result<(), ApiError> {
        let result = redis::cmd("XGROUP")
            .arg("CREATE")
            .arg(&self.key)
            .arg(GROUP)
            .arg("0")
            .arg("MKSTREAM")
            .query_async::<()>(&mut self.redis.clone())
            .await;
        match result {
            Ok(()) => Ok(()),
            Err(error) if error.code() == Some("BUSYGROUP") => Ok(()),
            Err(_) => Err(ApiError::unavailable()),
        }
    }

    pub async fn enqueue(&self, payload: &impl Serialize) -> Result<(), ApiError> {
        let value = serde_json::to_string(payload).map_err(|_| ApiError::unavailable())?;
        // Do not MAXLEN-trim a work stream: that can delete unacknowledged diagnostics.
        let _: String = redis::cmd("XADD")
            .arg(&self.key)
            .arg("*")
            .arg("payload")
            .arg(value)
            .query_async(&mut self.redis.clone())
            .await?;
        Ok(())
    }

    pub async fn consume(
        &self,
        state: &AppState,
        consumer: &str,
        cursor: &mut String,
    ) -> Result<(), ApiError> {
        let recovered: StreamAutoClaimReply = redis::cmd("XAUTOCLAIM")
            .arg(&self.key)
            .arg(GROUP)
            .arg(consumer)
            .arg(120_000)
            .arg(&*cursor)
            .arg("COUNT")
            .arg(16)
            .query_async(&mut self.redis.clone())
            .await?;
        *cursor = recovered.next_stream_id;
        let fresh: StreamReadReply = redis::cmd("XREADGROUP")
            .arg("GROUP")
            .arg(GROUP)
            .arg(consumer)
            .arg("COUNT")
            .arg(16)
            .arg("STREAMS")
            .arg(&self.key)
            .arg(">")
            .query_async(&mut self.redis.clone())
            .await?;
        let entries = recovered
            .claimed
            .into_iter()
            .chain(fresh.keys.into_iter().flat_map(|key| key.ids));
        for entry in entries {
            let diagnostic = entry
                .get::<String>("payload")
                .and_then(|s| serde_json::from_str(&s).ok());
            let result = match diagnostic {
                Some(d) => diagnostics::ingest(state, d).await,
                None => Err(ApiError::invalid()),
            };
            match result {
                Ok(()) => self.ack(&entry.id, None).await?,
                Err(error) if error.status.is_client_error() => {
                    self.ack(&entry.id, Some(error.code)).await?
                }
                Err(_) => tracing::error!("Diagnostic delivery failed; receipt remains pending"),
            }
        }
        Ok(())
    }

    async fn ack(&self, id: &str, failure: Option<&str>) -> Result<(), ApiError> {
        // A single group owns this stream. Ack and deletion are atomic; after a lost
        // response the database's diagnostic ID guard makes redelivery harmless.
        let _:i64=redis::cmd("EVAL").arg("local n=redis.call('XACK',KEYS[1],ARGV[1],ARGV[2]);if n>0 then if ARGV[3]~='' then redis.call('XADD',KEYS[2],'MAXLEN','=',5000,'*','id',ARGV[2],'code',ARGV[3]);end;redis.call('XDEL',KEYS[1],ARGV[2]);end;return n")
            .arg(2).arg(&self.key).arg(format!("{}:failed",self.key)).arg(GROUP).arg(id).arg(failure.unwrap_or("")).query_async(&mut self.redis.clone()).await?;
        Ok(())
    }

    pub async fn counts(&self) -> Result<(i64, i64, i64), ApiError> {
        let (waiting,active,failed):(i64,i64,i64)=redis::cmd("EVAL")
            .arg("local pending=redis.call('XPENDING',KEYS[1],ARGV[1])[1];return {math.max(0,redis.call('XLEN',KEYS[1])-pending),pending,redis.call('XLEN',KEYS[2])}")
            .arg(2).arg(&self.key).arg(format!("{}:failed",self.key)).arg(GROUP).query_async(&mut self.redis.clone()).await?;
        Ok((waiting, active, failed))
    }

    #[cfg(test)]
    pub(crate) fn key(&self) -> &str {
        &self.key
    }
}

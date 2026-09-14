use crate::error::ApiError;
use aws_sdk_s3::{
    Client,
    config::{Credentials, Region, retry::RetryConfig, timeout::TimeoutConfig},
    primitives::ByteStream,
};
use serde::Serialize;
use std::time::{Duration, Instant};
use uuid::Uuid;

#[derive(Clone, Default)]
pub struct Storage {
    bucket: Option<String>,
    client: Option<Client>,
}

impl Storage {
    pub fn from_env(external_effects: bool) -> Result<Self, ApiError> {
        let Some(bucket) = std::env::var("S3_BUCKET").ok().filter(|s| !s.is_empty()) else {
            return Ok(Self::default());
        };
        if !external_effects {
            return Ok(Self {
                bucket: Some(bucket),
                client: None,
            });
        }
        let required = |key| {
            std::env::var(key)
                .ok()
                .filter(|v| !v.trim().is_empty())
                .ok_or_else(ApiError::unavailable)
        };
        let access = required("S3_ACCESS_KEY_ID")?;
        let secret = required("S3_SECRET_ACCESS_KEY")?;
        let region = std::env::var("S3_REGION")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "us-east-1".into());
        let mut config = config()
            .region(Region::new(region))
            .credentials_provider(Credentials::new(access, secret, None, None, "datix"))
            .force_path_style(true)
            .retry_config(RetryConfig::standard().with_max_attempts(1))
            .timeout_config(
                TimeoutConfig::builder()
                    .operation_timeout(Duration::from_secs(10))
                    .operation_attempt_timeout(Duration::from_secs(10))
                    .build(),
            );
        if let Some(endpoint) = std::env::var("S3_ENDPOINT").ok().filter(|s| !s.is_empty()) {
            let url = url::Url::parse(&endpoint).map_err(|_| ApiError::unavailable())?;
            if url.scheme() != "https"
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(ApiError::unavailable());
            }
            config = config.endpoint_url(endpoint);
        }
        Ok(Self {
            bucket: Some(bucket),
            client: Some(Client::from_conf(config.build())),
        })
    }

    fn client(&self) -> Result<Option<(&Client, &str)>, ApiError> {
        self.bucket
            .as_deref()
            .map(|bucket| {
                self.client
                    .as_ref()
                    .map(|client| (client, bucket))
                    .ok_or_else(ApiError::unavailable)
            })
            .transpose()
    }

    /// Only normalized import metrics belong in archives, never original uploaded files.
    pub async fn archive(
        &self,
        environment: Uuid,
        id: Uuid,
        data: &impl Serialize,
    ) -> Result<(), ApiError> {
        if let Some((client, bucket)) = self.client()? {
            let bytes = serde_json::to_vec(data).map_err(|_| ApiError::unavailable())?;
            client
                .put_object()
                .bucket(bucket)
                .key(format!("imports/{environment}/{id}.json"))
                .content_type("application/json")
                .body(ByteStream::from(bytes))
                .send()
                .await
                .map_err(|_| ApiError::unavailable())?;
        }
        Ok(())
    }

    pub async fn remove_archive(&self, environment: Uuid, id: Uuid) -> Result<(), ApiError> {
        if let Some((client, bucket)) = self.client()? {
            client
                .delete_object()
                .bucket(bucket)
                .key(format!("imports/{environment}/{id}.json"))
                .send()
                .await
                .map_err(|_| ApiError::unavailable())?;
        }
        Ok(())
    }

    /// Return false at the batch deadline so the database tombstone stays retryable.
    pub async fn remove_environment(
        &self,
        environment: Uuid,
        deadline: Instant,
    ) -> Result<bool, ApiError> {
        let Some((client, bucket)) = self.client()? else {
            return Ok(true);
        };
        let prefix = format!("imports/{environment}/");
        let mut token = None;
        loop {
            if Instant::now() > deadline {
                return Ok(false);
            }
            let page = client
                .list_objects_v2()
                .bucket(bucket)
                .prefix(&prefix)
                .max_keys(1000)
                .set_continuation_token(token.clone())
                .send()
                .await
                .map_err(|_| ApiError::unavailable())?;
            for object in page.contents() {
                if Instant::now() > deadline {
                    return Ok(false);
                }
                let key = object
                    .key()
                    .filter(|key| key.starts_with(&prefix))
                    .ok_or_else(ApiError::unavailable)?;
                client
                    .delete_object()
                    .bucket(bucket)
                    .key(key)
                    .send()
                    .await
                    .map_err(|_| ApiError::unavailable())?;
            }
            if page.is_truncated() != Some(true) {
                return Ok(true);
            }
            let next = page
                .next_continuation_token()
                .filter(|t| !t.is_empty())
                .map(str::to_owned)
                .ok_or_else(ApiError::unavailable)?;
            if token.as_ref() == Some(&next) {
                return Err(ApiError::unavailable());
            }
            token = Some(next);
        }
    }
}

fn config() -> aws_sdk_s3::config::Builder {
    // Reuse the workspace's Ring TLS provider. Enabling both default providers
    // would leave Redis's Rustls connector without an unambiguous crypto default.
    let http = aws_smithy_http_client::Builder::new()
        .tls_provider(aws_smithy_http_client::tls::Provider::Rustls(
            aws_smithy_http_client::tls::rustls_provider::CryptoMode::Ring,
        ))
        .build_https();
    aws_sdk_s3::Config::builder()
        .behavior_version_latest()
        .http_client(http)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        extract::{Request, State},
        http::{StatusCode, header},
        response::{IntoResponse, Response},
    };
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    type RequestLog = Arc<Mutex<Vec<(String, Vec<u8>)>>>;
    #[derive(Clone)]
    struct Mock {
        prefix: String,
        requests: RequestLog,
    }
    async fn call(State(mock): State<Mock>, request: Request) -> Response {
        assert!(
            request.headers()[header::AUTHORIZATION]
                .to_str()
                .unwrap()
                .starts_with("AWS4-HMAC-SHA256 ")
        );
        let path = request.uri().path().to_owned();
        let method = request.method().clone();
        let body = axum::body::to_bytes(request.into_body(), 64 * 1024)
            .await
            .unwrap();
        mock.requests
            .lock()
            .unwrap()
            .push((format!("{method} {path}"), body.to_vec()));
        if method == axum::http::Method::GET {
            ([(header::CONTENT_TYPE,"application/xml")],format!("<ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Name>fixture</Name><IsTruncated>false</IsTruncated><Contents><Key>{}archive.json</Key></Contents></ListBucketResult>",mock.prefix)).into_response()
        } else {
            StatusCode::OK.into_response()
        }
    }
    #[tokio::test]
    async fn sdk_uses_exact_archive_paths_and_redacts_disabled_effects() {
        let environment = Uuid::new_v4();
        let id = Uuid::new_v4();
        let mock = Mock {
            prefix: format!("imports/{environment}/"),
            requests: Arc::default(),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new().fallback(call).with_state(mock.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let config = config()
            .region(Region::new("us-east-1"))
            .credentials_provider(Credentials::new(
                "fixture-access",
                "fixture-secret",
                None,
                None,
                "fixture",
            ))
            .force_path_style(true)
            .endpoint_url(endpoint)
            .retry_config(RetryConfig::standard().with_max_attempts(1))
            .build();
        let storage = Storage {
            bucket: Some("fixture".into()),
            client: Some(Client::from_conf(config)),
        };
        storage
            .archive(environment, id, &json!({"summary":{"pageviews":1}}))
            .await
            .unwrap();
        storage.remove_archive(environment, id).await.unwrap();
        assert!(
            storage
                .remove_environment(environment, Instant::now() + Duration::from_secs(5))
                .await
                .unwrap()
        );
        {
            let requests = mock.requests.lock().unwrap();
            assert_eq!(
                requests[0].0,
                format!("PUT /fixture/imports/{environment}/{id}.json")
            );
            assert!(String::from_utf8_lossy(&requests[0].1).contains("pageviews"));
            assert_eq!(
                requests[1].0,
                format!("DELETE /fixture/imports/{environment}/{id}.json")
            );
            assert_eq!(
                requests[3].0,
                format!("DELETE /fixture/imports/{environment}/archive.json")
            );
        }
        let disabled = Storage {
            bucket: Some("fixture".into()),
            client: None,
        };
        assert!(disabled.remove_archive(environment, id).await.is_err());
        server.abort();
    }
}

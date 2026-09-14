use axum::http::StatusCode;
use datix_auth::{AuthError, User};
use email_sdk::{
    EmailClient, EmailClientOptions, EmailMessage, SendOptions, create_email_client,
    providers::cloudflare::{CloudflareProviderOptions, cloudflare},
};

pub struct Mailer {
    client: EmailClient,
    from: String,
}

pub fn delivery_failed() -> AuthError {
    AuthError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "EMAIL_DELIVERY_FAILED",
        "Verification email could not be sent. Please try again.",
    )
}

impl Mailer {
    pub fn from_env(client: reqwest::Client) -> Result<Self, AuthError> {
        let token = std::env::var("CLOUDFLARE_API_TOKEN").map_err(|_| delivery_failed())?;
        let account = std::env::var("CLOUDFLARE_ACCOUNT_ID").map_err(|_| delivery_failed())?;
        let from = std::env::var("EMAIL_FROM").map_err(|_| delivery_failed())?;
        if token.trim().is_empty()
            || account.is_empty()
            || !account.bytes().all(|b| b.is_ascii_alphanumeric())
        {
            return Err(delivery_failed());
        }
        Self::new(
            CloudflareProviderOptions::new(token, account).client(client),
            from,
        )
    }

    fn new(options: CloudflareProviderOptions, from: String) -> Result<Self, AuthError> {
        if from.trim().is_empty() {
            return Err(delivery_failed());
        }
        let client = create_email_client(EmailClientOptions::new().adapter(cloudflare(options)))
            .map_err(|_| delivery_failed())?;
        Ok(Self {
            client,
            from: from.trim().into(),
        })
    }

    pub async fn send_verification(&self, user: &User, url: &str) -> Result<(), AuthError> {
        // These templates are the rendered output of the original React Email template.
        // Replace the URL first so a user-supplied name cannot introduce a URL placeholder.
        let html = include_str!("email/verification.html")
            .replace("{{verification_url}}", &escape(url))
            .replace("{{name}}", &escape(&user.name));
        let text = include_str!("email/verification.txt")
            .replace("{{verification_url}}", url)
            .replace("{{name}}", &user.name);
        let message = EmailMessage::builder(
            self.from.as_str(),
            user.email.as_str(),
            "Verify your Datix email address",
        )
        .html(html)
        .text(text)
        .build();
        // Cloudflare has no idempotency support. Do not automatically retry an ambiguous send
        // or fall back to another provider; the existing verification resend flow owns recovery.
        let response = self
            .client
            .send(message, Some(SendOptions::new().retries(0)))
            .await
            .map_err(|_| delivery_failed())?;
        if !response
            .accepted
            .iter()
            .any(|email| email.eq_ignore_ascii_case(&user.email))
            || response
                .rejected
                .iter()
                .any(|email| email.eq_ignore_ascii_case(&user.email))
        {
            return Err(delivery_failed());
        }
        Ok(())
    }
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, extract::State, http::HeaderMap, routing::post};
    use serde_json::{Value, json};
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    struct Mock {
        status: StatusCode,
        body: Value,
        requests: Arc<Mutex<Vec<Value>>>,
    }

    async fn send(
        State(mock): State<Mock>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> (StatusCode, Json<Value>) {
        assert_eq!(headers["authorization"], "Bearer fixture-token");
        mock.requests.lock().unwrap().push(body);
        (mock.status, Json(mock.body))
    }

    #[tokio::test]
    async fn cloudflare_sdk_preserves_template_acceptance_and_redacted_failures_without_retries() {
        for (status, body, accepted) in [
            (
                StatusCode::OK,
                json!({"success":true,"result":{"queued":["verify@example.test"]}}),
                true,
            ),
            (
                StatusCode::OK,
                json!({"success":true,"result":{"permanent_bounces":["verify@example.test"]}}),
                false,
            ),
            (
                StatusCode::OK,
                json!({"success":false,"errors":[{"message":"private-provider-error"}]}),
                false,
            ),
            (
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"errors":[{"message":"private-provider-error"}]}),
                false,
            ),
        ] {
            let mock = Mock {
                status,
                body,
                requests: Arc::default(),
            };
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let router = Router::new()
                .route("/accounts/fixture/email/sending/send", post(send))
                .with_state(mock.clone());
            let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
            let options = CloudflareProviderOptions::new("fixture-token", "fixture")
                .base_url(url)
                .client(
                    reqwest::Client::builder()
                        .timeout(std::time::Duration::from_secs(2))
                        .redirect(reqwest::redirect::Policy::none())
                        .build()
                        .unwrap(),
                );
            let mailer = Mailer::new(options, "Datix <hello@example.test>".into()).unwrap();
            let user = User {
                id: "fixture".into(),
                name: "<b>Alice & Bob</b>".into(),
                email: "verify@example.test".into(),
                email_verified: false,
                image: None,
                created_at: chrono::Utc::now(),
                updated_at: chrono::Utc::now(),
            };
            let link = "https://datix.example/api/auth/verify-email?token=fixture&callbackURL=%2Fdashboard";
            let result = mailer.send_verification(&user, link).await;
            assert_eq!(result.is_ok(), accepted);
            if let Err(error) = result {
                assert_eq!(error.code, "EMAIL_DELIVERY_FAILED");
                assert!(!error.to_string().contains("private-provider-error"));
            }
            let requests = mock.requests.lock().unwrap();
            assert_eq!(requests.len(), 1);
            assert_eq!(
                requests[0]["from"],
                json!({"address":"hello@example.test","name":"Datix"})
            );
            assert_eq!(requests[0]["to"], json!(["verify@example.test"]));
            let html = requests[0]["html"].as_str().unwrap();
            assert!(html.contains("&lt;b&gt;Alice &amp; Bob&lt;/b&gt;"));
            assert!(html.contains(&escape(link)));
            assert!(html.contains("This link expires in one hour."));
            assert!(!html.contains("{{verification_url}}"));
            assert!(requests[0]["text"].as_str().unwrap().contains(link));
            server.abort();
        }
    }
}

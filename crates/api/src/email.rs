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
        self.send(&user.email, "Verify your Datix email address", html, text)
            .await
    }

    async fn send_suspension(&self, name: &str, email: &str) -> Result<(), AuthError> {
        // Moderation reasons are internal notes, not recipient-facing email content.
        let html = include_str!("email/suspension.html").replace("{{name}}", &escape(name));
        let text = include_str!("email/suspension.txt").replace("{{name}}", name);
        self.send(email, "Your Datix account has been suspended", html, text)
            .await
    }

    async fn send(
        &self,
        email: &str,
        subject: &str,
        html: String,
        text: String,
    ) -> Result<(), AuthError> {
        let message = EmailMessage::builder(self.from.as_str(), email, subject)
            .html(html)
            .text(text)
            .build();
        // Cloudflare has no idempotency support. Do not automatically retry an ambiguous send
        // or fall back to another provider. Recovery must be an explicit separate action.
        let response = self
            .client
            .send(message, Some(SendOptions::new().retries(0)))
            .await
            .map_err(|_| delivery_failed())?;
        if !response
            .accepted
            .iter()
            .any(|accepted| accepted.eq_ignore_ascii_case(email))
            || response
                .rejected
                .iter()
                .any(|rejected| rejected.eq_ignore_ascii_case(email))
        {
            return Err(delivery_failed());
        }
        Ok(())
    }
}

pub(crate) async fn notify_suspension(
    mailer: Option<&Mailer>,
    external_effects: bool,
    name: &str,
    email: &str,
) -> &'static str {
    if !external_effects {
        return "disabled";
    }
    if let Some(mailer) = mailer
        && mailer.send_suspension(name, email).await.is_ok()
    {
        // Provider acceptance does not prove inbox delivery.
        "accepted"
    } else {
        tracing::error!("Account suspension email failed");
        "failed"
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
            assert_eq!(
                notify_suspension(Some(&mailer), false, &user.name, &user.email).await,
                "disabled"
            );
            assert_eq!(mock.requests.lock().unwrap().len(), 1);
            let suspension = notify_suspension(Some(&mailer), true, &user.name, &user.email).await;
            assert_eq!(suspension, if accepted { "accepted" } else { "failed" });
            let requests = mock.requests.lock().unwrap();
            assert_eq!(requests.len(), 2);
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
            assert_eq!(requests[1]["to"], json!(["verify@example.test"]));
            assert_eq!(
                requests[1]["subject"],
                "Your Datix account has been suspended"
            );
            let suspension_html = requests[1]["html"].as_str().unwrap();
            assert!(suspension_html.contains("&lt;b&gt;Alice &amp; Bob&lt;/b&gt;"));
            assert!(!suspension_html.contains("<b>Alice"));
            assert!(suspension_html.contains("mailto:hello@usedatix.com"));
            assert!(!suspension_html.contains(link));
            assert!(requests[1]["text"].as_str().unwrap().contains("signed out"));
            server.abort();
        }
    }

    #[tokio::test]
    async fn suspension_without_a_mailer_is_not_claimed_as_sent() {
        assert_eq!(
            notify_suspension(None, false, "Fixture", "fixture@example.test").await,
            "disabled"
        );
        assert_eq!(
            notify_suspension(None, true, "Fixture", "fixture@example.test").await,
            "failed"
        );
    }
}

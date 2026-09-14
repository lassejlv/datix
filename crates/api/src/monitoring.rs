use crate::config::Role;
use sentry::{ClientInitGuard, Hub, SentryFuture, SentryFutureExt, types::Dsn};
use std::{borrow::Cow, env, future::Future, sync::Arc, time::Duration};
use tracing_subscriber::prelude::*;

const DEFAULT_ERROR_SAMPLE_RATE: f32 = 1.0;

struct DisabledTransport;

impl sentry::Transport for DisabledTransport {
    fn send_envelope(&self, _envelope: sentry::Envelope) {}
}

pub fn init() -> anyhow::Result<ClientInitGuard> {
    // Sentry uses rustls without selecting a provider. Install the same Ring
    // provider already used by SQLx, reqwest, and the Smithy HTTP client.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let configured_dsn = optional_env("SENTRY_DSN")
        .map(|value| {
            value
                .parse::<Dsn>()
                .map_err(|_| anyhow::anyhow!("Invalid SENTRY_DSN"))
        })
        .transpose()?;
    let error_sample_rate = optional_env("SENTRY_ERROR_SAMPLE_RATE")
        .map(|value| parse_sample_rate(&value))
        .transpose()?
        .unwrap_or(DEFAULT_ERROR_SAMPLE_RATE);
    let enabled = env::var("EXTERNAL_EFFECTS").as_deref() == Ok("enabled");

    let mut options = sentry::ClientOptions::new()
        .sample_rate(error_sample_rate)
        .attach_stacktrace(true)
        .send_default_pii(false)
        .max_breadcrumbs(50)
        .shutdown_timeout(Duration::from_secs(5))
        .release(
            optional_env("SENTRY_RELEASE")
                .map(Cow::Owned)
                .unwrap_or_else(|| {
                    Cow::Borrowed(concat!(
                        env!("CARGO_PKG_NAME"),
                        "@",
                        env!("CARGO_PKG_VERSION")
                    ))
                }),
        )
        .environment(optional_env("SENTRY_ENVIRONMENT").unwrap_or_else(|| "production".into()))
        .before_send(redact_event);
    if enabled {
        options.dsn = configured_dsn;
    } else {
        // Sentry's defaults re-read SENTRY_DSN during initialization. A no-op
        // transport guarantees local isolated runs cannot deliver an event.
        options = options.transport(Arc::new(DisabledTransport));
    }
    Ok(sentry::init(options))
}

pub fn init_tracing() {
    use sentry::integrations::tracing::EventFilter;

    let sentry_layer = sentry::integrations::tracing::layer()
        .event_filter(|metadata| {
            let datix_target = ["datix_api", "datix_auth", "datix_db"]
                .iter()
                .any(|target| {
                    metadata.target() == *target
                        || metadata
                            .target()
                            .strip_prefix(*target)
                            .is_some_and(|suffix| suffix.starts_with("::"))
                });
            match (*metadata.level(), datix_target) {
                (tracing::Level::ERROR, true) => EventFilter::Event,
                (tracing::Level::WARN, true) => EventFilter::Breadcrumb,
                _ => EventFilter::Ignore,
            }
        })
        .span_filter(|_| false);
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer().with_filter(tracing_subscriber::EnvFilter::new(
                "datix_api=info,datix_auth=warn,datix_db=warn,tower_http=warn",
            )),
        )
        .with(sentry_layer)
        .init();
}

pub fn configure_runtime(role: Role) {
    sentry::configure_scope(|scope| {
        scope.set_tag("service", "datix-api");
        scope.set_tag("runtime.role", role_name(role));
    });
}

pub fn configure_request(route: &str, method: &str) {
    sentry::configure_scope(|scope| {
        scope.set_transaction(Some(route));
        scope.set_tag("http.route", route);
        scope.set_tag("http.method", method);
    });
}

pub fn report_http_failure(route: &str, method: &str, status: u16, code: &str, request_id: &str) {
    sentry::with_scope(
        |scope| {
            scope.set_fingerprint(Some(&["backend-http", route, code]));
        },
        || {
            tracing::error!(
                tags.http_route = route,
                tags.http_method = method,
                tags.http_status = status,
                tags.error_code = code,
                request_id,
                "Backend request failed"
            );
        },
    );
}

pub fn report_process_failure(stage: &str) {
    sentry::with_scope(
        |scope| scope.set_fingerprint(Some(&["backend-process", stage])),
        || tracing::error!(tags.stage = stage, "Backend process failed"),
    );
}

pub fn worker<F>(future: F, component: &'static str, instance: Option<usize>) -> SentryFuture<F>
where
    F: Future,
{
    let hub = Arc::new(Hub::new_from_top(Hub::current()));
    hub.configure_scope(|scope| {
        scope.set_tag("runtime.component", component);
        if let Some(instance) = instance {
            scope.set_tag("worker.instance", instance);
        }
    });
    future.bind_hub(hub)
}

fn optional_env(key: &str) -> Option<String> {
    env::var(key).ok().filter(|value| !value.trim().is_empty())
}

fn redact_event(
    mut event: sentry::protocol::Event<'static>,
) -> Option<sentry::protocol::Event<'static>> {
    // Datix supplies only bounded route, status, stage, and error-code context.
    // Keep this final guard in case a future integration adds request or user data.
    event.request = None;
    event.user = None;
    for exception in &mut event.exception {
        exception.value = Some("Backend exception".into());
    }
    Some(event)
}

fn parse_sample_rate(value: &str) -> anyhow::Result<f32> {
    let value = value
        .parse::<f32>()
        .map_err(|_| anyhow::anyhow!("Invalid SENTRY_ERROR_SAMPLE_RATE"))?;
    anyhow::ensure!(
        value.is_finite() && (0.0..=1.0).contains(&value),
        "SENTRY_ERROR_SAMPLE_RATE must be between 0 and 1"
    );
    Ok(value)
}

const fn role_name(role: Role) -> &'static str {
    match role {
        Role::Api => "api",
        Role::Worker => "worker",
        Role::Combined => "combined",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sentry_error_sample_rate_is_bounded() {
        assert_eq!(parse_sample_rate("0").unwrap(), 0.0);
        assert_eq!(parse_sample_rate("1").unwrap(), 1.0);
        for invalid in ["-0.1", "1.1", "NaN", "not-a-number"] {
            assert!(parse_sample_rate(invalid).is_err());
        }
    }

    #[test]
    fn sentry_events_drop_request_user_and_exception_values() {
        let event = sentry::protocol::Event {
            request: Some(sentry::protocol::Request {
                data: Some("secret request body".into()),
                ..Default::default()
            }),
            user: Some(sentry::protocol::User {
                email: Some("private@example.test".into()),
                ..Default::default()
            }),
            exception: vec![sentry::protocol::Exception {
                value: Some("private panic value".into()),
                ..Default::default()
            }]
            .into(),
            ..Default::default()
        };
        let event = redact_event(event).unwrap();
        assert!(event.request.is_none());
        assert!(event.user.is_none());
        assert_eq!(
            event.exception[0].value.as_deref(),
            Some("Backend exception")
        );
    }
}

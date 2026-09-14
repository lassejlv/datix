//! Datix authentication with Better Auth compatible HTTP and session contracts.

mod crypto;
mod error;
mod http;
mod model;
mod oauth;
mod service;

use sqlx::PgPool;
use std::{future::Future, pin::Pin, sync::Arc};
use url::Url;

pub use error::AuthError;
pub use model::{
    EmailCredentials, PasswordChange, Session, SessionData, User, VerificationRequest,
};
pub use oauth::{SocialAuthorization, SocialProvider, SocialSignIn};
pub use service::AuthApi;

pub type HookFuture<'a> = Pin<Box<dyn Future<Output = Result<(), AuthError>> + Send + 'a>>;

/// Application-owned effects. Authentication always awaits their success.
pub trait AuthHooks: Send + Sync {
    fn send_verification<'a>(&'a self, user: &'a User, url: &'a str) -> HookFuture<'a>;
    fn before_delete<'a>(&'a self, user: &'a User) -> HookFuture<'a>;
}

#[derive(Clone)]
struct Inner {
    pool: PgPool,
    secret: String,
    base_url: Url,
    hooks: Arc<dyn AuthHooks>,
    password_slots: Arc<tokio::sync::Semaphore>,
    social_providers: Vec<SocialProvider>,
    client: reqwest::Client,
}

/// A cloneable service exposing `auth.api()` and `auth.router()` like Better Auth.
#[derive(Clone)]
pub struct Auth(Arc<Inner>);

impl Auth {
    pub fn new(
        pool: PgPool,
        secret: String,
        base_url: &str,
        hooks: Arc<dyn AuthHooks>,
    ) -> Result<Self, AuthError> {
        let url = Url::parse(base_url).map_err(|_| AuthError::invalid())?;
        if secret.len() < 32
            || !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(AuthError::invalid());
        }
        Ok(Self(Arc::new(Inner {
            pool,
            secret,
            base_url: url,
            hooks,
            password_slots: Arc::new(tokio::sync::Semaphore::new(4)),
            social_providers: Vec::new(),
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("Datix")
                .build()
                .map_err(|_| AuthError::unavailable())?,
        })))
    }

    /// Configure providers before mounting the router. Existing clones are unchanged.
    pub fn with_social_providers(mut self, providers: Vec<SocialProvider>) -> Self {
        Arc::make_mut(&mut self.0).social_providers = providers;
        self
    }

    pub fn social_provider_ids(&self) -> Vec<&str> {
        self.0.social_providers.iter().map(|p| p.id()).collect()
    }

    pub fn api(&self) -> AuthApi<'_> {
        AuthApi(self)
    }

    pub fn router(&self) -> axum::Router {
        http::router(self.clone())
    }

    pub fn callback_url(&self, value: Option<&str>) -> Result<String, AuthError> {
        let url = self
            .0
            .base_url
            .join(value.unwrap_or("/"))
            .map_err(|_| AuthError::invalid())?;
        if url.origin() != self.0.base_url.origin()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(AuthError::new(
                axum::http::StatusCode::FORBIDDEN,
                "INVALID_CALLBACK_URL",
                "Use the application origin for redirects.",
            ));
        }
        Ok(url.to_string())
    }
}

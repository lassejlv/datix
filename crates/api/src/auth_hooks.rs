use crate::config::Config;
use datix_auth::{AuthError, AuthHooks, HookFuture, User};
use std::sync::Arc;

pub struct Hooks {
    pub billing: crate::billing::Billing,
    pub config: Arc<Config>,
    pub mailer: Option<Arc<crate::email::Mailer>>,
}

impl AuthHooks for Hooks {
    fn send_verification<'a>(&'a self, user: &'a User, url: &'a str) -> HookFuture<'a> {
        Box::pin(async move {
            if !self.config.external_effects {
                return Err(crate::email::delivery_failed());
            }
            self.mailer
                .as_ref()
                .ok_or_else(crate::email::delivery_failed)?
                .send_verification(user, url)
                .await
        })
    }
    fn before_delete<'a>(&'a self, user: &'a User) -> HookFuture<'a> {
        Box::pin(async move {
            self.billing
                .ensure_deletable(&user.id)
                .await
                .map_err(|error| AuthError::new(error.status, error.code, error.message))
        })
    }
}

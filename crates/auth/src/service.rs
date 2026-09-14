use axum::http::{HeaderMap, StatusCode};
use chrono::{Duration, Utc};
use sqlx::PgConnection;

use crate::{
    Auth, AuthError, EmailCredentials, PasswordChange, Session, SessionData, User,
    VerificationRequest, crypto,
    model::{SESSION_COLUMNS, USER_COLUMNS},
};

/// Server-side authentication operations independent of the HTTP router.
pub struct AuthApi<'a>(pub(crate) &'a Auth);

pub(crate) fn cookie_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all("cookie")
        .iter()
        .filter_map(|h| h.to_str().ok())
        .flat_map(|h| h.split(';'))
        .filter_map(|cookie| cookie.trim().split_once('='))
        .find_map(|(key, value)| (key == name).then_some(value))
}

pub(crate) fn valid_password(password: &str) -> Result<(), AuthError> {
    // JavaScript validates UTF-16 length, which differs from UTF-8 bytes for non-ASCII input.
    match password.encode_utf16().count() {
        0..8 => Err(AuthError::new(
            StatusCode::BAD_REQUEST,
            "PASSWORD_TOO_SHORT",
            "Password must be at least 8 characters.",
        )),
        129.. => Err(AuthError::new(
            StatusCode::BAD_REQUEST,
            "PASSWORD_TOO_LONG",
            "Password must be at most 128 characters.",
        )),
        _ => Ok(()),
    }
}

pub(crate) fn normalize_email(email: &str) -> Result<String, AuthError> {
    let email = email.to_lowercase();
    if email.len() > 254
        || email.chars().any(char::is_whitespace)
        || email.matches('@').count() != 1
    {
        return Err(AuthError::invalid());
    }
    let (local, domain) = email.split_once('@').ok_or_else(AuthError::invalid)?;
    if local.is_empty() || !domain.contains('.') || domain.starts_with('.') || domain.ends_with('.')
    {
        return Err(AuthError::invalid());
    }
    Ok(email)
}

pub(crate) async fn user_by_id(
    connection: &mut PgConnection,
    id: &str,
) -> Result<Option<User>, AuthError> {
    Ok(sqlx::query_as(&format!(
        "SELECT {USER_COLUMNS} FROM public.\"user\" WHERE id=$1"
    ))
    .bind(id)
    .fetch_optional(connection)
    .await?)
}

impl AuthApi<'_> {
    pub fn session_token(&self, headers: &HeaderMap) -> Option<String> {
        cookie_value(headers, &self.0.cookie_name("session_token"))
            .and_then(|v| crypto::verify_cookie(&self.0.0.secret, v))
    }

    pub async fn get_session(&self, headers: &HeaderMap) -> Result<Option<SessionData>, AuthError> {
        let Some(token) = self.session_token(headers) else {
            return Ok(None);
        };
        let mut connection = self.0.0.pool.acquire().await?;
        let session: Option<Session> = sqlx::query_as(&format!(
            "SELECT {SESSION_COLUMNS} FROM public.session WHERE token=$1 AND expires_at>now()"
        ))
        .bind(&token)
        .fetch_optional(&mut *connection)
        .await?;
        let Some(mut session) = session else {
            return Ok(None);
        };
        let Some(user) = user_by_id(&mut connection, &session.user_id).await? else {
            return Ok(None);
        };
        let suspended: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM user_suspensions WHERE user_id=$1)")
                .bind(&user.id)
                .fetch_one(&mut *connection)
                .await?;
        if suspended {
            return Err(AuthError::new(
                StatusCode::FORBIDDEN,
                "account_suspended",
                "Account suspended.",
            ));
        }
        let remember = cookie_value(headers, &self.0.cookie_name("dont_remember"))
            .and_then(|v| crypto::verify_cookie(&self.0.0.secret, v))
            .is_none();
        if remember && session.updated_at < Utc::now() - Duration::days(1) {
            let updated = sqlx::query_as(&format!("UPDATE public.session SET updated_at=now(),expires_at=now()+interval '7 days' WHERE id=$1 AND expires_at>now() RETURNING {SESSION_COLUMNS}"))
                .bind(&session.id).fetch_optional(&mut *connection).await?;
            let Some(updated) = updated else {
                return Ok(None);
            };
            session = updated;
        }
        Ok(Some(SessionData { session, user }))
    }

    pub async fn require_session(&self, headers: &HeaderMap) -> Result<SessionData, AuthError> {
        let session = self
            .get_session(headers)
            .await?
            .ok_or_else(AuthError::unauthorized)?;
        if !session.user.email_verified {
            return Err(AuthError::new(
                StatusCode::FORBIDDEN,
                "email_not_verified",
                "Verify your email address before using your account.",
            ));
        }
        Ok(session)
    }

    pub async fn sign_up_email(&self, input: EmailCredentials) -> Result<User, AuthError> {
        if !input.accept_terms {
            return Err(AuthError::terms_not_accepted());
        }
        let email = normalize_email(&input.email)?;
        valid_password(&input.password)?;
        let name = input
            .name
            .filter(|n| !n.trim().is_empty() && n.encode_utf16().count() <= 80)
            .ok_or_else(AuthError::invalid)?;
        let callback = self.0.callback_url(input.callback_url.as_deref())?;
        let _permit = self
            .0
            .0
            .password_slots
            .acquire()
            .await
            .map_err(|_| AuthError::unavailable())?;
        let hash = crypto::hash_password(input.password).await?;
        let mut tx = self.0.0.pool.begin().await?;
        let id = uuid::Uuid::new_v4().simple().to_string();
        let inserted: Option<User> = sqlx::query_as(&format!("INSERT INTO public.\"user\"(id,name,email,email_verified,created_at,updated_at) VALUES($1,$2,$3,false,now(),now()) ON CONFLICT(email) DO NOTHING RETURNING {USER_COLUMNS}"))
            .bind(&id).bind(&name).bind(&email).fetch_optional(&mut *tx).await?;
        let Some(user) = inserted else {
            tx.rollback().await?;
            return Ok(User {
                id,
                name,
                email,
                email_verified: false,
                image: None,
                created_at: Utc::now(),
                updated_at: Utc::now(),
            });
        };
        sqlx::query("INSERT INTO account(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES($1,$2,'credential',$2,$3,now(),now())")
            .bind(uuid::Uuid::new_v4().simple().to_string()).bind(&id).bind(hash).execute(&mut *tx).await?;
        tx.commit().await?;
        // Persist before delivery so a provider failure can recover through resend.
        self.send_verification(&user, &callback).await?;
        Ok(user)
    }

    pub async fn sign_in_email(
        &self,
        input: EmailCredentials,
        headers: &HeaderMap,
    ) -> Result<SessionData, AuthError> {
        let email = normalize_email(&input.email)?;
        if input.password.encode_utf16().count() > 128 {
            return Err(AuthError::credentials());
        }
        self.0.callback_url(input.callback_url.as_deref())?;
        let _permit = self
            .0
            .0
            .password_slots
            .acquire()
            .await
            .map_err(|_| AuthError::unavailable())?;
        let row: Option<(String,String)> = sqlx::query_as("SELECT a.user_id,a.password FROM account a JOIN public.\"user\" u ON u.id=a.user_id WHERE u.email=$1 AND a.provider_id='credential' AND a.password IS NOT NULL LIMIT 1")
            .bind(&email).fetch_optional(&self.0.0.pool).await?;
        let Some((id, hash)) = row else {
            crypto::hash_password(input.password).await?;
            return Err(AuthError::credentials());
        };
        if !crypto::verify_password(hash.clone(), input.password).await? {
            return Err(AuthError::credentials());
        }
        let mut tx = self.0.0.pool.begin().await?;
        sqlx::query("SELECT id FROM public.\"user\" WHERE id=$1 FOR UPDATE")
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        let current: Option<String> = sqlx::query_scalar(
            "SELECT password FROM account WHERE user_id=$1 AND provider_id='credential' LIMIT 1",
        )
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await?
        .flatten();
        if current.as_deref() != Some(hash.as_str()) {
            return Err(AuthError::credentials());
        }
        let user = user_by_id(&mut tx, &id)
            .await?
            .ok_or_else(AuthError::credentials)?;
        if !user.email_verified {
            tx.rollback().await?;
            let callback = self.0.callback_url(input.callback_url.as_deref())?;
            self.send_verification(&user, &callback).await?;
            return Err(AuthError::new(
                StatusCode::FORBIDDEN,
                "EMAIL_NOT_VERIFIED",
                "Email not verified.",
            ));
        }
        let session = self
            .create_session(&mut tx, &id, headers, input.remember_me != Some(false))
            .await?;
        tx.commit().await?;
        Ok(SessionData { session, user })
    }

    pub async fn send_verification_email(
        &self,
        input: VerificationRequest,
        headers: &HeaderMap,
    ) -> Result<(), AuthError> {
        let start = tokio::time::Instant::now();
        let email = normalize_email(&input.email)?;
        let callback = self.0.callback_url(input.callback_url.as_deref())?;
        if let Some(session) = self.get_session(headers).await? {
            if session.user.email != email {
                return Err(AuthError::new(
                    StatusCode::BAD_REQUEST,
                    "EMAIL_MISMATCH",
                    "Email does not match the session.",
                ));
            }
            if session.user.email_verified {
                return Err(AuthError::new(
                    StatusCode::BAD_REQUEST,
                    "EMAIL_ALREADY_VERIFIED",
                    "Email already verified.",
                ));
            }
        }
        let user: Option<User> = sqlx::query_as(&format!(
            "SELECT {USER_COLUMNS} FROM public.\"user\" WHERE email=$1"
        ))
        .bind(&email)
        .fetch_optional(&self.0.0.pool)
        .await?;
        let result = if let Some(user) = user.filter(|u| !u.email_verified) {
            self.send_verification(&user, &callback).await
        } else {
            Ok(())
        };
        tokio::time::sleep_until(start + std::time::Duration::from_millis(500)).await;
        result
    }

    pub(crate) async fn send_verification(
        &self,
        user: &User,
        callback: &str,
    ) -> Result<(), AuthError> {
        let token =
            crypto::verification_token(&self.0.0.secret, &user.email, Utc::now().timestamp())?;
        let mut url = self
            .0
            .0
            .base_url
            .join("/api/auth/verify-email")
            .map_err(|_| AuthError::invalid())?;
        url.query_pairs_mut()
            .append_pair("token", &token)
            .append_pair("callbackURL", callback);
        self.0.0.hooks.send_verification(user, url.as_str()).await
    }

    pub async fn verify_email(
        &self,
        token: &str,
        headers: &HeaderMap,
    ) -> Result<Option<SessionData>, AuthError> {
        let email = crypto::verify_email_token(&self.0.0.secret, token, Utc::now().timestamp())?;
        let mut tx = self.0.0.pool.begin().await?;
        let user: Option<User> = sqlx::query_as(&format!(
            "SELECT {USER_COLUMNS} FROM public.\"user\" WHERE email=$1 FOR UPDATE"
        ))
        .bind(email)
        .fetch_optional(&mut *tx)
        .await?;
        let mut user = user.ok_or_else(AuthError::token)?;
        if user.email_verified {
            return Ok(None);
        }
        sqlx::query("UPDATE public.\"user\" SET email_verified=true,updated_at=now() WHERE id=$1")
            .bind(&user.id)
            .execute(&mut *tx)
            .await?;
        user.email_verified = true;
        user.updated_at = Utc::now();
        let session = self
            .create_session(&mut tx, &user.id, headers, true)
            .await?;
        tx.commit().await?;
        Ok(Some(SessionData { session, user }))
    }

    pub async fn sign_out(&self, headers: &HeaderMap) -> Result<(), AuthError> {
        if let Some(token) = self.session_token(headers) {
            sqlx::query("DELETE FROM public.session WHERE token=$1")
                .bind(token)
                .execute(&self.0.0.pool)
                .await?;
        }
        Ok(())
    }

    pub async fn update_user(&self, headers: &HeaderMap, name: &str) -> Result<User, AuthError> {
        if name.trim().is_empty() || name.encode_utf16().count() > 80 {
            return Err(AuthError::invalid());
        }
        let session = self.require_session(headers).await?;
        Ok(sqlx::query_as(&format!("UPDATE public.\"user\" SET name=$1,updated_at=now() WHERE id=$2 RETURNING {USER_COLUMNS}"))
            .bind(name).bind(session.user.id).fetch_one(&self.0.0.pool).await?)
    }

    pub async fn change_password(
        &self,
        headers: &HeaderMap,
        input: PasswordChange,
    ) -> Result<SessionData, AuthError> {
        valid_password(&input.new_password)?;
        let session = self.require_session(headers).await?;
        let _permit = self
            .0
            .0
            .password_slots
            .acquire()
            .await
            .map_err(|_| AuthError::unavailable())?;
        let hash = self.password_hash(&session.user.id).await?;
        if input.current_password.encode_utf16().count() > 128
            || !crypto::verify_password(hash.clone(), input.current_password).await?
        {
            return Err(AuthError::credentials());
        }
        let new_hash = crypto::hash_password(input.new_password).await?;
        let mut tx = self.0.0.pool.begin().await?;
        sqlx::query("SELECT id FROM public.\"user\" WHERE id=$1 FOR UPDATE")
            .bind(&session.user.id)
            .execute(&mut *tx)
            .await?;
        let changed = sqlx::query("UPDATE account SET password=$1,updated_at=now() WHERE user_id=$2 AND provider_id='credential' AND password=$3")
            .bind(new_hash).bind(&session.user.id).bind(hash).execute(&mut *tx).await?;
        if changed.rows_affected() != 1 {
            return Err(AuthError::credentials());
        }
        if input.revoke_other_sessions {
            sqlx::query("DELETE FROM public.session WHERE user_id=$1")
                .bind(&session.user.id)
                .execute(&mut *tx)
                .await?;
            let new_session = self
                .create_session(&mut tx, &session.user.id, headers, true)
                .await?;
            tx.commit().await?;
            return Ok(SessionData {
                session: new_session,
                user: session.user,
            });
        }
        tx.commit().await?;
        Ok(session)
    }

    pub async fn delete_user(
        &self,
        headers: &HeaderMap,
        password: Option<&str>,
    ) -> Result<(), AuthError> {
        let session = self.require_session(headers).await?;
        let _permit = self
            .0
            .0
            .password_slots
            .acquire()
            .await
            .map_err(|_| AuthError::unavailable())?;
        let hash = if let Some(password) = password.filter(|p| !p.is_empty()) {
            let hash = self.password_hash(&session.user.id).await?;
            if password.encode_utf16().count() > 128
                || !crypto::verify_password(hash.clone(), password.into()).await?
            {
                return Err(AuthError::credentials());
            }
            Some(hash)
        } else {
            // Better Auth permits fresh social sessions to delete without a credential account.
            if session.session.created_at <= Utc::now() - Duration::days(1) {
                return Err(AuthError::new(
                    StatusCode::BAD_REQUEST,
                    "SESSION_EXPIRED",
                    "Sign in again before deleting your account.",
                ));
            }
            None
        };
        self.0.0.hooks.before_delete(&session.user).await?;
        let mut tx = self.0.0.pool.begin().await?;
        sqlx::query("SELECT id FROM public.\"user\" WHERE id=$1 FOR UPDATE")
            .bind(&session.user.id)
            .execute(&mut *tx)
            .await?;
        let valid_session: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM public.session WHERE id=$1 AND token=$2 AND expires_at>now())")
            .bind(&session.session.id).bind(&session.session.token).fetch_one(&mut *tx).await?;
        if !valid_session {
            return Err(AuthError::unauthorized());
        }
        if let Some(hash) = hash {
            let current: Option<String> = sqlx::query_scalar(
                "SELECT password FROM account WHERE user_id=$1 AND provider_id='credential' LIMIT 1",
            )
            .bind(&session.user.id)
            .fetch_optional(&mut *tx)
            .await?
            .flatten();
            if current.as_deref() != Some(hash.as_str()) {
                return Err(AuthError::credentials());
            }
        }
        sqlx::query("DELETE FROM public.\"user\" WHERE id=$1")
            .bind(&session.user.id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    async fn password_hash(&self, id: &str) -> Result<String, AuthError> {
        sqlx::query_scalar(
            "SELECT password FROM account WHERE user_id=$1 AND provider_id='credential' LIMIT 1",
        )
        .bind(id)
        .fetch_optional(&self.0.0.pool)
        .await?
        .flatten()
        .ok_or_else(AuthError::credentials)
    }

    pub(crate) async fn create_session(
        &self,
        connection: &mut PgConnection,
        id: &str,
        headers: &HeaderMap,
        remember: bool,
    ) -> Result<Session, AuthError> {
        let blocked: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM user_suspensions WHERE user_id=$1)")
                .bind(id)
                .fetch_one(&mut *connection)
                .await?;
        if blocked {
            return Err(AuthError::new(
                StatusCode::FORBIDDEN,
                "account_suspended",
                "Account suspended.",
            ));
        }
        Ok(sqlx::query_as(&format!("INSERT INTO public.session(id,user_id,token,expires_at,created_at,updated_at,ip_address,user_agent) VALUES($1,$2,$3,now()+$4*interval '1 second',now(),now(),$5,$6) RETURNING {SESSION_COLUMNS}"))
            .bind(uuid::Uuid::new_v4().simple().to_string()).bind(id).bind(crypto::random_token())
            .bind(if remember {604800f64} else {86400f64})
            .bind(headers.get("x-datix-client-ip").and_then(|v|v.to_str().ok()))
            .bind(headers.get("user-agent").and_then(|v|v.to_str().ok()).map(|v|v.chars().take(1024).collect::<String>()))
            .fetch_one(connection).await?)
    }

    pub(crate) async fn rate_limit(
        &self,
        key: &str,
        window: i64,
        max: i32,
    ) -> Result<(), AuthError> {
        let key = hex::encode(crypto::sign(&self.0.0.secret, key.as_bytes())?);
        let now = Utc::now().timestamp_millis();
        let count: i32 = sqlx::query_scalar("INSERT INTO rate_limit(id,key,count,last_request) VALUES($1,$2,1,$3) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limit.last_request<$4 THEN 1 ELSE rate_limit.count+1 END,last_request=CASE WHEN rate_limit.last_request<$4 THEN $3 ELSE rate_limit.last_request END RETURNING count")
            .bind(uuid::Uuid::new_v4().simple().to_string()).bind(key).bind(now).bind(now-window*1000).fetch_one(&self.0.0.pool).await?;
        if count > max {
            return Err(AuthError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "TOO_MANY_REQUESTS",
                "Too many requests. Try again later.",
            ));
        }
        Ok(())
    }
}

impl Auth {
    pub(crate) fn cookie_name(&self, suffix: &str) -> String {
        format!(
            "{}better-auth.{suffix}",
            if self.0.base_url.scheme() == "https" {
                "__Secure-"
            } else {
                ""
            }
        )
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::{AuthHooks, HookFuture};

    struct Hooks;

    impl AuthHooks for Hooks {
        fn send_verification<'a>(&'a self, _: &'a User, _: &'a str) -> HookFuture<'a> {
            Box::pin(async { Ok(()) })
        }

        fn before_delete<'a>(&'a self, _: &'a User) -> HookFuture<'a> {
            Box::pin(async { Ok(()) })
        }
    }

    #[tokio::test]
    async fn email_signup_fails_closed_without_terms_acceptance() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://fixture:fixture@localhost/fixture")
            .unwrap();
        let auth = Auth::new(
            pool,
            "fixture-secret-at-least-32-characters".into(),
            "http://localhost:3000",
            Arc::new(Hooks),
        )
        .unwrap();
        let input = serde_json::from_value(json!({
            "email":"person@example.test",
            "password":"long-enough-password",
            "name":"Person"
        }))
        .unwrap();

        let error = auth.api().sign_up_email(input).await.unwrap_err();

        assert_eq!(error.code, "TERMS_NOT_ACCEPTED");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
    }
}

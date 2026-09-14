use axum::http::{HeaderMap, StatusCode};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use url::Url;

use crate::{
    Auth, AuthApi, AuthError, SessionData, User, crypto,
    model::USER_COLUMNS,
    service::{cookie_value, normalize_email, user_by_id},
};

/// Supported OAuth providers. Endpoints are fixed, never supplied by an HTTP caller.
#[derive(Clone)]
pub struct SocialProvider {
    id: &'static str,
    client_id: String,
    client_secret: String,
    authorize: String,
    token: String,
    userinfo: String,
    emails: Option<String>,
}

impl SocialProvider {
    pub fn github(client_id: String, client_secret: String) -> Result<Self, AuthError> {
        Self::new("github", client_id, client_secret)
    }

    pub fn google(client_id: String, client_secret: String) -> Result<Self, AuthError> {
        Self::new("google", client_id, client_secret)
    }

    fn new(id: &'static str, client_id: String, client_secret: String) -> Result<Self, AuthError> {
        if client_id.trim().is_empty() || client_secret.trim().is_empty() {
            return Err(AuthError::invalid());
        }
        let (authorize, token, userinfo, emails) = if id == "github" {
            (
                "https://github.com/login/oauth/authorize",
                "https://github.com/login/oauth/access_token",
                "https://api.github.com/user",
                Some("https://api.github.com/user/emails".into()),
            )
        } else {
            (
                "https://accounts.google.com/o/oauth2/v2/auth",
                "https://oauth2.googleapis.com/token",
                "https://openidconnect.googleapis.com/v1/userinfo",
                None,
            )
        };
        Ok(Self {
            id,
            client_id,
            client_secret,
            authorize: authorize.into(),
            token: token.into(),
            userinfo: userinfo.into(),
            emails,
        })
    }

    pub fn id(&self) -> &str {
        self.id
    }

    fn scope(&self) -> &str {
        if self.id == "github" {
            "read:user user:email"
        } else {
            "openid email profile"
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocialSignIn {
    pub provider: String,
    #[serde(rename = "callbackURL")]
    pub callback_url: Option<String>,
    #[serde(rename = "errorCallbackURL")]
    pub error_callback_url: Option<String>,
    #[serde(rename = "newUserCallbackURL")]
    pub new_user_callback_url: Option<String>,
    #[serde(default)]
    pub disable_redirect: bool,
}

pub struct SocialAuthorization {
    pub url: String,
    pub(crate) state_cookie: String,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct OAuthState {
    provider: String,
    callback: String,
    pub(crate) error_callback: String,
    new_user_callback: String,
    verifier: String,
}

#[derive(Deserialize)]
struct Tokens {
    access_token: String,
    token_type: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    expires_in: Option<i64>,
    refresh_token_expires_in: Option<i64>,
    scope: Option<String>,
}

struct Profile {
    id: String,
    email: String,
    verified: bool,
    name: String,
    image: Option<String>,
}

#[derive(Deserialize)]
struct GithubUser {
    id: u64,
    login: String,
    name: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct GithubEmail {
    email: String,
    primary: bool,
    verified: bool,
}

#[derive(Deserialize)]
struct GoogleUser {
    sub: String,
    email: String,
    #[serde(default)]
    email_verified: bool,
    name: Option<String>,
    picture: Option<String>,
}

fn oauth_error(code: &'static str) -> AuthError {
    AuthError::new(
        StatusCode::BAD_REQUEST,
        code,
        "Social sign-in failed. Please try again.",
    )
}

async fn provider_json<T: DeserializeOwned>(
    request: reqwest::RequestBuilder,
) -> Result<T, AuthError> {
    let mut response = request
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|_| AuthError::unavailable())?;
    if !response.status().is_success() {
        return Err(oauth_error("oauth_provider_error"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| AuthError::unavailable())?
    {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err(oauth_error("oauth_provider_error"));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| oauth_error("oauth_provider_error"))
}

impl Auth {
    fn provider(&self, id: &str) -> Result<&SocialProvider, AuthError> {
        self.0
            .social_providers
            .iter()
            .find(|p| p.id == id)
            .ok_or_else(|| oauth_error("PROVIDER_NOT_FOUND"))
    }

    fn oauth_redirect(&self, provider: &str) -> Result<String, AuthError> {
        self.callback_url(Some(&format!("/api/auth/callback/{provider}")))
    }
}

impl AuthApi<'_> {
    pub async fn sign_in_social(
        &self,
        input: SocialSignIn,
    ) -> Result<SocialAuthorization, AuthError> {
        let provider = self.0.provider(&input.provider)?;
        let callback = self.0.callback_url(input.callback_url.as_deref())?;
        let state = crypto::random_token();
        let data = OAuthState {
            provider: provider.id.into(),
            new_user_callback: self
                .0
                .callback_url(input.new_user_callback_url.as_deref().or(Some(&callback)))?,
            callback,
            error_callback: self.0.callback_url(
                input
                    .error_callback_url
                    .as_deref()
                    .or(Some("/signin?oauth=failed")),
            )?,
            verifier: crypto::random_token(),
        };
        let mut url = Url::parse(&provider.authorize).map_err(|_| AuthError::unavailable())?;
        url.query_pairs_mut()
            .append_pair("client_id", &provider.client_id)
            .append_pair("redirect_uri", &self.0.oauth_redirect(provider.id)?)
            .append_pair("response_type", "code")
            .append_pair("scope", provider.scope())
            .append_pair("state", &state)
            .append_pair(
                "code_challenge",
                &URL_SAFE_NO_PAD.encode(Sha256::digest(data.verifier.as_bytes())),
            )
            .append_pair("code_challenge_method", "S256");
        let id = format!(
            "datix-oauth-{}",
            hex::encode(Sha256::digest(state.as_bytes()))
        );
        sqlx::query("INSERT INTO verification(id,identifier,value,expires_at,created_at,updated_at) VALUES($1,$2,$3,now()+interval '10 minutes',now(),now())")
            .bind(id).bind(format!("datix-oauth:{}", provider.id))
            .bind(serde_json::to_string(&data).map_err(|_| AuthError::unavailable())?)
            .execute(&self.0.0.pool).await?;
        Ok(SocialAuthorization {
            url: url.into(),
            state_cookie: crypto::signed_cookie(&self.0.0.secret, &state)?,
        })
    }

    pub(crate) async fn consume_oauth_state(
        &self,
        provider: &str,
        state: &str,
        headers: &HeaderMap,
    ) -> Result<OAuthState, AuthError> {
        self.0.provider(provider)?;
        if state.len() != 64 || !state.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(oauth_error("invalid_state"));
        }
        let cookie = cookie_value(headers, &self.0.cookie_name("oauth_state"))
            .and_then(|v| crypto::verify_cookie(&self.0.0.secret, v))
            .ok_or_else(|| oauth_error("invalid_state"))?;
        if !bool::from(cookie.as_bytes().ct_eq(state.as_bytes())) {
            return Err(oauth_error("invalid_state"));
        }
        // DELETE RETURNING makes callbacks one-shot across every API instance.
        let value: Option<String> = sqlx::query_scalar("DELETE FROM verification WHERE id=$1 AND identifier=$2 AND expires_at>now() RETURNING value")
            .bind(format!("datix-oauth-{}", hex::encode(Sha256::digest(state.as_bytes()))))
            .bind(format!("datix-oauth:{provider}")).fetch_optional(&self.0.0.pool).await?;
        let data: OAuthState =
            serde_json::from_str(&value.ok_or_else(|| oauth_error("invalid_state"))?)
                .map_err(|_| oauth_error("invalid_state"))?;
        if data.provider != provider {
            return Err(oauth_error("invalid_state"));
        }
        Ok(data)
    }

    pub(crate) async fn finish_social_sign_in(
        &self,
        state: &OAuthState,
        code: &str,
        headers: &HeaderMap,
    ) -> Result<(SessionData, String), AuthError> {
        if code.is_empty() || code.len() > 8192 {
            return Err(oauth_error("invalid_code"));
        }
        let provider = self.0.provider(&state.provider)?;
        let tokens: Tokens = provider_json(self.0.0.client.post(&provider.token).form(&[
            ("client_id", provider.client_id.as_str()),
            ("client_secret", provider.client_secret.as_str()),
            ("code", code),
            ("redirect_uri", &self.0.oauth_redirect(provider.id)?),
            ("grant_type", "authorization_code"),
            ("code_verifier", &state.verifier),
        ]))
        .await?;
        if tokens.access_token.is_empty() || !tokens.token_type.eq_ignore_ascii_case("bearer") {
            return Err(oauth_error("oauth_provider_error"));
        }
        let profile = self
            .provider_profile(provider, &tokens.access_token)
            .await?;
        let (user, new_user) = self.link_social_account(provider, profile, &tokens).await?;
        let callback = if new_user {
            &state.new_user_callback
        } else {
            &state.callback
        };
        if !user.email_verified {
            self.send_verification(&user, callback).await?;
            return Err(oauth_error("email_not_verified"));
        }
        let mut tx = self.0.0.pool.begin().await?;
        sqlx::query("SELECT id FROM public.\"user\" WHERE id=$1 FOR UPDATE")
            .bind(&user.id)
            .execute(&mut *tx)
            .await?;
        let session = self
            .create_session(&mut tx, &user.id, headers, true)
            .await?;
        tx.commit().await?;
        Ok((SessionData { session, user }, callback.clone()))
    }

    async fn provider_profile(
        &self,
        provider: &SocialProvider,
        token: &str,
    ) -> Result<Profile, AuthError> {
        let request = self.0.0.client.get(&provider.userinfo).bearer_auth(token);
        let mut profile = if let Some(emails_url) = &provider.emails {
            let user: GithubUser = provider_json(request).await?;
            let emails: Vec<GithubEmail> =
                provider_json(self.0.0.client.get(emails_url).bearer_auth(token)).await?;
            let email = emails
                .iter()
                .find(|e| e.primary && e.verified)
                .or_else(|| emails.iter().find(|e| e.verified))
                .or_else(|| emails.iter().find(|e| e.primary))
                .ok_or_else(|| oauth_error("email_not_found"))?;
            Profile {
                id: user.id.to_string(),
                email: email.email.clone(),
                verified: email.verified,
                name: user.name.filter(|n| !n.is_empty()).unwrap_or(user.login),
                image: user.avatar_url,
            }
        } else {
            // Identity is obtained over the authenticated provider connection; never decode an
            // unverified ID-token payload or accept a token supplied by the browser as identity.
            let user: GoogleUser = provider_json(request).await?;
            Profile {
                id: user.sub,
                name: user.name.unwrap_or_else(|| user.email.clone()),
                email: user.email,
                verified: user.email_verified,
                image: user.picture,
            }
        };
        if profile.id.is_empty() || profile.id.len() > 255 {
            return Err(oauth_error("oauth_provider_error"));
        }
        profile.email = normalize_email(&profile.email)?;
        profile.name = profile.name.chars().take(256).collect();
        profile.image = profile
            .image
            .filter(|v| v.len() <= 4096 && Url::parse(v).is_ok_and(|u| u.scheme() == "https"));
        Ok(profile)
    }

    async fn link_social_account(
        &self,
        provider: &SocialProvider,
        profile: Profile,
        tokens: &Tokens,
    ) -> Result<(User, bool), AuthError> {
        let mut tx = self.0.0.pool.begin().await?;
        // The inherited schema has no provider/account unique constraint. Serialize both
        // identities in stable order so simultaneous callbacks cannot create duplicate links.
        let mut keys = [
            format!("oauth:{}:{}", provider.id, profile.id),
            format!("oauth-email:{}", profile.email),
        ];
        keys.sort();
        for key in keys {
            sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 917421))")
                .bind(key)
                .execute(&mut *tx)
                .await?;
        }
        let accounts: Vec<(String, String)> = sqlx::query_as(
            "SELECT id,user_id FROM account WHERE provider_id=$1 AND account_id=$2 LIMIT 2",
        )
        .bind(provider.id)
        .bind(&profile.id)
        .fetch_all(&mut *tx)
        .await?;
        if accounts.len() > 1 {
            return Err(oauth_error("account_not_linked"));
        }
        let mut account_id = None;
        let existing: Option<User> = if let Some((id, owner)) = accounts.first() {
            account_id = Some(id.clone());
            sqlx::query_as(&format!(
                "SELECT {USER_COLUMNS} FROM public.\"user\" WHERE id=$1 FOR UPDATE"
            ))
            .bind(owner)
            .fetch_optional(&mut *tx)
            .await?
        } else {
            sqlx::query_as(&format!(
                "SELECT {USER_COLUMNS} FROM public.\"user\" WHERE email=$1 FOR UPDATE"
            ))
            .bind(&profile.email)
            .fetch_optional(&mut *tx)
            .await?
        };
        if account_id.is_some() && existing.is_none() {
            return Err(oauth_error("account_not_linked"));
        }
        let new_user = existing.is_none();
        let user = if let Some(mut user) = existing {
            // Better Auth's default requires both the existing local address and the provider
            // address to be verified before implicit email-based linking (pre-hijack defense).
            if account_id.is_none() && (!user.email_verified || !profile.verified) {
                return Err(oauth_error("account_not_linked"));
            }
            if !user.email_verified && profile.verified && user.email == profile.email {
                sqlx::query(
                    "UPDATE public.\"user\" SET email_verified=true,updated_at=now() WHERE id=$1",
                )
                .bind(&user.id)
                .execute(&mut *tx)
                .await?;
                user.email_verified = true;
                user.updated_at = Utc::now();
            }
            user
        } else {
            let id = uuid::Uuid::new_v4().simple().to_string();
            // A concurrent email signup is handled by the unique email constraint. Retrying
            // the flow will then apply the local-email verification rule above.
            sqlx::query_as(&format!("INSERT INTO public.\"user\"(id,name,email,email_verified,image,created_at,updated_at) VALUES($1,$2,$3,$4,$5,now(),now()) ON CONFLICT(email) DO NOTHING RETURNING {USER_COLUMNS}"))
                .bind(id).bind(profile.name).bind(profile.email).bind(profile.verified).bind(profile.image)
                .fetch_optional(&mut *tx).await?.ok_or_else(|| oauth_error("account_not_linked"))?
        };
        let expires = token_expiry(tokens.expires_in)?;
        let refresh_expires = token_expiry(tokens.refresh_token_expires_in)?;
        if let Some(id) = account_id {
            sqlx::query("UPDATE account SET access_token=$1,refresh_token=COALESCE($2,refresh_token),id_token=COALESCE($3,id_token),access_token_expires_at=$4,refresh_token_expires_at=COALESCE($5,refresh_token_expires_at),updated_at=now() WHERE id=$6")
                .bind(&tokens.access_token).bind(&tokens.refresh_token).bind(&tokens.id_token)
                .bind(expires).bind(refresh_expires).bind(id).execute(&mut *tx).await?;
        } else {
            sqlx::query("INSERT INTO account(id,account_id,provider_id,user_id,access_token,refresh_token,id_token,access_token_expires_at,refresh_token_expires_at,scope,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now())")
                .bind(uuid::Uuid::new_v4().simple().to_string()).bind(profile.id).bind(provider.id).bind(&user.id)
                .bind(&tokens.access_token).bind(&tokens.refresh_token).bind(&tokens.id_token)
                .bind(expires).bind(refresh_expires).bind(tokens.scope.as_deref().unwrap_or(provider.scope()))
                .execute(&mut *tx).await?;
        }
        let user = user_by_id(&mut tx, &user.id)
            .await?
            .ok_or_else(AuthError::unavailable)?;
        tx.commit().await?;
        Ok((user, new_user))
    }
}

fn token_expiry(seconds: Option<i64>) -> Result<Option<DateTime<Utc>>, AuthError> {
    seconds
        .map(|seconds| {
            if !(1..=315_576_000).contains(&seconds) {
                return Err(oauth_error("oauth_provider_error"));
            }
            Ok(Utc::now() + Duration::seconds(seconds))
        })
        .transpose()
}

#[cfg(test)]
mod tests;

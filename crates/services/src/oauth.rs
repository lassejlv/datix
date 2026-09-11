//! Provider-agnostic OAuth sign-in. Each provider maps an id to endpoints plus a
//! profile parser; credentials come from [`analytics_core::config::OAuthClient`],
//! and a provider is live only when its id and secret are both configured.
//! To add a provider: extend [`Provider`], wire its env keys in core config,
//! and add its profile parser below alongside a frontend icon entry.
use crate::auth::{self, Reply};
use analytics_core::{Error, Result, State, config::OAuthClient, models::User, validation};
use axum::http::HeaderMap;
use serde_json::Value;
use uuid::Uuid;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Provider {
    Github,
    Google,
}
impl Provider {
    pub fn all() -> [Self; 2] {
        [Self::Github, Self::Google]
    }
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "github" => Some(Self::Github),
            "google" => Some(Self::Google),
            _ => None,
        }
    }
    pub fn id(self) -> &'static str {
        match self {
            Self::Github => "github",
            Self::Google => "google",
        }
    }
    fn authorize_url(self) -> &'static str {
        match self {
            Self::Github => "https://github.com/login/oauth/authorize",
            Self::Google => "https://accounts.google.com/o/oauth2/v2/auth",
        }
    }
    fn token_url(self) -> &'static str {
        match self {
            Self::Github => "https://github.com/login/oauth/access_token",
            Self::Google => "https://oauth2.googleapis.com/token",
        }
    }
    fn scope(self) -> &'static str {
        match self {
            Self::Github => "read:user user:email",
            Self::Google => "openid email profile",
        }
    }
}

/// Ids of providers that have both a client id and a secret configured.
pub fn enabled(state: &State) -> Vec<&str> {
    Provider::all()
        .iter()
        .filter(|p| state.config.oauth.iter().any(|c| c.provider == p.id()))
        .map(|p| p.id())
        .collect()
}
fn client(state: &State, provider: Provider) -> Option<&OAuthClient> {
    state
        .config
        .oauth
        .iter()
        .find(|c| c.provider == provider.id())
}
fn redirect_uri(state: &State, provider: Provider) -> String {
    format!(
        "{}/api/auth/callback/{}",
        state.config.app_url.as_str().trim_end_matches('/'),
        provider.id()
    )
}
fn authorize_url(
    provider: Provider,
    client_id: &str,
    redirect_uri: &str,
    state_token: &str,
) -> String {
    let mut url = url::Url::parse(provider.authorize_url()).expect("constant provider URL");
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", provider.scope())
        .append_pair("state", state_token);
    if provider == Provider::Google {
        url.query_pairs_mut().append_pair("response_type", "code");
    }
    url.into()
}
fn state_key(state_token: &str) -> String {
    format!("analytics:oauth:{state_token}")
}
fn valid_state_token(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Start an OAuth flow. Returns the provider authorize URL, or 404 when the
/// provider id is unknown or its credentials are not configured.
pub async fn begin(state: &State, provider_id: &str) -> Result<String> {
    let provider = Provider::from_id(provider_id)
        .ok_or_else(|| Error::new(404, "not_found", "Endpoint not found."))?;
    let credentials = client(state, provider)
        .ok_or_else(|| Error::new(404, "not_found", "Endpoint not found."))?;
    let state_token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let mut conn = state.redis.clone();
    redis::cmd("SET")
        .arg(state_key(&state_token))
        .arg(provider.id())
        .arg("EX")
        .arg(600)
        .query_async::<()>(&mut conn)
        .await?;
    Ok(authorize_url(
        provider,
        &credentials.client_id,
        &redirect_uri(state, provider),
        &state_token,
    ))
}
fn query_value(query: &str, key: &str) -> Option<String> {
    url::form_urlencoded::parse(query.as_bytes())
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
}
fn failed_redirect() -> Reply {
    Reply {
        body: Value::Null,
        cookies: vec![],
        redirect: Some("/signin?oauth=failed".into()),
    }
}
/// Complete an OAuth flow. Every outcome is a redirect: dashboard with a fresh
/// session on success, sign-in with a generic flag otherwise. Failures never
/// leak which step or provider detail went wrong.
pub async fn callback(
    state: &State,
    provider_id: &str,
    query: &str,
    headers: &HeaderMap,
    ip: &str,
) -> Result<Reply> {
    match complete(state, provider_id, query, headers, ip).await {
        Ok(reply) => Ok(reply),
        Err(error) => {
            tracing::warn!(
                provider = provider_id,
                code = error.code,
                "oauth callback failed"
            );
            Ok(failed_redirect())
        }
    }
}
async fn complete(
    state: &State,
    provider_id: &str,
    query: &str,
    headers: &HeaderMap,
    ip: &str,
) -> Result<Reply> {
    let failed = || Error::new(400, "oauth_failed", "OAuth sign-in failed.");
    let provider = Provider::from_id(provider_id).ok_or_else(failed)?;
    let credentials = client(state, provider).ok_or_else(failed)?;
    if query_value(query, "error").is_some() {
        return Err(failed());
    }
    let code = query_value(query, "code")
        .filter(|v| !v.is_empty())
        .ok_or_else(failed)?;
    let state_token = query_value(query, "state")
        .filter(|v| valid_state_token(v))
        .ok_or_else(failed)?;
    let mut conn = state.redis.clone();
    let stored: Option<String> = redis::cmd("GETDEL")
        .arg(state_key(&state_token))
        .query_async(&mut conn)
        .await?;
    if stored.as_deref() != Some(provider.id()) {
        return Err(failed());
    }
    let tokens = exchange(state, provider, credentials, &code).await?;
    let profile = profile(state, provider, tokens.access.as_deref()).await?;
    let email = valid_email(&profile.email).ok_or_else(failed)?;
    let name = display_name(&profile.name, &email);
    let mut tx = state.db.begin().await?;
    let user = link_or_create(&mut tx, provider, &profile, &tokens, &email, &name).await?;
    let session = auth::new_session(&mut tx, &user.id, ip, headers, true).await?;
    tx.commit().await?;
    Ok(Reply {
        body: Value::Null,
        cookies: vec![
            auth::cookie(state, &session.token, true),
            auth::remember_cookie(state, true),
        ],
        redirect: Some("/dashboard".into()),
    })
}
async fn link_or_create(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    provider: Provider,
    profile: &Profile,
    tokens: &Tokens,
    email: &str,
    name: &str,
) -> Result<User> {
    let failed = || Error::new(400, "oauth_failed", "OAuth sign-in failed.");
    if let Some(user_id) = linked_user(tx, provider, &profile.id).await? {
        sqlx::query("UPDATE account SET access_token=$1,refresh_token=$2,id_token=$3,scope=$4,updated_at=now() AT TIME ZONE 'UTC' WHERE provider_id=$5 AND account_id=$6")
            .bind(&tokens.access).bind(&tokens.refresh).bind(&tokens.id).bind(provider.scope()).bind(provider.id()).bind(&profile.id).execute(&mut **tx).await?;
        return sqlx::query_as::<_, User>("SELECT * FROM \"user\" WHERE id=$1")
            .bind(&user_id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(failed);
    }
    if let Some(user) =
        sqlx::query_as::<_, User>("SELECT * FROM \"user\" WHERE email=$1 FOR UPDATE")
            .bind(email)
            .fetch_optional(&mut **tx)
            .await?
    {
        link(tx, provider, profile, tokens, &user.id).await?;
        mark_verified(tx, &user.id).await?;
        return Ok(user);
    }
    let now = chrono::Utc::now().naive_utc();
    let id = Uuid::new_v4().simple().to_string();
    let created = sqlx::query_as::<_, User>("INSERT INTO \"user\"(id,name,email,email_verified,image,created_at,updated_at) VALUES($1,$2,$3,true,$4,$5,$5) ON CONFLICT(email) DO NOTHING RETURNING *")
        .bind(&id).bind(name).bind(email).bind(&profile.image).bind(now).fetch_optional(&mut **tx).await?;
    if let Some(user) = created {
        link(tx, provider, profile, tokens, &user.id).await?;
        return Ok(user);
    }
    // Lost a signup race; fall back to linking the winning row.
    let user = sqlx::query_as::<_, User>("SELECT * FROM \"user\" WHERE email=$1 FOR UPDATE")
        .bind(email)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(failed)?;
    link(tx, provider, profile, tokens, &user.id).await?;
    mark_verified(tx, &user.id).await?;
    Ok(user)
}
async fn linked_user(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    provider: Provider,
    account_id: &str,
) -> Result<Option<String>> {
    Ok(
        sqlx::query_scalar("SELECT user_id FROM account WHERE provider_id=$1 AND account_id=$2")
            .bind(provider.id())
            .bind(account_id)
            .fetch_optional(&mut **tx)
            .await?,
    )
}
async fn mark_verified(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: &str,
) -> Result<()> {
    sqlx::query(
        "UPDATE \"user\" SET email_verified=true,updated_at=now() AT TIME ZONE 'UTC' WHERE id=$1",
    )
    .bind(user_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
async fn link(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    provider: Provider,
    profile: &Profile,
    tokens: &Tokens,
    user_id: &str,
) -> Result<()> {
    if linked_user(tx, provider, &profile.id).await?.is_some() {
        return Ok(());
    }
    let now = chrono::Utc::now().naive_utc();
    sqlx::query("INSERT INTO account(id,account_id,provider_id,user_id,access_token,refresh_token,id_token,scope,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)")
        .bind(Uuid::new_v4().simple().to_string()).bind(&profile.id).bind(provider.id()).bind(user_id).bind(&tokens.access).bind(&tokens.refresh).bind(&tokens.id).bind(provider.scope()).bind(now).execute(&mut **tx).await?;
    Ok(())
}
struct Tokens {
    access: Option<String>,
    refresh: Option<String>,
    id: Option<String>,
}
fn token_params<'a>(
    provider: Provider,
    client_id: &'a str,
    client_secret: &'a str,
    code: &'a str,
    redirect_uri: &'a str,
) -> Vec<(&'static str, &'a str)> {
    let mut params = vec![
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("code", code),
        ("redirect_uri", redirect_uri),
    ];
    // RFC 6749 requires grant_type; GitHub's endpoint does not take it.
    if provider == Provider::Google {
        params.push(("grant_type", "authorization_code"));
    }
    params
}
async fn exchange(
    state: &State,
    provider: Provider,
    credentials: &OAuthClient,
    code: &str,
) -> Result<Tokens> {
    let failed = || Error::new(502, "oauth_exchange_failed", "OAuth sign-in failed.");
    let redirect = redirect_uri(state, provider);
    let response = state
        .http
        .post(provider.token_url())
        .header("Accept", "application/json")
        .form(&token_params(
            provider,
            &credentials.client_id,
            &credentials.client_secret,
            code,
            &redirect,
        ))
        .send()
        .await
        .map_err(|_| failed())?;
    if !response.status().is_success() {
        return Err(failed());
    }
    let body: Value = response.json().await.map_err(|_| failed())?;
    if body.get("error").is_some() {
        return Err(failed());
    }
    Ok(Tokens {
        access: body["access_token"].as_str().map(str::to_string),
        refresh: body["refresh_token"].as_str().map(str::to_string),
        id: body["id_token"].as_str().map(str::to_string),
    })
}
struct Profile {
    id: String,
    email: String,
    name: String,
    image: Option<String>,
}
async fn profile(state: &State, provider: Provider, access: Option<&str>) -> Result<Profile> {
    let failed = || Error::new(502, "oauth_profile_failed", "OAuth sign-in failed.");
    let access = access.ok_or_else(failed)?;
    let get = |url: &str| {
        state
            .http
            .get(url)
            .bearer_auth(access)
            .header("Accept", "application/json")
            .header("User-Agent", "datix")
            .send()
    };
    match provider {
        Provider::Github => {
            let user: Value = get("https://api.github.com/user")
                .await
                .map_err(|_| failed())?
                .json()
                .await
                .map_err(|_| failed())?;
            let emails: Value = get("https://api.github.com/user/emails")
                .await
                .map_err(|_| failed())?
                .json()
                .await
                .map_err(|_| failed())?;
            github_profile(&user, &emails).ok_or_else(failed)
        }
        Provider::Google => {
            let info: Value = get("https://openidconnect.googleapis.com/v1/userinfo")
                .await
                .map_err(|_| failed())?
                .json()
                .await
                .map_err(|_| failed())?;
            google_profile(&info).ok_or_else(failed)
        }
    }
}
fn github_profile(user: &Value, emails: &Value) -> Option<Profile> {
    let id = match &user["id"] {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        _ => return None,
    };
    let email = emails
        .as_array()?
        .iter()
        .find(|e| e["primary"] == true && e["verified"] == true)?
        .get("email")?
        .as_str()?
        .to_string();
    Some(Profile {
        id,
        email,
        name: user["name"].as_str().unwrap_or("").to_string(),
        image: user["avatar_url"].as_str().map(str::to_string),
    })
}
fn google_profile(info: &Value) -> Option<Profile> {
    if info["email_verified"] != true {
        return None;
    }
    Some(Profile {
        id: info["sub"].as_str()?.to_string(),
        email: info["email"].as_str()?.to_string(),
        name: info["name"].as_str().unwrap_or("").to_string(),
        image: info["picture"].as_str().map(str::to_string),
    })
}
fn valid_email(value: &str) -> Option<String> {
    let email = value.trim().to_lowercase();
    if email.len() > 254
        || !regex::Regex::new(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
            .expect("constant regex")
            .is_match(&email)
    {
        return None;
    }
    Some(email)
}
/// Provider names are untrusted input: strip controls, cap length, and fall
/// back to the email local part so signup never fails on a blank name.
fn display_name(raw: &str, email: &str) -> String {
    let clean: String = raw
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(80)
        .collect();
    if !clean.is_empty() {
        return validation::name(&clean, 80).unwrap_or_else(|_| "user".into());
    }
    let local: String = email
        .split('@')
        .next()
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .take(80)
        .collect();
    validation::name(&local, 80).unwrap_or_else(|_| "user".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_ids_round_trip() {
        assert_eq!(Provider::all().map(|p| p.id()), ["github", "google"]);
        assert_eq!(Provider::from_id("github"), Some(Provider::Github));
        assert_eq!(Provider::from_id("google"), Some(Provider::Google));
        assert_eq!(Provider::from_id("azure"), None);
        assert_eq!(Provider::from_id(""), None);
    }
    #[test]
    fn authorize_urls_carry_oauth_params() {
        let url = authorize_url(
            Provider::Github,
            "github-id",
            "http://localhost:3001/api/auth/callback/github",
            &"a".repeat(64),
        );
        assert!(url.starts_with("https://github.com/login/oauth/authorize?"));
        assert!(url.contains("client_id=github-id"));
        assert!(url.contains("scope=read%3Auser+user%3Aemail"));
        assert!(url.contains("state="));
        assert!(url.contains(
            "redirect_uri=http%3A%2F%2Flocalhost%3A3001%2Fapi%2Fauth%2Fcallback%2Fgithub"
        ));
        let url = authorize_url(
            Provider::Google,
            "google-id",
            "https://usedatix.com/api/auth/callback/google",
            &"b".repeat(64),
        );
        assert!(url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("scope=openid+email+profile"));
    }
    #[test]
    fn token_params_match_each_provider() {
        let github = token_params(Provider::Github, "id", "secret", "code", "uri");
        assert_eq!(github.len(), 4);
        assert!(!github.iter().any(|(key, _)| *key == "grant_type"));
        let google = token_params(Provider::Google, "id", "secret", "code", "uri");
        assert_eq!(google.len(), 5);
        assert!(google.contains(&("grant_type", "authorization_code")));
    }
    #[test]
    fn state_tokens_must_be_64_hex_chars() {
        assert!(valid_state_token(&"f".repeat(64)));
        assert!(!valid_state_token(&"f".repeat(63)));
        assert!(!valid_state_token(&"g".repeat(64)));
        assert!(!valid_state_token(""));
    }
    #[test]
    fn github_profile_needs_verified_primary_email() {
        let user = serde_json::json!({"id": 4242, "name": "Sam", "avatar_url": "https://img"});
        let emails = serde_json::json!([
            {"email": "old@example.com", "primary": false, "verified": true},
            {"email": "Sam@Example.com", "primary": true, "verified": true},
        ]);
        let profile = github_profile(&user, &emails).unwrap();
        assert_eq!(profile.id, "4242");
        assert_eq!(profile.email, "Sam@Example.com");
        assert_eq!(profile.name, "Sam");
        let unverified = serde_json::json!([
            {"email": "x@example.com", "primary": true, "verified": false},
        ]);
        assert!(github_profile(&user, &unverified).is_none());
        assert!(github_profile(&serde_json::json!({"id": 1}), &emails).is_some());
        assert!(github_profile(&serde_json::json!({}), &emails).is_none());
    }
    #[test]
    fn google_profile_needs_verified_email() {
        let info = serde_json::json!({
            "sub": "1099", "email": "sam@example.com", "email_verified": true,
            "name": "Sam", "picture": "https://img",
        });
        let profile = google_profile(&info).unwrap();
        assert_eq!(profile.id, "1099");
        let unverified = serde_json::json!({"sub": "1", "email": "x@y.z", "email_verified": false});
        assert!(google_profile(&unverified).is_none());
        assert!(google_profile(&serde_json::json!({"sub": "1"})).is_none());
    }
    #[test]
    fn display_name_sanitizes_and_falls_back() {
        assert_eq!(display_name("  Sam  ", "x@y.z"), "Sam");
        assert_eq!(display_name("", "sam@example.com"), "sam");
        assert_eq!(display_name("a\u{0}b", "x@y.z"), "ab");
        assert_eq!(display_name(&"n".repeat(200), "x@y.z").len(), 80);
        assert_eq!(display_name("", "bad"), "bad");
    }
    #[test]
    fn oauth_emails_match_signup_rules() {
        assert_eq!(valid_email(" Sam@Example.com ").unwrap(), "sam@example.com");
        assert!(valid_email("not-an-email").is_none());
        assert!(valid_email(&format!("{}@x.co", "a".repeat(250))).is_none());
    }
}

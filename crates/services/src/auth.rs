//! Password hashes and signed cookies remain compatible with existing Better Auth accounts.
use analytics_core::{
    Error, Result, State, crypto,
    models::{Session, User},
    validation,
};
use axum::http::HeaderMap;
use chrono::{Duration, Utc};
use percent_encoding::{NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use serde_json::{Value, json};
use sqlx::PgConnection;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

#[derive(Clone)]
pub struct Identity {
    pub user: User,
    pub session: Session,
}
pub struct Reply {
    pub body: Value,
    pub cookies: Vec<String>,
    pub redirect: Option<String>,
}
impl Reply {
    fn json(body: Value) -> Self {
        Self {
            body,
            cookies: vec![],
            redirect: None,
        }
    }
}
fn unauthorized() -> Error {
    Error::new(401, "unauthorized", "Sign in to continue.")
}
fn password_input(value: &Value, key: &str, new: bool) -> Result<String> {
    let p = value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| Error::invalid("A password is required."))?;
    let len = p.encode_utf16().count();
    if len > 128 || len < if new { 12 } else { 1 } {
        return Err(Error::invalid("Passwords must contain 12–128 characters."));
    }
    Ok(p.into())
}
fn key(password: &str, salt: &str) -> Result<Vec<u8>> {
    let params = scrypt::Params::new(14, 16, 1, 64).map_err(|_| Error::unavailable())?;
    let normalized: String = password.nfkc().collect();
    let mut bytes = vec![0u8; 64];
    scrypt::scrypt(normalized.as_bytes(), salt.as_bytes(), &params, &mut bytes)
        .map_err(|_| Error::unavailable())?;
    Ok(bytes)
}
static PASSWORD_WORKERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
pub async fn hash_password(password: String) -> Result<String> {
    let permit = PASSWORD_WORKERS
        .acquire()
        .await
        .map_err(|_| Error::unavailable())?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let salt = Uuid::new_v4().simple().to_string();
        Ok(format!("{salt}:{}", hex::encode(key(&password, &salt)?)))
    })
    .await
    .map_err(|_| Error::unavailable())?
}
pub async fn verify_password(password: String, encoded: String) -> Result<bool> {
    let permit = PASSWORD_WORKERS
        .acquire()
        .await
        .map_err(|_| Error::unavailable())?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let Some((salt, hash)) = encoded.split_once(':') else {
            return Ok(false);
        };
        let Ok(expected) = hex::decode(hash) else {
            return Ok(false);
        };
        Ok(crypto::equal(&key(&password, salt)?, &expected))
    })
    .await
    .map_err(|_| Error::unavailable())?
}
fn cookie_name(state: &State) -> &'static str {
    if state.config.app_url.scheme() == "https" {
        "__Secure-better-auth.session_token"
    } else {
        "better-auth.session_token"
    }
}
pub fn cookie(state: &State, token: &str, remember: bool) -> String {
    let signed = crypto::sign_cookie(&state.config.auth_secret, token);
    format!(
        "{}={}; Path=/; HttpOnly; SameSite=Lax{}{}",
        cookie_name(state),
        utf8_percent_encode(&signed, NON_ALPHANUMERIC),
        if state.config.app_url.scheme() == "https" {
            "; Secure"
        } else {
            ""
        },
        if remember { "; Max-Age=604800" } else { "" }
    )
}
fn clear_cookie(state: &State) -> String {
    format!(
        "{}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{}",
        cookie_name(state),
        if state.config.app_url.scheme() == "https" {
            "; Secure"
        } else {
            ""
        }
    )
}
pub(crate) fn remember_cookie(state: &State, remember: bool) -> String {
    let name = cookie_name(state).replace("session_token", "dont_remember");
    let value = if remember {
        String::new()
    } else {
        utf8_percent_encode(
            &crypto::sign_cookie(&state.config.auth_secret, "true"),
            NON_ALPHANUMERIC,
        )
        .to_string()
    };
    format!(
        "{name}={value}; Path=/; HttpOnly; SameSite=Lax{}{}",
        if state.config.app_url.scheme() == "https" {
            "; Secure"
        } else {
            ""
        },
        if remember { "; Max-Age=0" } else { "" }
    )
}
fn dont_remember(state: &State, headers: &HeaderMap) -> bool {
    let name = cookie_name(state).replace("session_token", "dont_remember");
    headers
        .get("cookie")
        .and_then(|h| h.to_str().ok())
        .and_then(|raw| {
            raw.split(';')
                .filter_map(|p| p.trim().split_once('='))
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value)
        })
        .and_then(|v| percent_decode_str(v).decode_utf8().ok())
        .and_then(|v| crypto::verify_cookie(&state.config.auth_secret, &v))
        .is_some_and(|v| v == "true")
}
pub fn cookie_token(state: &State, headers: &HeaderMap) -> Option<String> {
    let raw = headers.get("cookie")?.to_str().ok()?;
    let value = raw
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find(|(key, _)| *key == cookie_name(state))?
        .1;
    let decoded = percent_decode_str(value).decode_utf8().ok()?;
    crypto::verify_cookie(&state.config.auth_secret, &decoded)
}
pub async fn identity(state: &State, headers: &HeaderMap) -> Result<Option<Identity>> {
    let Some(token) = cookie_token(state, headers) else {
        return Ok(None);
    };
    let session = sqlx::query_as::<_, Session>(
        "SELECT * FROM session WHERE token=$1 AND expires_at > now() AT TIME ZONE 'UTC'",
    )
    .bind(&token)
    .fetch_optional(&state.db)
    .await?;
    let Some(session) = session else {
        return Ok(None);
    };
    let user = sqlx::query_as::<_, User>("SELECT * FROM \"user\" WHERE id=$1")
        .bind(&session.user_id)
        .fetch_optional(&state.db)
        .await?;
    Ok(user.map(|user| Identity { user, session }))
}
pub async fn require(state: &State, headers: &HeaderMap) -> Result<Identity> {
    identity(state, headers).await?.ok_or_else(unauthorized)
}
fn user_json(user: &User) -> Value {
    json!({"id":user.id,"name":user.name,"email":user.email,"emailVerified":user.email_verified,"image":user.image,"createdAt":user.created_at.and_utc(),"updatedAt":user.updated_at.and_utc()})
}
fn session_json(s: &Session) -> Value {
    json!({"id":s.id,"token":s.token,"userId":s.user_id,"createdAt":s.created_at.and_utc(),"updatedAt":s.updated_at.and_utc(),"expiresAt":s.expires_at.and_utc(),"ipAddress":s.ip_address,"userAgent":s.user_agent})
}
pub(crate) async fn new_session(
    conn: &mut PgConnection,
    user_id: &str,
    ip: &str,
    headers: &HeaderMap,
    remember: bool,
) -> Result<Session> {
    let now = Utc::now().naive_utc();
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    Ok(sqlx::query_as::<_,Session>("INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at,ip_address,user_agent) VALUES($1,$2,$3,$4,$5,$5,$6,$7) RETURNING *")
 .bind(Uuid::new_v4().simple().to_string()).bind(token).bind(user_id).bind(now+Duration::days(if remember{7}else{1})).bind(now).bind(ip).bind(headers.get("user-agent").and_then(|x|x.to_str().ok()).unwrap_or("")).fetch_one(conn).await?)
}
pub async fn handle(
    state: &State,
    path: &str,
    method: &str,
    headers: &HeaderMap,
    body: Value,
    ip: &str,
    query: &str,
) -> Result<Reply> {
    if method == "POST" {
        if body.as_object().is_none() {
            return Err(Error::invalid("A JSON object is required."));
        }
        for key in ["rememberMe", "revokeOtherSessions"] {
            if body.get(key).is_some_and(|v| !v.is_boolean()) {
                return Err(Error::invalid(format!("Invalid {key}.")));
            }
        }
        if path == "delete-user"
            && body
                .as_object()
                .is_some_and(|v| v.len() != 1 || !v.contains_key("password"))
        {
            return Err(Error::invalid("Provide only the current password."));
        }
    }
    if path == "list-sessions" && method == "GET" {
        let identity = require(state, headers).await?;
        let sessions = sqlx::query_as::<_, Session>(
            "SELECT * FROM session WHERE user_id=$1 AND expires_at > now() AT TIME ZONE 'UTC'",
        )
        .bind(&identity.user.id)
        .fetch_all(&state.db)
        .await?;
        return Ok(Reply::json(json!(
            sessions.iter().map(session_json).collect::<Vec<_>>()
        )));
    }
    if path == "get-session" && method == "GET" {
        let Some(mut identity) = identity(state, headers).await? else {
            return Ok(Reply::json(Value::Null));
        };
        let mut cookies = vec![];
        if !dont_remember(state, headers)
            && identity.session.updated_at < Utc::now().naive_utc() - Duration::days(1)
        {
            let now = Utc::now().naive_utc();
            let expiry = now + Duration::days(7);
            let count = sqlx::query(
                "UPDATE session SET updated_at=$1,expires_at=$2 WHERE id=$3 AND expires_at > $1",
            )
            .bind(now)
            .bind(expiry)
            .bind(&identity.session.id)
            .execute(&state.db)
            .await?
            .rows_affected();
            if count == 0 {
                return Ok(Reply::json(Value::Null));
            }
            identity.session.updated_at = now;
            identity.session.expires_at = expiry;
            cookies.push(cookie(state, &identity.session.token, true));
        }
        let s = &identity.session;
        return Ok(Reply {
            body: json!({"user":user_json(&identity.user),"session":{"id":s.id,"token":s.token,"userId":s.user_id,"createdAt":s.created_at.and_utc(),"updatedAt":s.updated_at.and_utc(),"expiresAt":s.expires_at.and_utc(),"ipAddress":s.ip_address,"userAgent":s.user_agent}}),
            cookies,
            redirect: None,
        });
    }
    if let Some(provider) = path.strip_prefix("callback/") {
        if method != "GET" {
            return Err(Error::new(405, "method_not_allowed", "Use GET."));
        }
        return super::oauth::callback(state, provider, query, headers, ip).await;
    }
    if method != "POST" {
        return Err(Error::new(405, "method_not_allowed", "Use POST."));
    }
    if path == "sign-in/social" {
        let provider = body["provider"].as_str().unwrap_or("");
        let url = super::oauth::begin(state, provider).await?;
        return Ok(Reply::json(json!({"url":url,"redirect":true})));
    }
    if path == "sign-up/email" || path == "sign-in/email" {
        let signup = path == "sign-up/email";
        let password = password_input(&body, "password", signup)?;
        let email = body["email"]
            .as_str()
            .ok_or_else(|| Error::invalid("Email is required."))?
            .trim()
            .to_lowercase();
        if email.len() > 254
            || !regex::Regex::new(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
                .unwrap()
                .is_match(&email)
        {
            return Err(Error::invalid("Invalid email."));
        }
        let remember = body["rememberMe"].as_bool().unwrap_or(true);
        let mut conn = state.db.acquire().await?;
        let mut verified_hash = None;
        let owner = if signup {
            let name = validation::name(body["name"].as_str().unwrap_or(""), 80)?;
            let encoded = hash_password(password).await?;
            let mut tx = sqlx::Connection::begin(&mut *conn).await?;
            let now = Utc::now().naive_utc();
            let id = Uuid::new_v4().simple().to_string();
            let user=sqlx::query_as::<_,User>("INSERT INTO \"user\"(id,name,email,email_verified,created_at,updated_at) VALUES($1,$2,$3,false,$4,$4) ON CONFLICT(email) DO NOTHING RETURNING *").bind(&id).bind(name).bind(&email).bind(now).fetch_optional(&mut *tx).await?.ok_or_else(||Error::new(422,"USER_ALREADY_EXISTS","User already exists."))?;
            sqlx::query("INSERT INTO account(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES($1,$2,'credential',$2,$3,$4,$4)").bind(Uuid::new_v4().simple().to_string()).bind(&id).bind(encoded).bind(now).execute(&mut *tx).await?;
            tx.commit().await?;
            user
        } else {
            let user = sqlx::query_as::<_, User>("SELECT * FROM \"user\" WHERE email=$1")
                .bind(&email)
                .fetch_optional(&mut *conn)
                .await?;
            let encoded = if let Some(ref user) = user {
                sqlx::query_scalar::<_,String>("SELECT password FROM account WHERE user_id=$1 AND provider_id='credential' AND password IS NOT NULL LIMIT 1").bind(&user.id).fetch_optional(&mut *conn).await?
            } else {
                None
            };
            // Match the expensive verification path for unknown emails to avoid a cheap enumeration signal.
            let encoded =
                encoded.unwrap_or_else(|| format!("{}:{}", "0".repeat(32), "0".repeat(128)));
            if !verify_password(password, encoded.clone()).await? || user.is_none() {
                return Err(Error::new(
                    401,
                    "INVALID_EMAIL_OR_PASSWORD",
                    "Invalid email or password.",
                ));
            }
            verified_hash = Some(encoded);
            user.unwrap()
        };
        let mut tx = sqlx::Connection::begin(&mut *conn).await?;
        sqlx::query("SELECT id FROM \"user\" WHERE id=$1 FOR UPDATE")
            .bind(&owner.id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(unauthorized)?;
        if let Some(expected) = verified_hash {
            let current: Option<String> = sqlx::query_scalar(
                "SELECT password FROM account WHERE user_id=$1 AND provider_id='credential'",
            )
            .bind(&owner.id)
            .fetch_optional(&mut *tx)
            .await?;
            if current
                .as_ref()
                .is_none_or(|hash| !crypto::equal(hash.as_bytes(), expected.as_bytes()))
            {
                return Err(Error::new(
                    401,
                    "INVALID_EMAIL_OR_PASSWORD",
                    "Invalid email or password.",
                ));
            }
        }
        let session = new_session(&mut tx, &owner.id, ip, headers, remember).await?;
        tx.commit().await?;
        return Ok(Reply {
            body: json!({"token":session.token,"user":user_json(&owner),"redirect":false}),
            cookies: vec![
                cookie(state, &session.token, remember),
                remember_cookie(state, remember),
            ],
            redirect: None,
        });
    }
    if path == "sign-out" {
        if let Some(token) = cookie_token(state, headers) {
            sqlx::query("DELETE FROM session WHERE token=$1")
                .bind(token)
                .execute(&state.db)
                .await?;
        }
        return Ok(Reply {
            body: json!({"success":true}),
            cookies: vec![clear_cookie(state), remember_cookie(state, true)],
            redirect: None,
        });
    }
    if ![
        "update-user",
        "change-password",
        "delete-user",
        "revoke-session",
        "revoke-sessions",
        "revoke-other-sessions",
    ]
    .contains(&path)
    {
        return Err(Error::new(404, "not_found", "Endpoint not found."));
    }
    let identity = require(state, headers).await?;
    if path == "update-user" {
        let name = validation::name(body["name"].as_str().unwrap_or(""), 80)?;
        sqlx::query("UPDATE \"user\" SET name=$1,updated_at=now() AT TIME ZONE 'UTC' WHERE id=$2")
            .bind(name)
            .bind(&identity.user.id)
            .execute(&state.db)
            .await?;
        return Ok(Reply::json(json!({"status":true})));
    }
    if path.starts_with("revoke-") {
        let token = body["token"].as_str().unwrap_or("");
        let query = match path {
            "revoke-session" => "DELETE FROM session WHERE user_id=$1 AND token=$2",
            "revoke-other-sessions" => "DELETE FROM session WHERE user_id=$1 AND token<>$2",
            _ => "DELETE FROM session WHERE user_id=$1 AND ($2::text IS NOT NULL)",
        };
        sqlx::query(query)
            .bind(&identity.user.id)
            .bind(if path == "revoke-session" {
                token
            } else {
                &identity.session.token
            })
            .execute(&state.db)
            .await?;
        return Ok(Reply::json(json!({"status":true})));
    }
    if path == "delete-user" {
        return delete_user(state, &identity, &body).await;
    }
    let current = password_input(&body, "currentPassword", false)?;
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT id FROM \"user\" WHERE id=$1 FOR UPDATE")
        .bind(&identity.user.id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(unauthorized)?;
    let encoded = credential_hash(&mut tx, &identity.user.id)
        .await?
        .ok_or_else(|| Error::invalid("No password is set on this account."))?;
    if !verify_password(current, encoded).await? {
        return Err(Error::new(400, "INVALID_PASSWORD", "Invalid password."));
    }
    let next = hash_password(password_input(&body, "newPassword", true)?).await?;
    sqlx::query("UPDATE account SET password=$1,updated_at=now() AT TIME ZONE 'UTC' WHERE user_id=$2 AND provider_id='credential'").bind(next).bind(&identity.user.id).execute(&mut *tx).await?;
    let mut cookies = vec![];
    let mut token = Value::Null;
    if body["revokeOtherSessions"].as_bool() == Some(true) {
        sqlx::query("DELETE FROM session WHERE user_id=$1")
            .bind(&identity.user.id)
            .execute(&mut *tx)
            .await?;
        let session = new_session(&mut tx, &identity.user.id, ip, headers, true).await?;
        cookies.push(cookie(state, &session.token, true));
        token = Value::String(session.token);
    }
    tx.commit().await?;
    Ok(Reply {
        body: json!({"token":token,"user":user_json(&identity.user)}),
        cookies,
        redirect: None,
    })
}
async fn credential_hash(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: &str,
) -> Result<Option<String>> {
    Ok(sqlx::query_scalar::<_, String>("SELECT password FROM account WHERE user_id=$1 AND provider_id='credential' AND password IS NOT NULL LIMIT 1 FOR UPDATE")
        .bind(user_id)
        .fetch_optional(&mut **tx)
        .await?)
}
async fn delete_user(state: &State, identity: &Identity, body: &Value) -> Result<Reply> {
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT id FROM \"user\" WHERE id=$1 FOR UPDATE")
        .bind(&identity.user.id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(unauthorized)?;
    let encoded = credential_hash(&mut tx, &identity.user.id).await?;
    // OAuth-only accounts have no password to re-enter; the session plus the
    // billing deletability check in the HTTP handler still guard deletion.
    if let Some(encoded) = encoded {
        let current = password_input(body, "password", false)?;
        if !verify_password(current, encoded).await? {
            return Err(Error::new(400, "INVALID_PASSWORD", "Invalid password."));
        }
    }
    // Provider synchronization and cancellation checks are performed by the HTTP handler before deletion.
    sqlx::query("DELETE FROM \"user\" WHERE id=$1")
        .bind(&identity.user.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Reply {
        body: json!({"success":true,"message":"User deleted"}),
        cookies: vec![clear_cookie(state), remember_cookie(state, true)],
        redirect: None,
    })
}

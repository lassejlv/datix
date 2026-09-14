use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use hmac::{Hmac, Mac};
use rand::RngCore;
use scrypt::{
    Params, Scrypt,
    password_hash::{PasswordHash, PasswordVerifier},
};
use serde_json::{Value, json};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use unicode_normalization::UnicodeNormalization;

use crate::AuthError;

pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

pub fn sign(secret: &str, message: &[u8]) -> Result<Vec<u8>, AuthError> {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| AuthError::unavailable())?;
    mac.update(message);
    Ok(mac.finalize().into_bytes().to_vec())
}

pub fn signed_cookie(secret: &str, value: &str) -> Result<String, AuthError> {
    Ok(format!(
        "{value}.{}",
        STANDARD.encode(sign(secret, value.as_bytes())?)
    ))
}

pub fn verify_cookie(secret: &str, value: &str) -> Option<String> {
    let decoded = percent_encoding::percent_decode_str(value)
        .decode_utf8()
        .ok()?;
    let (value, signature) = decoded.rsplit_once('.')?;
    let signature = STANDARD.decode(signature).ok()?;
    let expected = sign(secret, value.as_bytes()).ok()?;
    (bool::from(signature.ct_eq(&expected)) && !value.is_empty()).then(|| value.to_owned())
}

pub async fn hash_password(password: String) -> Result<String, AuthError> {
    tokio::task::spawn_blocking(move || {
        let salt = &random_token()[..32];
        let params = Params::new(14, 16, 1, 64).map_err(|_| AuthError::unavailable())?;
        let mut key = [0u8; 64];
        let normalized: String = password.nfkc().collect();
        scrypt::scrypt(normalized.as_bytes(), salt.as_bytes(), &params, &mut key)
            .map_err(|_| AuthError::unavailable())?;
        Ok(format!("{salt}:{}", hex::encode(key)))
    })
    .await
    .map_err(|_| AuthError::unavailable())?
}

pub async fn verify_password(hash: String, password: String) -> Result<bool, AuthError> {
    tokio::task::spawn_blocking(move || {
        if hash.starts_with("$scrypt$") {
            let Ok(hash) = PasswordHash::new(&hash) else {
                return Ok(false);
            };
            return Ok(Scrypt.verify_password(password.as_bytes(), &hash).is_ok());
        }
        let Some((salt, expected)) = hash.split_once(':') else {
            return Ok(false);
        };
        if salt.len() != 32 || expected.len() != 128 {
            return Ok(false);
        }
        let Ok(expected) = hex::decode(expected) else {
            return Ok(false);
        };
        let normalized: String = password.nfkc().collect();
        let params = Params::new(14, 16, 1, 64).map_err(|_| AuthError::unavailable())?;
        let mut key = [0u8; 64];
        scrypt::scrypt(normalized.as_bytes(), salt.as_bytes(), &params, &mut key)
            .map_err(|_| AuthError::unavailable())?;
        Ok(bool::from(key.ct_eq(&expected)))
    })
    .await
    .map_err(|_| AuthError::unavailable())?
}

pub fn verification_token(secret: &str, email: &str, now: i64) -> Result<String, AuthError> {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256"}"#);
    let payload =
        URL_SAFE_NO_PAD.encode(json!({"email":email,"iat":now,"exp":now+3600}).to_string());
    let unsigned = format!("{header}.{payload}");
    Ok(format!(
        "{unsigned}.{}",
        URL_SAFE_NO_PAD.encode(sign(secret, unsigned.as_bytes())?)
    ))
}

pub fn verify_email_token(secret: &str, token: &str, now: i64) -> Result<String, AuthError> {
    if token.len() > 8192 {
        return Err(AuthError::token());
    }
    let (unsigned, signature) = token.rsplit_once('.').ok_or_else(AuthError::token)?;
    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| AuthError::token())?;
    if !bool::from(signature.ct_eq(&sign(secret, unsigned.as_bytes())?)) {
        return Err(AuthError::token());
    }
    let (header, payload) = unsigned.split_once('.').ok_or_else(AuthError::token)?;
    let decode = |s| -> Result<Value, AuthError> {
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(s).map_err(|_| AuthError::token())?)
            .map_err(|_| AuthError::token())
    };
    let header = decode(header)?;
    let claims = decode(payload)?;
    if header["alg"] != "HS256"
        || header.get("crit").is_some()
        || claims.get("updateTo").is_some()
        || claims.get("requestType").is_some()
    {
        return Err(AuthError::token());
    }
    if claims["exp"]
        .as_i64()
        .is_none_or(|expiration| expiration <= now)
        || claims
            .get("nbf")
            .is_some_and(|n| n.as_i64().is_none_or(|n| n > now))
    {
        return Err(AuthError::new(
            axum::http::StatusCode::UNAUTHORIZED,
            "TOKEN_EXPIRED",
            "Verification token expired.",
        ));
    }
    claims["email"]
        .as_str()
        .filter(|email| email.contains('@'))
        .map(str::to_owned)
        .ok_or_else(AuthError::token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn verifies_better_auth_scrypt_with_nfkc_normalization() {
        let hash = "0123456789abcdef0123456789abcdef:72bc0f1b1cead5fe5c7b238c2a2dec7a7138d9ea5cfb6e897fc47bccb9233016c5529c230326ec21449c319f8ccf7da54dc375972593a7985a34314272401bad";
        assert!(
            verify_password(hash.into(), "Pässｗord-123".into())
                .await
                .unwrap()
        );
    }

    #[test]
    fn verifies_cookie_generated_by_better_call() {
        let token = verify_cookie(
            "fixture-secret-at-least-32-characters",
            "fixture-session-token.ZGYenL0BZu%2BJAMd0L4PdFiuwsgILdB6wnkLe9fOLMek%3D",
        );
        assert_eq!(token.as_deref(), Some("fixture-session-token"));
    }

    #[test]
    fn rejects_modified_cookie_payload() {
        assert!(
            verify_cookie(
                "fixture-secret-at-least-32-characters",
                "changed-token.ZGYenL0BZu%2BJAMd0L4PdFiuwsgILdB6wnkLe9fOLMek%3D"
            )
            .is_none()
        );
    }

    #[test]
    fn verification_token_expires_at_the_deadline() {
        let token = verification_token(
            "fixture-secret-at-least-32-characters",
            "person@example.test",
            1000,
        )
        .unwrap();
        assert!(verify_email_token("fixture-secret-at-least-32-characters", &token, 4600).is_err());
    }
}

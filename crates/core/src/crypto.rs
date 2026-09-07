use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;
pub fn signature(secret: &[u8], input: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(input);
    mac.finalize().into_bytes().to_vec()
}
pub fn hash(secret: &str, input: &str) -> String {
    hex::encode(signature(secret.as_bytes(), input.as_bytes()))
}
pub fn equal(a: &[u8], b: &[u8]) -> bool {
    a.ct_eq(b).into()
}
pub fn sign_cookie(secret: &str, token: &str) -> String {
    format!(
        "{token}.{}",
        STANDARD.encode(signature(secret.as_bytes(), token.as_bytes()))
    )
}
pub fn verify_cookie(secret: &str, value: &str) -> Option<String> {
    let (token, sig) = value.rsplit_once('.')?;
    let received = STANDARD.decode(sig).ok()?;
    equal(&signature(secret.as_bytes(), token.as_bytes()), &received).then(|| token.to_owned())
}

use super::{error::Error, parse::collator};
use icu_collator::CollatorBorrowed;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Match canonicalFingerprint in the previous backend without retaining another
/// serialized copy of a potentially large import. Counts are safe integers only.
pub fn fingerprint(value: &Value) -> Result<String, Error> {
    let collator = collator()?;
    let mut hash = Sha256::new();
    append(&mut hash, &collator, value);
    Ok(hex::encode(hash.finalize()))
}
fn append(hash: &mut Sha256, collator: &CollatorBorrowed<'_>, value: &Value) {
    match value {
        Value::Array(values) => {
            hash.update(b"[");
            for (i, value) in values.iter().enumerate() {
                if i > 0 {
                    hash.update(b",");
                }
                append(hash, collator, value);
            }
            hash.update(b"]");
        }
        Value::Object(values) => {
            let mut values: Vec<_> = values.iter().collect();
            values.sort_by(|a, b| collator.compare(a.0, b.0));
            hash.update(b"{");
            for (i, (key, value)) in values.into_iter().enumerate() {
                if i > 0 {
                    hash.update(b",");
                }
                hash.update(Value::String(key.clone()).to_string());
                hash.update(b":");
                append(hash, collator, value);
            }
            hash.update(b"}");
        }
        _ => hash.update(value.to_string()),
    }
}

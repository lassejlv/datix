//! Short-lived report responses are bounded per process and never stored in the durable event queue.
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

struct Entry {
    value: Value,
    until: Instant,
    bytes: usize,
}
#[derive(Default)]
pub struct ReportCache(Mutex<HashMap<String, Entry>>);
impl ReportCache {
    pub fn get(&self, key: &str) -> Option<Value> {
        let mut entries = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if entries.get(key).is_some_and(|e| e.until <= Instant::now()) {
            entries.remove(key);
        }
        entries.get(key).map(|entry| entry.value.clone())
    }
    pub fn put(&self, key: String, value: &Value, seconds: u64) {
        if seconds == 0 {
            return;
        }
        let bytes = value.to_string().len() + key.len();
        if bytes > 256 * 1024 {
            return;
        }
        let mut entries = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let now = Instant::now();
        entries.retain(|_, entry| entry.until > now);
        entries.remove(&key);
        let mut used: usize = entries.values().map(|e| e.bytes).sum();
        while entries.len() >= 256 || used + bytes > 8 * 1024 * 1024 {
            let Some(oldest) = entries
                .iter()
                .min_by_key(|(_, e)| e.until)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some(entry) = entries.remove(&oldest) {
                used -= entry.bytes;
            }
        }
        entries.insert(
            key,
            Entry {
                value: value.clone(),
                until: now + Duration::from_secs(seconds),
                bytes,
            },
        );
    }
}

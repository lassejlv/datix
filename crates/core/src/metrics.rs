//! Bounded, process-local operational metrics. No tenant, URL, or visitor labels.
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

const BOUNDS: [f64; 13] = [
    0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1., 2.5, 5., 10., 30.,
];

pub struct Histogram {
    buckets: [AtomicU64; 14],
    micros: AtomicU64,
}
impl Default for Histogram {
    fn default() -> Self {
        Self {
            buckets: std::array::from_fn(|_| AtomicU64::new(0)),
            micros: AtomicU64::new(0),
        }
    }
}
impl Histogram {
    pub fn observe(&self, seconds: f64) {
        let value = seconds.max(0.);
        let index = BOUNDS
            .iter()
            .position(|bound| value <= *bound)
            .unwrap_or(13);
        self.buckets[index].fetch_add(1, Relaxed);
        self.micros.fetch_add((value * 1_000_000.) as u64, Relaxed);
    }
    fn render(&self, out: &mut String, name: &str, labels: &str) {
        let mut count = 0;
        let separator = if labels.is_empty() { "" } else { "," };
        for (index, bucket) in self.buckets.iter().enumerate() {
            count += bucket.load(Relaxed);
            let bound = BOUNDS
                .get(index)
                .map(ToString::to_string)
                .unwrap_or_else(|| "+Inf".into());
            out.push_str(&format!(
                "{name}_bucket{{{labels}{separator}le=\"{bound}\"}} {count}\n"
            ));
        }
        let labels = if labels.is_empty() {
            String::new()
        } else {
            format!("{{{labels}}}")
        };
        out.push_str(&format!(
            "{name}_sum{labels} {}\n{name}_count{labels} {count}\n",
            self.micros.load(Relaxed) as f64 / 1_000_000.
        ));
    }
}

#[derive(Default)]
pub struct Metrics {
    pub http: [Histogram; 4],
    pub http_errors: AtomicU64,
    pub collect_accepted: AtomicU64,
    pub committed: AtomicU64,
    pub skipped: AtomicU64,
    pub retries: AtomicU64,
    pub batch_seconds: Histogram,
    pub event_delay_seconds: Histogram,
    pub pool_wait_seconds: Histogram,
    pub transaction_start_seconds: Histogram,
    pub queue_depth: AtomicU64,
    pub queue_failed: AtomicU64,
    pub queue_oldest_seconds: AtomicU64,
    pub billing_pending: AtomicU64,
    pub billing_oldest_seconds: AtomicU64,
    pub billing_delivered: AtomicU64,
    pub retention_backlog: AtomicU64,
    pub report_cache_hits: AtomicU64,
    pub report_cache_misses: AtomicU64,
    pub last_observation: AtomicU64,
}
impl Metrics {
    pub fn http_group(path: &str) -> usize {
        if path == "/api/collect" {
            0
        } else if path.starts_with("/api/sites/") {
            1
        } else if path.starts_with("/api/auth/") {
            2
        } else {
            3
        }
    }
    pub fn render(&self, pool: &sqlx::PgPool) -> String {
        let mut out = String::new();
        for (name, value) in [
            ("analytics_http_errors_total", &self.http_errors),
            ("analytics_collect_accepted_total", &self.collect_accepted),
            ("analytics_events_committed_total", &self.committed),
            ("analytics_events_skipped_total", &self.skipped),
            ("analytics_event_retries_total", &self.retries),
            ("analytics_queue_depth", &self.queue_depth),
            ("analytics_queue_failed", &self.queue_failed),
            ("analytics_queue_oldest_seconds", &self.queue_oldest_seconds),
            ("analytics_billing_pending", &self.billing_pending),
            (
                "analytics_billing_oldest_seconds",
                &self.billing_oldest_seconds,
            ),
            ("analytics_billing_delivered_total", &self.billing_delivered),
            ("analytics_retention_backlog", &self.retention_backlog),
            ("analytics_report_cache_hits_total", &self.report_cache_hits),
            (
                "analytics_report_cache_misses_total",
                &self.report_cache_misses,
            ),
            (
                "analytics_metrics_observed_timestamp_seconds",
                &self.last_observation,
            ),
        ] {
            let kind = if name.ends_with("_total") {
                "counter"
            } else {
                "gauge"
            };
            out.push_str(&format!(
                "# TYPE {name} {kind}\n{name} {}\n",
                value.load(Relaxed)
            ));
        }
        out.push_str(&format!("# TYPE analytics_db_pool_connections gauge\nanalytics_db_pool_connections {}\n# TYPE analytics_db_pool_idle gauge\nanalytics_db_pool_idle {}\n", pool.size(), pool.num_idle()));
        out.push_str("# TYPE analytics_http_duration_seconds histogram\n");
        for (index, name) in ["collect", "sites", "auth", "other"].iter().enumerate() {
            self.http[index].render(
                &mut out,
                "analytics_http_duration_seconds",
                &format!("route=\"{name}\""),
            );
        }
        for (name, histogram) in [
            (
                "analytics_ingest_batch_duration_seconds",
                &self.batch_seconds,
            ),
            (
                "analytics_event_commit_delay_seconds",
                &self.event_delay_seconds,
            ),
            ("analytics_db_pool_wait_seconds", &self.pool_wait_seconds),
            (
                "analytics_db_transaction_start_seconds",
                &self.transaction_start_seconds,
            ),
        ] {
            out.push_str(&format!("# TYPE {name} histogram\n"));
            histogram.render(&mut out, name, "");
        }
        out
    }
}

# Scaling and operating Datix

The API and background work deploy independently in the existing Railway production project. Both use the existing Neon database and persistent Redis service. The `web` service serves React and Axum with `SERVICE_ROLE=api`; `worker` (`2399cc05-2728-4890-9d73-10c56a89e05a`) runs ingestion, billing and retention with `SERVICE_ROLE=worker`. Worker HTTP exposes only readiness, liveness and authenticated metrics; it has no public domain or frontend build. Local development defaults to `combined`.

## Throughput and correctness

Four workers use dedicated blocking Redis connections and read up to 64 events at once. API enqueue and rate limits have separate Redis connections. Pending deliveries are reclaimed after 60 seconds; a batch has a 45-second processing deadline. Shutdown stops reads and finishes delivered batches. Both Railway services allow 90 seconds for graceful shutdown ([Railway teardown settings](https://docs.railway.com/deployments/deployment-teardown)).

Each owner batch takes the same account lock used by settings and account deletion. It checks subscriptions, enabled environments, tracking policy, deduplication and integer credit balances inside the transaction. Bulk inserts update events, activity, usage, visitor counts and aggregates. Billing outbox quantities are grouped by owner, billing period, event type and UTC day; their stable external IDs survive retries. Different owners can commit independently; a failure never acknowledges another owner's uncommitted work. The collection endpoint loads a compact admission snapshot and updates the existing abuse policy in one SQL function call.

The queue rejects new collection requests with HTTP 503 when its outstanding stream reaches `QUEUE_MAX_PENDING` (100,000 by default). Accepted entries are never trimmed to make room. Inspect the durable failed stream after malformed events or ten failed deliveries.

Billing starts a bounded drain every second, continuing beyond the previous 500-row cap. Provider errors retain quantities and stable IDs with backoff. Retention rotates between tables and removes bounded batches until its time/row budget expires. It marks the UTC day complete only after every table is drained; unfinished work resumes on the next minute tick. It preserves the existing 30-day raw/activity and 730-day aggregate policy.

## Database connections

Production budgets are six SQLx connections per API replica and eight per worker replica. Four event consumers leave worker connections for billing, retention and observation. With one of each, the client cap is 14; allow 28 during simultaneous rolling replacements, plus administrative connections. These are SQLx client budgets: Neon transaction pooling also has its own backend limits. Keep the total within the configured Neon compute capacity before adding replicas. Additional workers cannot remove the intentional serialization of one account's exact credit balance.

Pool acquisition times out after five seconds. Queries have a 15-second statement timeout and UTC timezone. For Neon `-pooler` hosts, configure these defaults on `analytics_runtime` using the owner connection, then recycle **idle** runtime backends so old pooled backends acquire the defaults:

```sql
ALTER ROLE analytics_runtime SET statement_timeout='15s';
ALTER ROLE analytics_runtime SET timezone='UTC';
```

Startup rejects a transaction-pooled connection with an absent or excessive timeout. It does not rely on a per-client `SET statement_timeout` surviving PgBouncer transaction pooling. Direct connections receive bounded startup options. Runtime variables and defaults are documented in `.env.example`; secrets are stored in Railway variables, with worker references to the existing web service's credentials.

## Partitioning and session reports

`events` and `activity_events` use daily UTC partitions. Maintenance keeps the 30-day range and seven future days, dropping only partitions whose upper boundary is fully outside retention. The partial oldest day is deleted in bounded batches. A DEFAULT partition accepts data when maintenance has been offline; recovery moves its rows into the correct new partition before attaching it, without reapplying receipts or session counters.

Global `event_receipts(environment_id,id,kind)` preserves duplicate protection even when a replay changes its timestamp or crosses a partition boundary. Receipts remain for 31 days, beyond the accepted 30-day arrival window. Account/environment deletion cascades to receipts and summaries.

Deferred event triggers maintain UTC session-day summaries after optional rich activity has been inserted. Session lists read these summaries and consult raw rows only for the partially retained oldest day. Totals and the page come from one grouped query. Activity details retain the original raw/rich merge. Signed `nextCursor` values use complete ordering ties and are bound to environment, dates, visitor and session filters. Offset pagination remains compatible. Cursors avoid large offsets; they are not historical snapshots, so a live session can move while paging.

Report caching is local to each API process, lasts five seconds, and is bounded to 256 entries, 8 MiB total and 256 KiB per entry. Every request authenticates and verifies current site/environment ownership before accessing the cache. Fresh data can take up to five seconds to appear after commit. Set `REPORT_CACHE_SECONDS=0` to disable caching.

## Metrics and scaling decisions

`GET /internal/metrics` returns Prometheus text only with `Authorization: Bearer <METRICS_TOKEN>`. Missing/incorrect tokens return 404. Both services share the protected token; use private networking for worker scrapes. No tenant IDs, visitor IDs, URLs or credentials appear in labels. HTTP histograms use only `collect`, `sites`, `auth` and `other` route groups.

Counters/histograms are per process and reset at deployment. Scrape every replica and retain the service/instance labels. Queue and billing gauges are shared-state observations refreshed by workers every 15 seconds; take their **maximum**, not their sum. API copies have observation timestamp zero and should not be used for backlog alerts. Check `analytics_metrics_observed_timestamp_seconds` to detect stale observations. Pool acquisition histograms cover instrumented admission/report acquisitions; transaction-start histograms include acquisition plus `BEGIN` for ingestion and billing.

Useful queries (adjust thresholds from observed production traffic):

```promql
# Accepted vs committed rates; expected skips include duplicate redelivery.
sum(rate(analytics_collect_accepted_total[5m]))
sum(rate(analytics_events_committed_total[5m]))

# Collection latency and dashboard latency.
histogram_quantile(0.95, sum by (le, route) (rate(analytics_http_duration_seconds_bucket[5m])))

# Old accepted events and billing backlog.
max(analytics_queue_oldest_seconds)
max(analytics_billing_oldest_seconds)

# Pool acquisition pressure.
histogram_quantile(0.95, sum by (le) (rate(analytics_db_pool_wait_seconds_bucket[5m])))
```

Investigate queue age above 60 seconds for five minutes, any failed entries, sustained 5xx errors, or billing age above five minutes. Persistent retention backlog across many passes needs inspection. If queue age rises while PostgreSQL has spare capacity, increase worker replicas or consumers within the connection budget. If pool waits or database latency rise, inspect query plans/locks and Neon compute before increasing connections. Scale API replicas for HTTP pressure independently of worker replicas. These metrics expose current state; a historical monitoring/alerting service must scrape them to retain history and send alerts.

## Schema rollout and rollback

Startup checks schema version/checksums and never changes schema. `analytics-db upgrade` is an explicit owner operation. Version 2 adds receipts, session summaries and the abuse function; version 3 converts raw tables to partitions. The transaction verifies the complete copied row sets before renaming tables. Write locks fail after three seconds rather than waiting indefinitely; a failed upgrade rolls back. The migration's statement limit is 120 seconds. The reviewed production dataset was below 1 MiB; for a future large conversion, design an online copy instead of increasing lock duration blindly.

The original `events_unpartitioned_backup` and `activity_events_unpartitioned_backup` remain for comparison and recovery. They have deletion cascades and participate in privacy retention. They are snapshots at migration time, not current replicas. Never rename them back over current tables: that would lose subsequent events. Do not edit an applied migration/checksum.

For application rollback, deploy the preceding Rust commit `a21cfc0` on web in its original combined mode and stop the separate worker. That application is compatible with the upgraded table shapes and `ON CONFLICT DO NOTHING`; the prepared-writer rehearsal verified the partition rename behavior. Keep the upgraded schema and receipts in place. Verify existing login, collection, reporting, exact credits and queue drain. A full schema downgrade requires a separately reviewed copy of **current** partition data with both writers paused; no destructive downgrade is included in this release.

## Reproducible evidence

All integration/load tests require the explicitly matched isolated `api-tests` Neon branch and loopback Redis (port 6394). Load fixtures have no live Autumn key. They clean their accounts; the retention test additionally removes expired records in this disposable test branch. Never point these tests at production or a shared development database.

```sh
cargo test --locked --workspace
cargo test --locked -p analytics-server --test integration -- --ignored --nocapture --test-threads=1
bun --env-file=.env web/scripts/scaling-schema-rehearsal.ts
bun run --cwd web typecheck
bun run --cwd web test
bun run --cwd web build
```

The same local debug build/remote-Neon setup drained 80 queued events in 77.898 seconds before batching and 3.071 seconds afterward (1.03 to 26.05 events/second, about 25×). A bounded HTTP test sent 320 unique events and 32 duplicate retries in each scenario using 24 concurrent clients, six API connections and eight worker connections. Eight-account traffic drained in 39.13 seconds (8.18 unique events/second); single-account traffic drained in 27.45 seconds (11.66/second). Every unique event was stored and billed exactly once; both failed streams were empty. Collection p95 was 3.46/3.63 seconds and dashboard p95 5.79/5.86 seconds respectively. These are local debug tests over a remote connection, not production throughput or latency guarantees.

Correctness checks cover credit boundaries, timestamp-changing duplicates, prepared readers/writers, session report equivalence at UTC/retention boundaries, cursor ties/tampering, abuse decision boundaries, partition DEFAULT recovery, a 601-row billing backlog and 100,500 expired retention rows. Empty database initialization and repeated upgrades passed. Ignored local artifacts are under `web/artifacts/scaling/`; production continuity checks are under `web/artifacts/scaling-production/`.

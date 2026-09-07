# Deployment and operations

Analytics Beer runs in the [Analytics Beer Railway project](https://railway.com/project/ff5d734f-2a11-4fec-a74d-d2793515f557), production environment. The web service runs `/usr/local/bin/analytics-server`, an Axum application with SQLx and Redis Streams. It serves the static React/TanStack Router frontend and runs event consumers and maintenance in the same process.

## Build and runtime

`Dockerfile` builds the frontend with Bun 1.4.2 and the Cargo workspace with Rust 1.96. The final Debian image contains three native binaries, CA certificates, and `web/dist/client`. Bun and Node are build/test tools and are absent from the runtime image. `railway.json` selects the Dockerfile, Rust start command, readiness endpoint and restart policy.

The server listens on `PORT` (3000 in production). `/health/ready` verifies PostgreSQL, Redis, and background task liveness. Startup validates the existing schema before listening; it never applies migrations. SIGTERM stops accepting HTTP requests, drains active requests and jobs, and closes the SQLx pool. Unacknowledged events remain in Redis for recovery.

Cloudflare proxies `analytics.beer` to Railway. The diagnostic domain is [web-production-2465a.up.railway.app](https://web-production-2465a.up.railway.app). Authentication uses `APP_URL=https://analytics.beer`; use that domain for account flows. Existing Cloudflare DNS, Full TLS configuration and origin authentication remain in place.

## Database and configuration

The existing Neon production branch is retained: project `billowing-night-55335840`, branch `br-frosty-frost-b18zvthi`, database `analytics`, Frankfurt. SQLx uses the restricted `analytics_runtime` role, a maximum of ten pooled connections, certificate/hostname-verified TLS and a 15-second statement timeout. No database copy or schema change is required for the Rust migration.

Required variables: `APP_URL`, `DATABASE_URL`, `REDIS_URL`, `BETTER_AUTH_SECRET`, and `VISITOR_HASH_SECRET`. Production also retains `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, and `CLOUDFLARE_ORIGIN_SECRET`. Preserve signing secrets to keep existing sessions and visitor hashes valid. Railway's private Redis URL stays unchanged. Keep credentials out of build arguments and source control.

`CLOUDFLARE_ORIGIN_SECRET` verifies the `x-analytics-origin-key` transform before trusting Cloudflare country metadata. Railway's resolved client IP is used only in the Railway runtime; direct requests cannot supply trusted country information. Optional variables are `STATIC_DIR` (default `web/dist/client`), `EVENT_STREAM` (default `analytics:events:v2`), `POLAR_API_URL` (for isolated provider tests), and `RUST_LOG`.

## Deploying

The private repository [lassejlv/analytics-beer](https://github.com/lassejlv/analytics-beer) deploys its `main` branch to Railway web service `a5cb579e-e445-4882-a49f-6aea52c8480a` in environment `3f8cf4d9-b6d5-4532-8e1c-dc8ced8a1b76`.

```sh
bun run --cwd web typecheck
bun run --cwd web test
bun run --cwd web build
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --locked --workspace
cargo test --locked -p analytics-server --test integration -- --ignored --test-threads=1
cargo build --locked --release --workspace
git push origin main
```

For a deliberate upload of the working tree, use `railway up` with the explicit project, environment and service IDs above. Wait for the exact deployment to succeed, inspect its runtime logs for `runtime=rust` and `framework=axum`, then verify an existing session and a public tracker → Redis → Neon → report round trip. A successful build or health response alone is insufficient.

## Schema and tests

The live schema snapshot is `docs/database/schema.sql`; the corresponding SQLx baseline is `crates/core/migrations/0001_existing_schema.sql`. `analytics-db check` compares the deployed schema with the 133-column manifest and required default-environment trigger. `analytics-db init-empty` refuses populated databases and initializes only a new empty database. Never apply the baseline to an existing installation. Add future reviewed changes as versioned SQL migrations and apply them explicitly under an owner role.

`cargo test --workspace` runs Rust unit tests. `cargo test -p analytics-server --test integration -- --ignored --test-threads=1` explicitly runs the ignored database/Redis tests against the isolated Neon branch, with `TEST_DATABASE_URL`, matching `TEST_DATABASE_HOST`, and `RUST_TEST_REDIS_URL` (default loopback port 6394). They test atomic credit limits, duplicate ingestion, concurrency, ownership, consent, reports, signed webhooks, provider retries and crash recovery. They remove only their own records. `bun web/scripts/rust-auth-compatibility.ts` verifies both directions against the frozen Better Auth test fixture. JavaScript backend tests were replaced by Rust tests; frontend/tracker tests remain in Bun.

## Queue cutover and recovery

The Rust consumer group `analytics-rust` reads `analytics:events:v2`. An event is acknowledged and deleted only after its PostgreSQL transaction commits. Four consumers reclaim deliveries abandoned for at least 60 seconds. After ten failed deliveries, the original payload moves atomically into `analytics:events:v2:failed`; malformed envelopes also remain there for inspection. No event ID is regenerated. Duplicate redelivery does not charge twice.

Redis must retain its persistent volume, append-only persistence and `noeviction` policy. Billing remains a PostgreSQL outbox with stable Polar external IDs, checked every minute under a Redis lease. Daily retention runs at or after 03:17 UTC and catches up after downtime; its completion marker is written only after successful cleanup.

For the initial cutover, let Railway switch traffic to the healthy Rust deployment and stop the old application, then run inside that service:

```sh
analytics-queue inspect
analytics-queue migrate-legacy
analytics-queue inspect
```

The migration copies unfinished BullMQ jobs from waiting, active, paused, delayed and failed states into the Rust stream. An atomic per-job marker makes reruns safe. Legacy payloads are preserved for rollback; invalid envelopes stay in their original queue and cause a nonzero exit. Confirm both the Rust stream and failed stream drain to zero. Do not delete legacy queue records during the rollback window.

For a failed Rust event, repair its cause, preserve its ID and replay its original `data` payload to the event stream. Keep retries inside the existing 30-day deduplication window.

## Rollback

Commit `9842b39` is the pre-Rust Hono/Bun deployment and retains the complete former backend. Redeploy that commit and verify its original Bun start command, health and database access. It uses the same tables, password hashes, signed cookies, visitor secrets and Polar outbox. No database restore is required.

Once the Rust deployment has stopped, run `bun web/scripts/rollback-rust-queue.ts --apply` from this migration checkout with the target `REDIS_URL`. It copies all remaining Rust envelopes (including the failed stream) into BullMQ with stable event-derived job IDs, retaining original stream entries and invalid records. Its default mode is read-only. Re-run after the old worker drains the queue, verify reports and check failed jobs. Do not run queue replay while both deployments are consuming traffic. Preserve source streams until rollback is verified.

The older Cloudflare deployment history is retained in [Cloudflare deployment history](cloudflare-deployment-history.md). The pre-Rust rollback above is the relevant rollback for this release.

# Datix

## Workspace and compatibility

Work on `main`. Cargo workspace: `crates/api` (Axum HTTP + workers),
`crates/auth` (custom Better Auth-compatible service), `crates/db` (SQLx).
The unchanged React application is in `web/`, using standard Vite.
Bun remains only for frontend dependencies, tracker builds, and frontend tests.
The replaced Bun backend, duplicate `apps/web`, database/email packages, Vite+,
and obsolete TypeScript migration tools have been removed; Git retains their history.

Preserve frontend routes, payloads, tracking behavior, auth cookies, OAuth callback
spelling, and billing contracts. Do not change application source for this migration.
Only the billing catalog import needed a relative-path adjustment during relocation.
Keep essential guidance here; do not add root-level planning documents.

## Development and verification

- Rust minimum 1.94.1; checked with Rust 1.98.1. Bun 1.4.2. Install with
  `bun install --frozen-lockfile`; keep both Cargo.lock and bun.lock.
- `bun run dev` builds Rust and starts API 3001 + Vite 3000. It reads only
  ignored `.local/rust.env`, validates the isolated host/database and queue prefix,
  removes owner credentials from the runtime environment, and disables external effects.
  Restart after Rust edits. `DEV_API_PORT` / `DEV_APP_URL` may select local ports.
- Existing root `.env` is unchanged and points to production. Never use it for
  tests or local API development. Rust does not automatically load dotenv files.
  `.env.example` is a template for an isolated configuration, not production fixtures.
- `bun run check` runs Rust format/Clippy/tests and web formatting/lint/typecheck/tests.
  `bun run build` builds release Rust binaries and `web/dist/client`.
  The frontend retains its existing lint warnings and large-chunk build warning.
- Direct Rust checks: `cargo fmt --all --check`,
  `cargo clippy --workspace --all-targets --locked -- -D warnings`,
  `cargo test --workspace --locked`.
- `bun run test:integration`, equivalently
  `DATIX_TEST_ENV=.local/rust.env cargo test --workspace --locked -- --ignored`,
  runs focused real database/Redis checks. Each test validates the isolated target.
  Provider requests use loopback mocks; no real email, OAuth consent, or billing.
  Stop all dev API/worker processes before running this suite: Redis prefixes
  isolate diagnostic streams, but PostgreSQL receipts are shared within a database.
- `bun run --cwd web test` runs the unchanged frontend checks.
  `bun run fmt` applies Rust formatting plus the prior web blank-line rules
  and standalone Oxfmt. Do not reformat generated files or applied migrations.

## Databases and immutable migrations

Use one Neon PostgreSQL 18 database with TimescaleDB for application and analytics
data. No DuckDB, separate analytics store, or manual partitions.

- Project `datix-timescale` / `rapid-flower-57581427`.
  Production branch `br-ancient-smoke-b1le6vrt`, database `datix`.
  The user confirmed this configured Datix schema; the originally supplied
  `ep-morning-voice-assxbb3l` database is unrelated and is not a migration source.
- Dev branch `dev-rust-20260914` / `br-cool-poetry-b1qf0tp7`, expires
  September 21, 2026. Direct host
  `ep-sweet-sun-b1ynkxmz.c-5.eu-central-1.aws.neon.tech`.
  Verify the branch still exists before using it. It was requested schema-only,
  initialized from the original migrations, and catalog-compared with production.
  Never copy production rows into fixtures.
- Runtime uses restricted pooled `DATABASE_URL`; direct owner
  `DATABASE_URL_UNPOOLED` is only for explicit database tooling. Keep UTC,
  bounded statement/lock timeouts, and Neon's connection budget.
- `crates/db/schema/production.json` is a metadata-only format-2 catalog snapshot:
  columns, constraints, indexes, triggers, non-extension functions, Timescale
  dimensions, table/security settings, views, sequence definitions (not counters),
  policies, enum/domain types, and extension versions. Production/dev catalogs match.
- The two SQL migrations are byte-for-byte originals. Preserve filenames,
  SHA-256 checksums, ledger `datix_schema_migrations`, and advisory transaction
  lock `791343524`. Never edit applied SQL, clear history, or add destructive downs.
- Plan explicitly:
  `bun run db --env-file .local/rust.env --expect-host HOST --expect-database datix migrate`.
  Review target and pending SQL before adding `--apply`. No startup migrations.
  Production writes remain disabled in the migration CLI until a separately requested cutover.
- `runtime-role [--apply]` refreshes minimal grants after new tables. Create the
  unprivileged login separately; reconnect after role-default changes.
  `snapshot --output PATH` reads metadata only.
  `baseline --schema PATH [--apply]` only restores migration metadata when the
  full catalog and complete bundled migration checksums match. Old/partial snapshots fail.
- New schema changes must be forward migrations, expand compatibility first,
  and be rehearsed against an empty isolated target. A development rollback runs
  the prior Git revision/artifact against the unchanged compatible schema.
- This port uses Datix's existing schema, not a copy from the unrelated source.
  No production data copying or traffic cutover has been performed.

## Auth, email, billing, and imports

- Unverified or suspended accounts cannot access protected APIs. Preserve
  Better Auth scrypt/NFKC, signed session-cookie format, refresh/expiry,
  verification/resend, and deletion freshness/password requirements.
- OAuth callbacks stay `/api/auth/callback/github` and
  `/api/auth/callback/google`. Keep verified-account linking, database-backed
  single-use state, signed browser binding, PKCE, and callback URL validation.
- Preserve `BETTER_AUTH_SECRET` and `VISITOR_HASH_SECRET` through cutover.
  Never commit credentials, log SQL parameters, or log auth/provider error objects.
- Email uses the user-requested Rust `email-sdk` pinned to 0.1.1, Cloudflare
  provider, and rendered verification templates in `crates/api/src/email/`.
  Preserve `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `EMAIL_FROM`.
  Check recipient acceptance; disable automatic retries/fallbacks because the
  provider has no send idempotency. Disabled external effects fail closed.
- Polar has no official Rust SDK. The typed HTTP adapter preserves the pinned
  API version and `config/polar-catalog.json`, with no automatic HTTP retries.
  Preserve the configured webhook secret unchanged. Verify both Polar's legacy
  raw UTF-8 signing (including `whsec_`) and Standard Webhooks decoded 32-byte
  keys for secrets generated from 2026-09-08. Keep exact body bytes and timestamp tolerance.
- Preserve organization-scoped entitlements, monotonic customer timestamps,
  webhook deduplication, stable usage event IDs, and complete inserted-plus-duplicate
  outbox acknowledgments. Keep checkout/portal/customer sync and deletion policy.
- Unpaid users can finish onboarding and select a plan. Onboarding completion
  does not grant subscription access to protected workspace routes.
- Imports preserve Plausible/GA4 CSV contracts, bounded safe ZIP extraction,
  Unicode canonical fingerprints, PostgreSQL timezone/DST boundaries, preview
  checks, duplicate detection, overlap rules, and serialized transactional writes.
  ICU collation is pinned for fingerprint stability; review changes before upgrading.
- Optional normalized import archives use official `aws-sdk-s3`, existing
  `imports/{environment}/{id}.json` keys, and `S3_*` settings. Never archive raw
  uploads. Configured writes fail closed with disabled effects. Keep Ring-backed
  Smithy HTTP to avoid ambiguous Rustls crypto providers.

## Workers and deployment

Do not deploy without an explicit request. Use Unkey Compute, never Railway.
The root Dockerfile builds frontend assets and Rust separately; the runtime
contains only the Rust server and static assets, running as a non-root user.

- PostgreSQL `ingestion_receipts` is the durable analytics queue. Workers poll,
  reapply current tracking policy, and atomically commit analytics, usage outbox,
  and receipt state under the owner lock.
- Redis Streams carries sanitized diagnostics. Keep consumer groups,
  `XAUTOCLAIM` recovery, and commit-before-acknowledge/delete. Do not trim
  unacknowledged entries. Do not consume the prior BullMQ queues.
- Use the configured Upstash TLS `REDIS_URL` and a distinct Rust `QUEUE_PREFIX`.
  Before any requested cutover, stop old writers and drain old queues. Keep
  API/workers on the same database, Redis, and prefix.
- `SERVICE_ROLE=combined` initially; `api` and `worker` also supported.
  Worker-only HTTP exposes health/readiness/metrics, not application routes.
  Retention uses Timescale chunks plus bounded deletion batches and durable tombstones.
- Readiness `/health/ready`, liveness `/api/health`. Honor `PORT`.
  Allow at least 90 seconds for graceful HTTP/worker transaction draining.
  Never upload owner or legacy-source database credentials to the runtime.
- Trust Cloudflare forwarding headers only with matching `x-analytics-origin-key`.
  Protect `/internal/metrics` with its bearer token.
  Preserve Polar webhook `/api/webhooks/polar`.
- Enable live external effects only after a verified, explicitly requested cutover.
  Local checks do not prove deployment, real delivery, OAuth consent, live billing,
  or production migration. Container execution requires separate validation where
  Docker is available; this workspace currently has no Docker/container engine.

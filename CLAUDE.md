# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Datix is privacy-first website analytics (usedatix.com; the legacy `analytics.beer` domain and its tracker snippets stay live). A Rust/Axum API serves both `/api` and the built SPA; Vite is a frontend-only dev server.

`AGENTS.md` carries the operational detail (env vars, QA script contracts, localization rules). Read it before deployment, schema, or QA work.

## Commands

Rust 1.96 and Bun 1.4.2. Copy `.env.example` to `.env`. Dev Redis must be running at `127.0.0.1:6393` with AOF and `noeviction`.

```sh
bun install --cwd web --frozen-lockfile
redis-server --bind 127.0.0.1 --port 6393 --appendonly yes --maxmemory-policy noeviction
bun run --cwd web dev          # Vite :3000 proxying /api and /health to Axum :3001
```

```sh
bun run --cwd web typecheck && bun run --cwd web test
bun run --cwd web lint && bun run --cwd web format:check
cargo test --locked --workspace
cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings
```

Single tests:

```sh
bun test tests/unit/tracker.test.ts                       # from web/
cargo test --locked -p analytics-services
cargo test --locked -p analytics-server --test integration <filter> -- --ignored --test-threads=1
```

`cargo test --workspace` skips the ignored DB/Redis integration tests. Those need `TEST_DATABASE_URL` on a host that differs from `DATABASE_URL`, `RUST_TEST_REDIS_URL`, and `--test-threads=1`; wrap ad-hoc commands with `bun web/scripts/rust-test-env.ts -- <cmd>` to point at the isolated pair. There is no CI workflow — these commands are the gate.

`web/scripts/*.ts` `chdir` to the repo root, so invoke them as `bun web/scripts/<name>.ts` from anywhere. The `*-qa.ts` smoke scripts need a running app and stay on localhost unless the script documents `--production`.

## Architecture

### Request path

`web/public/tracker.js` → `POST /api/collect` → Redis Stream (`analytics:events:v2`, group `analytics-rust`) → worker `ingest` → Postgres → `/api/sites/*` report endpoints → React dashboard.

Collection never writes to Postgres synchronously. Event IDs must stay stable across retries, because ingest and goal conversion both dedupe on them.

### Crates

- `crates/core` — `Config`/`State` (pool, Redis connection manager, `reqwest` client, metrics, report cache), errors, crypto, validation, and the schema check plus versioned upgrades.
- `crates/services` — the domain: `auth`, `sites`, `collect`, `ingest`, `queue`, `reports`, `billing`, `imports`, `abuse`, `retention`, `tracking`, `features`.
- `crates/server` — Axum router, SPA fallback, background jobs. Binaries: `analytics-server`, `analytics-db`, `analytics-queue`.

### Roles

One binary, `SERVICE_ROLE` selects behaviour. `combined` locally. Production runs `api` (HTTP plus static SPA) alongside `worker` (ingest, billing delivery, retention, pulse; exposes only health and metrics, no SPA). `crates/server/src/http/mod.rs` returns early with just the operational routes when the role is `Worker`, and `crates/server/src/jobs.rs` holds the loops (event, maintenance, billing, observation, pulse), each guarded by a Redis lease so multiple workers do not double-run.

### Cross-cutting middleware

`crates/server/src/middleware.rs::perimeter` wraps every non-worker route: it derives client IP and country, authenticates into a `Context` extension, **strips** client-supplied `cf-connecting-ip` / `cf-ipcountry` / `x-analytics-*` headers before the handler sees them, rewrites error bodies into the `{error:{code,message,requestId}}` shape, and sets CORS only for `/api/collect`, `/api/telemetry`, `/api/tracker-config`. Cloudflare country is trusted only when `CLOUDFLARE_ORIGIN_SECRET` matches. `GET /internal/metrics` 404s without a valid `Authorization: Bearer <METRICS_TOKEN>`.

### Schema

Startup **checks** compatibility and never migrates; a checksum mismatch makes the service return 503 `schema_upgrade_required`.

- `crates/core/migrations/0001_existing_schema.sql` is the empty-DB baseline only (`analytics-db init-empty`) and refuses populated databases.
- `crates/core/upgrades/000N_*.sql` are versioned and checksummed. Append new files to `UPGRADES` in `crates/core/src/database.rs`; applied SQL is immutable.
- `docs/database/live-schema.json` is the column manifest the check compares against — update it in the same change as the upgrade.

`events` and `activity_events` are daily-partitioned. SQLx uses runtime queries; there is no `SQLX_OFFLINE` cache, so query errors surface at test time rather than compile time. Larger SQL lives in `sql/*.sql` files next to its module and is pulled in with `include_str!`.

### Auth

Authentication is hand-written Rust in `crates/services/src/auth.rs`. The env var `BETTER_AUTH_SECRET` and the cookies `better-auth.session_token` / `__Secure-better-auth.session_token` are historical names that must be kept. The `better-auth` dependency in `web/package.json` is used by fixtures and scripts only — it is not the server.

### Billing

Polar is the provider. `config/polar-catalog.json` pins the organization, product IDs, benefit IDs, and the usage meter; both Rust (`billing/catalog.rs`) and the frontend (`web/src/lib/billing-plans.ts`) read it. All checkout currencies are USD regardless of UI language. Annual products are drafts — the API rejects annual checkout and the UI shows the prices as coming soon; do not enable them from a frontend flag alone.

Enforcement is local, not a per-event provider call: `billing/admission.rs` loads one snapshot per site/environment (tracking mode, domain, credit budget, subscriptions, usage) that `collect` checks, `billing/allowance.rs` derives the active period, and `billing/delivery.rs` drains `billing_outbox` to Polar from the worker. `docs/autumn.md` describes the superseded Autumn integration and must not be used for configuration.

### Optional features

`crates/services/src/features/` holds per-environment switches stored in `environments.feature_settings`: goals, error tracking, web vitals, geography globe, pulse uptime monitoring. `features::KEYS` is the single source of truth for the key set and `validate` requires every key present as a boolean, so adding a feature means touching that array, the schema manifest, and the frontend `web/src/lib/features.ts` together. Diagnostics ride the same Redis stream but never affect pageviews, journeys, or billing usage. Details are in `docs/features.md`.

### Frontend

`web/` is the only JS package — there is no root `package.json`. React 19, TanStack Router, Tailwind 4, Bun as the runtime and test runner.

- Do not edit `web/src/routeTree.gen.ts` (generated by TanStack Router).
- Edit the tracker at `web/public/tracker.js`; `bun run --cwd web build` minifies it into `dist/client`.
- Charts use the in-repo `web/src/components/dither-kit/` primitives rather than a charting library, and the globe renders bundled Natural Earth geometry (`web/public/world-countries.json`) — no third-party map requests.
- Oxfmt with single quotes; oxlint for linting.
- Locales are `en` / `da` / `de`, and the English source strings in `web/src/lib/i18n/en.ts` are the keys. Other catalogs are `Record<Copy, string>` with identical `{placeholders}`. Translate whole sentences via `t()` / `Translated`; leave website names, paths, event names, snippets, and CSV column names untranslated. API errors stay English.

### Contract

`config/openapi.json` is the HTTP contract and is served at `/api/openapi.json`. Keep it in step with route changes.

## Repository notes

`ROADMAP.md` describes the pre-Rust Cloudflare Worker stack and is stale — trust `README.md` and `docs/deployment.md` instead.

# Analytics Beer

Privacy-first website analytics. Axum serves `/api` and `web/dist/client`; Vite is the frontend only. Trust `README.md` and `docs/deployment.md` over `ROADMAP.md` (that file describes the pre-Rust Cloudflare Worker stack).

## Layout

- `crates/core` — config, pool, errors, schema check/upgrades
- `crates/services` — auth, sites, collect, ingest, reports, billing, imports, abuse, retention, queue
- `crates/server` — Axum routes, static fallback, jobs; bins `analytics-server`, `analytics-db`, `analytics-queue`
- `web/` — the only JS package (Bun). No root `package.json`
- `config/openapi.json` — HTTP contract; `config/polar-catalog.json` — Polar products

JS/Cargo commands from the paths above. `web/scripts/*.ts` `chdir` to the repo root, so run them as `bun web/scripts/<name>.ts`.

## Commands

Rust 1.96, Bun 1.4.2. Copy `.env.example` → `.env`. Dev Redis: `127.0.0.1:6393` (AOF, `noeviction`).

```sh
bun install --cwd web --frozen-lockfile
bun run --cwd web dev          # Vite :3000, Axum :3001, APP_URL=http://localhost:3000
bun run --cwd web typecheck && bun run --cwd web test
bun run --cwd web lint && bun run --cwd web format:check
cargo test --locked --workspace
cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings
```

Oxfmt uses single quotes. Do not edit `web/src/routeTree.gen.ts` (TanStack Router). Edit the tracker at `web/public/tracker.js`; `bun run --cwd web build` minifies it into `dist/client`.

Focused checks:

```sh
bun test tests/unit/tracker.test.ts          # from web/
cargo test --locked -p analytics-services
cargo test --locked -p analytics-server --test integration <filter> -- --ignored --test-threads=1
```

`cargo test --workspace` skips ignored DB/Redis tests. There is no GitHub Actions workflow.

## Runtime

`SERVICE_ROLE` is `combined` locally. Production is `api` (HTTP + static) plus `worker` (ingest/billing/retention only; health/metrics, no SPA). Collection enqueues to Redis Streams (`analytics:events:v2`, group `analytics-rust`); workers ingest into Postgres. Keep event IDs stable across retries.

Env names are historical: `BETTER_AUTH_SECRET` and cookies `better-auth.session_token` / `__Secure-better-auth.session_token`. Auth is Rust (`crates/services/src/auth.rs`). Keep those names. `better-auth` in `web/package.json` is fixtures/scripts, not the server.

SQLx uses runtime queries. There is no `SQLX_OFFLINE` / `.sqlx` cache.

Country from Cloudflare is trusted only with `CLOUDFLARE_ORIGIN_SECRET`. `GET /internal/metrics` needs `Authorization: Bearer <METRICS_TOKEN>` or it 404s.

## Schema

Startup **checks** compatibility and never migrates. Mismatched checksums → 503 `schema_upgrade_required`.

- `crates/core/migrations/0001_existing_schema.sql` — empty-DB baseline only (`analytics-db init-empty`). Refuses populated databases.
- `crates/core/upgrades/0002_*.sql` onward — versioned, checksummed. Append new files to `UPGRADES` in `crates/core/src/database.rs`. Applied SQL is immutable.
- `docs/database/live-schema.json` — column manifest the check compares against. Update it with the upgrade.

```sh
cargo run --locked -p analytics-server --bin analytics-db -- check
cargo run --locked -p analytics-server --bin analytics-db -- upgrade   # owner role, existing DBs
```

`events` and `activity_events` are daily-partitioned. See `docs/deployment.md` and `docs/scaling.md` for Railway cutover and connection budgets.

## Tests and QA

Ignored integration tests (`crates/server/tests/integration.rs`, including `imports` and `scaling`) need:

- `TEST_DATABASE_URL` whose host equals `TEST_DATABASE_HOST`
- that host **different** from `DATABASE_URL`
- Redis `RUST_TEST_REDIS_URL` (default `redis://127.0.0.1:6394`)
- `--test-threads=1`

They create `rust-it-*` users and delete their own rows. Wrap ad-hoc commands against the test branch with `bun web/scripts/rust-test-env.ts -- <cmd>` (rewrites `DATABASE_URL`/`REDIS_URL` to the isolated pair).

HTTP/browser smokes (`web/scripts/smoke.ts`, `browser-smoke.ts`, `*-qa.ts`) require a running app and stay on localhost unless a script documents `--production`. They insert disposable fixtures. Playwright Chromium: `bunx playwright install chromium`. Artifacts go to gitignored `web/artifacts/`.

## UI copy

Locales: `en` / `da` / `de`. English source strings are the keys (`web/src/lib/i18n/en.ts`); other catalogs are `Record<Copy, string>` with the same `{placeholders}`. Use `t()` / `Translated` for whole sentences. Keep website names, paths, event names, snippets, and CSV column names untranslated. API errors stay English; `message()` localizes known templates only. Cookies: `ab-language`, `ab-theme`. Details: `docs/localization.md`.

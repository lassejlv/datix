# Analytics Beer

A small analytics app built with Axum in Rust, a static React/TanStack Router frontend, Railway, Redis Streams, compatible signed authentication sessions, SQLx, and Neon PostgreSQL. The responsive dashboard uses Tailwind v4, coss components, [Dither Kit charts](https://www.tripwire.sh/dither-kit), and self-hosted IBM Plex Sans. It follows the system light/dark theme. Dashboard tabs, website changes, and sign-in/sign-up views use a short fade-and-rise transition; reduced-motion preferences disable these animations. The product domain is `analytics.beer`.

Create an account, add a website, copy its script, and check for the first pageview. The dashboard shows pageviews, daily visitor estimates, custom events, date ranges, and page/referrer/country/device breakdowns. Website settings support renaming, pausing collection, and deletion with confirmation. All reports come from the API. Onboarding includes a clearly labeled interactive sample; it does not create traffic in your account.

The public homepage is a centered landing page with a custom eight-second stop-motion mascot video. `/signup` opens account creation and `/signin` opens sign in; authenticated visitors to either enter their dashboard. Legacy auth query links redirect to these routes. Existing site, environment and report deep links still open the application. The video follows the system theme, honors reduced motion, and pauses offscreen. The preview dialog uses a real dashboard screenshot with clearly labeled example data. See [landing page design and media notes](web/docs/landing-page-design.md). Run `bun web/scripts/landing-qa.ts` for the landing page browser checks. Source artwork lives in `web/output/landing-media`; `bun web/scripts/render-landing-video.ts` rebuilds the loops using local Chromium, FFmpeg and cwebp.

## Repository layout

- `web/`: React frontend, tracker and media assets, Vite configuration, frontend package, unit tests and browser verification scripts.
- `crates/`: Rust Cargo workspace with core, services and Axum server crates.
- `config/`: shared API contract and billing catalog.
- `web/scripts/` and `web/tests/fixtures/`: JavaScript browser and migration verification utilities.

All JavaScript dependencies and tooling live in `web/`, with its own package manifest and Bun lockfile. Production serves `web/dist/client` with the Rust binary.

## Development

Use Rust 1.96 and Bun 1.4.2. PostgreSQL stays on Neon; Redis is required for queues and rate limits.

```sh
bun install --cwd web --frozen-lockfile
# Copy .env.example to .env and fill in development credentials and random secrets.
redis-server --bind 127.0.0.1 --port 6393 --appendonly yes --maxmemory-policy noeviction
# Starts the frontend dev server plus Axum with its background jobs:
bun run --cwd web dev
```

Open [localhost:3000](http://localhost:3000) to match `APP_URL`. `bun run --cwd web dev` starts Vite on port 3000 and Axum on port 3001; Vite proxies `/api` and `/health` to Axum. The Rust backend runs event consumption and maintenance jobs in the same process. Use `DEV_PORT` and `DEV_API_PORT` to change development ports, and keep `APP_URL` aligned with the frontend origin. `DATABASE_URL` and secrets are server-only. Keep production Polar credentials out of local runs.

| Resource                   | Value                                                          |
| -------------------------- | -------------------------------------------------------------- |
| Neon project               | `analytics` / `billowing-night-55335840`                       |
| Organization               | Team Lasse                                                     |
| Region                     | AWS Frankfurt (`aws-eu-central-1`)                             |
| PostgreSQL                 | 17                                                             |
| Database                   | `analytics`                                                    |
| Development branch         | `development` / `br-late-brook-b1z9dchn`                       |
| Test branch                | `api-tests` / `br-fragrant-bar-b1ua6epq`                       |
| Production branch          | `production` / `br-frosty-frost-b18zvthi` (protected, default) |
| Compute per branch         | 0.25–1 CU, suspend after 300 seconds idle                      |
| Configured restore history | 24 hours; a restore drill remains a launch task                |

## API

See [the API guide](docs/api.md). The OpenAPI contract for application endpoints is served at `/api/openapi.json`; Authentication endpoints are described separately in the guide.

```html
<script defer src="https://YOUR-API-HOST/tracker.js" data-site="YOUR-SITE-UUID"></script>
```

```js
window.simpleAnalytics.track('signup');
```

The tracker records the initial page and History API navigation. It ignores query-string-only and fragment-only navigation, respects Do Not Track, and sends no analytics cookies. Global Privacy Control does not suppress collection. Repeated pageviews of the same origin/path are throttled for 60 seconds per site and tab, including reloads and return navigation. The tracker keeps recent pageview timestamps in sessionStorage, falls back to memory if storage is blocked, and logs `Pageview ignored - throttled (same URL within 1 minute)`. Skipped attempts do not extend the window; custom events are unaffected. Event IDs are reused on limited network/5xx retries. CSP must permit the script host and `connect-src` collector.

To test from a local website, turn on **Allow localhost for testing** in Installation or Website settings. It accepts `localhost`, `127.0.0.1`, and `::1` on any port using the same script. The option is off by default, and test activity is included in that website’s reports. DNT still prevent collection. On local pages the tracker logs skipped initialization and collector HTTP statuses to the browser console; add `data-debug` to the script tag to enable the same diagnostics elsewhere.

## Validation

Oxfmt handles formatting (with single quotes to match the existing source), and Oxlint checks correctness with TypeScript and React rules. Generated route/Worker types, migration metadata, and captured artifacts are excluded.

```sh
bun run --cwd web lint
bun run --cwd web lint:fix
bun run --cwd web format
bun run --cwd web format:check
```

`lint:fix` applies safe lint fixes; `format` rewrites supported files. The other two commands only check files and can be used in CI.

```sh
bun run --cwd web test
cargo test --locked --workspace
cargo test --locked -p analytics-server --test integration -- --ignored --test-threads=1
bun web/scripts/smoke.ts
bun web/scripts/browser-smoke.ts
bun run --cwd web typecheck
bun run --cwd web build
```

Integration tests use the isolated Neon test branch. They test real PostgreSQL and real local Redis, including queue reconnects, retries, duplicate suppression and atomic limits. Set `RUST_TEST_REDIS_URL` (default `redis://127.0.0.1:6394`) to the isolated local Redis. They refuse to use the development hostname and clean up only users created by that run. Run integration suites serially with the supplied command.

The smoke and browser tests require `bun run --cwd web dev` in another terminal, or `bun run --cwd web build` and `cargo build --locked --release --workspace`, followed by `./target/release/analytics-server` to check the production build. The same Rust process serves the frontend/API and consumes the queued events. The API smoke test exercises HTTP requests through Redis into the Rust worker and Neon, then deletes its own fixtures. The browser test also checks onboarding, tracker execution, reports, settings, sign-in, keyboard interactions, and mobile layout. It requires Playwright Chromium (`bunx playwright install chromium`). Successful runs write `web/artifacts/api-smoke.json`, `web/artifacts/browser-qa.json`, and screenshots. Screenshots show synthetic traffic created solely for the disposable QA account.

Validation reports and screenshots are local outputs under `web/artifacts/` and are excluded from Git. Run `bun web/scripts/design-state-check.ts` and `bun web/scripts/chart-qa.ts` with the app running to repeat the form interaction and contrast checks.

## Database and backend

The Cargo workspace separates `analytics-core` (configuration, SQLx pool, errors, validation, schema), `analytics-services` (authentication, sites, collection, ingestion, reporting, billing, abuse and retention), and `analytics-server` (Axum routes, middleware and background tasks).

The schema was read directly from the existing Neon database. The DDL snapshot and column manifest are in `docs/database`; SQLx queries use the existing tables and preserve all current data. Startup checks schema compatibility without applying migrations.

```sh
cargo run --locked -p analytics-server --bin analytics-db -- check
# Only for an empty database, never an existing installation:
cargo run --locked -p analytics-server --bin analytics-db -- init-empty
```

Future schema changes belong in `crates/core/migrations` as reviewed SQL. The baseline is exclusively for initializing an empty database. Production migration application must be explicit; startup never changes the schema.

Production runs at [analytics.beer](https://analytics.beer) on Railway with one Rust service, Redis, and the existing Neon production branch. See [deployment and operations](docs/deployment.md) for runtime, queue cutover and rollback instructions.

## Website environments

Use **Add environment** in the dashboard to separate Production, Staging, Testing, or any custom name. Each environment has its own tracking snippet, reports, domain, localhost permission, and pause control. Existing sites and scripts automatically use Production. Switch environments above the report; your selection is remembered per website. Environment deletion affects only its own traffic.

## Cookie-based session mode

In **Website settings → Tracking mode**, choose **Cookie-based · sessions and activity** for the selected environment. This opt-in mode tracks consented sessions, page visits, clicks, links, downloads, form submissions, scroll depth, active time, and device/browser details. The Visitors page shows visit history, friendly anonymous aliases, page trails, and chronological activity. Use View visitor history to see other visits by that visitor in the selected period.

Choose cookie-based sessions or **Cookieless visitors · local storage** in Settings. Both visitor modes require analytics consent; the local-storage mode creates no tracking cookies. Install provides the script and consent callback; nothing is collected before analytics consent. The banner must also support rejection and withdrawal. Detailed activity expires after 30 days. Cookieless remains the default. See [the integration and data reference](docs/api.md#cookie-based-sessions-and-activity).

### Dashboard URLs

Dashboard pages use `/site/:siteId/:environmentId/:page`, where `page` is `overview`, `visitors`, `installation`, or `settings`. Links support refresh, bookmarking, and browser back/forward. `/dashboard` opens your remembered website and environment; `/signin` and `/signup` open authentication. Old `?site=…&environment=…&view=…` links redirect to the new routes. A missing or inaccessible environment displays an unavailable message.

Run `bun web/scripts/routes-qa.ts` to verify routing with a disposable local account, or `bun --env-file=.env.production web/scripts/routes-qa.ts --production` for production.

Local-storage visitor QA: `bun --env-file=.env.production web/scripts/sessions-qa.ts --production --local-storage`. Cookieless remains the default and includes anonymous daily visitor journeys from retained pageviews and custom events; no existing environment is switched automatically.

Default cookieless mode includes browser/OS, device, viewport/screen dimensions, language, clicks, links, downloads, form submissions, scroll depth and active time. It sends an anonymous `activity` context, never client visitor/session identifiers. The existing daily hash groups visits; identities reset each UTC day. Field values and page text are excluded. `data-analytics-ignore` and Do Not Track are respected. A sessionStorage pageview throttle contains only paths/timestamps, not visitor IDs. Browser QA: `bun --env-file=.env.production web/scripts/sessions-qa.ts --production --cookieless`.

### Usage limits

The account Usage tab (`/usage`, `GET /api/usage`) shows monthly events across all websites and environments. Collection requires an active Pro subscription or unexpired Pro trial. At the event limit, all account sites pause automatically until renewal or upgrade; historical reports remain available. Pageviews and actions count, while engagement heartbeats and duplicate deliveries do not. Pro supports ten websites. Deleting a site does not erase its usage. See `docs/polar.md` for billing setup and verification.

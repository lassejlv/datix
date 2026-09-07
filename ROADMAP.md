# Analytics

Goal: build a low-cost analytics product on Cloudflare with Neon PostgreSQL.

## API milestone: implemented and verified

- [x] Worker/TanStack Start foundation, generated binding types, Vite 8
- [x] PostgreSQL schema and versioned migrations on Neon development and test branches
- [x] Better Auth account and session endpoints
- [x] Owner-scoped website management
- [x] Validated collection endpoint and lightweight tracker
- [x] Queue consumer with transactional event deduplication
- [x] Daily summaries, overview, time series, breakdowns
- [x] Retention job and abuse controls
- [x] Real Neon integration and local Worker HTTP verification
- [x] API contract and deployment instructions

Verified 2026-09-06: 11 unit tests, 14 Neon integration tests, development and production-preview HTTP smoke tests, TypeScript, Vite 8 production build, frozen Bun install, client secret scan, and Worker deployment dry run. Production is deployed to analytics.beer; see the live verification record in `artifacts/production/`.

## Frontend milestone: implemented and verified

- [x] Website onboarding, tracking snippet, and live installation verification
- [x] Account creation, sign-in, sign-out, and expired-session handling
- [x] Analytics dashboard with date selection, three metrics, and five breakdowns
- [x] Website selection, rename, pause/resume, and guarded deletion
- [x] Responsive layouts, labelled controls, keyboard chart inspection, and mobile drawer focus handling
- [x] Chromium validation against development and production preview using real API/Queue/Neon paths

Desktop and mobile screenshots and browser checks are recorded in `artifacts/`. Data in screenshots belongs to disposable test accounts; the app itself only displays API results.

## Production deployment

- [x] Separate empty, protected Neon production branch with versioned migration history
- [x] Production Worker and Queues, including a dead-letter queue with 14-day retention
- [x] Hyperdrive with query caching disabled and a restricted database runtime role
- [x] Independent production secrets and analytics.beer custom domain

## Remaining operations work

- Enable email verification/recovery with a mail provider
- Exercise backup restoration and configure queue failure/usage alerts

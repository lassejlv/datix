# Datix

Bun + Hono + Effect v4 API in `apps/api`, React frontend and tracker in `apps/web`, Drizzle schemas and migrations in `packages/db`. Preserve existing API routes, payloads, auth cookies, and billing contracts.

Email delivery and React Email templates live in `packages/email` (`@datix/email`). Unverified accounts must not access protected API routes; keep verification and resend flows available.

Use one Neon PostgreSQL 18 database with TimescaleDB for application and analytics data. Bun provides SQL, Redis, and optional S3; BullMQ handles background delivery. Use Timescale chunks and indexes, not a separate analytics store or manual partitions.

## Development

- Install with `bun install --frozen-lockfile`; respect the pinned versions and lockfile.
- Copy `.env.example` to ignored `.env`. Never commit credentials or log SQL parameters/auth error objects.
- `bun run dev` starts web on port 3000 and API on 3001, with billing effects disabled and a separate queue prefix. It still uses the configured database: use an isolated branch for development.
- `bun run fmt` applies blank-line rules and Vite+ formatting; bare `vp fmt` does not add blank lines. Shared tooling lives in `vite.config.ts`; exclude generated files and applied migrations.
- `bun run check` runs formatting, lint, TypeScript, and API tests. Also run `bun run --cwd apps/web test` for frontend changes and `bun run build` for build changes. Keep tests focused.
- Behavior changes require `bun run test:integration` against a fresh isolated branch configured through `.env.test.example`. Never use production for test fixtures. Previous test branches were deleted.

## Effect

Before writing Effect code, read `node_modules/effect/AGENTS.md` completely and follow its relevant links. For additional APIs, inspect `node_modules/effect/src`.

Use `Context.Service`, `Layer.effect`, `Effect.fn`, and typed errors. Keep resource ownership scoped and the managed runtime at Hono/BullMQ boundaries. Native SQL transactions and SDK callbacks may use Promises inside `Effect.tryPromise`; never start a runtime inside business transactions.

Use Context7 for current library documentation: resolve with `bunx ctx7@latest library`, then fetch `docs`. Never include credentials in queries.

## Database and migration

Neon project: `datix-timescale` (`rapid-flower-57581427`). Production branch: `br-ancient-smoke-b1le6vrt`, named `production`; database: `datix`.

- Runtime uses the restricted pooled `DATABASE_URL`. Direct owner `DATABASE_URL_UNPOOLED` is for migration tools only. Preserve UTC and runtime query/lock timeouts; startup validates schema checksums, privileges, and hypertables.
- Never edit an applied migration. Generate with `bun run db:generate` and review the SQL. Inspect a target with `bun run db:migrate --expect-host HOST`; add `--apply` deliberately. Run `bun run db:runtime --expect-host HOST --apply` after new tables to refresh grants. Role-default changes require fresh database connections.
- Data-copy templates are `config/data-migration.example.json` (split sources) and `config/data-migration.legacy.example.json` (monolithic Rust). Copy the chosen plan to `.local/` and validate source/destination identities independently.
- `bun run data:copy --plan PATH` is read-only inventory. Rehearse against an isolated empty target using `--apply --snapshot --targets-quiesced`, then `--verify` against the same stable source. Sources are never modified.
- Final copying requires drained old queues, stopped source and destination writers, and `--source-quiesced` instead of `--snapshot`. Verify before traffic cutover. Resume only with the same plan and unchanged source; copying is not incremental synchronization.
- Preserve `BETTER_AUTH_SECRET` and `VISITOR_HASH_SECRET` through migration. Use a new queue prefix to avoid consuming old jobs. Keep reports and credentials in ignored local files.

Use `@polar-sh/sdk` for Polar requests and webhook verification. Keep Datix entitlement checks and durable outbox acknowledgments; disable SDK retries because the outbox owns retries. Pass the webhook secret unchanged to the SDK.

## Deployment and access

Do not deploy without an explicit request. Use Unkey Compute, never Railway. Build from the root `Dockerfile`; the server serves the built web app and API on one origin.

- Readiness: `/health/ready`; liveness: `/api/health`. Honor `PORT` and allow at least 90 seconds for shutdown draining.
- Start with `SERVICE_ROLE=combined`. Separate API/workers must share database, Redis, and `QUEUE_PREFIX`; keep total connections within Neon's budget.
- Use the configured Upstash TLS `REDIS_URL`. Never upload owner or legacy-source database credentials to the runtime. Enable live billing effects only after verified cutover.
- Preserve OAuth callbacks `/api/auth/callback/github` and `/api/auth/callback/google`, and Polar webhook `/api/webhooks/polar`.
- Trust Cloudflare forwarding headers only with the matching `x-analytics-origin-key`. Protect `/internal/metrics` with its bearer token.
- Unpaid users must be able to finish onboarding and reach plan selection. Completing onboarding must not grant subscription access to protected workspace routes.

Local checks do not prove deployment, OAuth consent, real billing, or production data migration. Verify those separately when requested; do not infer live status from old test results.

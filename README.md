# Datix

Bun + Hono + Effect TS v4 in a Vite+ monorepo. The existing frontend lives in `apps/web` and uses the same API routes, payloads, cookies, and billing catalog.

| Directory           | Purpose                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `apps/api`          | Hono HTTP boundary, Effect services, Better Auth, ingestion, reports, billing, admin, imports |
| `apps/web`          | Existing React + TanStack Router frontend and tracker                                         |
| `packages/database` | Drizzle schemas, Bun SQL adapter, immutable PostgreSQL/Timescale migrations                   |
| `scripts`           | Local development, schema/role setup, data copying, focused integration checks                |
| `config`            | API specification, billing catalog, migration plan templates                                  |

All application and analytics data lives in one Neon PostgreSQL 18 database. Six Timescale hypertables provide time partitioning and chunk retention. New events are queried directly; legacy daily totals are retained only to preserve history whose raw events have already expired. There is no separate analytics database runtime or manual partition-management service.

Bun provides SQL, Redis and optional S3 access. BullMQ handles delivery with durable database receipts and a billing outbox. Effect owns resources, typed failures, service composition, and scoped background recovery. Promise callbacks remain at native SQL transactions and external-library boundaries.

## Run locally

Bun **1.4.2** is pinned. Effect is pinned to **4.0.0-rc.115**. Install dependencies from the repository root:

```sh
bun install --frozen-lockfile
bun run dev
```

`dev` serves the frontend at `http://localhost:3000` and API at `http://localhost:3001`. It uses the ignored root `.env`, overrides the application origin for localhost, disables external billing effects, and uses a separate development queue prefix. The provided Upstash connection is configured in `.env`.

For a new checkout, copy `.env.example` to `.env` and fill in credentials. The provisioned database is already initialized. To initialize a different, empty database, use the explicit schema and role commands in [the migration runbook](docs/migration.md).

```sh
bun run fmt         # Format the monorepo
bun run fmt:check   # Check formatting without writing
bun run lint        # Lint the monorepo
bun run lint:fix    # Apply safe lint fixes
bun run check       # Vite+ format/lint checks, TypeScript, and API tests
bun run --cwd apps/web test
bun run test:integration
bun run build
```

Formatting and linting are configured centrally in `vite.config.ts`. `bun run fmt` first applies the Stylistic blank-line rule through Vite+ lint, then runs Vite+ formatting. This adds spacing after imports, around functions and multiline declarations, and before control flow and returns. `bun run fmt:check` and `bun run check` enforce that spacing. Use the Bun scripts for the complete formatting workflow; bare `vp fmt` preserves blank lines but does not insert them. Generated assets, build output, and applied database migrations are excluded. Existing React effect, ref, purity, and dependency findings in frontend components remain warnings; other correctness findings fail the check. TypeScript uses the existing per-package checks.

The integration suite requires the isolated database settings described in `.env.test.example`. The API build is `apps/api/dist/main.js`; the frontend build is `apps/web/dist/client`.

## Infrastructure and migration

The new Neon project is **datix-timescale** (`rapid-flower-57581427`), in `aws-eu-central-1`, with PostgreSQL **18.6** and TimescaleDB **2.24.0**. Its default branch is `production`. The disposable `api-tests` and `migration-rehearsal` branches were deleted after verification; create a fresh isolated branch and update the test environment before running live integration tests or copy rehearsals again.

Neon exposes the Apache-licensed Timescale feature set. This implementation uses hypertables, indexes and `drop_chunks`; it does not require compression or continuous aggregates. See [Neon's Timescale documentation](https://neon.com/docs/extensions/timescaledb).

Data-copy scripts support both the older monolithic Rust database and the later split source layout, with one Neon destination. They default to read-only inspection and verify every copied column and row count. See [migration](docs/migration.md), [Unkey container setup](docs/unkey.md), and [verification evidence](docs/verification.md).

Nothing has been deployed or pushed. Unkey Compute is the intended runtime target.

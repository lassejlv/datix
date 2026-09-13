# Datix

Bun + Hono API in `apps/api`, unchanged React frontend in `apps/web`, Drizzle schemas and migrations in `packages/database`. One Neon PostgreSQL 18 database with TimescaleDB. Use Bun, Vite+ and Effect v4; preserve existing web/API contracts.

Do not deploy without an explicit request. Unkey Compute is the runtime target. Do not use Railway deployment tooling.

Never edit an applied migration. Use the restricted runtime database role. Migration tools default to read-only inspection and must validate the independent target identity. Keep credentials in ignored environment files.

## Learning more about Effect

This repository uses the Effect Typescript library, pinned to v4.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md` **completely**, and follow the links in the file when required.

If you need to learn more about particular Effect APIs and concepts that the guide doesn't cover, search through the source code in `node_modules/effect/src`.

Use `Context.Service`, `Layer.effect`, `Effect.fn`, and typed errors. Keep the managed runtime at Hono and BullMQ boundaries. Bun SQL transaction callbacks and third-party SDK callbacks may use Promises inside `Effect.tryPromise`; do not start an Effect runtime inside business transactions. Keep resource ownership scoped.

Use the Context7 CLI for current library documentation: resolve with `bunx ctx7@latest library`, then fetch the relevant `docs`. Never include credentials in documentation queries.

## Checks

`bun run fmt:check`, `bun run typecheck`, `bun run lint`, `bun test apps/api/tests`, and `bun run --cwd apps/web test`. Run the isolated HTTP integration suite for behavior changes. Build with `bun run build`. Use focused tests; do not duplicate implementations in tests.

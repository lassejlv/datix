# Web frontend

All JavaScript source, dependencies, build configuration and verification tools live here. React and TanStack Router code is in `src/`; the tracker and media are in `public/`. Vite writes `dist/client/`, which the Rust server serves.

From this directory:

```sh
bun install --frozen-lockfile
bun run dev
bun run build
bun run typecheck
bun run test
```

`dev` reads the repository root `.env` and starts Vite plus the root Cargo backend. `dev:frontend` starts Vite alone. Run Cargo commands from the repository root. There is no root JavaScript package or workspace.

Browser and migration checks live in `scripts/`, with shared fixtures in `tests/fixtures/`. They keep operational paths relative to the repository, and write verification output under `web/artifacts/`. From the repository root, run for example `bun web/scripts/routes-qa.ts`; from this directory, use `bun --env-file=../.env scripts/routes-qa.ts`.

# Datix web

The existing React + TanStack Router frontend and tracker, now part of the root Bun/Vite+ workspace. API URLs, response shapes and UI behavior remain unchanged. Vite writes `dist/client`, served by the Hono API in production.

Run commands from the repository root:

```sh
bun install --frozen-lockfile
bun run dev
bun run build
bun run --cwd apps/web test
```

The development command starts both the Bun API and Vite. `bun run --cwd apps/web dev:frontend` runs only Vite and proxies `/api` and `/health` to the local API. Shared billing configuration lives in `config/polar-catalog.json` at the repository root.

# Datix web

The existing React + TanStack Router frontend and tracker. API URLs, response shapes
and UI behavior are unchanged. Standard Vite writes `dist/client`, served by the Rust API.

Run from the repository root:

```sh
bun install --frozen-lockfile
bun run dev
bun run build
bun run --cwd web test
```

The development command builds and starts Rust plus Vite with the isolated
`.local/rust.env` configuration. `bun run --cwd web dev:frontend` runs only Vite
and proxies `/api` and `/health` to the local API. Shared billing configuration
lives in `config/polar-catalog.json`. Standalone Oxlint/Oxfmt retain the existing
lint/format rules without Vite+.

# Datix

Rust/Axum API, Better Auth-compatible authentication, SQLx, and Neon PostgreSQL 18
with TimescaleDB. The unchanged React frontend lives in `web/` and uses standard Vite.

```sh
bun install --frozen-lockfile
bun run dev
bun run check
bun run test:integration
bun run build
```

Development uses the isolated branch in ignored `.local/rust.env`, never the root
production `.env`. The launcher disables external effects and validates its target.
Bun is only frontend tooling; the production server is a Rust binary.

Cloudflare verification emails use Rust `email-sdk` 0.1.1. Configure
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `EMAIL_FROM`.
Sending requires enabled external effects and live billing mode. SDK retries and
fallbacks are disabled; recipient acceptance is checked and provider errors are redacted.

See [AGENTS.md](AGENTS.md) for schema safety, commands, queue cutover, and deployment
boundaries. No deployment or production data writes are part of this migration.

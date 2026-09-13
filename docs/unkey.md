# Unkey Compute

The root `Dockerfile` builds both apps with Bun 1.4.2 and Vite+, installs production API dependencies, and runs the compiled Hono/Effect server as the non-root `bun` user. The same server serves `apps/web/dist/client`, keeping auth cookies and API calls on one origin.

Configure the eventual Unkey build from the repository root with `Dockerfile`. Listen on Unkey's `PORT` (the image defaults to `8080`); health/readiness is `GET /health/ready`. Liveness is `GET /api/health`. The process handles SIGTERM, stops accepting requests, drains HTTP requests, closes the scoped worker and disposes the database/Redis resources. The internal shutdown deadline is 85 seconds; allow a drain period of at least 90 seconds.

Start with `SERVICE_ROLE=combined`, `EVENT_WORKERS=2`, `EVENT_BATCH_SIZE=64`, and `DB_MAX_CONNECTIONS=8`. If API and workers are separated later, set `SERVICE_ROLE=api` / `worker` and give both the same database, Redis URL and `QUEUE_PREFIX`. The worker role exposes health and protected metrics only. Keep the number of replicas within the Neon connection budget. Analytics growth is handled with Timescale chunks and indexes rather than a separate analytics store.

Use the secrets in the ignored `.env` as the source for the eventual runtime configuration. `DATABASE_URL` must be the new restricted pooled Neon connection, and `REDIS_URL` is the supplied Upstash TLS connection. Do not provide owner/migration URLs or legacy source credentials to the deployed service. Keep auth/hash secrets unchanged through migration. Optional S3 settings archive sanitized import metrics; the application remains usable without a bucket.

For production, set `APP_URL=https://usedatix.com`, `NODE_ENV=production`, `BILLING_STATE_MODE=live`, and `EXTERNAL_EFFECTS=enabled` only after the final data copy and traffic cutover. Polar defaults to `https://api.polar.sh`; explicit sandbox use requires both its API URL and a separate `POLAR_SANDBOX_IDS` mapping. Local development and rehearsals disable external effects.

Keep the existing GitHub/Google OAuth applications and callback paths `/api/auth/callback/github` and `/api/auth/callback/google` on the same application origin. Polar webhooks use `/api/webhooks/polar`. Trusted Cloudflare IP/country headers require the matching `x-analytics-origin-key`; direct untrusted headers cannot replace the socket IP. `/internal/metrics` requires the configured bearer token.

No deployment, domain change, secret upload or Unkey project mutation has been performed. No callable Unkey MCP tool was exposed in this session. Container build execution also remains unverified because no Docker/container engine is installed locally; the assembled production dependency layout and compiled server are tested separately.

Reference: [Unkey documentation](https://www.unkey.com/docs).

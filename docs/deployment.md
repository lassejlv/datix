# Deployment and operations

Analytics Beer runs in the [Analytics Beer Railway project](https://railway.com/project/ff5d734f-2a11-4fec-a74d-d2793515f557), production environment. One Hono application runs on Bun 1.4.2, which is the runtime, build tool and package manager. Vite builds the React/TanStack Router frontend into static files in `dist/client`; there is no TanStack Start or separate frontend server in production. `Dockerfile` pins that version and installs from `bun.lock` with `--frozen-lockfile`.

## Services

| Service | Command                          | Responsibility                                                                                        |
| ------- | -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| web     | `bun run start`                  | Hono API, frontend files, Redis event consumption, billing every minute, retention daily at 03:17 UTC |
| Redis   | Redis 8.2 with persistent volume | BullMQ queues and shared atomic rate limits                                                           |

The application stays running on port 3000. `/health/ready` verifies PostgreSQL, Redis, and both job consumers before reporting ready. SIGTERM stops accepting HTTP traffic, drains active requests and jobs, then closes queue and database connections. BullMQ retains retries and schedules in Redis across application restarts. The former standalone worker is retired after the combined app is verified.

`analytics.beer` uses Cloudflare DNS/proxy in front of Railway. Its CNAME target is `b5g0rjxe.up.railway.app`. The diagnostic Railway domain is [web-production-2465a.up.railway.app](https://web-production-2465a.up.railway.app). Authentication keeps `APP_URL=https://analytics.beer`; use that domain for account flows. Cloudflare uses Full TLS mode, as required for its proxied Railway origin. The `_railway-verify` TXT record proves domain ownership.

## Database and secrets

The existing Neon production branch is retained: project `billowing-night-55335840`, branch `br-frosty-frost-b18zvthi`, database `analytics`, Frankfurt. No data copy or schema migration is needed for the hosting move. The combined Bun process uses a PostgreSQL pool capped at 10 connections, with the restricted `analytics_runtime` role. Owner credentials in `.env.production` remain for explicit migrations only.

The application requires `APP_URL`, `DATABASE_URL`, `REDIS_URL`, `BETTER_AUTH_SECRET`, `VISITOR_HASH_SECRET`, `POLAR_ACCESS_TOKEN`, and `POLAR_WEBHOOK_SECRET`. Set `NODE_ENV=production` and `PORT=3000`. `REDIS_URL` references `${{Redis.REDIS_URL}}` over Railway private networking. The signing secrets are preserved from Cloudflare so existing cookies and visitor hashes remain valid. It also requires `CLOUDFLARE_ORIGIN_SECRET`, matching the `x-analytics-origin-key` request transform for `analytics.beer`. Bun checks this secret before accepting Cloudflare country metadata and removes the header before application handling. Railway already resolves `X-Real-IP` to the visitor; the direct Railway URL ignores unauthenticated country headers. Secrets are runtime variables; `.dockerignore` excludes environment files and local artifacts from the image.

## Deploying

The private source repository is [lassejlv/analytics-beer](https://github.com/lassejlv/analytics-beer). The `web` service deploys from its `main` branch. Pushes to `main` build and deploy the combined application with `bun run start`. Redis continues to use its managed image and persistent volume.

Run the checks before pushing:

```sh
bun run deploy:check
# Only when there is a reviewed schema change:
bun run db:migrate:production
git push origin main
```

For a deliberate deployment of local code without pushing GitHub, the existing CLI path remains available:

```sh
railway up --project ff5d734f-2a11-4fec-a74d-d2793515f557 --environment 3f8cf4d9-b6d5-4532-8e1c-dc8ced8a1b76 --service a5cb579e-e445-4882-a49f-6aea52c8480a --detach
```

`bun run deploy` runs the checks and uploads the application with the pinned project/environment/service IDs. Wait for the deployment to report success, inspect runtime logs, then verify an authenticated account and an actual collector → Redis → worker → report round trip on the public domain. A build or health check alone is insufficient. Railway service settings hold the Dockerfile, start command, health check, restart policy and always-on configuration.

## Queue and recovery

Events enter `analytics-events` and retry ten times with exponential backoff. Completed jobs are retained for up to one day/10,000 jobs; failed jobs remain for inspection and retry. PostgreSQL ingestion keeps the existing deduplication and account allowance locks, including when a job is redelivered after a crash. Redis uses append-only persistence with `appendfsync everysec` on its volume and `noeviction`; do not use an evicting cache policy for queues.

Maintenance uses the separate `analytics-maintenance` queue with durable BullMQ schedulers. Billing retains the PostgreSQL outbox and its stable Polar external IDs. A failed Polar delivery leaves the outbox rows available for retry. Useful logs include `events_ingested`, `job_failed`, `worker_error`, `billing_delivery_failed`, `retention`, and `api_failure`. They exclude raw visitor IPs, event payloads, SQL error detail and credentials.

For event failures, repair the underlying issue and retry the original failed BullMQ jobs. Never replace their event IDs. Keep retries within the existing 30-day database deduplication window. For database recovery, restore to an isolated Neon branch and verify consistency before changing production connections; the restore history is 24 hours and a restore drill is still outstanding.

## Cloudflare rollback reference

Git commit `8847d85` retains the pre-Hono Bun web/worker setup and the former Cloudflare deployment source. Roll back from that commit if necessary; the active source uses Hono and does not include a Cloudflare build path. The prior Worker and queues are retained for rollback. Both Cloudflare event/dead-letter queues were empty at cutover; HTTP routes and the old cron triggers are disabled. Reattaching its custom domain would switch traffic back; only do so as a deliberate rollback. Earlier deployment details and product verification records are in [Cloudflare deployment history](cloudflare-deployment-history.md).

## Initial Railway migration verification — 2026-09-07

At the initial Railway cutover, web deployment `1ece80ac-7ab6-4746-ab6f-26237eec23f0` and worker deployment `bb213aa0-9559-424c-923a-577bb8ea3659` were verified healthy. These precede the Hono consolidation. Live verification covered existing-session continuity, browser tracker ingestion and reporting, country/locale handling, forged-header rejection, independent event IDs across environments, new sign-in/sign-out, and Polar API/signing credentials. The queue had 17 completed jobs with no waiting, active, delayed or failed jobs at the check. Billing and retention schedulers were present; both old Cloudflare queues were empty. The disposable account and temporary secret-transfer files were removed.

Build, TypeScript, scoped lint, 42 unit tests and 52 distinct integration tests passed. Two pre-existing session-test timeouts were increased to 60 seconds for remote Neon; those six tests were rerun successfully. Existing React lint errors in unchanged components remain. Detailed evidence is in `artifacts/railway/migration-verification.json` and the adjacent live-check reports.

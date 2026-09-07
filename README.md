# Analytics Beer

A small analytics app built with TanStack Start, Bun, Railway, Redis/BullMQ, Better Auth, Drizzle, and Neon PostgreSQL. The responsive dashboard uses Tailwind v4, coss components, [Dither Kit charts](https://www.tripwire.sh/dither-kit), and self-hosted IBM Plex Sans. It follows the system light/dark theme. Dashboard tabs, website changes, and sign-in/sign-up views use a short fade-and-rise transition; reduced-motion preferences disable these animations. The product domain is `analytics.beer`.

Create an account, add a website, copy its script, and check for the first pageview. The dashboard shows pageviews, daily visitor estimates, custom events, date ranges, and page/referrer/country/device breakdowns. Website settings support renaming, pausing collection, and deletion with confirmation. All reports come from the API. Onboarding includes a clearly labeled interactive sample; it does not create traffic in your account.

The public homepage is a centered landing page with a custom eight-second stop-motion mascot video. `/signup` opens account creation and `/signin` opens sign in; authenticated visitors to either enter their dashboard. Legacy auth query links redirect to these routes. Existing site, environment and report deep links still open the application. The video follows the system theme, honors reduced motion, and pauses offscreen. The preview dialog uses a real dashboard screenshot with clearly labeled example data. See [landing page design and media notes](docs/landing-page-design.md). Run `bun scripts/landing-qa.ts` for the landing page browser checks. Source artwork lives in `output/landing-media`; `bun scripts/render-landing-video.ts` rebuilds the loops using local Chromium, FFmpeg and cwebp.

## Development

Use Bun 1.4.2. PostgreSQL stays on Neon; Redis is required for queues and rate limits.

```sh
bun install --frozen-lockfile
# Copy .env.example to .env and fill in development credentials and random secrets.
redis-server --bind 127.0.0.1 --port 6393 --appendonly yes --maxmemory-policy noeviction
# In separate terminals:
bun run dev
bun run dev:worker
```

Open [localhost:3000](http://localhost:3000) to match `APP_URL`. The web process and worker must share the same development database and Redis URL. `DATABASE_URL` and secrets are server-only. Keep production Polar credentials out of local test workers. `.dev.vars` and Wrangler configuration are retained only for the Cloudflare rollback path.

| Resource                   | Value                                                          |
| -------------------------- | -------------------------------------------------------------- |
| Neon project               | `analytics` / `billowing-night-55335840`                       |
| Organization               | Team Lasse                                                     |
| Region                     | AWS Frankfurt (`aws-eu-central-1`)                             |
| PostgreSQL                 | 17                                                             |
| Database                   | `analytics`                                                    |
| Development branch         | `development` / `br-late-brook-b1z9dchn`                       |
| Test branch                | `api-tests` / `br-fragrant-bar-b1ua6epq`                       |
| Production branch          | `production` / `br-frosty-frost-b18zvthi` (protected, default) |
| Compute per branch         | 0.25–1 CU, suspend after 300 seconds idle                      |
| Configured restore history | 24 hours; a restore drill remains a launch task                |

## API

See [the API guide](docs/api.md). The OpenAPI contract for application endpoints is served at `/api/openapi.json`; Better Auth's endpoints are described separately in the guide.

```html
<script defer src="https://YOUR-API-HOST/tracker.js" data-site="YOUR-SITE-UUID"></script>
```

```js
window.simpleAnalytics.track('signup');
```

The tracker records the initial page and History API navigation. It ignores query-string-only and fragment-only navigation, respects Do Not Track, and sends no analytics cookies. Global Privacy Control does not suppress collection. Repeated pageviews of the same origin/path are throttled for 60 seconds per site and tab, including reloads and return navigation. The tracker keeps recent pageview timestamps in sessionStorage, falls back to memory if storage is blocked, and logs `Pageview ignored - throttled (same URL within 1 minute)`. Skipped attempts do not extend the window; custom events are unaffected. Event IDs are reused on limited network/5xx retries. CSP must permit the script host and `connect-src` collector.

To test from a local website, turn on **Allow localhost for testing** in Installation or Website settings. It accepts `localhost`, `127.0.0.1`, and `::1` on any port using the same script. The option is off by default, and test activity is included in that website’s reports. DNT still prevent collection. On local pages the tracker logs skipped initialization and collector HTTP statuses to the browser console; add `data-debug` to the script tag to enable the same diagnostics elsewhere.

## Validation

Oxfmt handles formatting (with single quotes to match the existing source), and Oxlint checks correctness with TypeScript and React rules. Generated route/Worker types, migration metadata, and captured artifacts are excluded.

```sh
bun run lint
bun run lint:fix
bun run format
bun run format:check
```

`lint:fix` applies safe lint fixes; `format` rewrites supported files. The other two commands only check files and can be used in CI.

```sh
bun run test
bun run test:integration
bun run test:smoke
bun run test:browser
bun run typecheck
bun run build
```

Integration tests use the isolated Neon test branch. They test real PostgreSQL and real local Redis, including queue reconnects, retries, duplicate suppression and atomic limits. Set `TEST_REDIS_URL` to the isolated local Redis. They refuse to use the development hostname and clean up only users created by that run. Run one integration suite at a time because rollback tests briefly install a trigger in the isolated branch.

The smoke and browser tests require `bun run dev` in another terminal, or `bun run build` followed by `bun run preview` to check the production build. Run the Bun worker alongside the web process. The API smoke test exercises HTTP requests through Redis into the Bun worker and Neon, then deletes its own fixtures. The browser test also checks onboarding, tracker execution, reports, settings, sign-in, keyboard interactions, and mobile layout. It requires Playwright Chromium (`bunx playwright install chromium`). Successful runs write `artifacts/api-smoke.json`, `artifacts/browser-qa.json`, and screenshots. Screenshots show synthetic traffic created solely for the disposable QA account.

Validation reports and screenshots are local outputs under `artifacts/` and are excluded from Git. Run `bun run test:design` and `bun scripts/chart-qa.ts` with the app running to repeat the form interaction and contrast checks.

## Migrations

```sh
bun run db:generate
# Review the generated SQL before applying it.
bun run db:migrate
bun run db:migrate --test
```

The first command creates versioned migrations. The latter commands apply them to the configured Neon development and test databases, respectively. Neither runs automatically in requests or startup.

Production runs at [analytics.beer](https://analytics.beer) on Railway with separate Bun web/worker services, Redis, and the existing Neon production branch. See [deployment and operations](docs/deployment.md) for exact deployment commands, resources, migrations, and live verification.

## Website environments

Use **Add environment** in the dashboard to separate Production, Staging, Testing, or any custom name. Each environment has its own tracking snippet, reports, domain, localhost permission, and pause control. Existing sites and scripts automatically use Production. Switch environments above the report; your selection is remembered per website. Environment deletion affects only its own traffic.

## Cookie-based session mode

In **Website settings → Tracking mode**, choose **Cookie-based · sessions and activity** for the selected environment. This opt-in mode tracks consented sessions, page visits, clicks, links, downloads, form submissions, scroll depth, active time, and device/browser details. The Visitors page shows visit history, friendly anonymous aliases, page trails, and chronological activity. Use View visitor history to see other visits by that visitor in the selected period.

Choose cookie-based sessions or **Cookieless visitors · local storage** in Settings. Both visitor modes require analytics consent; the local-storage mode creates no tracking cookies. Install provides the script and consent callback; nothing is collected before analytics consent. The banner must also support rejection and withdrawal. Detailed activity expires after 30 days. Cookieless remains the default. See [the integration and data reference](docs/api.md#cookie-based-sessions-and-activity).

### Dashboard URLs

Dashboard pages use `/site/:siteId/:environmentId/:page`, where `page` is `overview`, `visitors`, `installation`, or `settings`. Links support refresh, bookmarking, and browser back/forward. `/dashboard` opens your remembered website and environment; `/signin` and `/signup` open authentication. Old `?site=…&environment=…&view=…` links redirect to the new routes. A missing or inaccessible environment displays an unavailable message.

Run `bun scripts/routes-qa.ts` to verify routing with a disposable local account, or `bun --env-file=.env.production scripts/routes-qa.ts --production` for production.

Local-storage visitor QA: `bun --env-file=.env.production scripts/sessions-qa.ts --production --local-storage`. Cookieless remains the default and includes anonymous daily visitor journeys from retained pageviews and custom events; no existing environment is switched automatically.

Default cookieless mode includes browser/OS, device, viewport/screen dimensions, language, clicks, links, downloads, form submissions, scroll depth and active time. It sends an anonymous `activity` context, never client visitor/session identifiers. The existing daily hash groups visits; identities reset each UTC day. Field values and page text are excluded. `data-analytics-ignore` and Do Not Track are respected. A sessionStorage pageview throttle contains only paths/timestamps, not visitor IDs. Browser QA: `bun --env-file=.env.production scripts/sessions-qa.ts --production --cookieless`.


### Usage limits

The account Usage tab (`/usage`, `GET /api/usage`) shows monthly events across all websites and environments. Collection requires an active Pro subscription or unexpired Pro trial. At the event limit, all account sites pause automatically until renewal or upgrade; historical reports remain available. Pageviews and actions count, while engagement heartbeats and duplicate deliveries do not. Pro supports ten websites. Deleting a site does not erase its usage. See `docs/polar.md` for billing setup and verification.

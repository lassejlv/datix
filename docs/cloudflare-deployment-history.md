# Deployment and operations

## Current state

Deployed on 2026-09-06 at [analytics.beer](https://analytics.beer), in Cloudflare account Team Lasse. Production uses the `production` environment in `wrangler.jsonc`. The top-level configuration remains local development; its placeholder Hyperdrive ID is intentional.

| Resource              | Production value                                                                  |
| --------------------- | --------------------------------------------------------------------------------- |
| Worker                | `analytics-beer`                                                                  |
| Initial version       | `741c25f1-e279-4d8f-8b6d-467adf655a6f`                                            |
| Custom domain         | `analytics.beer` (Cloudflare-managed DNS and TLS)                                 |
| Neon project          | `analytics` / `billowing-night-55335840`                                          |
| Neon branch           | `production` / `br-frosty-frost-b18zvthi` (protected, default)                    |
| Database              | `analytics`, PostgreSQL 17, AWS Frankfurt                                         |
| Compute               | 0.25–1 CU, suspend after 300 seconds idle                                         |
| Restore history       | 24 hours; restore drill not yet performed                                         |
| Hyperdrive            | `analytics-production` / `e3041622b8a14870998803e941b80821`                       |
| Database runtime role | `analytics_runtime`: table CRUD and sequence usage; no schema/role administration |
| Hyperdrive caching    | Disabled, five origin connections, encrypted origin connection                    |
| Event queue           | `analytics-events-production` / `95f1260ae45444eba493186046c521a0`                |
| Dead-letter queue     | `analytics-events-dead-production` / `879f7a1353db443c99680583f3c8bdae`           |
| Queue retention       | 14 days on both queues                                                            |
| Consumer              | Up to 100 messages per batch, 5-second batch wait, 5 retries                      |
| Cleanup schedule      | `17 3 * * *` (03:17 UTC daily)                                                    |

Production started empty using a schema-only Neon branch. Columns, indexes, and constraints were compared with development, all application tables were checked empty, and migration hashes were checked against the source branch and local migration files before recording the migration journal. No development accounts, websites, or analytics were copied. Production migration credentials are stored separately in the ignored, mode-600 `.env.production` file as `PRODUCTION_DATABASE_URL` and `PRODUCTION_DATABASE_HOST`. Local `.env` credentials still target development.

Independent `BETTER_AUTH_SECRET` and `VISITOR_HASH_SECRET` values are held in Cloudflare's secret store. The Worker connects using the restricted runtime role through Hyperdrive. Neither secrets nor database URLs are included in published client/server bundles.

GPC update: version `2ae146fa-8d6f-4800-a1bb-ad84dbdee2b3` removes GPC suppression from the tracker and collector. The live browser suite passed in Brave with GPC enabled, including real Queue ingestion and reports. Do Not Track remains respected.

Throttle update: `7bbb34d4-b2c5-4097-979a-59f2e809908b` adds a 60-second per-site/tab pageview throttle. Live Brave verification confirmed that reloads and return navigation log the throttle message without additional collection requests, while repeated custom events still reach the production report. All 16 unit tests and TypeScript checks pass.

Current version: `8543f817-0013-4fcd-8c16-4535123d9c51` adds 180ms view transitions for dashboard tabs, website selection, and authentication views. Local and production browser checks verified form-value preservation, focus, rapid switching, mobile layout, and live reduced-motion preference changes. Evidence: `artifacts/transitions/verification.json`.

## Subsequent deployments

```sh
bun run typecheck
bun test tests/unit
# Review generated SQL first; never migrate api-tests as production.
bun run db:migrate:production
bun run deploy
```

`deploy` validates the production domain and Hyperdrive ID, builds with `CLOUDFLARE_ENV=production`, and deploys the generated `dist/server/wrangler.json`. A plain `bun run build` still creates a local preview build. Cloudflare environments are chosen at build time, so never deploy a local preview bundle as production.

To repeat live browser verification:

```sh
bun --env-file=.env.production scripts/production-smoke.ts
```

This creates a uniquely named disposable account, operates the browser against the public domain, sends actual tracker requests from a local fixture directly to Cloudflare, verifies the remote Queue/database/report path, and removes only that account afterward. The first successful run is recorded in `artifacts/production/verification.json`, with desktop/mobile screenshots. It also verified secure session cookies, unauthenticated rejection, cross-origin mutation rejection, immediately paused/revoked collection, sign-out revocation, and incorrect/correct password handling. Production log inspection confirmed ingestion with no Worker exceptions or application failure logs during the check.

The official references are [TanStack Start hosting](https://tanstack.com/start/latest/docs/framework/react/guide/hosting), [Hyperdrive query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/), and [Cloudflare Queue delivery](https://developers.cloudflare.com/queues/reference/delivery-guarantees/).

## Recovery

- **Database/consumer outage:** unacknowledged messages retry; exhausted retries go to `analytics-events-dead-production`. Monitor the dead-letter queue and oldest message age. Repair the underlying problem, then replay the original envelopes with their original event IDs within the 30-day deduplication window. Do not generate replacement IDs.
- **Database rollback/restore:** restore data in an isolated branch first, validate event/summary consistency and auth behavior, then plan the production switch. A point-in-time restore can remove data that was previously acknowledged by the queue; restoring backups alone does not guarantee zero event loss. This phase does not keep an independent event archive.
- **Retention backlog:** monitor the `retention` log's `backlogPossible` flag. Increase cleanup frequency/capacity or reduce ingestion before older data accumulates indefinitely.
- **Credential changes:** update Hyperdrive/Worker secrets in the intended environment and verify auth. Changing the auth secret invalidates cookies; changing the visitor secret mid-day can overcount daily visitors.

## Remaining operations work

Configure verified email delivery and password recovery, privacy documentation, monitoring, usage alerts and a billing/traffic policy. The current collector is public by design: origin checks deter accidental cross-site attribution but cannot authenticate arbitrary browser traffic. Load-test the expected ingest/report concurrency before setting paid traffic limits.

Useful logs are `api_failure`, `events_ingested`, `queue_failure`, `invalid_queue_envelope`, and `retention`. Logs intentionally avoid event payloads, SQL error detail, IPs, and credentials. A successful `/api/health` alone is not end-to-end evidence.

## Dashboard

The same-origin TanStack Start dashboard uses Tailwind v4, coss components, and Dither Kit charts. Account flows, website onboarding, installation checks, report views, and site settings were exercised on the deployed domain. Object exports can add a private R2 binding when needed.

## Environment migration (0003)

Migration 0003 adds a Production environment for each existing site using the original site ID. Historical event, visitor, and summary rows and their primary keys are preserved. Their legacy `site_id` storage columns now reference environments. A compatibility trigger creates/updates the default environment when an older Worker writes site settings, so apply the migration before deploying the new Worker.

The migration is transactional and uses a five-second lock timeout. On failure it rolls back; retry after resolving lock contention. Verify historical rows/counters and default environment permissions after applying it. Runtime default privileges must grant CRUD on the new table.

For Worker rollback, keep migration 0003 in place. The previous Worker can serve default traffic with the compatibility trigger; custom environment management and traffic require the new Worker. Version-2 queue messages may retry or reach the dead-letter queue until the new consumer is restored. Restore the new Worker and replay those messages. Do not drop the environment table or reverse its foreign keys after custom traffic exists.

Environment support was deployed on 2026-09-07 (Europe/Copenhagen), Worker version `cd4046c3-da87-4c43-847f-060e4915b553`. The production migration verified preservation of the 3 existing sites, 14 raw events, 2 daily visitor records, and 11 summary rows, plus default environment mappings and runtime table privileges. The previous Worker passed the live Brave legacy-tracker smoke test after migration.

The new Worker passed `scripts/environments-qa.ts --production`: browser sign-up, custom Staging creation/domain/snippet, remembered selection, real tracker → public collector → Queue → production reports for both environments, independent localhost and pause controls, persistent rename, mobile/dark rendering, and typed environment deletion preserving Production. Disposable verification accounts were removed. Evidence: `artifacts/environments-production/verification.json`. Run with `bun --env-file=.env.production scripts/environments-qa.ts --production`. Local equivalent: `bun scripts/environments-qa.ts` with the development server running. Typecheck, production build, 17 unit tests, and all 19 integration tests passed.

## Session activity migration (0004)

Migration 0004 is additive: it creates `activity_events` and adds `environments.tracking_mode` with a `cookieless` default. It preserves all existing traffic and default-environment triggers. Apply to development/test, verify preservation, then production before deploying the new Worker. Runtime default privileges must cover the new activity table. The migration uses a five-second lock timeout and is transactional.

Worker rollback keeps this schema. Versions 1/2 retain their old meaning. Version-3 session messages require the new consumer; if rolled back, stop session-mode trackers and restore the compatible consumer before replaying retries/dead-letter messages. The old Worker does not enforce session-mode consent metadata, so rollback must not leave cookie-mode snippets collecting against it. Prefer rolling forward or pausing collection for affected environments. Do not drop activity tables or reverse the migration after collecting session data.

Cookie-based session mode deployed on 2026-09-07 (Europe/Copenhagen), Worker version `d8d4db7d-9f87-4585-a7f0-fe065ff186e7`. Migration preservation checks confirmed all 3 existing sites, 4 environments, 20 raw events, 3 daily visitor records, and 11 summary rows, plus full runtime CRUD privileges on the new activity table. Existing environments remain cookieless.

Validation: typecheck and production build passed; 22 unit tests and all 22 integration tests passed. The focused session integration test additionally verifies action ordering despite out-of-order delivery. `scripts/sessions-qa.ts` passed locally and on production, covering the opt-in mode and banner notice, no pre-consent tracking, cookie continuity across navigation/reload, automatic clicks/forms/links/downloads/scroll/active time, excluded private content, cross-tab withdrawal, actual remote queue ingestion, session metrics, and desktop/mobile/dark timelines. Production evidence: `artifacts/sessions-production/verification.json`. Run with `bun --env-file=.env.production scripts/sessions-qa.ts --production`.

The existing production smoke test also passed in Brave with GPC enabled after this deployment: cookieless tracking, one-minute throttle, custom events, auth, reports, origin checks, pause, and localhost revocation. All browser verification accounts were deleted after testing.

### Dashboard routing verification — 2026-09-07

Deployed version `75c5ac6d-6bdf-43ad-8393-3c2fd9e8ed2f` adds `/site/:siteId/:environmentId/:page`, `/dashboard`, `/signin`, and `/signup`, with redirects from legacy query links. Typecheck, production build, and local/production routing browser checks passed. Production environment QA also verified actual tracker ingestion through the Queue, environment isolation, desktop/mobile reports, and typed environment deletion. Disposable verification accounts were removed. Evidence: `artifacts/routes/production.json` and `artifacts/environments-production/verification.json`.

### Coss sidebar verification — 2026-09-07

Deployed version `a2a42309-a48d-4281-b4ee-02e8cea849e7` reorganizes dashboard navigation around the official Coss UI sidebar. Typecheck, production build, routing checks, and sidebar browser QA passed. Live checks include desktop collapse, active/hover/focus states, tablet widths, mobile focus trapping/restoration, creation dialogs, sign-out, and light/dark/reduced-motion behavior. Evidence: `artifacts/sidebar/production/verification.json` and `artifacts/routes/production.json`. See `docs/dashboard-design.md` for source attribution and design decisions.

### Workspace switcher refinement — 2026-09-07

Deployed version `6a4f33a9-b34a-4efe-9b00-81389bd94d53` replaces native website/environment dropdowns with a compact Coss Combobox context block. Typecheck, production build, route regression checks, and sidebar interaction checks passed. Final live switcher verification passed search by domain/name, empty results, keyboard selection, focus restoration, environment reload, light/dark visuals, and nested mobile selection. Evidence: `artifacts/switchers/production/verification.json`. One parallel local QA rerun hit the existing API rate limit; the isolated final live run passed. All switcher test accounts were removed by exact email.

### Inset sidebar — 2026-09-07

Version `bcdca253-8af2-427b-ac0a-b083921a6f26` applies Coss's inset sidebar and content wrapper with a dashboard-scoped neutral surround. Typecheck, production build, and local/live sidebar browser checks passed, including desktop collapse, tablet widths, mobile navigation, creation flows, keyboard focus, and light/dark/reduced-motion states. Evidence: `artifacts/sidebar/production/verification.json`.

### Visitor journeys — 2026-09-07

Version `a63f95c3-79c5-437f-b7e1-51e1173d94ba` adds a dedicated Visitors page with anonymous animal aliases, page trails, chronological activity, and history across visits for a selected visitor. The sessions API supports an optional visitor filter with the existing ownership and environment checks. No database migration is required.

Typecheck, production build, and focused session integration tests passed (3 tests, 37 assertions). Local and live journey checks covered visitor filtering, both pagination paths, retained activity, direct-route reload, date controls, and mobile focus restoration. Desktop, dark, and mobile screenshots were inspected. Production tracker QA also passed consent, withdrawal across tabs, actual collector/Queue ingestion, and viewing the collected events on the new Visitors page. Disposable verification accounts were removed. Evidence: `artifacts/journeys/production/verification.json` and `artifacts/sessions-production/verification.json`.

### Simpler dashboard and onboarding — 2026-09-07

Version `9bf03e86-6c78-410a-9b85-7d254788a5a0` replaces the Visitors split layout with compact rows and a focused activity view. It removes the duplicate page trail and empty side panel, reduces summary and icon sizes, and simplifies the overview metric selection. Signup and first-site setup now include the existing beer mascot, an explicitly labeled sample preview, resumable setup, and a completion screen gated on a persisted pageview. Billing remains a preview.

Production build, typecheck, and 22 unit tests passed. Live `journeys-qa.ts`, `onboarding-qa.ts`, and `sidebar-qa.ts` passed, including filtering, pagination, hover/focus, mobile navigation, real tracker → collector → Queue → setup completion, and plan-preview navigation. Desktop/mobile/light/dark screenshots were inspected. The first onboarding fixture was correctly excluded by the bot filter; the final test uses a normal browser profile and asserts `accepted: true` before checking persistence. Verification accounts were removed by the scripts. Evidence: `artifacts/journeys/production/verification.json`, `artifacts/onboarding/production/verification.json`, and `artifacts/sidebar/production/verification.json`.

### Product simplification and Hugeicons — 2026-09-07

Version `b456a091-fa91-489c-bc3f-5e0d5e07d81c` replaces Lucide with the free rounded Hugeicons family throughout the application. Landing, pricing, onboarding, settings, and empty reports have less decoration, fewer nested panels, and shorter repeated explanations. Visitors retain compact rows and focused activity details. Consent notices and tracking behavior are preserved.

Typecheck and production build passed. Live sidebar, onboarding, visitor journey, and landing browser checks passed. Coverage includes real tracker → collector → Queue → setup completion, visitor filtering and pagination, mobile navigation/focus, light/dark layouts at four widths, signup links, preview dialogs, and mascot playback with reduced motion, offscreen pausing, and network failure. Verification accounts were removed by the scripts. Evidence: `artifacts/sidebar/production/verification.json`, `artifacts/onboarding/production/verification.json`, `artifacts/journeys/production/verification.json`, and `artifacts/landing/verification.json`.

### Country flags — 2026-09-07

Version `07a5c969-7da2-402e-98ee-1959e5e6f48a` adds native flag emoji beside country names in the overview breakdown and visitor details. A shared label keeps country names readable and hides decorative emoji from assistive technology; unknown locations receive no flag. Typecheck, production build, and live visitor browser QA passed, including visible Denmark name/flag assertions and mobile rendering.

### Compact dashboard sizing — 2026-09-07

Version `5829bd60-a425-4705-ba51-a3d15de466f1` caps dashboard content at 960px, reduces the header to 48px, tightens desktop visitor rows and navigation, shortens the chart, and uses narrower settings panels with standard-sized inputs. Mobile navigation retains 44px targets. Typecheck, production build, and live visitor/sidebar browser checks passed, including pagination, filtering, keyboard focus, mobile navigation, dark mode, and overflow checks. The compact visitor list screenshot was inspected.

### Consistent controls — 2026-09-07

Version `5a4cb26c-38c5-44cb-bd46-c8c5a910cd5d` matches date/refresh heights, compacts workspace controls and options, ties popup width to its trigger, removes the doubled search focus ring, and shrinks the sign-out control while allowing email wrapping. Long menu labels truncate with title disclosure. Typecheck and production builds passed. Live visitor checks passed matching 32px date/refresh dimensions and existing journeys behavior; final live switcher checks passed popup-width alignment, search, keyboard focus, environment persistence, and mobile selection. Dark menu screenshots were inspected.

### Plain workspace selectors — 2026-09-07

Version `5132b4d9-97eb-4967-ab79-bd74080f9376` removes the workspace card, globe, domain subtitle, and Environment label. Website and environment are two plain compact text selectors with small chevrons. Searchable menus retain domain descriptions. Typecheck, production build, and live switcher checks passed for keyboard selection/focus, search, persistence, popup width, and mobile navigation. The final dark sidebar screenshot was inspected.

### Basic Getting started — 2026-09-07

Version `71eee02d-e1a8-4767-ae79-c1b9a30742e6` replaces decorative onboarding with a compact 600px setup flow. Removes mascots, sample preview, progress strip, and plan promotion from onboarding; keeps script installation steps, resumable setup, and persisted-pageview confirmation. Typecheck, production build, and live onboarding QA passed, including real collector/Queue ingestion, completion focus, desktop/mobile/dark rendering, and resume behavior. The setup screenshot was inspected.

### Switcher creation actions — 2026-09-07

Version `e754d16f-4ed0-4b36-8871-332ed3bc7462` moves website and environment creation from sidebar links into a separated footer in each corresponding switcher menu. The website switcher remains available with no sites. Typecheck, production build, and live sidebar QA passed, including opening both menu actions and creating a website/environment from mobile dialogs.

### Agent installation copy — 2026-09-07

Version `5afa53f3-e360-4566-9e37-292cce631ddc` adds an Agent clipboard button beside Copy script in Install and Setup. Its prompt includes the selected snippet, domain/environment/mode, existing-framework integration, duplicate avoidance, mode-specific consent instructions, localhost/paused status, and persisted-pageview verification. Clipboard failure exposes a selectable text fallback. Typecheck and production build passed. A focused session-prompt check verified consent and snippet preservation; live onboarding QA verified actual clipboard content, mobile rendering, and real tracker-to-setup completion.

### Local-storage visitor mode — 2026-09-07

Version `c0b1d9e7-665c-4fec-b0ae-0091bde8bcce` adds opt-in `trackingMode: local` / `data-mode="local"`. It records consented visitor journeys using local storage without tracking cookies, reusing the session API and Visitors UI. Existing aggregate-only cookieless and cookie-session settings remain unchanged. The existing tracking_mode text column accommodates the new value; no schema migration is required. Rollback to an older Worker is incompatible with environments set to local; switch them and their snippets back first or roll forward.

The tracker scopes IDs to origin/environment, renews visitor/session expiry to 90 days/30 minutes, replaces expired IDs on use, handles blocked storage without volatile identities, and propagates withdrawal with BroadcastChannel/storage events. The collector enforces matching mode, storage metadata, and affirmative consent. Install, Settings, Agent copy, and privacy disclosures describe the new option.

Typecheck, production build, 28 unit tests (172 assertions), and four session integration tests (49 assertions) passed. Live local-storage and cookie-session QA both passed actual browser → collector → Queue → database → Visitors timeline, navigation/reload continuity, private-content exclusion, consent gating, and cross-tab withdrawal. Local-mode QA explicitly checked zero tracking cookies and scoped local-storage IDs. Evidence: `artifacts/local-visitors-production/verification.json` and `artifacts/sessions-production/verification.json`. Disposable QA accounts were deleted.

### Production tracker minification — 2026-09-07

Version `a747b118-633b-4957-bda2-156883a48214` serves a minified tracker. Both Vite build commands finish with `build:tracker`, replacing the copied public asset using Bun's browser IIFE minifier; the development source remains readable. The artifact is 8,558 bytes versus 16,997 source bytes (50% smaller). Typecheck and production build passed; all 16 tracker tests (77 assertions) passed against `dist/client/tracker.js` via `TRACKER_TEST_FILE`. The live `/tracker.js` response matched the tested artifact byte-for-byte.

### Account menu and settings — 2026-09-07

Version `c654d021-5350-4e4f-8d63-d90b69054738` replaces the standalone footer sign-out icon with a compact account dropdown. Account settings opens a responsive dialog with name editing, read-only sign-in email, and a collapsible password form. Password updates require the current password and revoke other sessions through the existing authentication endpoints. Profile changes update the sidebar immediately and persist across reloads. No authentication configuration or database schema changes are required.

Typecheck, production build, and local/live account QA passed. Coverage includes menu keyboard focus, dialog/mobile focus restoration, name persistence, unauthorized/cross-origin rejection, password mismatch and incorrect-current-password handling, old-password invalidation, other-session revocation, retained current session, and dropdown sign-out. Desktop/mobile/dark screenshots were inspected. Evidence: `artifacts/account/production/verification.json`. Tests modified only disposable accounts, which were removed afterward.

### Account deletion — 2026-09-07

Version `a26042c8-0ea5-4a6a-861d-1e3252434954` enables account deletion in Account settings. The expanded deletion section explains permanent removal and requires the current password. The API strictly requires a password even for fresh sessions and rejects additional target-user fields. Existing database cascades delete owned sites, environments, raw events, daily visitor records, summaries, activity, credentials, and sessions. The client clears scoped account preferences and returns to sign-in only after successful deletion.

Typecheck, production build, and local/live deletion QA passed using disposable accounts and synthetic analytics. Checks covered missing/wrong passwords, unauthenticated/cross-origin/foreign-user inputs, mobile deletion, session revocation, failed subsequent login, all data cascades, delayed event replay, and preservation of another test account. Evidence: `artifacts/account-delete/production/verification.json`. No schema migration was needed.

### Compact footer preferences — 2026-09-07

Version `e3aaf9d4-8796-4e0b-bea4-f3e22378052a` groups privacy, language, and theme in a quiet footer row, wrapping on small screens. Compact native selectors use small Hugeicons and accessible hidden labels; large borders and duplicate visible labels are removed. Typecheck, production build, and live footer QA passed across English/German/Danish, light/dark/system themes, persisted preferences, 320/390/1280px widths, keyboard focus, and the privacy dialog. Desktop/mobile screenshots were inspected. Evidence: `artifacts/footer/verification.json`.

### Simpler signup — 2026-09-07

Version `5965dcfe-256d-4fe5-b097-0e0fb53dcf3e` keeps signup's mascot and welcoming heading while removing the large marketing panel, floating discovery card, repeated messaging, and oversized controls. The layout caps at 960px with a 360px form and a smaller desktop mascot; mobile gets one small mascot above the form. Typecheck, production build, live signup/onboarding QA, and dark/mobile/password-visibility checks passed. Final screenshots were inspected.

### Default cookieless visitor journeys — 2026-09-07

Version `9d38e227-9eec-4283-81a9-eed2f5eddeb7` exposes retained cookieless pageviews and custom events in Visitors. Reports group these events by the existing environment-scoped, UTC-daily anonymous visitor hash. They do not identify returning visitors across days and may combine people sharing an IP/browser. No tracker or storage behavior changed, and no migration or snippet update is needed. Existing events are available for the 30-day raw-data retention window. Events with richer activity records are excluded from the cookieless branch to prevent duplicates. Local storage is labeled Persistent visitors and remains opt-in.

Validation: 28 unit tests and 24 integration tests passed; the final sessions suite passed again after adding daily-journey metadata. Live browser verification is recorded in `artifacts/journeys/production/verification.json`.

### Cookieless activity details — 2026-09-07

Version `fe9e14ea-1f71-48aa-928c-fb6893cc6ce0` shares the activity collector between default cookieless and persistent tracking. Cookieless sends a strict anonymous `activity` context (browser/OS derived server-side; screen, viewport, language and activity details supplied by the tracker), without client visitor/session IDs. Its existing daily hash becomes both journey and visitor key. Legacy basic events remain supported and join the same daily journey without double counting. The selector offers only Cookieless and Cookie-based; legacy local-storage environments are shown an explicit transition message without being changed silently. No migration or snippet change is required. New metadata is available for new traffic only.

Validation: typecheck, 29 unit tests, six session integration tests, and 17 tests against the minified tracker passed. Browser evidence for default cookieless mode is under `artifacts/cookieless-activity-production`.


### Pricing and Polar webhook — 2026-09-07

Pricing is deployed with one Pro offer, a planned 14-day trial, and a plain `mailto:hello@analytics.beer` Contact sales link above 5 million events. The unused Free and Enterprise products are archived in Polar. Production pricing browser QA passed in English, Danish and German at desktop and mobile widths.

Worker code version `551dadf7-844e-40fc-97a1-e303ec3f67e7` adds the Polar webhook receiver. The additive billing migration was applied to production before deployment. The generated Polar endpoint secret was subsequently installed as the encrypted `POLAR_WEBHOOK_SECRET` Worker binding. Live signed webhook fixtures passed and their database records were removed. No Polar access token is configured by this change. See `docs/polar.md` for integration state and remaining work.

### Account usage and automatic pauses — 2026-09-07

Version `2c72301a-7f20-4ce3-9109-ee79d0c0b2ed` deploys `/usage`, authenticated `/api/usage`, and account-wide collector/queue enforcement. Migration `0006_outgoing_loa.sql` was applied before deployment. Accounts without an active Pro subscription or unexpired Pro trial do not collect events. Allowances are shared across websites/environments and enforced atomically on committed events. At the event limit, tracking pauses automatically; renewal or upgrade restores available capacity without changing manual environment switches.

Validation: 31 unit tests and the 38-test integration suite passed, followed by the focused quota tests after the environment-lock/settings refinement (6 tests, 65 assertions). A real production browser and tracker reached exactly 100,000 events, rejected the next action, then resumed on a larger allowance while retaining usage. Desktop/mobile light/dark states and direct Usage navigation passed without browser errors. All disposable account, billing and analytics fixtures were removed. See `artifacts/usage/production/verification.json` and screenshots in the same directory. Polar checkout and outbound meter delivery remain unconnected pending the access token and integration work.

### Polar checkout and usage delivery — 2026-09-07

Final version `a7028aa8-a7b5-4ae6-9e7c-681b79ba97aa` deploys authenticated monthly checkout, the billing portal, provider-state refresh, and durable outbound usage metering. Migration `0007_abnormal_unicorn.sql` was applied before deployment; the access token is encrypted in the production Worker. Once-per-minute delivery retries are separate from daily retention. Yearly checkout remains disabled pending Polar's monthly credit-cycling support.

Hosted checkout includes only the selected product. Older cached multi-product checkouts are skipped when the user starts again from Usage. Identity is bound before checkout, existing subscriptions go to the portal, and successful provider state drives local allowance activation.

Typecheck, scoped lint, 31 unit tests and 43 integration tests passed; the final one-plan/customer mapping changes passed the focused five-test billing suite (51 assertions). The user corrected the initial missing token permissions, and those permissions were verified against Polar. Live checkout opens with the correct monthly price and 14-day trial, and the customer portal opens for the correct account. No paid purchase was completed.

Live verification completed at 2026-09-07T11:16:10Z. The browser showed exactly one selected checkout plan, the correct $9/month price and 14-day trial, checkout reuse, the annual gate, and the authenticated billing portal. Two actual tracker events committed through the production queue and drained from the durable Polar outbox; direct provider retries returned one duplicate and zero extra inserts. Mobile overflow checks and browser error checks passed. No purchase was completed, and customer meters remained empty for the disposable unsubscribed customer, so a real subscription benefit grant and meter balance were not verified. Evidence: `artifacts/billing/production/verification.json`. Disposable accounts and provider customers were removed.

Version `2ef20bfb-4904-4cac-a5bd-d02be1b89214` restricts new checkout trials to Pro 100k and updates pricing/Usage copy. The final billing integration suite passed five tests (53 assertions), typecheck and scoped lint passed. Polar catalog updates make the six monthly plans public for self-service plan changes and remove trials from the ten larger monthly/yearly products. Both 100k products retain 14 days; yearly checkout remains gated.

### Spam protection verification — September 7, 2026

Deployed Worker `b37faa88-95cc-4b28-9eb8-d363dcc7cb14` after migration `0009_married_stepford_cuckoos.sql` on development, isolated test, and production databases. Collection now checks persistent source limits and historical anomaly signals before queueing. Usage includes blocked-request totals and editable per-website credit budgets.

Validation: typecheck and scoped lint passed (the pre-existing intentional control-character regex in validation remains a lint exception); 38 unit tests passed; the complete integration suite passed 48 tests before the final lock-contention refinement, followed by focused guard tests (3 tests) and budget/admission tests (9 tests). These cover concurrent source requests, different sources, historical detection, ordinary traffic spikes, tenant isolation, fractional credits, independent website collection, and budget renewal.

Live browser QA used disposable accounts, four seeded historical summary days and a seeded busy-window counter for historical detection. A real tracker pageview plus a bounded 24-request flood produced 10 accepted flood requests and 14 rejections (10 unusual-activity, 4 repetition). The 14 rejected requests consumed zero credits. Saving a 3.3-credit website budget paused both the tracker and a direct collector probe. Removing the budget resumed the real tracker: final totals were 12 stored events, 3.6 credits and 14 blocked requests. Local QA separately verified the immediate repetition guard, without a busy-window fixture: 20 accepted flood requests and 4 blocked. The test accounts were deleted after recording results. Browser Usage showed no console errors.

Artifacts: `artifacts/abuse/local/verification.json`, `artifacts/abuse/production/verification.json`. The UI was inspected in a narrow app panel and a desktop browser view; an attempted 390px viewport override was not applied by the in-app browser, so that exact width is not claimed as verified. Historical detection is statistical and cannot guarantee rejection of all distributed spam.


## Free plan removal — 2026-09-07

Version `a11bbc31-535d-472b-a5c1-21465ccca5f6` restores Pro-only pricing and collection after Free was withdrawn. Accounts without an active Pro subscription or unexpired trial receive `subscription_required`; no automatic allowance is granted. Pro limits, spam protection, weighted credits, and optional website budgets remain in place. The applied `0010_green_molly_hayes.sql` migration is retained; its retired ledger has no runtime reader or writer.

Validation: production build, typecheck, scoped lint, 38 unit tests and 19 integration tests covering billing, usage and environments passed. The live browser showed Pro-only pricing and a paused account without a subscription. The real tracker stored zero events before activating a disposable database Pro fixture, then stored one localhost pageview for 0.3 credits after activation. No real subscription was purchased. The fixture was removed after verification. Evidence: `artifacts/pro-only/production/verification.json`; fixture runner: `bun --env-file=.env.production scripts/pro-only-qa.ts --production`.

# Polar billing

Datix uses Polar for hosted checkout, subscription management and usage reporting. The Rust API owns customer mapping and local credit enforcement. Secrets and payment details never reach the application browser.

## Catalog

[`config/polar-catalog.json`](../config/polar-catalog.json) pins the Datix organization (`8ded9438-0be0-4f4a-8cef-f448d77c202c`), product IDs, benefit IDs and usage meter. Both Rust and the frontend read this catalog. All checkout currencies are USD, regardless of language.

| Plan | Monthly USD | Annual USD (unavailable) | Monthly credits | Websites |
| --- | ---: | ---: | ---: | ---: |
| Basic | 9 | 90 | 15,000 | 10 |
| Pro | 49 | 490 | 500,000 | 10 |
| Ultra | 149 | 1490 | 5,000,000 | 10 |

Basic includes a 14-day trial. Annual products are drafts: the current organization cannot cycle their event-credit benefit monthly. The UI displays their prices as coming soon and the API rejects annual checkout. Do not enable them merely by changing a frontend flag; first configure and verify monthly credit renewal in Polar, then update the shared catalog and tests.

## Configuration and release gate

- `POLAR_ACCESS_TOKEN`: organization token for Datix. Required access: customers read/write, subscriptions read, checkouts read/write, customer sessions write, events write.
- `POLAR_API_URL`: defaults to `https://api.polar.sh`. Use only a matching organization/catalog when changing environments.
- `POLAR_WEBHOOK_SECRET`: signing secret from a **new** webhook endpoint at `https://usedatix.com/api/webhooks/polar`, subscribed to `customer.state_changed` and `customer.deleted`.

Requests pin `Polar-Version: 2026-04`. The new endpoint must use Standard Webhooks signing: the base64-decoded `whsec_` suffix is the HMAC key. Historical endpoints using the old raw-secret convention are incompatible; register a new endpoint and install its secret.

On 2026-09-09, the organization default and all six product prices were verified as USD. Polar reports checkout payments, subscription renewals and payouts enabled; monthly meter cycling for annual products remains disabled. Before launch, install API/worker secrets, register and verify a real provider webhook, and verify a subscription's actual credit grant. Local mock-provider checks do not prove a real purchase or grant. No production migration or deployment is performed by the QA script.

## Schema and cutover

Apply registered upgrades through 0010 with `analytics-db upgrade` using the owner role. Startup only checks compatibility. Upgrade 0009 introduces organization scoping; 0010 creates `billing_organization_usage` and restores the historical ledger's conflict key for older code. Applied upgrades are immutable.

Current snapshots, checkouts and outbox rows are scoped to Datix; current usage is in the organization ledger. Legacy Polar and Autumn records are preserved but never treated as Datix grants or automatically delivered to Datix. Coordinate API/worker versions and reconcile any old pending usage before cutover. Existing subscriptions are not migrated automatically.

## Checkout and access

The authenticated user ID becomes Polar's `external_id`; email never links accounts. The API verifies both customer identity and organization. It reuses only an unexpired checkout which Polar still reports as open or confirmed for the same customer, product and USD currency. Existing renewable subscriptions, including past-due and paused subscriptions, open the hosted portal instead of a second checkout. Account deletion requires canceling renewing subscriptions first.

Signed webhooks deduplicate delivery IDs and update snapshots in one transaction. Older snapshots cannot replace newer ones. Payloads and payment details are not stored. The return-page query grants no access; an authenticated sync fetches authoritative customer state. Polling every minute backs up webhooks and snapshots older than five minutes stop granting access.

Access requires an enabled catalog product, an active/trialing subscription, correct period/currency and the analytics, website and meter-credit grants. Canceled periods and expired trials stop granting access. Website capacity comes from the grant metadata; event capacity comes from the granted credit units. Polar's asynchronous consumed totals never reset the local ledger.

### Workspace access after onboarding

New accounts may add one website and copy its installation script before selecting a plan. `POST /api/onboarding/complete` saves completion in `account_onboarding`; it does not claim that the script has sent a pageview. Collection already requires a subscription, so checking the first pageview happens after activation. Upgrade 0012 marks existing accounts with websites as having completed onboarding.

`GET /api/usage` returns `onboardingCompleted` together with the server-verified plan. Until a plan is valid, the app renders only initial setup or the plan selector, with billing management, subscription refresh and sign-out. It does not mount the workspace sidebar, reports, installation settings or other product routes. Deep links, cleared browser storage and checkout return parameters cannot bypass this gate. Verification errors fail closed; polling, focus and denied API requests refresh access.

The API independently requires a current verified subscription for all `/api/sites/{site}/...` operations. Before onboarding completion, `/api/sites` permits listing and creating exactly one website; creation and completion use the same user-row lock. After completion, listing also requires a subscription. Billing, authentication and account recovery/deletion remain reachable. Denied workspace requests return `402 subscription_required`. Active trials and subscriptions canceled at the end of a still-valid period retain access. Running out of event credits pauses collection without revoking workspace access. Expired, past-due, canceled or unverified subscriptions do not grant access.

`bun web/scripts/subscription-access-qa.ts` checks the gate with local browser fixtures. The local Polar QA below additionally exercises actual Rust routes, the isolated database, signed webhook activation and revocation.

## Usage delivery

Admission and ingestion enforce account and optional website budgets transactionally. Event credit values are stored in hundredths so fractional usage stays exact. Deduplicated analytics writes and usage outbox rows commit together. Delivery sends `events` with `metadata.quantity`, `metadata.event_type`, the account external ID and the original timestamp; no visitor identity or page data is sent.

Each outbox UUID produces a stable `datix-usage-…` event external ID across every retry. Polar deduplicates that ID within the organization. Delivery batches up to ten rows by account. Only an inserted-plus-duplicate count matching the entire batch completes delivery; errors and incomplete acknowledgements preserve every row with backoff. Stable per-event IDs make retries of partially accepted batches safe. Redis leases coordinate worker delivery. Unlike the former provider's deduplication window, retries are not discarded after 24 hours.

## Verification

Run the normal workspace and frontend checks in `AGENTS.md`. Focused database coverage is in `crates/server/tests/integration/polar.rs`; run it with the isolated test database and Redis configured, using `--ignored --test-threads=1`. These tests exercise a local Polar-compatible HTTP mock, signed webhooks, grant revocation, stale access, organization isolation, checkout reuse and durable fractional usage. They do not charge a card or establish live provider acceptance.

Browser smoke (after building the Rust server and frontend):

```sh
bun --env-file=.env web/scripts/polar-qa.ts
```

This starts a local API and mock checkout/portal, creates one disposable app user, verifies USD pricing in all three locales, the annual gate, onboarding, blocked report APIs, checkout return without a grant, signed trial activation, portal navigation and renewed blocking after revocation, then removes its records. Screenshots are written to `web/artifacts/polar/`. Install Playwright Chromium first. It requires the explicitly isolated test branch and Redis on 6394.

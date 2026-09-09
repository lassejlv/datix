# Autumn billing

Autumn owns subscription state and handles Stripe payment webhooks. This application has no billing webhook endpoint. Its authenticated Rust API creates hosted checkout and billing portal links; the browser never receives the Autumn secret key.

## Catalog

`config/autumn-catalog.json` and `web/src/lib/billing-plans.ts` describe the matching sandbox and production catalogs:

| Plan  | Monthly USD | Monthly EUR | Monthly DKK | Monthly events | Websites |
| ----- | ----------: | ----------: | ----------: | -------------: | -------: |
| Basic |           9 |           9 |          59 |        100,000 |       10 |
| Pro   |          49 |          49 |         329 |      1,000,000 |       10 |
| Ultra |         149 |         149 |         999 |      5,000,000 |       10 |

Annual prices are ten times monthly. English checkout selects USD, Danish DKK, and German EUR; the same fixed prices appear on the pricing page. Enable multi-currency in Autumn and configure every currency on monthly and annual plans before deploying. An existing customer may be locked to their billing currency by Stripe.

IDs are `basic`, `pro`, `ultra`, with `_annual` variants. Every plan includes `events`, `websites`, and the boolean `analytics` entitlement. Event credits reset monthly even when billed annually. Basic has a 14-day card-required trial; Pro and Ultra have none. There is no permanent free tier, rollover, or overage charge.

## Configuration

Set `AUTUMN_SECRET_KEY` on the API and worker services. A key beginning `am_sk_test_` is sandbox-only. `AUTUMN_API_URL` defaults to `https://api.useautumn.com`; override it only for isolated provider tests. The Rust client pins API version `2.2` and uses the RPC endpoints documented by Autumn's SDK.

The current local `.env` uses the sandbox. Production must have its own matching Autumn catalog and live key before cutover. Do not deploy the local test key as production billing.

## Access and usage

The app's user ID is Autumn's customer ID; email never determines ownership. Checkout always requests a hosted confirmation (`redirect_mode=always`), including upgrades with a saved card. Repeated new-customer requests reuse a recent checkout. Selecting the already-active plan opens the billing portal. The return page refreshes subscription state. Checkout options include `managed_payments: { enabled: true }`, locale, and currency; cached checkout links are scoped to these options. Stripe rejects Managed Payments on Connect accounts, including Autumn's default Connect sandbox. Use an eligible direct Stripe connection; do not silently fall back to unmanaged checkout.

Usage requests refresh subscription state after 60 seconds. The worker refreshes known customers in bounded batches without requiring a dashboard visit. Only Autumn snapshots newer than five minutes grant collection access; prolonged provider failures pause collection rather than retaining canceled access indefinitely. Reports remain available.

Collection and ingestion retain local atomic quota enforcement and per-website budgets. Each committed billable event enters the PostgreSQL outbox. The worker sends its fractional quantity to Autumn's `events` feature with a stable idempotency key and timestamp. No page paths, visitor identifiers, or URLs are sent to the billing provider. Heartbeats and imported history remain unbilled.

Autumn's documented idempotency window is 24 hours. Unresolved deliveries stop automatic retries at 23 hours after their first attempt and remain in the outbox for reconciliation. Monitor pending count and oldest age; do not blindly replay an expired key. The app's local usage ledger remains authoritative for collection budgets.

## Database and cutover

Apply upgrades 0005 through 0007 with the database owner before starting this version. Startup checks compatibility and does not migrate.

The upgrade labels existing customer snapshots, checkouts, and outbox rows `polar`; the new application explicitly writes `autumn`. Defaults remain `polar` so writes from older binaries stay isolated during a rolling deployment. Historical Polar records are retained, but cannot grant Autumn access or be delivered to Autumn. Existing reporting data is retained. `config/polar-catalog.json` is a historical reference only.

Copying a catalog does not transfer existing paid subscriptions or payment methods from Polar. Review any existing Polar subscribers and undelivered usage before production cutover, arrange their subscription transition, and disable the old Polar webhook registration. Do not charge a second subscription automatically. The former `/api/webhooks/polar` route returns 404.

## Verification

`cargo test --locked --workspace` covers catalog allowance periods and pure logic. Explicit ignored integration tests require the isolated test database and Redis described in `AGENTS.md`:

```sh
cargo test --locked -p analytics-server --test integration autumn -- --ignored --test-threads=1
```

They verify hosted checkout, annual selection, customer ownership, cancellation, stale access, removed webhooks, and stable fractional usage delivery retries.

Live checkout also requires an explicit eligible Stripe tax code on each mapped product. An account-wide preset is insufficient. The Basic, Pro, and Ultra production products use `txcd_10103001` (SaaS, business use); their annual variants share those products.

Production was upgraded to schema 7 and both Railway services deployed on September 9, 2026. `web/scripts/autumn-production-qa.ts --production` verified hosted Managed Payments checkout for all six plans and all three currencies without submitting payment. This check requires the production database variables and live Autumn key; it deletes only its disposable customer and app account.

## Customer overrides

The public catalog is used for checkout selection only. Access snapshots fetch `customers.get` with `expand: ["subscriptions.plan"]`: the expanded plan supplies its display name, while customer `balances.events` and `balances.websites` supply the actual allowances. Custom plan IDs and customer-specific overrides are supported. Unlimited allowances appear as `null` in the usage API. Missing or invalid entitlements cannot grant access.

Usage combines Autumn's customer usage with pending local deliveries and events ingested since that snapshot. Snapshot reads, ingestion, and delivery serialize on the account lock so delivered usage is not added twice. An ambiguous delivery stays conservatively reserved until reconciled. Manual usage adjustments in Autumn take effect on the next refresh, normally within 60 seconds; stale snapshots expire after five minutes and at the feature reset boundary. Feature reset dates determine the allowance window, independently of annual subscription billing dates. Website creation and collection use the same customer allowance.

> Historical Polar integration. The application now uses [Autumn](autumn.md). These setup instructions apply only to the previous release.

# Polar catalog

Created and read back through the Polar MCP server on 2026-09-07 in the **Analytics** organization (`analyticsbeer`, `4f109880-3be1-48f8-a8b2-bea2f101634f`). The catalog contains 12 Pro products, plus archived Free and Enterprise products. The complete product, price, benefit and meter IDs are in [`config/polar-catalog.json`](../config/polar-catalog.json).

| Plan       |      Monthly events | Websites |   USD / month |    USD / year |
| ---------- | ------------------: | -------: | ------------: | ------------: |
| Pro 100k   |             100,000 |       10 |             9 |            90 |
| Pro 250k   |             250,000 |       10 |            19 |           190 |
| Pro 500k   |             500,000 |       10 |            29 |           290 |
| Pro 1M     |           1,000,000 |       10 |            49 |           490 |
| Pro 2M     |           2,000,000 |       10 |            79 |           790 |
| Pro 5M     |           5,000,000 |       10 |           149 |         1,490 |
| Enterprise | More than 5,000,000 |   Quoted | Contact sales | Contact sales |

The Free product is archived and unavailable for new subscriptions. Monthly Pro products are public so the customer portal can offer plan changes; yearly Pro products remain drafts. Only Pro 100k Monthly and Pro 100k Yearly have a 14-day free trial. All larger products have no trial. Each Pro product has three benefits: its event allowance, website allowance, and all reports/events/environments. Event credits have rollover disabled. Prices are fixed; no metered overage price was added.

## Required before activation

- **Yearly billing with monthly allowances:** the API rejected `meter_interval: "month"` with `Separate meter cycling is not enabled for this organization.` The six yearly products therefore remain drafts, with `activation_blocked: enable_monthly_meter_cycle`. Their monthly credit benefit is attached but would currently renew on the annual billing cycle. Before making these products purchasable, enable separate meter cycling, set `meter_interval: "month"` and `meter_interval_count: 1`, verify the resulting monthly grant schedule, and remove the pending metadata. Do not substitute one annual pool for the promised monthly allowance.
- **Payments:** the organization is active. Polar now confirms checkout payments, subscription renewals, and payouts are enabled.
- **Enterprise:** contact sales is a plain `mailto:hello@usedatix.com` link for more than 5 million events. The unused Enterprise draft is archived; no Enterprise checkout product is needed.
- **App integration:** the webhook receiver is deployed and registered, and stores customer/subscription state. Local usage counting and allowance enforcement are implemented. Checkout, customer mapping, the billing portal and durable Polar usage delivery are now implemented. The access token is installed as an encrypted Worker secret. No paid purchase was completed during verification.
- **Pricing page:** Contact sales links to `mailto:hello@usedatix.com`. Monthly checkout is available. Yearly pricing remains a preview with checkout disabled.

## Event meters

All three meters filter the event name `analytics.events.v1` and sum the numeric `event_count` metadata field:

| Meter           | Additional filter       | Purpose                               |
| --------------- | ----------------------- | ------------------------------------- |
| Events          | None                    | Shared plan allowance and total usage |
| Pageviews       | `event_type = pageview` | Usage breakdown                       |
| Activity events | `event_type = event`    | Usage breakdown                       |

The main Events meter is linked by the allowance benefits. The other meters are diagnostic breakdowns, not additional billable quantities.

Example payload for the Polar event ingestion API:

```json
{
  "events": [
    {
      "name": "analytics.events.v1",
      "external_customer_id": "ANALYTICS_BEER_ACCOUNT_OWNER_ID",
      "metadata": {
        "event_type": "pageview",
        "event_count": 12
      }
    },
    {
      "name": "analytics.events.v1",
      "external_customer_id": "ANALYTICS_BEER_ACCOUNT_OWNER_ID",
      "metadata": {
        "event_type": "event",
        "event_count": 8
      }
    }
  ]
}
```

This records 20 Events, 12 Pageviews, and 8 Activity events. Use the authenticated website owner's account ID, never an anonymous tracked visitor ID. Send positive credit quantities, with at most two decimal places. Production pageviews cost 1 credit and other actions cost 0.5. Localhost applies a 0.3 multiplier: 0.3 per pageview and 0.15 per action. Engagement heartbeats remain free. Historical usage is preserved at its original rate. Reports continue to show actual counts. Emit counts from committed, deduplicated ingestion results with a durable delivery mechanism; do not count collector retries or replay whole successful batches. Keep raw IPs, page paths, browser information and visitor identifiers out of billing payloads.

Polar accepts usage even when an allowance is exhausted; application code must enforce any limits. No automatic overage fee is configured. Wire customer mapping, checkout/webhooks, usage delivery, and enforcement before representing billing as active.

References: [Meters](https://polar.sh/docs/features/usage-based-billing/meters), [event ingestion](https://polar.sh/docs/features/usage-based-billing/event-ingestion), [credit benefits](https://polar.sh/docs/features/benefits/credits).


## Live webhook

`POST https://analytics.beer/api/webhooks/polar` is registered as **Analytics Beer billing** (`a4cbb9b8-0ab9-4f78-8bbe-a44e07804d2f`). It subscribes to `customer.state_changed` and `customer.deleted`. Customer state snapshots cover trial, subscription and benefit changes; a subscription canceled at period end remains present while still active.

The endpoint signing secret is installed in Cloudflare as `POLAR_WEBHOOK_SECRET`, separate from `POLAR_ACCESS_TOKEN`. The receiver uses the official SDK to verify the exact request bytes, signature and delivery timestamp, then checks the Analytics organization ID. It fails closed with 503 when no signing secret is configured.

Migration `0005_last_ender_wiggin.sql` adds `billing_webhook_events` and `billing_customers`. Event ID deduplication and snapshot writes share one transaction. Older event timestamps cannot replace newer state, including differences smaller than one millisecond. Database failures return 503 with Retry-After so Polar can retry. Only account IDs and selected subscription fields are stored; emails, addresses, payment details, and raw webhook bodies are discarded. Account linking uses `external_id` matching an existing auth user ID, never email. The collector and queue consumer use this billing state to enforce active Pro access and event allowances. Checkout activation is handled by the authenticated billing routes.

Verification: 29 unit tests and 32 integration tests passed. Live signed fixtures verified valid delivery, invalid signatures, retries, ordering, storage and deletion; all disposable database rows were removed. See `artifacts/polar/webhook-production.json`. These were locally signed requests to the live Worker, not a real subscription purchase or a Polar-originated delivery. Polar endpoint registration was independently read back. A provider-side disposable-customer test was rejected because example.com does not accept email; no customer was created.

Re-run receiver verification with `POLAR_WEBHOOK_SECRET_FILE=/path/to/protected-secret bun --env-file=.env.production scripts/polar-webhook-qa.ts`. The script reads its secret from a protected file, validates the production hostname, and cleans up only its own rows.


## Usage and automatic pausing

The account Usage tab is available at `/usage`, backed by authenticated `GET /api/usage`. It shows the shared event allowance, UTC period, website counts and per-website status. Accounts without an active Pro subscription or unexpired Pro trial cannot collect events. There is no preview or free allowance. Historical reports and installation settings remain accessible.

Allowances come from the known Pro product IDs in the catalog. An account's pageviews and tracked actions count across every website and environment. Engagement heartbeat records and duplicate deliveries do not consume credits. Counters are stored in `billing_usage`, independent of raw-data retention and website/environment deletion. Migration `0006_outgoing_loa.sql` adds this table.

Admission, raw-event deduplication, counter increments and report updates commit in one PostgreSQL transaction. Account locks serialize concurrent batches; no events beyond the allowance are committed. The collector returns `202 {accepted:false,reason:"subscription_required"|"event_limit"|"website_limit"|"website_budget"}` when paused. A queue write already accepted before a limit or subscription change is checked again during consumption. Paused events are discarded, not replayed later.

Quota pauses are computed from billing state and counters, without changing environment enabled switches. Tracking resumes when an active plan has a renewed allowance or a larger allowance is granted. UTC monthly windows are anchored to the subscription billing period, including annual plans, with calendar-aware month-end handling. Trial/period expiry pauses collection until valid state arrives. Late deliveries never spend a later month's allowance; messages outside the current subscription's billing interval are dropped.

Pro supports ten registered websites. Creating an eleventh is rejected; if a legacy account already has more, the oldest ten websites are eligible to collect and the rest report a website-limit pause. Manual environment switches remain independent: pausing Production does not pause Staging. If multiple Pro subscriptions exist, the largest active allowance is used rather than adding allowances together.

Polar usage delivery is connected. Migration `0007_abnormal_unicorn.sql` adds a checkout cache and durable outbox. Each analytics transaction writes positive counts for committed, deduplicated pageviews/actions into the outbox. Groups keep owner, event type and allowance period separate; timestamps come from actual receipt times. Only the immutable account ID, event category and quantity leave the app.

The consumer attempts delivery after acknowledging committed analytics. A once-per-minute scheduled handler retries pending rows, while the existing daily schedule still performs retention. Leases prevent concurrent delivery; each row retains its UUID-derived Polar `external_id` across retries. Both inserted and duplicate responses count as acknowledged. Partial responses and failures preserve the rows with backoff; logs omit payloads and credentials. Queued billing data is removed if its account is deleted.

`POST /api/billing/checkout` accepts only catalog-backed monthly volumes and locale, derives identity from the authenticated user, and fixes return URLs to the app. Existing subscribers go to the billing portal. Concurrent attempts reuse one open checkout; a provider lookup recovers a checkout if the initial response/database write was lost. Products and prices are never accepted from the client. Yearly requests fail closed.

`POST /api/billing/portal` creates a session for the authenticated account. `POST /api/billing/sync` fetches customer state by immutable external ID; the browser return query alone never grants access. API snapshots cannot replace newer webhook state. Account deletion requires canceling any automatically renewing subscription first. Upgrades and cancellation are managed in Polar; subscription state continues to drive local allowance enforcement.

The token is never sent to the browser or stored in versioned config. Local development reads the ignored `.dev.vars`; Cloudflare uses its encrypted `POLAR_ACCESS_TOKEN` binding. Keep that name in `secrets.required`, since Wrangler filters local secret files when a required-secret list is configured.

### Access-token verification — 2026-09-07

The user updated the token permissions after the initial customer/customer-session requests returned insufficient scope. Current probes now pass these authorization checks, along with product/checkout access, subscription reads, usage ingestion and customer-meter reads.

The final checkout is restricted to one selected monthly product. Existing multi-product cached sessions are skipped when requesting a new checkout. A customer is created with the authenticated account's immutable external ID before checkout, so open sessions can be recovered through Polar before a purchase is completed. Concurrent requests for the same plan reuse the existing checkout.

The focused billing integration suite passed five tests with 51 assertions after the one-plan correction. The preceding full integration suite passed 43 tests (366 assertions), and 31 unit tests passed. Live browser verification covers signup preserving plan selection, hosted checkout showing one product with a 14-day trial and correct price, annual checkout rejection, and the authenticated billing portal. No completed purchase is claimed.

Live verification completed at 2026-09-07T11:16:10Z. The browser showed exactly one selected checkout plan, the correct $9/month price and 14-day trial, checkout reuse, the annual gate, and the authenticated billing portal. Two actual tracker events committed through the production queue and drained from the durable Polar outbox; direct provider retries returned one duplicate and zero extra inserts. Mobile overflow checks and browser error checks passed. No purchase was completed, and customer meters remained empty for the disposable unsubscribed customer, so a real subscription benefit grant and meter balance were not verified. Evidence: `artifacts/billing/production/verification.json`. Disposable accounts and provider customers were removed.

### Plan changes and trial eligibility — 2026-09-07

All six monthly products are public and eligible for the already-enabled customer portal plan switcher. Only the two Pro 100k products retain a 14-day trial; the other ten products have both trial fields cleared. The app explicitly disables trials on larger checkout selections and updates reused checkout sessions accordingly. Pricing and Usage copy follow the selected volume. Existing customer subscriptions were not changed. All twelve product settings were read back successfully; see `artifacts/billing/plan-settings.json`.

Migration `0008_sweet_vision.sql` stores exact decimal credits in usage and the delivery outbox, and adds per-environment tracking settings. Disabled event types are rejected by the collector and rechecked inside admission. Optional details are stripped before storage. The tracker loads public `GET /api/tracker-config?siteId=…&environmentId=…` settings (no account data), refreshes after 60 seconds, and pauses when settings cannot be loaded. Apply this migration before deploying the Worker.


Free was removed on 2026-09-07. The already-applied `0010_green_molly_hayes.sql` migration and its retired `free_usage` table remain for migration compatibility and historical data; neither grants collection access or receives new usage.

# API contract

Base URL in development: `http://localhost:3000`. Application OpenAPI: `GET /api/openapi.json`.

Axum serves the API and the static TanStack Router frontend from the same Rust process. `GET /api/preferences` returns `{ locale: 'en' | 'de' | 'da', theme: 'system' | 'light' | 'dark' }`; saved preference cookies override trusted country defaults. This endpoint is public and its response is not cached.

## Authentication

Better Auth owns `/api/auth/*`. Email/password is enabled for the current development/beta phase; passwords must contain 12–128 characters. Verification and password recovery emails are not configured yet. Configure a delivery provider and these flows before open registration.

| Method | Path                      | Request                                                                               |
| ------ | ------------------------- | ------------------------------------------------------------------------------------- |
| POST   | `/api/auth/sign-up/email` | `{ "name": "Sam", "email": "sam@example.com", "password": "a-long-unique-password" }` |
| POST   | `/api/auth/sign-in/email` | `{ "email": "sam@example.com", "password": "a-long-unique-password" }`                |
| GET    | `/api/auth/get-session`   | Session cookie                                                                        |
| POST   | `/api/auth/sign-out`      | `{}` and session cookie                                                               |
| GET    | `/api/me`                 | Session cookie; returns minimal user details                                          |

Preserve `Set-Cookie` responses and send the cookie on account/reporting requests. HTTPS deployments use secure cookies. All POST/PATCH/DELETE account requests require `Origin` equal to the configured `APP_URL`. The dashboard shares that origin; cross-origin dashboard clients are not enabled. Sign-out invalidates the server-side session immediately. Database authorization reads use the direct Neon connection without proxy caching.

Better Auth returns its own response/error format. Application errors use `{ "error": { "code", "message", "requestId" } }`. Responses include `X-Request-Id`, `Cache-Control: no-store`, and `Retry-After` for 429/503. Health reports only Worker availability, not database readiness.

## Websites

| Method | Path                          | Behavior                                                               |
| ------ | ----------------------------- | ---------------------------------------------------------------------- |
| GET    | `/api/sites`                  | Returns `{ sites: [...] }`; maximum 100 per account                    |
| POST   | `/api/sites`                  | Accepts `{ name, domain }`, returns `{ site }` with 201                |
| GET    | `/api/sites/:id`              | Returns `{ site }`                                                     |
| PATCH  | `/api/sites/:id`              | Accepts `name`, `enabled`, and/or `allowLocalhost`; returns `{ site }` |
| DELETE | `/api/sites/:id`              | Deletes site, raw events, visitor hashes and summaries; returns 204    |
| GET    | `/api/sites/:id/installation` | Returns `{ receiving, lastReceivedAt }` from a persisted pageview      |

A website belongs to one account. All reads and mutations verify the owner and return 404 for another account's website. A hostname is unique per owner, immutable, and exact: `example.com` and `www.example.com` are different websites. Hostnames use ASCII DNS labels; provide punycode for internationalized names where supported. Domain verification is not a claim of ownership: the public collector validates the event origin, and this check does not prevent forged traffic from non-browser clients.

`allowLocalhost` defaults to `false` for new and existing websites. Enable it in Installation or Website settings, or PATCH `{ "allowLocalhost": true }`, to accept HTTP(S) activity from `localhost`, `127.0.0.1`, and `::1` on any port as well as the registered domain. The browser Origin must still exactly match the event URL’s origin, including scheme and port. Other hosts, LAN addresses, and localhost subdomains are not added. Test activity is included in normal reports and remains after the option is disabled. Pausing collection also stops localhost events. The same tracking script works without modification. Browser DNT signals still prevent the tracker from sending requests. Local pages log these skip reasons and collector HTTP statuses to the browser console; `data-debug` enables these diagnostics on non-local pages without logging event payloads.

`receiving` means at least one pageview exists within the raw-data retention period; it is an installation check, not a real-time uptime signal. Pausing prevents new collection; already accepted queue messages may still finish. Deleting a site makes pending messages no-ops and prevents data resurrection.

## Collection

Historical Plausible and GA4 exports use the owner-authenticated [imports API](imports.md#api). They are stored as separate aggregates and do not enter event collection or billing.

`POST /api/collect` accepts `application/json` or JSON carried as `text/plain` (avoids a browser CORS preflight). Maximum body: 8192 bytes. Cookies are unnecessary. OPTIONS is supported; collection responses allow any browser origin without credentials, while payload validation enforces the site's allowed hostnames and Origin/URL agreement.

```json
{
  "siteId": "cfa2f62c-d380-4a6b-b872-b1c8078c3731",
  "id": "e76b760c-3305-44d5-b2e8-ea53dfbaaf4c",
  "type": "pageview",
  "url": "https://example.com/pricing",
  "referrer": "https://search.example/"
}
```

For a custom event use `"type": "event"` and add `"name": "signup"`. Names start with a letter, contain letters/digits/underscore/dot/hyphen, and have at most 64 characters. Unknown properties and client timestamps are rejected. Generate a new UUID for each real event and reuse it for retries. The first persisted event for a `(siteId, id)` wins.

`202 { "accepted": true }` means the event was durably accepted by the queue, not that reports already contain it. An unavailable queue returns 503. Global Privacy Control (`Sec-GPC`) does not suppress collection. DNT or detected bot traffic receives `202 { "accepted": false, "reason": "excluded" }`. Bot detection is deliberately basic and is not a comprehensive bot filter. Reports become visible after the consumer commits, normally after a short batch delay.

## Reports

All reporting endpoints require the owner's session. `from` and `to` are inclusive UTC dates (`YYYY-MM-DD`), defaulting to the last 30 days. Requests span at most 366 days and must lie within the last 730 days, with no future dates.

| Endpoint suffix under `/api/sites/:id` | Response                                                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `/overview`                            | `{ range, pageviews, customEvents, dailyUniqueVisitors, visitorMetric }`                                 |
| `/timeseries`                          | `{ range, data: [{ day, pageviews, customEvents, dailyUniqueVisitors }] }`; missing days are zero-filled |
| `/breakdown?dimension=path&limit=10`   | `{ range, dimension, metric, data: [{ value, count }] }`                                                 |

Dimensions: `path`, `referrer`, `country`, `device`, `event`. Limits: 1–100 results. All except `event` count pageviews. `event` counts named custom events. Empty referrers/countries mean direct or unknown. Device categories are desktop/mobile/tablet, inferred coarsely from the browser header. Country comes from Cloudflare metadata and can be unknown in development.

Cookieless daily visitor estimates use an HMAC of environment ID, UTC date, network address and a bounded browser header. Raw IP addresses and browser headers do not enter analytics storage. Shared networks/browsers can undercount and changing addresses can overcount. The same visitor on two days counts twice in a range; `visitorMetric` explicitly identifies this as `sum_of_daily_unique_visitors`. This is not a count of distinct people over the whole period. Rotating the hash secret during a day can split visitor counts.

Cookieless collection stores URL paths and referrer hostnames. Query strings and fragments are discarded. Paths and custom event names may themselves contain sensitive data: site owners should avoid including it. Login session records are separate from analytics and may retain IP/browser information as part of Better Auth session security. Cookieless collection alone is not a privacy/compliance guarantee.

## Delivery and retention

The consumer writes raw events, visitor deduplication records, and summary increments in one PostgreSQL transaction. It acknowledges only committed valid messages. Duplicate delivery never increments summaries a second time while the raw deduplication record exists. Invalid envelopes and failed transactions retry and eventually go to the configured dead-letter queue. The 30-day raw retention exceeds the maximum Cloudflare Queue retention of 14 days. Events older than the raw retention window are discarded rather than replayed into summaries.

The scheduled job runs at 03:17 UTC. It removes raw events/visitor records beyond approximately 30 days and summaries outside 730 calendar days, and cleans expired auth sessions/rate limits/verifications. Raw retention is a cleanup target, not immediate deletion at exactly 30 days: daily scheduling and backlog can delay removal. Each invocation deletes at most 100,000 rows per table in bounded chunks; `backlogPossible=true` requires follow-up. Keep queue and retention alerts enabled when the service is deployed.

Rate limiting currently allows up to 120 collector requests per IP per minute, 20 auth requests per IP per minute, and 120 API requests per IP and account per minute, with additional database-backed Better Auth limits. Cloudflare's limiters operate per location and are best-effort abuse controls, not globally exact billing quotas. Shared public IPs share limits. There are no paid plans or billing limits in this phase.

### Repeated pageviews

The browser tracker throttles the same normalized origin/path for 60 seconds per site and tab, including reloads and return navigation. It uses sessionStorage for recent timestamps and falls back to memory when storage is unavailable. Query strings and fragments are not part of the key. Throttled visits log `[Analytics Beer] Pageview ignored - throttled (same URL within 1 minute)` and do not extend the window. Custom events are not throttled. Rejected collection clears the timestamp; transport retries keep the original event ID. This is a browser-side throttle, separate from server event-ID deduplication and rate limits.

## Environments

Every website starts with a default **Production** environment whose ID equals the site ID. Existing scripts and reports continue to use it. Site responses include an `environments` array. Each environment has its own name, exact domain, collection pause, localhost permission, script, and reports; names can be custom and are unique per site ignoring case. Maximum 20 environments per website, including Production.

- `GET /api/sites/:id/environments` lists environments.
- `POST /api/sites/:id/environments` accepts `{ name, domain?, allowLocalhost? }`; domain defaults to the site domain. Returns `{ environment }` with 201.
- `GET/PATCH /api/sites/:id/environments/:environmentId` reads or updates an environment. PATCH accepts `name`, `domain`, `enabled`, and `allowLocalhost`.
- `DELETE /api/sites/:id/environments/:environmentId` deletes that environment and its traffic. The default environment cannot be deleted or change domain; its name can change.

All environment mutations require the same owner session and matching Origin as site mutations. Legacy site `enabled` and `allowLocalhost` updates affect only the default environment. Deleting a website deletes all its environments.

Use `?environment=UUID` on installation, overview, timeseries, and breakdown endpoints. Omission selects the default environment. An ID belonging to a different website is rejected. Collector payloads accept optional `environmentId` alongside `siteId`. Tracker snippets for custom environments include both attributes:

```html
<script
  defer
  src="https://analytics.beer/tracker.js"
  data-site="SITE_ID"
  data-environment="ENVIRONMENT_ID"
></script>
```

Visitor estimates, event deduplication, and the one-minute pageview throttle are isolated by environment. Existing snippets without `data-environment` remain valid.

## Cookie-based sessions and activity

Environments expose `trackingMode: "cookieless" | "sessions" | "local"`. Existing environments default to `cookieless`. Set `trackingMode` on the environment PATCH endpoint (or creation). The dashboard exposes it in Website settings and explains the cookie requirement before enabling it. Replace your tracking snippet when changing modes.

**Session mode uses cookies and requires a cookie banner.** Connect the banner's affirmative analytics-consent callback before collecting anything, provide refusal and withdrawal, and explain the cookies and data in your notices. See [Datatilsynet's cookie guidance](https://www.datatilsynet.dk/regler-og-vejledning/cookies-og-lignende-teknologier). Enabling this setting does not create a cookie banner.

```html
<script
  defer
  src="https://analytics.beer/tracker.js"
  data-site="SITE_ID"
  data-environment="ENVIRONMENT_ID"
  data-mode="sessions"
></script>
```

```js
// Call from your banner when analytics consent changes, and restore its saved
// choice on every page. This works before or after the tracker loads.
function onAnalyticsConsentChanged(granted) {
  window.analyticsBeerConsent = granted === true;
  window.simpleAnalytics?.consent(granted === true);
}
```

No tracking cookies, pageviews, or activity events are created before affirmative consent. Refusal or withdrawal deletes this environment's cookies, cancels in-flight requests where possible, prevents retries and future collection, and broadcasts withdrawal to open same-origin tabs. Events already delivered cannot be unsent. The consent manager is responsible for persisting and restoring the consent choice. The tracker does not persist consent itself.

| Cookie                      | Purpose                        | Expiry                              |
| --------------------------- | ------------------------------ | ----------------------------------- |
| `ab_visitor_ENVIRONMENT_ID` | Random pseudonymous visitor ID | 90 days, renewed by activity        |
| `ab_session_ENVIRONMENT_ID` | Random visit/session ID        | 30 minutes without tracked activity |

Cookies are first-party, host-only, Path=/, SameSite=Lax, and Secure on HTTPS. Raw cookie identifiers and IP addresses are not stored in analytics tables. Server HMAC keys scope session and visitor references to the environment. Identity does not cross websites or environments. Cookie restrictions, rejection, DNT, blockers, and network failure can prevent collection.

Automatic activity includes every page visit (including reloads and SPA path changes), clicks, outbound links, downloads, form submit events, scroll milestones, and active time. Cookieless mode retains its existing one-minute same-path pageview throttle. A click on a download or outbound link records both the click and the specific action. Submission events indicate a browser form submission attempt, not server-confirmed success. Use `simpleAnalytics.track('signup_complete')` after confirmed success.

Activity records include a client timestamp and page-local sequence to order actions despite network delivery order. Client times more than five minutes from receipt are replaced with receipt time; retention uses server receipt time. Activity details include structural element paths or explicit labels, click position as viewport percentages, destination URL without query/fragment, viewport and screen dimensions, browser family, operating system, language, device, country, and referrer host. Typed input values, passwords, page text, arbitrary attributes, full DOM contents, and keystroke values are not collected. This mode provides an activity timeline, not visual session replay. Paths and explicit labels can still contain personal data; exclude sensitive pages/sections and use nonpersonal labels.

```html
<div data-analytics-ignore>Private section excluded from automatic activity</div>
<button data-analytics-label="checkout-button">Continue</button>
<!-- Use data-analytics-ignore on html or body to exclude the whole page. -->
```

Active time is estimated with 15-second heartbeats while the page is visible and there was recent interaction (within 30 seconds). Heartbeats do not increase the Events count. Background or idle time is excluded. It is not a recording of attention or exact wall-clock duration.

Collector requests in session mode include `session: { consent: true, visitorId, sessionId, kind, details }`; see OpenAPI for allowed types and bounds. This is a client assertion of consent, not independent evidence that a banner collected valid consent. The collector rejects missing session metadata in session mode, session metadata in cookieless mode, unknown fields, and mismatched pageview kinds. Queue version 3 contains only environment-scoped hashed identities and sanitized details; versions 1/2 remain supported. Ingestion atomically deduplicates raw events, activity, visitors, and counters.

`GET /api/sites/:id/sessions?environment=UUID&from=YYYY-MM-DD&to=YYYY-MM-DD` returns session/visitor/click totals, average active time, and the latest 50 sessions. Sessions with activity in the selected dates are included; metrics use activity within that window. Pass `offset=nextOffset` while `hasMore` is true. Add `session=SESSION_KEY` to retrieve its chronological timeline in pages of 200 events. All reads enforce site ownership and environment membership. The dashboard's Sessions & activity section supports both pagination paths. If switched back to cookieless mode, retained session history remains accessible.

Detailed session activity is readable for 30 days and removed by scheduled retention. Aggregate pageview/event summaries keep their existing 730-day retention. Deleting an environment or site deletes its session activity as well. Historical cookieless traffic cannot be reconstructed into sessions.

### Cookieless visitors with local storage

Set the environment to `trackingMode: "local"` and replace its snippet with `data-mode="local"`. This enables the same Visitors page, history, and activity events without tracking cookies. Aggregate-only `cookieless` remains unchanged. No database migration or automatic mode switch is performed.

Use the same consent callback shown above. The tracker accesses no identity storage or activity collection before consent. It stores one origin/environment-scoped record at `analytics-beer:identity:ENVIRONMENT_ID` with random visitor/session UUIDs and expiry timestamps. Visitor expiry is renewed to 90 days and session expiry to 30 minutes on activity. Expired IDs are replaced on the next consented event; local storage does not delete records automatically when a timestamp expires. Blocked storage stops visitor collection instead of silently creating volatile identities. Withdrawal deletes the scoped record and cancels activity across tabs through BroadcastChannel and storage events. The banner owns consent persistence.

Local visitor payloads require `session.storage: "local"` and `session.consent: true`. The collector rejects mismatches with the environment's mode. Legacy cookie payloads may omit `storage` (treated as `cookie`). Hashed identities, ownership checks, visitor filters, activity retention, and queue deduplication are shared with cookie sessions. The Agent button includes the correct mode and consent requirements.

### Tracking controls and event credits

Environment settings offer individual switches for pageviews, custom events, clicks, outbound links, downloads, form submissions, scroll depth and engagement time. Optional details include referrers, country, device/browser/OS, screen size, language and click positions. Existing environments default to all enabled. PATCH the environment with a complete `trackingSettings` object to save these booleans. Existing reports remain unchanged.

The tracker reads public `/api/tracker-config?siteId=UUID&environmentId=UUID` settings, caches them for 60 seconds and pauses if settings cannot be loaded. Collection and queue admission also enforce the current policy. Disabled details are stripped before storage; disabled events do not use credits.

The usage allowance counts credits: production pageviews cost 1, production actions 0.5, localhost pageviews 0.3, and localhost actions 0.15. Engagement time is free. Discounts combine. Reports still count actual events, and historical billed usage keeps its original value. Localhost classification is derived by the collector after exact Origin/URL validation, never supplied as a billing flag by the client.

### Spam protection and website budgets

Collection checks persistent source counters before sending an event to the queue. Detected spam returns HTTP 202 with `accepted: false, reason: "spam_detected"`; these requests enter neither reports nor the billing outbox. The existing network limit may instead return HTTP 429. Rejected events are discarded and are never replayed later.

The detector learns hourly from up to 14 completed days of accepted daily summaries. At least three days with visitors and 20 events are required for historical detection. It uses medians and excludes days with 50 or more blocked requests to limit the influence of attacks. Source limits and repetitive-activity detection work immediately. A site-wide volume spike requires an additional source-level reload loop or abnormal action mix before historical detection blocks a request. Source counters are exact under concurrent requests; the historical traffic window is a recent snapshot. This is statistical, rule-based protection, not a trained AI model or a guarantee against distributed abuse.

Network source identities are HMACs of environment, UTC day and the trusted client IP. Browser names and client-supplied visitor/session IDs cannot reset the limits. Raw IPs and rejected payloads are not stored. Short-lived source counters and pattern hashes are scheduled for deletion after two days; aggregate blocked-request counts are retained for 90 days. Usage shows the last 30 days, excluding edge-rate-limit rejections and the basic bot/opt-out filter.

`PATCH /api/sites/{siteId}` accepts `creditBudget` (a positive number of credits, minimum 0.15, two decimals, or null to remove it). This optional ceiling applies to all environments in that website within the current account allowance period. Already consumed credits count immediately. Admission enforces the website and account ceilings in the same transaction, and capacity renews with the account period. A site reports `website_budget` when less than 0.15 credits remain; it can reject a more expensive event before that point. Other websites remain eligible for collection. Usage offers the same control under each website.

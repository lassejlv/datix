# Optional environment features

Each environment has its own switches under **Settings → Features**. Goals, Error Tracking, Globe and Pulse start disabled. Web Vitals starts enabled. Disabling a feature stops its additional collection or monitoring; previously collected reports remain available for their retention window. Globe uses the existing country setting and never collects city coordinates.

## Goals

Create up to 20 named goals per environment. Match either an exact custom event name (for example `signup`, sent with `simpleAnalytics.track('signup')`) or an exact page path (for example `/thank-you`, without query parameters). Matching starts when the goal is created. The underlying pageview or custom event must be enabled and admitted normally. A retried event cannot create a second conversion. Goals do not add billable events.

Reports show conversions, daily unique converting visitors and their rate against daily unique visitors in the selected UTC calendar dates. Deleting a goal removes its conversion history. Conversion records expire after 30 days.

## Error Tracking and Web Vitals

The existing tracker loads the separately bundled `/web-vitals.js` module only when the feature is enabled. It uses the official `web-vitals` package for LCP, INP and CLS, without DOM attribution. INP requires visitor interaction. Reports show the 75th percentile separately for each device class. Values can update within a page lifetime without adding another measurement.

Error Tracking listens for uncaught JavaScript errors and unhandled promise rejections. It records a bounded message, source, stack, line and column, grouping errors by normalized message and source. Marking an error resolved records a timestamp; a later occurrence reopens it. At most ten distinct errors are reported per page. URL queries/fragments, email addresses, quoted values and long tokens are stripped before sending and again before storage. Avoid embedding personal data in application error messages.

Both features respect Do Not Track, `data-analytics-ignore`, environment status and the selected consent mode. Session/local mode waits for explicit analytics consent; revocation cancels pending transmissions. They use the existing durable Redis stream, stable event IDs, daily anonymous visitor hashes and separate PostgreSQL diagnostic records. Diagnostics do not change pageviews, visitor journeys or billing usage. An active subscription and website allowance are required. Diagnostic records expire after 30 days.

## Globe

The globe shows daily unique visitors by country over the last 24 hours, visitors active in the last five minutes, top referrers and recent events. Counts refresh every 30 seconds while the page is visible. Country bubbles represent aggregates, not exact individual locations. Unknown locations remain in the country list. Drag or use arrow keys to rotate; buttons zoom, reset and open a fullscreen overlay. No map requests go to a third-party mapping service.

The bundled geographic geometry and label points are derived from [Natural Earth's public-domain country dataset](https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_admin_0_countries.geojson), at 1:110m scale. Small territories may not have a visible shape at this scale.

## Pulse

Enable Pulse and save a public HTTPS monitor URL for the environment's exact domain. Optionally link a public HTTPS webhook in the same settings panel. The saved webhook is never returned by the API; an empty field preserves it and the explicit removal checkbox deletes it.

Workers schedule checks every minute. Two consecutive failed checks confirm an outage. The initial successful check is silent; confirmed outages and subsequent recoveries create durable alerts. Webhooks receive JSON with `id`, `event` (`pulse.down` or `pulse.up`), `url`, `state`, `text` and `content`. The stable alert ID is also sent as `Idempotency-Key`. Delivery is at least once: receivers should deduplicate that ID. Only a 2xx response counts as delivery. Failed deliveries retry up to five attempts with increasing delays; the Pulse page shows delivery failure.

Requests use HTTPS port 443, bounded timeouts and DNS resolution restricted to public addresses. Validated addresses are pinned per request to prevent DNS rebinding. Monitor redirects must stay on the same hostname; webhook redirects are not followed. No response bodies, cookies or authentication headers are collected. Checks stop when the feature/environment/site is disabled or the account lacks an active website allowance. Uptime excludes monitoring gaps and is calculated from recorded checks, not elapsed time. Check history and alert records expire after 30 days.

## Release and rollback

Apply checksummed schema upgrade `0008_features.sql` as the database owner before starting the new services. It only adds tables and the `environments.feature_settings` column. Deploy the new worker successfully before the API: old workers cannot understand diagnostic envelopes. Purge `/tracker.js` and `/web-vitals.js` from the Cloudflare caches for both `usedatix.com` and `analytics.beer` after the API deployment; stable asset URLs can otherwise retain an older tracker. Keep the new worker running if rolling back only the frontend/API; drain diagnostics before rolling the worker back to a release without diagnostic support.

Focused verification: `optional_features_goals_diagnostics_and_privacy` in the ignored Rust integration suite, `features-qa.ts` against the isolated localhost app, and tracker/unit tests. Browser artifacts are under `web/artifacts/features/`.

## Overview

`GET /api/sites/:site/environments/:env/features/overview` returns traffic totals, daily series and five breakdowns, plus `previous`, `previousRange`, `goals`, and `annotations`. Date ranges are inclusive UTC days. The previous period is the immediately preceding interval of equal length, including comparison of today's partial traffic with a full day. A zero baseline is shown as no previous traffic rather than an infinite percentage.

`window=24h` selects a rolling 24-hour interval ending at one server-captured timestamp. It returns 24 one-hour buckets (`at` gives each bucket start), with a comparison covering the preceding 24 hours. Totals, filters and goals share those exact time bounds; visitor totals deduplicate within each UTC day across all buckets. This window uses native events and does not include imported daily aggregates. The response exposes the exact `window.from`/`window.to` and timestamp-based `previousRange`.

Optional exact-match `path`, `referrer`, `country`, and `device` query parameters combine with AND; an empty referrer explicitly selects direct traffic. Without filters, reports retain their existing native/import merging rules and two-year aggregate retention. Filters use native events from UTC midnight 29 days ago onwards (30 calendar dates including today), excluding imports. Responses expose `filtered`, `partial`, and `retainedFrom`; a comparison outside available retention is `null`, never a fabricated zero baseline. The UI labels retained-event coverage. Goal conversion counts and daily converting visitors use actual goal conversions joined to the same retained event scope; the conversion rate divides those visitors by retained daily visitors. It is available only within the retained 30-day portion of the selected dates. Primary goal choice is saved per environment in the current browser.

`GET .../features/live` returns the environment-wide last-five-minute active visitor estimate and ten recent events; it refreshes every 30 seconds in the overview and opens an accessible activity dialog. Live data is independent of historical date selections and filters.

`POST .../features/annotations` accepts `{ "action": "create", "day": "YYYY-MM-DD", "label": "Campaign launch" }` or `{ "action": "delete", "id": "uuid" }`. Notes are environment-owned, persist across browser sessions, and are shown in their selected date range. Labels are limited to 120 characters, with at most 500 notes per environment. They are removed when the environment is deleted. Authorization and CSRF protections match other feature configuration endpoints. Traffic periods use the existing report cache; notes are read fresh so writes are immediately visible.

Deployment requires owner-run `analytics-db upgrade` for upgrade 0011 before API/worker rollout. Startup never applies the upgrade itself.

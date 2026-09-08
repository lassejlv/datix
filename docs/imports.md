# Historical analytics imports

Open **Imports** in a website environment, select a provider, set its reporting timezone, and upload the export. **Review import** shows the dates, metrics and limitations without storing anything. Confirm the preview to add the historical data to Overview. Import history links to the imported report dates and allows removing an import independently of tracked data.

## Supported exports

- **Plausible:** full export ZIP from site settings → Imports & Exports → Export Data, or its `imported_visitors` CSV. Daily totals come only from that visitors file. ZIP imports also accept pages, sources/referrers, countries, devices and custom events. Other tables are explicitly identified as skipped. Dashboard “Export stats” files are not migration exports. Full exports exclude history previously imported into Plausible. See the [export guide](https://plausible.io/docs/export-stats) and [CSV schema](https://plausible.io/docs/csv-import).
- **Google Analytics 4:** an English CSV with exactly **Date**, **Views**, and **Total users**, in any column order. In Explore → Free form, use Date as the only table dimension and these two metrics, without segments or comparisons. Filter to the website's web stream if the property includes apps. Confirm web-only traffic before uploading. `Users`/`Active users` and additional dimensions are rejected rather than misinterpreted. See [Free-form setup](https://support.google.com/analytics/answer/9327972?hl=en), [exporting explorations](https://support.google.com/analytics/answer/7579450?hl=en), and [metric definitions](https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema).

This is a file-import feature. It does not connect provider accounts or perform recurring synchronization. GA4 exploration history depends on the property's retention settings; arbitrary reports and legacy Universal Analytics exports are not supported.

## Data boundaries

Imports accept completed source days within the existing 730-day reporting retention window, ending no later than yesterday. Source calendar dates and IANA timezone are preserved; daily aggregates cannot be accurately rebucketed into UTC. Actual source-day intervals, including DST, must end before the earliest native UTC reporting day. Existing imports cannot overlap by date or actual time interval, even across providers or timezones. Identical normalized content is idempotent. Late native history takes precedence in reports.

Daily visitors are summed daily provider counts, never period-unique people. GA4 Total users can exceed Views. Missing breakdowns and custom-event metrics are not invented. Aggregate exports cannot reconstruct visitor journeys. Page query strings and fragments are removed, and URL referrers are reduced to hostnames, with normalization disclosed in the preview.

Uploaded files are parsed in memory and are not retained. Accepted aggregates and import receipts are stored separately from native events, abuse baselines, and billing. Limits: 10 MiB upload, 32 MiB total ZIP expansion, 20 files, 100,000 records, and 50 imports per environment. Empty, malformed, encrypted and unsafe archives are rejected. Export a shorter date range when necessary.

## API

All endpoints require the environment's owner session. Mutations require the configured application Origin.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/sites/:site/environments/:environment/imports` | `{ imports: [...] }` |
| POST | `/api/sites/:site/environments/:environment/imports/preview` | Validate raw CSV/ZIP body; return a summary and canonical `fingerprint`; no persistence |
| POST | `/api/sites/:site/environments/:environment/imports` | Revalidate and commit the reviewed file; 201 new or 200 duplicate; `{ import, duplicate }` |
| DELETE | `/api/sites/:site/environments/:environment/imports/:id` | Remove this batch and its aggregates; 204 |

Uploads use `application/octet-stream` (`text/csv` and `application/zip` also accepted). Required query fields: `provider=plausible|ga4`, `timeZone=<IANA name>`, and `filename=<basename>`. GA4 also requires `webOnly=true`. Commit additionally requires the preview's `fingerprint` and the same file/configuration. Previews and commits share a 12-per-minute owner limit and two concurrent parser slots per process.

The preview/receipt includes provider, filename, source timezone, visitor metric, date range, daily row count, totals, available metrics and breakdowns, warnings, and fingerprint. Stored receipts also include `id` and `createdAt`. Overview adds `imports` provenance while preserving existing totals; timeseries and supported breakdowns include accepted historical data. Environment import revisions invalidate report cache keys across replicas after creation/removal.

## Schema rollout and verification

Upgrade `0004_imports.sql` adds import tables and `environments.import_revision`; apply it explicitly with the database-owner `analytics-db upgrade` command before starting this release. Startup verifies checksums and never migrates automatically. Production was upgraded to schema 4 on 2026-09-08 after deploying the schema-3 compatibility projections and waiting for the preceding API process to drain.

The preceding release uses prepared `SELECT *` queries on environments. Adding a column can invalidate their result types on pooled PostgreSQL connections. For a rolling rollout, first deploy explicit environment projections compatible with schema 3, then apply upgrade 4 and deploy this release. Alternatively use a coordinated maintenance cutover and recycle the old application/database connections. This release uses explicit projections. Do not modify an already applied upgrade or initialize an existing database from the baseline.

Validation uses synthetic fixtures matching documented Plausible schemas and explicitly supported GA4 columns, not a live provider-account connection. Run:

```sh
cargo test --workspace
cargo test -p analytics-server --test integration imports:: -- --ignored --test-threads=1
bun --env-file=../.env scripts/imports-qa.ts # from web/, against the isolated branch and localhost:3060
```

The ignored tests require `TEST_DATABASE_URL` and matching `TEST_DATABASE_HOST`, distinct from `DATABASE_URL`, plus local Redis. Browser checks create and clean up their own test account. They cover real ZIP/CSV upload, preview, commit, native reports, all five Plausible breakdowns, duplicate handling, GA4 metric semantics, report deep links, removal, zero billed usage, and desktop/mobile/dark layouts.

## Production verification — 2026-09-08

Deployed the working-tree build snapshot to web `0d96321f-d15a-4e3b-9f52-54d85ce7cbcf` and worker `592df52d-ac53-4ac0-89ad-0ae3f300736f`; both reached Railway `SUCCESS`. The preceding compatibility deployment was `4a4e8d0d-66d9-418f-b394-e17da1013514`. The deployed worker confirmed schema 4 using the actual restricted runtime role.

Browser verification against `https://analytics.beer` passed Plausible ZIP preview/commit, all five breakdowns, GA4 CSV totals, duplicate rejection, imported-date deep links, removal, desktop/mobile layouts and zero import allowance charges. A session created before rollout remained valid afterward; password login and a real tracker → worker → database → report round trip passed with the expected cumulative 0.9 credits. No browser errors occurred. Disposable accounts, synthetic billing fixtures and saved login credentials were removed. Local evidence and the build-input hashes are in `web/artifacts/imports-production/` and `web/artifacts/imports-release-production/`.

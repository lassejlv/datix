# Database setup and data migration

The default destination is Neon project `rapid-flower-57581427`, branch `br-ancient-smoke-b1le6vrt`, database `datix`. Its direct endpoint is `ep-red-shape-b1wifxvx.c-5.eu-central-1.aws.neon.tech`. Runtime credentials are restricted; owner credentials are only for schema changes and copying.

## Initialize a target

The supplied default database is already initialized. For another empty target, set `DATABASE_URL_UNPOOLED` to its direct owner URL, then inspect and apply:

```sh
bun run db:migrate --expect-host YOUR_DIRECT_HOST
bun run db:migrate --expect-host YOUR_DIRECT_HOST --apply
bun run db:runtime --expect-host YOUR_DIRECT_HOST --apply
```

The role command creates `datix_runtime` when absent, writes a generated connection string to ignored `.local/runtime.env`, and grants only business-table CRUD, schema-history reads, sequence usage and the fixed retention function. Existing passwords are preserved. If changing role defaults after pooled connections already exist, quiesce the new service and recycle those connections or restart that Neon compute before starting again; PostgreSQL role defaults take effect on newly opened backend sessions. Re-run it after migrations that introduce tables. Runtime role defaults impose a 15-second statement timeout, 3-second lock timeout, and 30-second idle transaction timeout. The application sets UTC through the Neon-supported startup option and verifies privileges, limits, checksums, lifecycle triggers, and hypertables at startup.

Migrations run under an advisory lock and reject changes to an already applied SQL file. Generate schema changes with `bun run db:generate`, review the SQL, then apply deliberately. Hypertable uniqueness includes its time partition key. Durable receipts enforce stable event IDs before analytics are written.

## Choose the source layout

`config/data-migration.example.json` describes the **current split source layout**: account data from the supplied primary Neon endpoint and analytics from a separately reachable PostgreSQL source. Both streams go into the same new Neon database. Fill in `sourceAnalytics.host` and `LEGACY_ANALYTICS_DATABASE_URL` with a reachable direct endpoint or local tunnel. The supplied private analytics hostname is not reachable from this Mac; no infrastructure was deployed to obtain access. A restored source backup can also be used.

`config/data-migration.legacy.example.json` describes the **older monolithic Rust layout**, with accounts, raw analytics, daily summaries and `event_receipts` in one source. The old monolithic connection supplied in the request did not establish a usable session during verification; choose a reachable restored copy if that is the source you need.

Copy the appropriate template to ignored `.local/data-migration.json`. Source credentials supplied in the request are saved in ignored `.env.migration-source`; add the reachable analytics source URL there when available. Review each host, port, database and role independently. The script requires direct endpoints and TLS for remote connections, rejects a destination matching either source, and never alters the sources.

For the monolithic layout, `rawFrom` is the first fully retained UTC raw day, no later than today. Raw totals for every day from that boundary must reconcile with legacy daily totals. Older daily summaries are retained; newer summaries are omitted so new events remain visible. All retained non-engagement raw events are copied, and legacy receipts are converted to delivered ingestion receipts. The split layout preserves the already migrated data directly; `rawFrom` does not filter its raw events.

## Rehearse, then copy

Keep API and worker writers stopped on the destination. Use a dedicated empty target: the script refuses to overwrite a populated target on the first run. Running local development against the intended target can populate it; use a separate development branch if preparing a final migration.

```sh
# Inventory only; no destination writes.
bun --env-file=.env --env-file=.env.migration-source scripts/copy-data.ts \
  --plan .local/data-migration.json --report .local/inventory.json

# Copy to an isolated rehearsal destination while the source stays available.
bun --env-file=.env --env-file=.env.migration-source scripts/copy-data.ts \
  --plan .local/data-migration.json --apply --snapshot --targets-quiesced \
  --report .local/copy-report.json

# Reconcile against the same unchanged source snapshot or quiesced source.
bun --env-file=.env --env-file=.env.migration-source scripts/copy-data.ts \
  --plan .local/data-migration.json --verify --report .local/verify-report.json
```

Each source is read within a repeatable-read, read-only transaction. Separate source databases do not share an atomic snapshot; `--snapshot` is for rehearsals, with external effects disabled. Verification after the source changes can correctly fail. Freeze the source or copy from stable restored snapshots for repeatable results.

For the final copy, drain old ingestion/billing queues, stop all old writers and use `--source-quiesced` instead of `--snapshot`. Keep destination writers stopped until verification succeeds. Do not point the new runtime at the old queue prefix. Preserve `BETTER_AUTH_SECRET` and `VISITOR_HASH_SECRET` so existing sessions, password hashes and visitor identities remain compatible.

Copies use bounded keyset batches, preserve JSON/numeric/timestamp values, reconcile all columns per batch, restore the audit sequence, and check complete table counts. Rerunning an interrupted copy requires exactly the same plan hash and an unchanged/quiesced source. It replays upserts from the beginning; it is not incremental synchronization and does not silently delete rows that disappeared from a moving source. Keep reports local because they describe database identities and record counts.

Only after final verification should the new Unkey runtime receive production traffic and enable live billing effects. Deployment and production copying were not performed by this implementation task.

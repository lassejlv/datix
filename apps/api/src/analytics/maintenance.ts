import { Effect, Clock } from 'effect';
import { removeArchive, removeEnvironmentArchives } from '../platform/storage';
import { Infrastructure } from '../platform/resources';
import { attempt } from '../shared/errors';

const analyticsTables = [
  ['imported_breakdowns', 'environment_id', 'day < current_date-729'],
  [
    'imported_daily_stats',
    'environment_id',
    'day < current_date-729 AND NOT EXISTS(SELECT 1 FROM imported_breakdowns b WHERE b.environment_id=imported_daily_stats.environment_id AND b.day=imported_daily_stats.day)',
  ],
  [
    'analytics_imports',
    'environment_id',
    'NOT EXISTS(SELECT 1 FROM imported_daily_stats d WHERE d.import_id=analytics_imports.id)',
  ],
  ['diagnostic_events', 'environment_id', "received_at < now()-interval '30 days'"],
  ['goal_conversions', 'environment_id', "received_at < now()-interval '30 days'"],
  ['activity_events', 'environment_id', "received_at < now()-interval '30 days'"],
  ['events', 'site_id', 'day < current_date-729'],
  ['daily_visitors', 'site_id', 'day < current_date-729'],
  ['daily_stats', 'site_id', 'day < current_date-729'],
] as const;

const primaryTables = [
  ['error_resolutions', "resolved_at < now()-interval '30 days'"],
  ['ingestion_receipts', "state<>'pending' AND created_at < now()-interval '731 days'"],
  ['rate_limit', 'last_request < (extract(epoch FROM now())*1000)::bigint-86400000'],
  ['session', "expires_at < now() AT TIME ZONE 'UTC'"],
  ['verification', "expires_at < now() AT TIME ZONE 'UTC'"],
  ['abuse_sources', "updated_at < now()-interval '2 days'"],
  ['abuse_daily', 'day < current_date-90'],
] as const;

/** Commits each bounded analytics deletion; a failure leaves the primary tombstone retryable. */
export const cleanDeletedEnvironments = Effect.fn('cleanDeletedEnvironments')(function* () {
  const r = yield* Infrastructure;
  const deadline = (yield* Clock.currentTimeMillis) + 8000;

  const rows = yield* attempt(
    () => r.primary`SELECT environment_id FROM analytics_deletions ORDER BY created_at LIMIT 16`,
  );

  for (const row of rows) {
    if ((yield* Clock.currentTimeMillis) > deadline) return;
    yield* attempt(() =>
      r.primary.begin(async (tx) => {
        const present =
          await tx`SELECT environment_id FROM analytics_deletions WHERE environment_id=${row.environment_id}::uuid FOR UPDATE SKIP LOCKED`;

        if (!present.length) return;

        for (const [table, column] of analyticsTables) {
          if (Date.now() > deadline) return;

          const deleted = await tx.unsafe(
            `DELETE FROM ${table} WHERE (tableoid,ctid) IN(SELECT tableoid,ctid FROM ${table} WHERE ${column}=$1 LIMIT 5000) RETURNING 1`,
            [row.environment_id],
          );

          if (deleted.length === 5000) return;
        }

        const receipts =
          await tx`DELETE FROM ingestion_receipts WHERE ctid IN(SELECT ctid FROM ingestion_receipts WHERE environment_id=${row.environment_id}::uuid LIMIT 5000) RETURNING 1`;

        if (receipts.length === 5000) return;
        await removeEnvironmentArchives(r, row.environment_id);
        await tx`DELETE FROM analytics_deletions WHERE environment_id=${row.environment_id}::uuid`;
      }),
    );
  }
});

export const retain = Effect.fn('retain')(function* () {
  const r = yield* Infrastructure;

  // Archives expire when their first day leaves retention, including mixed-age imports.
  const expired = yield* attempt(
    () =>
      r.analytics`SELECT id,environment_id FROM analytics_imports WHERE (summary->>'from')::date<current_date-729 AND NOT coalesce((summary->>'archiveDeleted')::boolean,false) ORDER BY created_at LIMIT 50`,
  );

  for (const row of expired) {
    yield* attempt(() => removeArchive(r, row.environment_id, row.id));
    yield* attempt(
      () =>
        r.analytics`UPDATE analytics_imports SET summary=summary||'{"archiveDeleted":true}'::jsonb WHERE id=${row.id}::uuid`,
    );
  }

  yield* attempt(() => r.sql`SELECT public.datix_retention()`);
  for (const [table, , predicate] of analyticsTables.filter(([name]) =>
    ['analytics_imports', 'imported_daily_stats', 'imported_breakdowns'].includes(name),
  ))
    yield* attempt(() =>
      r.analytics.unsafe(
        `DELETE FROM ${table} WHERE ctid IN(SELECT ctid FROM ${table} WHERE ${predicate} LIMIT 1000)`,
      ),
    );
  for (const [table, predicate] of primaryTables)
    yield* attempt(() =>
      r.primary.unsafe(
        `DELETE FROM ${table} WHERE ctid IN(SELECT ctid FROM ${table} WHERE ${predicate} LIMIT 1000)`,
      ),
    );
});

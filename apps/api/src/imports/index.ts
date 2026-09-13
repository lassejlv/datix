import * as Effect from 'effect/Effect';
import { archiveImport, removeArchive } from '../platform/storage';
import { Infrastructure } from '../platform/resources';
import { attempt, invalid, ApiError } from '../shared/errors';
import { getEnvironment } from '../sites/service';
import { id } from '../shared/validation';
import { canonicalFingerprint } from './fingerprint';
import { parse } from './parse';

const conflict = (code: string, message: string) => new ApiError({ status: 409, code, message });

export const imports = Effect.fn('imports')(function* (
  owner: string,
  site: string,
  key: string,
  operation: 'list' | 'preview' | 'create' | 'delete',
  query: Record<string, string>,
  request?: Request,
  importId?: string,
) {
  const r = yield* Infrastructure;
  const env = yield* getEnvironment(owner, site, key);

  return yield* attempt(async () => {
    if (operation === 'list') {
      const rows =
        await r.analytics`SELECT (summary||jsonb_build_object('id',id,'createdAt',created_at))::text AS data FROM analytics_imports WHERE environment_id=${env.id}::uuid ORDER BY created_at DESC,id DESC`;

      return { imports: rows.map((row: { data: string }) => JSON.parse(row.data)) };
    }

    if (operation === 'delete')
      return r.primary.begin(async (tx) => {
        await tx`SELECT id FROM "user" WHERE id=${owner} FOR UPDATE`;
        const rows = await tx`SELECT id FROM environments WHERE id=${env.id}::uuid FOR UPDATE`;
        if (!rows.length) throw invalid('Environment no longer exists.');
        await removeArchive(r, env.id, id(importId));

        const deleted =
          await tx`DELETE FROM analytics_imports WHERE environment_id=${env.id}::uuid AND id=${id(importId)}::uuid RETURNING id`;

        if (!deleted.length)
          throw new ApiError({
            status: 404,
            code: 'import_not_found',
            message: 'Import not found in this environment.',
          });
        await tx`UPDATE environments SET import_revision=import_revision+1 WHERE id=${env.id}::uuid`;

        return { deleted: true };
      });

    const name = query.filename ?? '',
      provider = query.provider ?? '',
      zone = query.timeZone ?? '';

    if (!name.trim() || name.length > 200 || name.includes('/') || name.includes('\\'))
      throw invalid('Use the export filename without a folder path.');
    if (provider === 'ga4' && query.webOnly !== 'true')
      throw invalid(
        'Confirm that the Google Analytics export contains only web traffic. Views can also include app screens.',
      );
    if (
      !request ||
      !['text/csv', 'application/zip', 'application/octet-stream'].includes(
        (request.headers.get('content-type') ?? '').split(';')[0]!,
      )
    )
      throw new ApiError({
        status: 415,
        code: 'unsupported_media_type',
        message: 'Upload a CSV file or Plausible export ZIP.',
      });

    const rate = Number(
      await r.redis.send('EVAL', [
        "local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],60) end;return n",
        '1',
        `${r.config.queuePrefix}:imports:${owner}`,
      ]),
    );

    if (rate > 12)
      throw new ApiError({
        status: 429,
        code: 'rate_limited',
        message: 'Too many requests. Try again in a minute.',
      });
    const data = parse(provider, name, new Uint8Array(await request.arrayBuffer()));
    const zones = await r.analytics`SELECT 1 FROM pg_timezone_names WHERE name=${zone}`;
    if (!zones.length)
      throw invalid('Choose a valid IANA source timezone, such as Europe/Copenhagen or UTC.');

    const dates =
      await r.analytics`SELECT d.day::text,(d.day::timestamp AT TIME ZONE ${zone}) AS starts,((d.day+1)::timestamp AT TIME ZONE ${zone}) AS ends FROM jsonb_to_recordset(${JSON.stringify(data.days)}::text::jsonb) d(day date)`;

    const today = new Date().toISOString().slice(0, 10),
      cutoff = new Date(Date.parse(today) - 729 * 86400000).toISOString().slice(0, 10);

    const days = data.days.map((row) => {
      const bounds = dates.find((d: { day: string }) => d.day === row.day);
      if (
        row.day < cutoff ||
        row.day >= today ||
        !bounds ||
        bounds.ends.getTime() > Date.now() ||
        bounds.starts >= bounds.ends
      )
        throw invalid(
          'Import complete dates within the last 730 days, ending no later than yesterday.',
        );

      return { ...row, starts: bounds.starts.toISOString(), ends: bounds.ends.toISOString() };
    });

    const totals = days.reduce(
      (sum, row) => ({
        pageviews: sum.pageviews + row.pageviews,
        dailyVisitors: sum.dailyVisitors + row.visitors,
        customEvents: sum.customEvents + row.custom,
      }),
      { pageviews: 0, dailyVisitors: 0, customEvents: 0 },
    );

    if (Object.values(totals).some((n) => !Number.isSafeInteger(n)))
      throw invalid('Imported totals exceed the supported count limit.');

    const fingerprint = canonicalFingerprint({
      provider,
      timeZone: zone,
      days,
      breakdowns: data.breakdowns,
      metrics: data.metrics,
    });

    const summary = {
      fingerprint,
      provider,
      sourceName: name,
      timeZone: zone,
      visitorMetric: provider === 'ga4' ? 'ga4_daily_total_users' : 'plausible_daily_visitors',
      dateBasis: 'provider_calendar_day',
      from: days[0]!.day,
      to: days.at(-1)!.day,
      days: days.length,
      rowCount: days.length + data.breakdowns.length,
      ...totals,
      metrics: data.metrics,
      breakdowns: [...new Set(data.breakdowns.map((b) => b.dimension))].sort(),
      warnings: data.warnings,
      files: data.files,
      duplicate: false,
    };

    if (operation === 'create' && query.fingerprint !== fingerprint)
      throw conflict(
        'import_changed',
        'The import changed after preview. Review the file again before importing.',
      );
    let archived: string | undefined;

    try {
      return await r.primary.begin(async (primary) => {
        if (operation === 'create') {
          await primary`SELECT id FROM "user" WHERE id=${owner} FOR UPDATE`;
          await primary`SELECT id FROM sites WHERE id=${site}::uuid AND owner_id=${owner} FOR UPDATE`;

          const rows =
            await primary`SELECT id FROM environments WHERE id=${env.id}::uuid AND site_id=${site}::uuid FOR UPDATE`;

          if (!rows.length) throw invalid('Environment no longer exists.');
        }

        const result = await (async () => {
          const tx = primary;

          const [existing] =
            await tx`SELECT (summary||jsonb_build_object('id',id,'createdAt',created_at,'duplicate',true))::text AS data FROM analytics_imports WHERE environment_id=${env.id}::uuid AND fingerprint=${fingerprint}`;

          if (existing) {
            const found = JSON.parse(existing.data);

            return operation === 'preview' ? found : { import: found, duplicate: true };
          }

          const [native] =
            await tx`SELECT min(day)::text AS day FROM (SELECT min(day) AS day FROM events WHERE site_id=${env.id}::uuid UNION ALL SELECT min(day) FROM daily_stats WHERE site_id=${env.id}::uuid AND dimension='total') d`;

          if (native.day && days.some((day) => Date.parse(day.ends) > Date.parse(native.day)))
            throw conflict(
              'import_live_overlap',
              `Live analytics starts on ${native.day} UTC. Export source days that end before that boundary; the source timezone may require excluding the preceding calendar day.`,
            );

          const [overlap] =
            await tx`SELECT EXISTS(SELECT 1 FROM imported_daily_stats existing JOIN jsonb_to_recordset(${JSON.stringify(days)}::text::jsonb) incoming(day date,starts timestamptz,ends timestamptz) ON existing.day=incoming.day OR (existing.starts_at<incoming.ends AND existing.ends_at>incoming.starts) WHERE existing.environment_id=${env.id}::uuid) AS found`;

          if (overlap.found)
            throw conflict(
              'import_overlap',
              'These dates overlap an existing import. Remove the earlier import before replacing its dates.',
            );

          const [count] =
            await tx`SELECT count(*)::int AS n FROM analytics_imports WHERE environment_id=${env.id}::uuid`;

          if (count.n >= 50)
            throw conflict('import_limit', 'An environment supports up to 50 imports.');
          if (operation === 'preview') return summary;
          const key = crypto.randomUUID();
          archived = key;
          await archiveImport(r, env.id, key, { summary, days, breakdowns: data.breakdowns });

          const [created] =
            await tx`INSERT INTO analytics_imports(id,environment_id,provider,source_timezone,fingerprint,summary) VALUES(${key}::uuid,${env.id}::uuid,${provider},${zone},${fingerprint},${JSON.stringify(summary)}::text::jsonb) RETURNING created_at`;

          await tx`INSERT INTO imported_daily_stats(environment_id,day,import_id,starts_at,ends_at,pageviews,visitors,custom_events) SELECT ${env.id}::uuid,d.day,${key}::uuid,d.starts,d.ends,d.pageviews,d.visitors,d.custom FROM jsonb_to_recordset(${JSON.stringify(days)}::text::jsonb) d(day date,starts timestamptz,ends timestamptz,pageviews bigint,visitors bigint,custom bigint)`;
          for (let i = 0; i < data.breakdowns.length; i += 2000)
            await tx`INSERT INTO imported_breakdowns(environment_id,day,dimension,value,count) SELECT ${env.id}::uuid,d.day,d.dimension,d.value,d.count FROM jsonb_to_recordset(${JSON.stringify(data.breakdowns.slice(i, i + 2000))}::text::jsonb) d(day date,dimension text,value text,count bigint)`;

          return {
            import: { ...summary, id: key, createdAt: created.created_at },
            duplicate: false,
          };
        })();

        if (operation === 'create')
          await primary`UPDATE environments SET import_revision=import_revision+1 WHERE id=${env.id}::uuid`;

        return result;
      });
    } catch (error) {
      if (archived)
        await removeArchive(r, env.id, archived).catch(() =>
          console.error('Import archive cleanup failed'),
        );
      throw error;
    }
  });
});

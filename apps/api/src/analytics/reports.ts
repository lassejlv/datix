import { Effect, Schema } from 'effect';
import { Infrastructure } from '../platform/resources';
import { attempt, invalid, attemptSync } from '../shared/errors';
import { getEnvironment } from '../sites/service';
import { decode } from '../shared/validation';
import native from './sql/native.sql' with { type: 'text' };

const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));

export function dateRange(query: Record<string, string>, now = new Date()) {
  const today = now.toISOString().slice(0, 10);

  const from = decode(
    Day,
    query.from ?? new Date(Date.parse(today) - 29 * 86400000).toISOString().slice(0, 10),
  );

  const to = decode(Day, query.to ?? today);
  const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  if (
    !Number.isInteger(days) ||
    days < 1 ||
    days > 366 ||
    to > today ||
    Date.parse(from) < Date.parse(today) - 729 * 86400000 ||
    new Date(from).toISOString().slice(0, 10) !== from ||
    new Date(to).toISOString().slice(0, 10) !== to
  )
    throw invalid('Choose 1–366 days within the last 730 days, ending no later than today.');

  return { from, to, days };
}

export const report = Effect.fn('report')(function* (
  owner: string,
  site: string,
  kind: string,
  query: Record<string, string>,
) {
  const r = yield* Infrastructure;
  const env = yield* getEnvironment(owner, site, query.environment ?? site);
  const range = yield* attemptSync(() => dateRange(query));

  return yield* attempt(() =>
    r.analytics.begin(async (tx) => {
      await tx`SET TRANSACTION READ ONLY`;
      const params = [env.id, range.from, range.to];

      if (kind === 'installation') {
        const [row] =
          await tx`SELECT max(received_at) AS latest FROM events WHERE site_id=${env.id}::uuid AND type='pageview'`;

        return { receiving: !!row.latest, lastReceivedAt: row.latest };
      }

      if (kind === 'timeseries') {
        const rows = await tx.unsafe(
          `${native}, combined AS (SELECT day,pageviews,custom_events,visitors FROM native UNION ALL SELECT day,pageviews,custom_events,visitors FROM imported) SELECT day::text,sum(pageviews)::bigint AS pageviews,sum(custom_events)::bigint AS custom,sum(visitors)::bigint AS visitors FROM combined GROUP BY day ORDER BY day`,
          params,
        );

        return {
          range,
          data: Array.from({ length: range.days }, (_, i) => {
            const day = new Date(Date.parse(range.from) + i * 86400000).toISOString().slice(0, 10);
            const row = rows.find((r: { day: string }) => r.day === day);

            return {
              day,
              pageviews: Number(row?.pageviews ?? 0),
              customEvents: Number(row?.custom ?? 0),
              dailyUniqueVisitors: Number(row?.visitors ?? 0),
            };
          }),
        };
      }

      if (kind === 'breakdown') {
        const dimension = decode(
          Schema.Literals(['path', 'referrer', 'country', 'device', 'event']),
          query.dimension ?? 'path',
        );

        const limit = decode(
          Schema.Number.check(Schema.isInt()).check(
            Schema.isGreaterThanOrEqualTo(1),
            Schema.isLessThanOrEqualTo(100),
          ),
          Number(query.limit ?? 10),
        );

        const rows = await tx.unsafe(
          `${native}, combined AS (
        SELECT value,CASE WHEN dimension='event' THEN custom_events ELSE pageviews END AS count FROM daily_stats WHERE site_id=$1 AND dimension=$4 AND day BETWEEN $2 AND $3
        UNION ALL SELECT CASE $4 WHEN 'path' THEN path WHEN 'referrer' THEN referrer WHEN 'country' THEN country WHEN 'device' THEN device WHEN 'event' THEN name END AS value,count(*)::bigint FROM raw WHERE type=CASE WHEN $4='event' THEN 'event' ELSE 'pageview' END GROUP BY 1
        UNION ALL SELECT b.value,b.count FROM imported_breakdowns b JOIN imported d ON d.environment_id=b.environment_id AND d.day=b.day WHERE b.dimension=$4
      ) SELECT value,sum(count)::bigint AS count FROM combined GROUP BY value ORDER BY count DESC,value ASC LIMIT $5`,
          [...params, dimension, limit],
        );

        return {
          range,
          dimension,
          metric: dimension === 'event' ? 'customEvents' : 'pageviews',
          data: rows.map((row: { value: string; count: unknown }) => ({
            value: row.value,
            count: Number(row.count),
          })),
        };
      }

      const [totals] = await tx.unsafe(
        `${native} SELECT coalesce(sum(pageviews),0)::bigint AS pageviews,coalesce(sum(custom_events),0)::bigint AS custom,coalesce(sum(visitors),0)::bigint AS visitors FROM native`,
        params,
      );

      const imported = await tx.unsafe(
        `${native} SELECT import_id,provider,source_timezone,summary::text,pageviews,custom_events,visitors FROM imported`,
        params,
      );

      const dimensions = await tx.unsafe(
        `${native} SELECT DISTINCT b.dimension FROM imported_breakdowns b JOIN imported d ON d.environment_id=b.environment_id AND d.day=b.day ORDER BY b.dimension`,
        params,
      );

      let pageviews = 0,
        visitors = 0,
        custom = 0;

      const sources = new Map();

      for (const row of imported) {
        pageviews += Number(row.pageviews);
        visitors += Number(row.visitors);
        custom += Number(row.custom_events);
        const summary = JSON.parse(row.summary);
        sources.set(row.import_id, {
          id: row.import_id,
          provider: row.provider,
          sourceName: summary.sourceName,
          timeZone: row.source_timezone,
          visitorMetric: summary.visitorMetric,
          from: summary.from,
          to: summary.to,
          metrics: summary.metrics,
          breakdowns: summary.breakdowns,
        });
      }

      return {
        range,
        pageviews: Number(totals.pageviews) + pageviews,
        customEvents: Number(totals.custom) + custom,
        dailyUniqueVisitors: Number(totals.visitors) + visitors,
        visitorMetric: 'sum_of_daily_unique_visitors',
        imports: {
          importedDays: imported.length,
          pageviews,
          dailyVisitors: visitors,
          customEvents: custom,
          calendarDayWarning: imported.some(
            (r: { source_timezone: string }) =>
              !['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT'].includes(r.source_timezone),
          ),
          dateBasis: 'provider_calendar_day',
          sources: [...sources.values()],
          breakdowns: dimensions.map((r: { dimension: string }) => r.dimension),
        },
      };
    }),
  );
});

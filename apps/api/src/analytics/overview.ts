import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import { Infrastructure } from '../platform/resources';
import { attempt, invalid, attemptSync } from '../shared/errors';
import { getEnvironment } from '../sites/service';
import { dateRange, report } from './reports';

export const overview = Effect.fn('overview')(function* (
  owner: string,
  site: string,
  key: string,
  query: Record<string, string>,
) {
  const r = yield* Infrastructure;
  const env = yield* getEnvironment(owner, site, key);

  const now = yield* Clock.currentTimeMillis,
    cutoff = new Date(now - 29 * 86400000).toISOString().slice(0, 10),
    values = ['path', 'referrer', 'country', 'device'].map((k) => query[k] ?? null);

  // eslint-disable-next-line no-control-regex -- Reject control characters at the privacy boundary.
  if (values.some((v) => v !== null && (v.length > 2048 || /[\x00-\x1f\x7f]/.test(v))))
    return yield* invalid('Invalid overview filter.');
  if (query.window && query.window !== '24h') return yield* invalid('Invalid overview window.');

  const hourly = query.window === '24h',
    filtered = values.some((v) => v !== null);

  const range = hourly
    ? yield* attemptSync(() =>
        dateRange({
          from: new Date(now - 86400000).toISOString().slice(0, 10),
          to: new Date(now).toISOString().slice(0, 10),
        }),
      )
    : yield* attemptSync(() => dateRange(query));

  const currentStart = hourly ? now - 86400000 : Date.parse(range.from),
    currentEnd = hourly ? now : Date.parse(range.to) + 86400000;

  const priorStart = currentStart - (currentEnd - currentStart),
    priorEnd = currentStart;

  const build = Effect.fn('build')(function* (start: number, end: number, full: boolean) {
    const r = yield* Infrastructure;

    const dates = {
      from: new Date(start).toISOString().slice(0, 10),
      to: new Date(end - 1).toISOString().slice(0, 10),
    };

    if (!hourly && !filtered) {
      const result: Record<string, unknown> = {
        overview: yield* report(owner, site, 'overview', { ...dates, environment: key }),
        timeseries: yield* report(owner, site, 'timeseries', { ...dates, environment: key }),
      };

      if (full)
        for (const dimension of ['path', 'referrer', 'country', 'device', 'event'])
          result[dimension] = yield* report(owner, site, 'breakdown', {
            ...dates,
            environment: key,
            dimension,
          });

      return result;
    }

    const boundsStart = hourly ? start : Math.max(start, Date.parse(cutoff));
    const cte = `WITH filtered AS MATERIALIZED (SELECT * FROM events WHERE site_id=$1 AND day BETWEEN $2 AND $3 AND received_at>=$8::timestamptz AND received_at<$9::timestamptz AND ($4::text IS NULL OR path=$4) AND ($5::text IS NULL OR referrer=$5) AND ($6::text IS NULL OR country=$6) AND ($7::text IS NULL OR device=$7))`;
    let extra = '';

    if (full)
      for (const dimension of ['path', 'referrer', 'country', 'device', 'event']) {
        const column = dimension === 'event' ? 'name' : dimension,
          type = dimension === 'event' ? 'event' : 'pageview';

        extra += `, '${dimension}',jsonb_build_object('data',coalesce((SELECT jsonb_agg(jsonb_build_object('value',value,'count',n) ORDER BY n DESC,value) FROM (SELECT ${column} AS value,count(*) AS n FROM filtered WHERE type='${type}' GROUP BY ${column} ORDER BY n DESC,value LIMIT 10) b),'[]'::jsonb))`;
      }

    const bucket = hourly
        ? "date_bin(interval '1 hour',received_at,$8::timestamptz)"
        : "day::timestamp AT TIME ZONE 'UTC'",
      series = hourly
        ? "generate_series($8::timestamptz,$9::timestamptz-interval '1 hour',interval '1 hour')"
        : "generate_series($2::date::timestamp AT TIME ZONE 'UTC',$3::date::timestamp AT TIME ZONE 'UTC',interval '1 day')";

    return yield* attempt(() =>
      r.analytics.begin(async (tx) => {
        await tx`SET TRANSACTION READ ONLY`;

        const [row] = await tx.unsafe(
          `${cte},buckets AS (SELECT ${bucket} AS at,count(*) FILTER(WHERE type='pageview') AS pageviews,count(*) FILTER(WHERE type='event') AS custom_events,count(DISTINCT(day,visitor)) AS visitors FROM filtered GROUP BY 1),series AS (SELECT d AS at,coalesce(pageviews,0) AS pageviews,coalesce(custom_events,0) AS custom_events,coalesce(visitors,0) AS visitors FROM ${series} d LEFT JOIN buckets ON buckets.at=d) SELECT jsonb_build_object('overview',jsonb_build_object('pageviews',coalesce(sum(pageviews),0),'customEvents',coalesce(sum(custom_events),0),'dailyUniqueVisitors',(SELECT count(DISTINCT(day,visitor)) FROM filtered)),'timeseries',jsonb_build_object('data',jsonb_agg(jsonb_build_object('day',(at AT TIME ZONE 'UTC')::date,${hourly ? "'at',at," : ''}'pageviews',pageviews,'customEvents',custom_events,'dailyUniqueVisitors',visitors) ORDER BY at))${extra})::text AS data FROM series`,
          [
            env.id,
            dates.from,
            dates.to,
            ...values,
            new Date(boundsStart).toISOString(),
            new Date(end).toISOString(),
          ],
        );

        return JSON.parse(row.data) as Record<string, unknown>;
      }),
    );
  });

  const current = yield* build(currentStart, currentEnd, true);

  const compare =
    hourly ||
    priorStart >=
      (filtered
        ? Date.parse(cutoff)
        : Date.parse(new Date(now).toISOString().slice(0, 10)) - 729 * 86400000);

  const previous = compare ? yield* build(priorStart, priorEnd, false) : null;

  const annotations = yield* attempt(
    () =>
      r.primary`SELECT id,day::text,label FROM overview_annotations WHERE environment_id=${env.id}::uuid AND day BETWEEN ${range.from} AND ${range.to} ORDER BY day,created_at,id`,
  );

  const definitions = yield* attempt(
    () =>
      r.primary`SELECT id,name,match_type AS "matchType",match_value AS "matchValue",created_at AS "createdAt" FROM conversion_goals WHERE environment_id=${env.id}::uuid ORDER BY created_at,id`,
  );

  const counts = yield* attempt(() =>
    r.analytics.begin(async (tx) => {
      await tx`SET TRANSACTION READ ONLY`;

      const params = [
        env.id,
        range.from,
        range.to,
        ...values,
        new Date(hourly ? currentStart : Math.max(currentStart, Date.parse(cutoff))).toISOString(),
        new Date(currentEnd).toISOString(),
      ];

      const cte = `WITH filtered AS MATERIALIZED (SELECT * FROM events WHERE site_id=$1 AND day BETWEEN $2 AND $3 AND received_at>=$8::timestamptz AND received_at<$9::timestamptz AND ($4::text IS NULL OR path=$4) AND ($5::text IS NULL OR referrer=$5) AND ($6::text IS NULL OR country=$6) AND ($7::text IS NULL OR device=$7))`;

      const rows = await tx.unsafe(
        `${cte} SELECT c.goal_id,count(*)::bigint AS conversions,count(DISTINCT(c.day,c.visitor))::bigint AS visitors FROM goal_conversions c JOIN filtered e ON e.id=c.event_id AND e.site_id=c.environment_id AND e.received_at=c.received_at GROUP BY c.goal_id`,
        params,
      );

      const [total] = await tx.unsafe(
        `${cte} SELECT count(DISTINCT(day,visitor))::bigint AS visitors FROM filtered`,
        params,
      );

      return { rows, visitors: Number(total.visitors) };
    }),
  );

  return {
    ...current,
    previous,
    previousRange: hourly
      ? { from: new Date(priorStart).toISOString(), to: new Date(priorEnd).toISOString() }
      : {
          from: new Date(priorStart).toISOString().slice(0, 10),
          to: new Date(priorEnd - 1).toISOString().slice(0, 10),
          days: range.days,
          timezone: 'UTC',
        },
    ...(hourly
      ? {
          window: {
            from: new Date(currentStart).toISOString(),
            to: new Date(currentEnd).toISOString(),
            interval: 'hour',
          },
        }
      : {}),
    filtered,
    retainedFrom: cutoff,
    partial: filtered && range.from < cutoff,
    annotations,
    goals: {
      visitors: counts.visitors,
      goals: definitions.map((goal: { id: string }) => {
        const row = counts.rows.find((row: { goal_id: string }) => row.goal_id === goal.id);

        return {
          ...goal,
          conversions: Number(row?.conversions ?? 0),
          visitors: Number(row?.visitors ?? 0),
        };
      }),
    },
  };
});

import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.server';
import type { dateRange } from '../lib/validation';
import { DAY_MS } from '../lib/validation';

type Range = ReturnType<typeof dateRange>;
export async function overview(db: Database, siteId: string, range: Range) {
  const result = await db.execute<{
    pageviews: string;
    custom_events: string;
    visitors: string;
  }>(sql`
    select coalesce(sum(pageviews), 0)::text as pageviews,
      coalesce(sum(custom_events), 0)::text as custom_events,
      coalesce(sum(visitors), 0)::text as visitors
    from daily_stats where site_id = ${siteId} and dimension = 'total' and day between ${range.from}::date and ${range.to}::date`);
  const row = result.rows[0]!;
  return {
    range,
    pageviews: Number(row.pageviews),
    customEvents: Number(row.custom_events),
    dailyUniqueVisitors: Number(row.visitors),
    visitorMetric: 'sum_of_daily_unique_visitors',
  };
}

export async function timeseries(db: Database, siteId: string, range: Range) {
  const result = await db.execute<{
    day: string;
    pageviews: string;
    custom_events: string;
    visitors: string;
  }>(sql`
    select day::text, pageviews::text, custom_events::text, visitors::text
    from daily_stats where site_id = ${siteId} and dimension = 'total' and day between ${range.from}::date and ${range.to}::date order by day`);
  const lookup = new Map(result.rows.map((row) => [row.day, row]));
  return {
    range,
    data: Array.from({ length: range.days }, (_, index) => {
      const day = new Date(Date.parse(range.from) + index * DAY_MS).toISOString().slice(0, 10);
      const row = lookup.get(day);
      return {
        day,
        pageviews: Number(row?.pageviews ?? 0),
        customEvents: Number(row?.custom_events ?? 0),
        dailyUniqueVisitors: Number(row?.visitors ?? 0),
      };
    }),
  };
}

export async function breakdown(
  db: Database,
  siteId: string,
  range: Range,
  dimension: string,
  limit: number,
) {
  const result = await db.execute<{ value: string; count: string }>(sql`
    select value, sum(case when dimension = 'event' then custom_events else pageviews end)::text as count
    from daily_stats where site_id = ${siteId} and dimension = ${dimension} and day between ${range.from}::date and ${range.to}::date
    group by value order by sum(case when dimension = 'event' then custom_events else pageviews end) desc, value asc limit ${limit}`);
  return {
    range,
    dimension,
    metric: dimension === 'event' ? 'customEvents' : 'pageviews',
    data: result.rows.map((row) => ({ value: row.value, count: Number(row.count) })),
  };
}

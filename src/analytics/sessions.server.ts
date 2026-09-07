import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.server';
import { HttpError, parse } from '../lib/http';
import type { dateRange } from '../lib/validation';

export async function sessionReport(
  db: Database,
  environmentId: string,
  range: ReturnType<typeof dateRange>,
  params: URLSearchParams,
) {
  const offset = parse(z.coerce.number().int().min(0).max(100000), params.get('offset') ?? 0);
  const visitor = params.has('visitor')
    ? parse(z.string().regex(/^[a-f0-9]{64}$/), params.get('visitor'))
    : null;
  const visitorFilter = visitor ? sql`and visitor_key=${visitor}` : sql``;
  const filter = sql`environment_id=${environmentId} and received_at >= greatest(${range.from}::date, now() - interval '30 days') and received_at < ${range.to}::date + interval '1 day' ${visitorFilter}`;
  // Existing raw events already carry a daily, environment-scoped anonymous hash.
  // Exclude events with richer activity so each event appears exactly once.
  const activitySource = sql`(
    select environment_id,id,received_at,session_key,visitor_key,kind,name,path,referrer,country,device,browser,os,details,(session_key=visitor_key) as daily
    from activity_events where ${filter}
    union all
    select e.site_id as environment_id,e.id,e.received_at,e.visitor as session_key,e.visitor as visitor_key,
      case when e.type='pageview' then 'pageview' else 'custom' end as kind,
      e.name,e.path,e.referrer,e.country,e.device,'' as browser,'' as os,'{}'::jsonb as details,true as daily
    from events e
    where e.site_id=${environmentId}
      and e.received_at >= greatest(${range.from}::date, now() - interval '30 days')
      and e.received_at < ${range.to}::date + interval '1 day'
      ${visitor ? sql`and e.visitor=${visitor}` : sql``}
      and not exists (select 1 from activity_events a where a.environment_id=e.site_id and a.id=e.id)
  ) as visit_activity`;
  const eventTime = sql`to_timestamp(coalesce((details->>'clientTime')::bigint, (extract(epoch from received_at)*1000)::bigint)/1000.0)`;
  if (params.has('session')) {
    const key = parse(z.string().regex(/^[a-f0-9]{64}$/), params.get('session'));
    const result = await db.execute(
      sql`select id, received_at as "receivedAt", ${eventTime} as "occurredAt", kind, name, path, referrer, country, device, browser, os, details from ${activitySource} where ${filter} and session_key=${key} and kind <> 'engagement' order by ${eventTime}, coalesce((details->>'sequence')::int,0), id limit 201 offset ${offset}`,
    );
    if (!result.rows.length && offset === 0)
      throw new HttpError(
        404,
        'session_not_found',
        'Session not found in this environment and date range.',
      );
    return {
      events: result.rows.slice(0, 200),
      hasMore: result.rows.length > 200,
      nextOffset: offset + 200,
    };
  }
  const grouped = sql`select session_key as id, visitor_key as "visitorKey", bool_and(daily) as daily, min(${eventTime}) as "startedAt", max(received_at) as "lastSeenAt", count(*) filter(where kind='pageview')::int as pageviews, count(*) filter(where kind='click')::int as clicks, count(*) filter(where kind<>'engagement')::int as events, coalesce(sum((details->>'activeSeconds')::int),0)::int as "activeSeconds", (array_agg(path order by ${eventTime},coalesce((details->>'sequence')::int,0),id))[1] as "entryPath", (array_agg(country order by received_at,id))[1] as country, (array_agg(device order by received_at,id))[1] as device from ${activitySource} where ${filter} group by session_key,visitor_key`;
  const result = await db.execute(
    sql`select * from (${grouped}) s order by "lastSeenAt" desc,id limit 51 offset ${offset}`,
  );
  const totals = await db.execute(
    sql`select count(*)::int as sessions, count(distinct "visitorKey")::int as visitors, coalesce(round(avg("activeSeconds")),0)::int as "averageActiveSeconds", coalesce(sum(clicks),0)::int as clicks from (${grouped}) s`,
  );
  return {
    range,
    retentionDays: 30,
    summary: totals.rows[0],
    sessions: result.rows.slice(0, 50),
    hasMore: result.rows.length > 50,
    nextOffset: offset + 50,
  };
}

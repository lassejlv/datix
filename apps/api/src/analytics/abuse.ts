import { Schema } from 'effect';
import type { Resources } from '../platform/resources';
import native from './sql/native.sql' with { type: 'text' };
import { hash, type Event } from './tracking';
const Baseline = Schema.Struct({
  days: Schema.Number,
  dailyEvents: Schema.Number,
  eventsPerVisitor: Schema.Number,
  customShare: Schema.Number,
});
const Source = Schema.Struct({
  minute: Schema.Number,
  minuteEvents: Schema.Number,
  minutePageviews: Schema.Number,
  hour: Schema.Number,
  hourEvents: Schema.Number,
  day: Schema.Number,
  dayEvents: Schema.Number,
  signature: Schema.String,
  repeats: Schema.Number,
});
const Traffic = Schema.Struct({
  start: Schema.Number,
  events: Schema.Number,
  custom: Schema.Number,
});
const emptySource = {
  minute: -1,
  minuteEvents: 0,
  minutePageviews: 0,
  hour: -1,
  hourEvents: 0,
  day: -1,
  dayEvents: 0,
  signature: '',
  repeats: 0,
};
const emptyBaseline = { days: 0, dailyEvents: 0, eventsPerVisitor: 0, customShare: 0 };
const emptyTraffic = { start: 0, events: 0, custom: 0 };
const median = (values: number[]) => {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length
    ? values.length % 2
      ? values[middle]!
      : (values[middle]! + values[middle - 1]!) / 2
    : 0;
};
export function detect(
  now: number,
  pageview: boolean,
  signature: string,
  previous = emptySource,
  traffic = emptyTraffic,
  baseline = emptyBaseline,
) {
  const minute = Math.max(Math.floor(now / 60000), previous.minute),
    hour = Math.max(Math.floor(now / 3600000), previous.hour),
    day = Math.max(Math.floor(now / 86400000), previous.day),
    same = minute === previous.minute;
  const source = {
    minute,
    minuteEvents: same ? previous.minuteEvents + 1 : 1,
    minutePageviews: (same ? previous.minutePageviews : 0) + Number(pageview),
    hour,
    hourEvents: hour === previous.hour ? previous.hourEvents + 1 : 1,
    day,
    dayEvents: day === previous.day ? previous.dayEvents + 1 : 1,
    signature,
    repeats: same && previous.signature === signature ? previous.repeats + 1 : 1,
  };
  const start = Math.floor(now / 300000),
    next = {
      start,
      events: start === traffic.start ? traffic.events + 1 : 1,
      custom: (start === traffic.start ? traffic.custom : 0) + Number(!pageview),
    };
  const learned = baseline.days >= 3,
    typical = learned ? baseline.eventsPerVisitor : 0;
  let reason: string | null = null;
  if (
    source.minuteEvents > 180 ||
    source.minutePageviews > 90 ||
    source.hourEvents > Math.min(6000, Math.max(1200, Math.ceil(typical * 40))) ||
    source.dayEvents > Math.min(30000, Math.max(6000, Math.ceil(typical * 200)))
  )
    reason = 'source_limit';
  else if (source.repeats > (pageview ? 20 : 60)) reason = 'repeated_activity';
  else if (
    learned &&
    next.events > Math.max(300, (baseline.dailyEvents / 288) * 12) &&
    ((pageview && source.repeats > 10) ||
      (!pageview &&
        baseline.customShare < 0.5 &&
        next.custom / next.events > 0.95 &&
        source.minuteEvents > 30))
  )
    reason = 'unusual_activity';
  return { source, traffic: next.start < traffic.start ? traffic : next, reason };
}
/** Called under the owner lock, before reserving billable units. Only HMACs are persisted. */
export async function guard(
  r: Resources,
  tx: Bun.TransactionSQL,
  event: Event,
  ip: string,
  secret: string,
) {
  const environment = event.environmentId ?? event.siteId,
    now = new Date(event.receivedAt),
    source = hash(secret, ['abuse-source', environment, event.day, ip]),
    signature = hash(secret, [
      'abuse-pattern',
      environment,
      event.type,
      event.activity?.kind ?? null,
      event.name,
      event.path,
    ]);
  await tx`INSERT INTO abuse_environment(environment_id,baseline,learned_at,traffic) VALUES(${environment}::uuid,${JSON.stringify(emptyBaseline)}::text::jsonb,to_timestamp(0),${JSON.stringify(emptyTraffic)}::text::jsonb) ON CONFLICT DO NOTHING`;
  const [previous] =
    await tx`INSERT INTO abuse_sources(environment_id,source,activity,updated_at) VALUES(${environment}::uuid,${source},${JSON.stringify(emptySource)}::text::jsonb,${now.toISOString()}) ON CONFLICT(environment_id,source) DO UPDATE SET updated_at=abuse_sources.updated_at RETURNING activity`;
  const [state] =
    await tx`SELECT baseline,learned_at,traffic FROM abuse_environment WHERE environment_id=${environment}::uuid FOR UPDATE`;
  let baseline = Schema.decodeUnknownSync(Baseline)(state.baseline),
    learnedAt = new Date(state.learned_at);
  if (now.getTime() - learnedAt.getTime() >= 3600000) {
    const since = new Date(now.getTime() - 14 * 86400000).toISOString().slice(0, 10),
      until = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
    const blocked =
      await tx`SELECT day::text,sum(blocked)::bigint AS blocked FROM abuse_daily WHERE environment_id=${environment}::uuid AND day BETWEEN ${since} AND ${until} GROUP BY day`;
    const days = await r.analytics.begin(async (analytics) => {
      await analytics`SET TRANSACTION READ ONLY`;
      return analytics.unsafe(
        `${native} SELECT day::text,pageviews,custom_events,visitors FROM native`,
        [environment, since, until],
      );
    });
    const clean = days
      .map((d: Record<string, unknown>) => ({
        events: Number(d.pageviews) + Number(d.custom_events),
        custom: Number(d.custom_events),
        visitors: Number(d.visitors),
        blocked: Number(blocked.find((b: { day: string }) => b.day === d.day)?.blocked ?? 0),
      }))
      .filter(
        (d: { events: number; visitors: number; blocked: number }) =>
          d.events >= 20 && d.visitors > 0 && d.blocked < 50,
      );
    baseline = {
      days: clean.length,
      dailyEvents: median(clean.map((d: { events: number }) => d.events)),
      eventsPerVisitor: median(
        clean.map((d: { events: number; visitors: number }) => d.events / d.visitors),
      ),
      customShare: median(
        clean.map((d: { events: number; custom: number }) => d.custom / d.events),
      ),
    };
    learnedAt = now;
  }
  const result = detect(
    now.getTime(),
    event.type === 'pageview',
    signature,
    Schema.decodeUnknownSync(Source)(previous.activity),
    Schema.decodeUnknownSync(Traffic)(state.traffic),
    baseline,
  );
  await tx`UPDATE abuse_sources SET activity=${JSON.stringify(result.source)}::text::jsonb,updated_at=${now.toISOString()} WHERE environment_id=${environment}::uuid AND source=${source}`;
  await tx`UPDATE abuse_environment SET baseline=${JSON.stringify(baseline)}::text::jsonb,learned_at=${learnedAt.toISOString()},traffic=${JSON.stringify(result.traffic)}::text::jsonb WHERE environment_id=${environment}::uuid`;
  if (result.reason)
    await tx`INSERT INTO abuse_daily(environment_id,day,reason,blocked,last_blocked_at) VALUES(${environment}::uuid,${event.day},${result.reason},1,${now.toISOString()}) ON CONFLICT(environment_id,day,reason) DO UPDATE SET blocked=abuse_daily.blocked+1,last_blocked_at=excluded.last_blocked_at`;
  return result.reason;
}
export async function protection(db: Bun.SQL, owner: string) {
  const since = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const reasons =
    await db`SELECT reason,sum(blocked)::bigint AS blocked,max(last_blocked_at) AS last FROM abuse_daily a JOIN environments e ON e.id=a.environment_id JOIN sites s ON s.id=e.site_id WHERE s.owner_id=${owner} AND a.day>=${since} GROUP BY reason`;
  const days =
    await db`SELECT coalesce((a.baseline->>'days')::int,0) AS days FROM environments e JOIN sites s ON s.id=e.site_id LEFT JOIN abuse_environment a ON a.environment_id=e.id WHERE s.owner_id=${owner}`;
  return {
    since,
    blocked: reasons.reduce(
      (
        sum: number,
        row: {
          blocked: unknown;
        },
      ) => sum + Number(row.blocked),
      0,
    ),
    reasons: reasons.map((row: { reason: string; blocked: unknown }) => ({
      reason: row.reason,
      blocked: Number(row.blocked),
    })),
    lastBlockedAt: reasons.length
      ? new Date(
          Math.max(...reasons.map((row: { last: Date }) => row.last.getTime())),
        ).toISOString()
      : null,
    learning: days.filter((d: { days: number }) => d.days < 3).length,
    learned: days.filter((d: { days: number }) => d.days >= 3).length,
  };
}

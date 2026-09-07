import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.server';
import {
  abuseDaily,
  abuseEnvironment,
  abuseSources,
  dailyStats,
  environments,
  sites,
} from '../db/schema';
import { detectActivity, learnBaseline, type AbuseReason } from './detection';

/** Persistent counters serialize concurrent requests across Workers before any queue/billing write. */
export async function guardActivity(
  db: Database,
  input: {
    environmentId: string;
    source: string;
    signature: string;
    pageview: boolean;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const day = now.toISOString().slice(0, 10);
  // Baseline reads are outside the source lock. Busy sites do not serialize all visitors
  // through a multi-query transaction; only requests from the same source wait together.
  let [state] = await db
    .select()
    .from(abuseEnvironment)
    .where(eq(abuseEnvironment.environmentId, input.environmentId));
  if (!state || now.getTime() - state.learnedAt.getTime() >= 3600000) {
    const start = new Date(now.getTime() - 14 * 86400000).toISOString().slice(0, 10);
    const days = await db
      .select({
        pageviews: dailyStats.pageviews,
        customEvents: dailyStats.customEvents,
        visitors: dailyStats.visitors,
        blocked: sql<number>`coalesce((select sum(blocked) from abuse_daily where environment_id = ${input.environmentId} and day = ${dailyStats.day}), 0)::float8`,
      })
      .from(dailyStats)
      .where(
        and(
          eq(dailyStats.siteId, input.environmentId),
          eq(dailyStats.dimension, 'total'),
          eq(dailyStats.value, ''),
          gte(dailyStats.day, start),
          lt(dailyStats.day, day),
        ),
      );
    const baseline = learnBaseline(days);
    [state] = await db
      .insert(abuseEnvironment)
      .values({
        environmentId: input.environmentId,
        baseline,
        learnedAt: now,
        traffic: { start: 0, events: 0, custom: 0 },
      })
      .onConflictDoUpdate({
        target: abuseEnvironment.environmentId,
        set: { baseline, learnedAt: now },
      })
      .returning();
  }
  return db.transaction(async (tx) => {
    const [previous] = await tx
      .insert(abuseSources)
      .values({
        environmentId: input.environmentId,
        source: input.source,
        updatedAt: now,
        activity: {
          minute: -1,
          minuteEvents: 0,
          minutePageviews: 0,
          hour: -1,
          hourEvents: 0,
          day: -1,
          dayEvents: 0,
          signature: '',
          repeats: 0,
        },
      })
      .onConflictDoUpdate({
        target: [abuseSources.environmentId, abuseSources.source],
        set: { updatedAt: sql`${abuseSources.updatedAt}` },
      })
      .returning();
    const decision = detectActivity({
      now: now.getTime(),
      pageview: input.pageview,
      signature: input.signature,
      previous: previous?.activity,
      traffic: state!.traffic,
      baseline: state!.baseline,
    });
    await tx
      .update(abuseSources)
      .set({ activity: decision.source, updatedAt: now })
      .where(
        and(
          eq(abuseSources.environmentId, input.environmentId),
          eq(abuseSources.source, input.source),
        ),
      );
    if (decision.reason)
      await tx
        .insert(abuseDaily)
        .values({
          environmentId: input.environmentId,
          day,
          reason: decision.reason,
          blocked: 1,
          lastBlockedAt: now,
        })
        .onConflictDoUpdate({
          target: [abuseDaily.environmentId, abuseDaily.day, abuseDaily.reason],
          set: { blocked: sql`${abuseDaily.blocked} + 1`, lastBlockedAt: now },
        });
    // One atomic counter update at the end avoids lost updates without holding the
    // environment row while reading history or checking sources. Detection uses a recent
    // snapshot; the hard source caps are exact under concurrency.
    const windowStart = Math.floor(now.getTime() / 300000);
    await tx
      .update(abuseEnvironment)
      .set({
        traffic: sql`jsonb_build_object(
        'start', greatest((${abuseEnvironment.traffic}->>'start')::bigint, ${windowStart}::bigint),
        'events', case when (${abuseEnvironment.traffic}->>'start')::bigint = ${windowStart} then (${abuseEnvironment.traffic}->>'events')::bigint + 1 when (${abuseEnvironment.traffic}->>'start')::bigint > ${windowStart} then (${abuseEnvironment.traffic}->>'events')::bigint else 1 end,
        'custom', case when (${abuseEnvironment.traffic}->>'start')::bigint = ${windowStart} then (${abuseEnvironment.traffic}->>'custom')::bigint + ${Number(!input.pageview)}::int when (${abuseEnvironment.traffic}->>'start')::bigint > ${windowStart} then (${abuseEnvironment.traffic}->>'custom')::bigint else ${Number(!input.pageview)}::int end
      )`,
      })
      .where(eq(abuseEnvironment.environmentId, input.environmentId));
    return { blocked: decision.reason !== null, reason: decision.reason };
  });
}

export async function protectionSummary(
  db: Pick<Database, 'select'>,
  ownerId: string,
  now = new Date(),
) {
  const since = new Date(now.getTime() - 29 * 86400000).toISOString().slice(0, 10);
  const rows = await db
    .select({
      reason: abuseDaily.reason,
      blocked: sql<number>`sum(${abuseDaily.blocked})::float8`,
      lastBlockedAt: sql<string>`max(${abuseDaily.lastBlockedAt})::text`,
    })
    .from(abuseDaily)
    .innerJoin(environments, eq(environments.id, abuseDaily.environmentId))
    .innerJoin(sites, eq(sites.id, environments.siteId))
    .where(and(eq(sites.ownerId, ownerId), gte(abuseDaily.day, since)))
    .groupBy(abuseDaily.reason);
  const learned = await db
    .select({
      days: sql<number>`coalesce((${abuseEnvironment.baseline}->>'days')::int, 0)`,
    })
    .from(environments)
    .innerJoin(sites, eq(sites.id, environments.siteId))
    .leftJoin(abuseEnvironment, eq(abuseEnvironment.environmentId, environments.id))
    .where(eq(sites.ownerId, ownerId));
  return {
    since,
    blocked: rows.reduce((sum, row) => sum + row.blocked, 0),
    reasons: rows.map((row) => ({ reason: row.reason as AbuseReason, blocked: row.blocked })),
    lastBlockedAt:
      rows
        .map((row) => new Date(row.lastBlockedAt).toISOString())
        .sort()
        .at(-1) ?? null,
    learning: learned.filter((row) => row.days < 3).length,
    learned: learned.filter((row) => row.days >= 3).length,
  };
}

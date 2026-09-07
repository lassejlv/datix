import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.server';
import { activityDetailsSchema, activityKindSchema } from '../lib/session-tracking';
import { activityEvents, dailyStats, dailyVisitors, events } from '../db/schema';
import { admitEvents, recordUsage } from '../billing/admission.server';

const messageFields = {
  localhost: z.boolean().optional(),
  siteId: z.uuid(),
  id: z.uuid(),
  receivedAt: z.iso.datetime(),
  day: z.iso.date(),
  type: z.enum(['pageview', 'event']),
  name: z.string().max(64),
  path: z.string().max(2048),
  referrer: z.string().max(253),
  country: z.string().max(2),
  device: z.enum(['desktop', 'mobile', 'tablet', '']),
  visitor: z.string().regex(/^[a-f0-9]{64}$/),
};
export const eventMessageSchema = z
  .discriminatedUnion('version', [
    z.object({ version: z.literal(1), ...messageFields }).strict(),
    z.object({ version: z.literal(2), environmentId: z.uuid(), ...messageFields }).strict(),
    z
      .object({
        version: z.literal(3),
        environmentId: z.uuid(),
        ...messageFields,
        activity: z
          .object({
            sessionKey: z.string().regex(/^[a-f0-9]{64}$/),
            visitorKey: z.string().regex(/^[a-f0-9]{64}$/),
            kind: activityKindSchema,
            browser: z.string().max(32),
            os: z.string().max(32),
            details: activityDetailsSchema,
          })
          .strict(),
      })
      .strict(),
  ])
  .refine((e) => e.receivedAt.slice(0, 10) === e.day, 'Day must match receipt time.');
export type EventMessage = z.infer<typeof eventMessageSchema>;
const trackingId = (event: EventMessage) =>
  event.version !== 1 ? event.environmentId : event.siteId;

/** The raw insert, visitor deduplication, and summary increments commit together. */
export async function ingest(db: Database, input: EventMessage[], now = new Date()) {
  if (!input.length) return { inserted: 0 };
  const oldest = now.getTime() - 30 * 86400000;
  const fresh = input.filter(
    (e) => Date.parse(e.receivedAt) >= oldest && Date.parse(e.receivedAt) <= now.getTime() + 60000,
  );
  if (!fresh.length) return { inserted: 0 };
  return db.transaction(async (tx) => {
    const { admitted, reservations } = await admitEvents(tx, fresh, now);
    const values = admitted.map((e) => ({
      siteId: trackingId(e),
      id: e.id,
      receivedAt: new Date(e.receivedAt),
      day: e.day,
      type: e.type,
      name: e.name,
      path: e.path,
      referrer: e.referrer,
      country: e.country,
      device: e.device,
      visitor: e.visitor,
    }));
    if (!values.length) return { inserted: 0 };
    const added = await tx.insert(events).values(values).onConflictDoNothing().returning();
    if (!added.length) return { inserted: 0 };
    await recordUsage(tx, added, reservations);

    const contexts = new Map(
      admitted
        .filter((e) => e.version === 3)
        .map((e) => [
          JSON.stringify([trackingId(e), e.id]),
          e.version === 3 ? e.activity : undefined,
        ]),
    );
    const activity = added.flatMap((event) => {
      const context = contexts.get(JSON.stringify([event.siteId, event.id]));
      return context
        ? [
            {
              environmentId: event.siteId,
              id: event.id,
              receivedAt: event.receivedAt,
              name: event.name,
              path: event.path,
              referrer: event.referrer,
              country: event.country,
              device: event.device,
              ...context,
            },
          ]
        : [];
    });
    if (activity.length) await tx.insert(activityEvents).values(activity).onConflictDoNothing();
    type Stat = typeof dailyStats.$inferInsert;
    const counts = new Map<string, Stat>();
    function increment(
      siteId: string,
      day: string,
      dimension: string,
      value: string,
      pageviews = 0,
      customEvents = 0,
      visitors = 0,
    ) {
      const key = JSON.stringify([siteId, day, dimension, value]);
      const current = counts.get(key) ?? {
        siteId,
        day,
        dimension,
        value,
        pageviews: 0,
        customEvents: 0,
        visitors: 0,
      };
      current.pageviews = (current.pageviews ?? 0) + pageviews;
      current.customEvents = (current.customEvents ?? 0) + customEvents;
      current.visitors = (current.visitors ?? 0) + visitors;
      counts.set(key, current);
    }
    for (const event of added) {
      if (contexts.get(JSON.stringify([event.siteId, event.id]))?.kind === 'engagement') continue;
      const pageview = event.type === 'pageview' ? 1 : 0;
      increment(event.siteId, event.day, 'total', '', pageview, 1 - pageview);
      if (pageview) {
        for (const dimension of ['path', 'referrer', 'country', 'device'] as const)
          increment(event.siteId, event.day, dimension, event[dimension], 1);
      } else increment(event.siteId, event.day, 'event', event.name, 0, 1);
    }
    const pageviews = added.filter((e) => e.type === 'pageview');
    if (pageviews.length) {
      const visitors = await tx
        .insert(dailyVisitors)
        .values(pageviews.map((e) => ({ siteId: e.siteId, day: e.day, visitor: e.visitor })))
        .onConflictDoNothing()
        .returning({ siteId: dailyVisitors.siteId, day: dailyVisitors.day });
      for (const visitor of visitors) increment(visitor.siteId, visitor.day, 'total', '', 0, 0, 1);
    }
    const stats = [...counts.values()].sort((a, b) =>
      JSON.stringify([a.siteId, a.day, a.dimension, a.value]).localeCompare(
        JSON.stringify([b.siteId, b.day, b.dimension, b.value]),
      ),
    );
    if (stats.length)
      await tx
        .insert(dailyStats)
        .values(stats)
        .onConflictDoUpdate({
          target: [dailyStats.siteId, dailyStats.day, dailyStats.dimension, dailyStats.value],
          set: {
            pageviews: sql`${dailyStats.pageviews} + excluded.pageviews`,
            customEvents: sql`${dailyStats.customEvents} + excluded.custom_events`,
            visitors: sql`${dailyStats.visitors} + excluded.visitors`,
          },
        });
    return { inserted: added.length };
  });
}

export async function installationStatus(db: Database, siteId: string) {
  const rows = await db
    .select({ receivedAt: events.receivedAt })
    .from(events)
    .where(and(eq(events.siteId, siteId), eq(events.type, 'pageview')))
    .orderBy(sql`${events.receivedAt} desc`)
    .limit(1);
  return { receiving: !!rows[0], lastReceivedAt: rows[0]?.receivedAt ?? null };
}

import { creditUnits } from './credits';
import { applyTrackingPolicy } from '../lib/tracking-policy.server';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.server';
import { billingOutbox, billingUsage, environments, events, sites, user } from '../db/schema';
import type { EventMessage } from '../analytics/ingest.server';
import { accountAllowance, periodUsage } from './usage.server';
import { allowancePeriod } from './allowance';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
const trackingId = (event: EventMessage) =>
  event.version === 1 ? event.siteId : event.environmentId;
export const billingEventKey = (environmentId: string, eventId: string) =>
  `${environmentId}:${eventId}`;
type Reservation = {
  ownerId: string;
  siteId: string;
  periodStart: string;
  periodEnd: string;
  units: number;
};

/** The account lock covers admission, raw deduplication, counters and analytics writes. */
export async function admitEvents(tx: Transaction, input: EventMessage[], now: Date) {
  const environmentIds = [...new Set(input.map(trackingId))].sort();
  const candidates = await tx
    .select({ ownerId: sites.ownerId, siteId: sites.id })
    .from(environments)
    .innerJoin(sites, eq(sites.id, environments.siteId))
    .where(inArray(environments.id, environmentIds));
  const ownerIds = [...new Set(candidates.map((row) => row.ownerId))].sort();
  const admitted: EventMessage[] = [];
  const reservations = new Map<string, Reservation>();
  if (!ownerIds.length) return { admitted, reservations };
  // Lock owners first, matching website creation. One owner's quota cannot race across batches.
  const owners = await tx
    .select({ id: user.id })
    .from(user)
    .where(inArray(user.id, ownerIds))
    .orderBy(user.id)
    .for('update');
  // Match environment settings/deletion: parent website locks precede environment locks.
  await tx
    .select({ id: sites.id })
    .from(sites)
    .where(inArray(sites.id, [...new Set(candidates.map((row) => row.siteId))].sort()))
    .orderBy(sites.id)
    .for('key share');
  const existing = await tx
    .select({
      id: environments.id,
      siteId: sites.id,
      ownerId: sites.ownerId,
      trackingSettings: environments.trackingSettings,
      allowLocalhost: environments.allowLocalhost,
    })
    .from(environments)
    .innerJoin(sites, eq(sites.id, environments.siteId))
    .where(and(inArray(environments.id, environmentIds), eq(environments.enabled, true)))
    .orderBy(environments.id)
    .for('key share', { of: environments });
  const parents = new Map(existing.map((row) => [row.id, row]));
  const stored = await tx
    .select({ siteId: events.siteId, id: events.id })
    .from(events)
    .where(
      and(
        inArray(events.siteId, environmentIds),
        inArray(events.id, [...new Set(input.map((event) => event.id))]),
      ),
    );
  const seen = new Set(stored.map((row) => billingEventKey(row.siteId, row.id)));
  for (const owner of owners) {
    const { allowance, websites } = await accountAllowance(tx, owner.id, now);
    if (!allowance) continue;
    const allowedSites = new Set(websites.slice(0, allowance.websiteLimit).map((site) => site.id));

    const remaining = new Map<string, number>();
    const siteRemaining = new Map<string, number>();
    for (const event of input) {
      const environment = parents.get(trackingId(event));
      const key = billingEventKey(trackingId(event), event.id);
      if (
        !environment ||
        environment.siteId !== event.siteId ||
        environment.ownerId !== owner.id ||
        !allowedSites.has(event.siteId) ||
        seen.has(key)
      )
        continue;
      if (event.localhost && !environment.allowLocalhost) continue;
      const filtered = applyTrackingPolicy(event, environment.trackingSettings);
      if (!filtered) continue;
      seen.add(key);
      // Late events never consume a later month's allowance or predate the subscription.
      const period = allowancePeriod(allowance.subscription, new Date(event.receivedAt));
      if (!period) continue;
      if (!remaining.has(period.start)) {
        const usage = await periodUsage(tx, owner.id, period.start);
        const used = usage.reduce((total, row) => total + row.events, 0);
        for (const website of websites) {
          const spent = usage.find((row) => row.siteId === website.id)?.events ?? 0;
          siteRemaining.set(
            `${period.start}:${website.id}`,
            website.creditBudget === null
              ? Infinity
              : Math.max(0, Math.round(website.creditBudget * 100) - Math.round(spent * 100)),
          );
        }
        remaining.set(
          period.start,
          Math.max(0, allowance.eventLimit * 100 - Math.round(used * 100)),
        );
      }
      if (!remaining.get(period.start)) continue;
      const siteKey = `${period.start}:${event.siteId}`;
      const siteAvailable = siteRemaining.get(siteKey) ?? 0;
      if (siteAvailable < 15) continue;
      const units = creditUnits(event);
      if (units > siteAvailable) continue;
      if (units > remaining.get(period.start)!) continue;
      remaining.set(period.start, remaining.get(period.start)! - units);
      siteRemaining.set(siteKey, siteAvailable - units);
      admitted.push(filtered);
      reservations.set(key, {
        ownerId: owner.id,
        siteId: event.siteId,
        periodStart: period.start,
        periodEnd: period.end,
        units,
      });
    }
  }
  return { admitted, reservations };
}

export async function recordUsage(
  tx: Transaction,
  added: { siteId: string; id: string; type: 'pageview' | 'event'; receivedAt: Date }[],
  reservations: Map<string, Reservation>,
) {
  const counters = new Map<string, Omit<Reservation, 'units'> & { events: number }>();
  const outgoing = new Map<string, typeof billingOutbox.$inferInsert>();
  for (const event of added) {
    const reservation = reservations.get(billingEventKey(event.siteId, event.id));
    if (!reservation?.units) continue;
    const { units, ...period } = reservation;
    const key = JSON.stringify([period.ownerId, period.periodStart, period.siteId]);
    const value = counters.get(key) ?? { ...period, events: 0 };
    value.events = (Math.round(value.events * 100) + units) / 100;
    counters.set(key, value);
    // Minute buckets preserve period boundaries without sending visitor or page data.
    const minute = event.receivedAt.toISOString().slice(0, 16) + ':00.000Z';
    const deliveryKey = JSON.stringify([period.ownerId, event.type, minute, period.periodStart]);
    const delivery = outgoing.get(deliveryKey) ?? {
      ownerId: period.ownerId,
      eventType: event.type,
      eventCount: 0,
      occurredAt: event.receivedAt,
    };
    if (event.receivedAt < delivery.occurredAt) delivery.occurredAt = event.receivedAt;
    delivery.eventCount = (Math.round(delivery.eventCount * 100) + units) / 100;
    outgoing.set(deliveryKey, delivery);
  }
  if (outgoing.size) await tx.insert(billingOutbox).values([...outgoing.values()]);
  if (counters.size)
    await tx
      .insert(billingUsage)
      .values([...counters.values()])
      .onConflictDoUpdate({
        target: [billingUsage.ownerId, billingUsage.periodStart, billingUsage.siteId],
        set: {
          events: sql`${billingUsage.events} + excluded.events`,
          periodEnd: sql`excluded.period_end`,
        },
      });
}

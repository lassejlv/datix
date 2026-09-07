import type { AppEnv } from '../runtime/types';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Database } from '../db/client.server';
import { withDatabase } from '../db/client.server';
import { billingOutbox } from '../db/schema';
import { polarClient } from './polar.server';
import type { Polar } from '@polar-sh/sdk';

export async function deliverUsage(db: Database, polar: Pick<Polar, 'events'>) {
  const leaseId = crypto.randomUUID();
  const rows = await db.transaction(async (tx) => {
    const ready = await tx
      .select()
      .from(billingOutbox)
      .where(lte(billingOutbox.availableAt, new Date()))
      .orderBy(billingOutbox.availableAt)
      .limit(100)
      .for('update', { skipLocked: true });
    if (!ready.length) return [];
    await tx
      .update(billingOutbox)
      .set({
        leaseId,
        availableAt: new Date(Date.now() + 120000),
        attempts: sql`${billingOutbox.attempts} + 1`,
      })
      .where(
        inArray(
          billingOutbox.id,
          ready.map((row) => row.id),
        ),
      );
    return ready;
  });
  if (!rows.length) return { delivered: 0 };
  try {
    const result = await polar.events.ingest({
      events: rows.map((row) => ({
        name: 'analytics.events.v1',
        externalId: `analytics-usage-${row.id}`,
        externalCustomerId: row.ownerId,
        timestamp: row.occurredAt,
        metadata: { event_type: row.eventType, event_count: row.eventCount },
      })),
    });
    // Unknown customers / partial success must never silently discard quantities.
    if (result.inserted + result.duplicates !== rows.length)
      throw new Error('IncompleteUsageDelivery');
    await db.delete(billingOutbox).where(
      and(
        eq(billingOutbox.leaseId, leaseId),
        inArray(
          billingOutbox.id,
          rows.map((row) => row.id),
        ),
      ),
    );
    return { delivered: rows.length };
  } catch {
    // Back off each durable row; no retry regenerates its external ID.
    for (const row of rows)
      await db
        .update(billingOutbox)
        .set({
          leaseId: null,
          availableAt: new Date(
            Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(row.attempts, 7)),
          ),
        })
        .where(and(eq(billingOutbox.id, row.id), eq(billingOutbox.leaseId, leaseId)));
    throw new Error('PolarUsageDeliveryFailed');
  }
}
export async function flushUsage(env: AppEnv, batches = 1) {
  if (!env.POLAR_ACCESS_TOKEN) return;
  try {
    const polar = polarClient(env);
    await withDatabase(env, async (db) => {
      for (let i = 0; i < batches; i++) {
        const result = await deliverUsage(db, polar);
        if (result.delivered < 100) break;
      }
    });
  } catch {
    console.error(JSON.stringify({ event: 'billing_delivery_failed' }));
  }
}

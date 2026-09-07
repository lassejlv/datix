import { validateEvent, WebhookVerificationError } from '@polar-sh/sdk/webhooks';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.server';
import { billingCustomers, billingWebhookEvents, user } from '../db/schema';
import { HttpError, json } from '../lib/http';

export const POLAR_ORGANIZATION_ID = '4f109880-3be1-48f8-a8b2-bea2f101634f';
const BODY_LIMIT = 256 * 1024;

async function rawBody(request: Request) {
  if (Number(request.headers.get('content-length')) > BODY_LIMIT)
    throw new HttpError(413, 'body_too_large', 'Webhook body is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'invalid_webhook', 'A webhook body is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > BODY_LIMIT) {
      await reader.cancel();
      throw new HttpError(413, 'body_too_large', 'Webhook body is too large.');
    }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks);
}

export async function polarWebhook(
  request: Request,
  secret: string | undefined,
  run: <T>(callback: (db: Database) => Promise<T>) => Promise<T>,
) {
  if (!secret) throw new HttpError(503, 'webhook_unconfigured', 'Webhook is not configured.');
  const body = await rawBody(request);
  let event: ReturnType<typeof validateEvent>;
  try {
    // Verify the exact bytes and delivery timestamp before parsing or touching the database.
    event = validateEvent(body, Object.fromEntries(request.headers), secret);
  } catch (error) {
    if (error instanceof WebhookVerificationError)
      throw new HttpError(403, 'invalid_signature', 'Invalid webhook signature.');
    throw new HttpError(400, 'invalid_webhook', 'Invalid webhook payload.');
  }
  if (event.type !== 'customer.state_changed' && event.type !== 'customer.deleted')
    return json({ received: true, ignored: true });
  if (event.data.organizationId !== POLAR_ORGANIZATION_ID)
    throw new HttpError(403, 'invalid_organization', 'Unexpected webhook organization.');
  const eventId = request.headers.get('webhook-id')!;
  if (eventId.length > 255)
    throw new HttpError(400, 'invalid_webhook', 'Invalid webhook identifier.');
  // Preserve sub-millisecond precision for ordering; the SDK converts timestamps to Date.
  const occurredAt = (JSON.parse(body.toString('utf8')) as { timestamp: string }).timestamp;
  const deleted = event.type === 'customer.deleted' || event.data.deletedAt !== null;
  const subscriptions =
    event.type === 'customer.state_changed' && !deleted
      ? event.data.activeSubscriptions.map((subscription) => ({
          id: subscription.id,
          productId: subscription.productId,
          status: subscription.status,
          currentPeriodStart: subscription.currentPeriodStart.toISOString(),
          currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
          trialEnd: subscription.trialEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          endsAt: subscription.endsAt?.toISOString() ?? null,
        }))
      : [];
  const result = await run((db) =>
    db.transaction(async (tx) => {
      const [receipt] = await tx
        .insert(billingWebhookEvents)
        .values({
          id: eventId,
          type: event.type,
          occurredAt,
        })
        .onConflictDoNothing()
        .returning({ id: billingWebhookEvents.id });
      if (!receipt) return { duplicate: true };
      // Bind only to our immutable account ID. Email matching must never grant account access.
      const [owner] =
        event.data.externalId && !deleted
          ? await tx
              .select({ id: user.id })
              .from(user)
              .where(eq(user.id, event.data.externalId))
              .limit(1)
          : [];
      const snapshot = {
        customerId: event.data.id,
        ownerId: owner?.id ?? null,
        subscriptions,
        deleted,
        occurredAt,
        updatedAt: new Date(),
      };
      const applied = await tx
        .insert(billingCustomers)
        .values(snapshot)
        .onConflictDoUpdate({
          target: billingCustomers.customerId,
          set: snapshot,
          setWhere: sql`${billingCustomers.occurredAt} < ${occurredAt}::timestamptz`,
        })
        .returning({ customerId: billingCustomers.customerId });
      return { duplicate: false, applied: applied.length > 0 };
    }),
  );
  return json({ received: true, ...result });
}

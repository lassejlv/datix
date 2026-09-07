import type { AppEnv } from '../runtime/types';
import { flushUsage } from '../billing/delivery.server';
import { withDatabase } from '../db/client.server';
import { eventMessageSchema, ingest, type EventMessage } from './ingest.server';

export async function consume(batch: MessageBatch<unknown>, env: AppEnv) {
  const valid: { message: Message<unknown>; event: EventMessage }[] = [];
  for (const message of batch.messages) {
    const parsed = eventMessageSchema.safeParse(message.body);
    if (parsed.success) valid.push({ message, event: parsed.data });
    else {
      // Invalid envelopes reach the dead-letter queue without delaying valid events.
      message.retry({ delaySeconds: 30 });
      console.error(JSON.stringify({ event: 'invalid_queue_envelope', messageId: message.id }));
    }
  }
  if (!valid.length) return;
  try {
    const result = await withDatabase(env, (db) =>
      ingest(
        db,
        valid.map((item) => item.event),
      ),
    );
    for (const item of valid) item.message.ack();
    await flushUsage(env);
    console.log(
      JSON.stringify({
        event: 'events_ingested',
        received: valid.length,
        inserted: result.inserted,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'queue_failure',
        size: valid.length,
        error: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
    for (const item of valid) item.message.retry({ delaySeconds: 30 });
  }
}

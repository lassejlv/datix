import { Queue, Worker, UnrecoverableError } from 'bullmq';
import { runtime, redisConnection, EVENT_QUEUE, MAINTENANCE_QUEUE } from './environment.server';
import { eventMessageSchema, ingest } from '../analytics/ingest.server';
import { retain } from '../analytics/retention.server';
import { withDatabase } from '../db/client.server';
import { flushUsage } from '../billing/delivery.server';

const app = runtime();
await app.ready();
const connection = redisConnection(true);
const events = new Worker(
  EVENT_QUEUE,
  async (job) => {
    const parsed = eventMessageSchema.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError('InvalidEventEnvelope');
    const result = await withDatabase(app.env, (db) => ingest(db, [parsed.data]));
    console.log(
      JSON.stringify({ event: 'events_ingested', received: 1, inserted: result.inserted }),
    );
  },
  { connection, concurrency: 10 },
);
const maintenance = new Queue(MAINTENANCE_QUEUE, { connection });
const tasks = new Worker(
  MAINTENANCE_QUEUE,
  async (job) => {
    if (job.name === 'billing') await flushUsage(app.env, 5);
    else if (job.name === 'retention') {
      const result = await withDatabase(app.env, (db) => retain(db));
      console.log(JSON.stringify({ event: 'retention', ...result }));
    } else throw new UnrecoverableError('UnknownMaintenanceTask');
  },
  { connection, concurrency: 1 },
);
for (const worker of [events, tasks]) {
  worker.on('error', () =>
    console.error(JSON.stringify({ event: 'worker_error', queue: worker.name })),
  );
  worker.on('failed', (job) =>
    console.error(
      JSON.stringify({
        event: 'job_failed',
        queue: worker.name,
        id: job?.id,
        attempts: job?.attemptsMade,
      }),
    ),
  );
}
const opts = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 10000 },
  removeOnComplete: { count: 100 },
  removeOnFail: false,
};
await maintenance.upsertJobScheduler(
  'billing',
  { every: 60000 },
  { name: 'billing', data: {}, opts },
);
await maintenance.upsertJobScheduler(
  'retention',
  { pattern: '17 3 * * *', tz: 'UTC' },
  { name: 'retention', data: {}, opts },
);
await Promise.all([events.waitUntilReady(), tasks.waitUntilReady()]);
const health = Bun.serve({
  hostname: '0.0.0.0',
  port: Number(process.env.PORT ?? 3001),
  async fetch(request) {
    if (new URL(request.url).pathname !== '/health/ready')
      return new Response(null, { status: 404 });
    try {
      await app.ready();
      if (!events.isRunning() || !tasks.isRunning()) throw new Error('WorkerStopped');
      return Response.json({ status: 'ok', runtime: 'bun', service: 'worker' });
    } catch {
      return Response.json({ status: 'unavailable' }, { status: 503 });
    }
  },
});
console.log(JSON.stringify({ event: 'worker_started', runtime: Bun.version }));
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await health.stop();
    await Promise.all([events.close(), tasks.close()]);
    await maintenance.close();
    await connection.quit();
    await app.close();
    process.exit(0);
  });

import { Queue, Worker, UnrecoverableError } from 'bullmq';
import { runtime, redisConnection, EVENT_QUEUE, MAINTENANCE_QUEUE } from './environment.server';
import { eventMessageSchema, ingest } from '../analytics/ingest.server';
import { retain } from '../analytics/retention.server';
import { withDatabase } from '../db/client.server';
import { flushUsage } from '../billing/delivery.server';

export async function startJobs(app: ReturnType<typeof runtime>) {
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
    // Leave capacity in the shared ten-connection pool for HTTP and maintenance.
    { connection, concurrency: 4 },
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
  maintenance.on('error', () =>
    console.error(JSON.stringify({ event: 'maintenance_queue_error' })),
  );
  const opts = {
    attempts: 5,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: { count: 100 },
    removeOnFail: false,
  };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.all([events.close(), tasks.close()]);
    await maintenance.close();
    await connection.quit();
  };
  try {
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
  } catch (error) {
    await close();
    throw error;
  }
  console.log(JSON.stringify({ event: 'jobs_started', runtime: Bun.version }));
  return {
    ready() {
      if (closed || !events.isRunning() || !tasks.isRunning()) throw new Error('JobsStopped');
    },
    close,
  };
}

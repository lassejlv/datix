import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { eventJobId, rateLimiter } from '../../src/runtime/environment.server';
import type { EventMessage } from '../../src/analytics/ingest.server';

const url = process.env.TEST_REDIS_URL;
if (!url || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname))
  throw new Error(
    'Redis integration tests require TEST_REDIS_URL pointing to an isolated local Redis.',
  );
const name = `analytics-test-${crypto.randomUUID()}`;
const connection = new Redis(url, { maxRetriesPerRequest: null });
const queue = new Queue(name, { connection });
let worker: Worker | undefined;
beforeAll(() => queue.waitUntilReady());
afterAll(async () => {
  await worker?.close();
  await queue.obliterate({ force: true });
  await queue.close();
  await connection.quit();
});

test('accepted jobs survive producer reconnect, retry failures, and deduplicate IDs', async () => {
  const producer = new Queue(name, {
    connection: { host: '127.0.0.1', port: Number(new URL(url!).port), maxRetriesPerRequest: 1 },
  });
  await producer.add(
    'ingest',
    { value: 1 },
    { jobId: 'event-1', attempts: 3, backoff: { type: 'fixed', delay: 20 } },
  );
  await producer.close();
  await queue.add('ingest', { value: 999 }, { jobId: 'event-1' });
  let attempts = 0;
  const completed = new Promise<void>((resolve, reject) => {
    worker = new Worker(
      name,
      async (job) => {
        expect(job.data.value).toBe(1);
        attempts++;
        if (attempts === 1) throw new Error('TransientDatabaseFailure');
      },
      { connection },
    );
    worker.on('completed', () => resolve());
    worker.on('error', reject);
  });
  await completed;
  expect(attempts).toBe(2);
  expect(await queue.getCompletedCount()).toBe(1);
}, 10000);

test('concurrent requests share an atomic limit across service instances', async () => {
  const namespace = `test-${crypto.randomUUID()}`;
  const first = rateLimiter(connection, namespace, 20);
  const second = rateLimiter(connection, namespace, 20);
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) => (i % 2 ? first : second).limit({ key: 'shared' })),
  );
  expect(results.filter((result) => result.success)).toHaveLength(20);
  const ttl = await connection.pttl(`analytics:rate:${namespace}:shared`);
  expect(ttl).toBeGreaterThan(0);
  expect(ttl).toBeLessThanOrEqual(60000);
  await connection.del(`analytics:rate:${namespace}:shared`);
});

test('the same event ID is independent across website environments', async () => {
  const isolated = new Queue(`${name}-environments`, { connection });
  const base: EventMessage = {
    version: 1,
    siteId: crypto.randomUUID(),
    id: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    day: new Date().toISOString().slice(0, 10),
    type: 'pageview',
    name: '',
    path: '/',
    referrer: '',
    country: '',
    device: 'desktop',
    visitor: 'a'.repeat(64),
  };
  const staging: EventMessage = { ...base, version: 2, environmentId: crypto.randomUUID() };
  try {
    await isolated.add('ingest', base, { jobId: eventJobId(base) });
    await isolated.add('ingest', staging, { jobId: eventJobId(staging) });
    await isolated.add('ingest', base, { jobId: eventJobId(base) });
    expect(await isolated.getWaitingCount()).toBe(2);
  } finally {
    await isolated.obliterate({ force: true });
    await isolated.close();
  }
});

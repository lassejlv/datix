import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { database } from '../db/client.server';
import type { AppEnv, RateLimiter } from './types';
import type { EventMessage } from '../analytics/ingest.server';

export const EVENT_QUEUE = 'analytics-events';
export const MAINTENANCE_QUEUE = 'analytics-maintenance';
const slot = Symbol.for('analytics.runtime');

export function eventJobId(event: EventMessage) {
  return `${event.version === 1 ? event.siteId : event.environmentId}-${event.id}`;
}

export function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function redisConnection(worker = false) {
  const redis = new Redis(required('REDIS_URL'), {
    maxRetriesPerRequest: worker ? null : 1,
    enableOfflineQueue: worker,
    connectTimeout: 5000,
    ...(worker ? {} : { commandTimeout: 5000 }),
  });
  redis.on('error', () => console.error(JSON.stringify({ event: 'redis_connection_error' })));
  return redis;
}

export function rateLimiter(redis: Redis, namespace: string, max: number): RateLimiter {
  return {
    async limit({ key }) {
      const count = await redis.eval(
        "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('PEXPIRE', KEYS[1], 60000) end; return n",
        1,
        `analytics:rate:${namespace}:${key}`,
      );
      return { success: Number(count) <= max };
    },
  };
}

function createRuntime() {
  const pool = new Pool({
    connectionString: required('DATABASE_URL'),
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
  });
  pool.on('error', () => console.error(JSON.stringify({ event: 'database_connection_error' })));
  const redis = redisConnection();
  const events = new Queue<EventMessage>(EVENT_QUEUE, {
    connection: redis,
    defaultJobOptions: {
      attempts: 10,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 86400, count: 10000 },
      removeOnFail: false,
    },
  });
  events.on('error', () => console.error(JSON.stringify({ event: 'event_queue_error' })));
  const env: AppEnv = {
    APP_URL: required('APP_URL'),
    BETTER_AUTH_SECRET: required('BETTER_AUTH_SECRET'),
    VISITOR_HASH_SECRET: required('VISITOR_HASH_SECRET'),
    POLAR_ACCESS_TOKEN: process.env.POLAR_ACCESS_TOKEN,
    POLAR_WEBHOOK_SECRET: process.env.POLAR_WEBHOOK_SECRET,
    DATABASE: database(pool),
    EVENTS: {
      async send(event) {
        await events.add('ingest', event, { jobId: eventJobId(event) });
      },
    },
    COLLECT_LIMITER: rateLimiter(redis, 'collect', 120),
    AUTH_LIMITER: rateLimiter(redis, 'auth', 20),
    API_LIMITER: rateLimiter(redis, 'api', 120),
  };
  return {
    env,
    pool,
    redis,
    events,
    async ready() {
      await events.waitUntilReady();
      await Promise.all([pool.query('SELECT 1'), redis.ping()]);
    },
    async close() {
      await events.close();
      await Promise.all([pool.end(), redis.quit()]);
    },
  };
}

export function runtime(): ReturnType<typeof createRuntime> {
  const globals = globalThis as typeof globalThis & { [slot]?: ReturnType<typeof createRuntime> };
  return (globals[slot] ??= createRuntime());
}

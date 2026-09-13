import { Context, Effect, Layer } from 'effect';
import { checkSchema } from './schema';
import { RedisClient, SQL, S3Client } from 'bun';
import { drizzle } from 'drizzle-orm/bun-sql';
import { Queue, createBunRedisClient } from 'bullmq';
import * as schema from '@datix/database/primary-schema';
import { redisConnection } from './redis';
import { readConfig, type Config } from './config';
import { attempt, unavailable } from '../shared/errors';

export function createResources(config: Config = readConfig()) {
  const databaseUrl = new URL(config.DATABASE_URL);
  databaseUrl.searchParams.set('options', '-c timezone=UTC');
  const sql = new SQL(databaseUrl.toString(), {
    max: config.maxConnections,
    prepare: false,
    connectionTimeout: 10,
    idleTimeout: 30,
    connection: {
      application_name: 'datix',
    },
  });
  const redis = redisConnection(config.REDIS_URL);
  const queueConnection = createBunRedisClient(new RedisClient(config.REDIS_URL));
  const queue = new Queue('ingestion', {
    connection: queueConnection,
    prefix: config.queuePrefix,
    defaultJobOptions: {
      attempts: 8,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });
  queue.on('error', () => console.error('Queue connection error'));
  const storage = process.env.S3_BUCKET
    ? new S3Client({
        bucket: process.env.S3_BUCKET,
        endpoint: process.env.S3_ENDPOINT,
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        region: process.env.S3_REGION,
      })
    : undefined;
  return {
    config,
    sql,
    primary: sql,
    analytics: sql,
    redis,
    queue,
    queueConnection,
    storage,
    db: drizzle({ client: sql, schema }),
    workerHealthy: undefined as (() => boolean) | undefined,
    async close() {
      await Promise.allSettled([queue.close()]);
      await Promise.allSettled([queueConnection.quit(), redis.close(), sql.close()]);
    },
  };
}
export type Resources = ReturnType<typeof createResources>;
export class Infrastructure extends Context.Service<Infrastructure, Resources>()(
  '@datix/api/platform/Infrastructure',
) {
  static readonly layer = Layer.effect(
    Infrastructure,
    Effect.gen(function* () {
      const r = yield* Effect.acquireRelease(Effect.sync(createResources), (r) =>
        Effect.promise(() => r.close()),
      );
      yield* attempt(() => checkSchema(r));
      yield* attempt(() =>
        Promise.all([r.sql`SELECT 1`, r.redis.send('PING', []), r.queue.waitUntilReady()]),
      );
      return r;
    }),
  );
}
export const readiness = Effect.fn('readiness')(function* () {
  const r = yield* Infrastructure;
  if (r.workerHealthy && !r.workerHealthy()) return yield* unavailable();
  yield* Effect.all(
    [
      attempt(() => r.sql`SELECT 1`),
      attempt(() => r.redis.send('PING', [])),
      attempt(() => r.queue.waitUntilReady()),
    ],
    { concurrency: 'unbounded' },
  );
  return { status: 'ok', runtime: 'bun', service: 'app', role: r.config.role };
});

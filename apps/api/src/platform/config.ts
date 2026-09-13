import { Schema } from 'effect';
const Environment = Schema.Struct({
  APP_URL: Schema.NonEmptyString,
  DATABASE_URL: Schema.String.check(Schema.isMinLength(1)),
  REDIS_URL: Schema.String.check(Schema.isMinLength(1)),
  BETTER_AUTH_SECRET: Schema.String.check(Schema.isMinLength(32)),
});
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = Schema.decodeUnknownSync(Environment)(env);
  const appUrl = new URL(value.APP_URL);
  if (!['http:', 'https:'].includes(appUrl.protocol) || appUrl.username || appUrl.password)
    throw new Error('Invalid APP_URL');
  const db = new URL(value.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(db.protocol))
    throw new Error('PostgreSQL URL required');
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(db.hostname) &&
    !['require', 'verify-full'].includes(db.searchParams.get('sslmode') ?? '')
  )
    throw new Error('Public database connections require TLS');
  const redis = new URL(value.REDIS_URL);
  if (!['redis:', 'rediss:'].includes(redis.protocol)) throw new Error('Redis URL required');
  if (!['enabled', 'disabled'].includes(env.EXTERNAL_EFFECTS ?? 'disabled'))
    throw new Error('Invalid EXTERNAL_EFFECTS');
  if (!['live', 'snapshot'].includes(env.BILLING_STATE_MODE ?? 'live'))
    throw new Error('Invalid BILLING_STATE_MODE');
  if (env.EXTERNAL_EFFECTS === 'enabled' && env.BILLING_STATE_MODE === 'snapshot')
    throw new Error('Snapshot copies cannot send external effects');
  const integer = (key: string, fallback: number, max: number) =>
    Schema.decodeUnknownSync(
      Schema.Number.check(
        Schema.isInt(),
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(max),
      ),
    )(Number(env[key] ?? fallback));
  return {
    ...value,
    appUrl: appUrl.origin,
    port: integer('PORT', 3001, 65535),
    maxConnections: integer('DB_MAX_CONNECTIONS', 8, 100),
    batchSize: integer('EVENT_BATCH_SIZE', 64, 1000),
    workers: integer('EVENT_WORKERS', 2, 32),
    role: Schema.decodeUnknownSync(Schema.Literals(['api', 'worker', 'combined']))(
      env.SERVICE_ROLE ?? 'combined',
    ),
    queuePrefix: Schema.decodeUnknownSync(
      Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,64}$/)),
    )(env.QUEUE_PREFIX ?? 'datix-timescale-v1'),
    admins: new Set(
      (env.ADMIN_EMAILS ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  };
}
export type Config = ReturnType<typeof readConfig>;

// Keep operational paths stable when invoked from either the repository or web/.
process.chdir(new URL('../..', import.meta.url).pathname);
import assert from 'node:assert/strict';
import Redis from 'ioredis';

// Dedicated, empty logical Redis database on the isolated QA instance.
const url = 'redis://127.0.0.1:6394/1';
const redis = new Redis(url, { maxRetriesPerRequest: 1 });
const stream = `analytics:queue-qa:${crypto.randomUUID()}`;
const event = {
  version: 1,
  siteId: crypto.randomUUID(),
  id: crypto.randomUUID(),
  receivedAt: new Date().toISOString(),
  day: new Date().toISOString().slice(0, 10),
  type: 'pageview',
  name: '',
  path: '/',
  referrer: '',
  country: 'DK',
  device: 'desktop',
  visitor: 'a'.repeat(64),
};
const job = `${event.siteId}-${event.id}`;
const env = { ...process.env, REDIS_URL: url, EVENT_STREAM: stream };
async function run(command: string[]) {
  const child = Bun.spawn(command, { env, stdout: 'pipe', stderr: 'inherit' });
  const output = await new Response(child.stdout).text();
  assert.equal(await child.exited, 0);
  return JSON.parse(output.trim());
}
assert.equal(await redis.dbsize(), 0, 'Queue QA requires an empty dedicated Redis database.');
try {
  await redis.hset(`bull:analytics-events:${job}`, 'data', JSON.stringify(event));
  await redis.lpush('bull:analytics-events:wait', job);
  const first = await run(['target/release/analytics-queue', 'migrate-legacy']);
  assert.equal(first.transferred, 1);
  const repeated = await run(['target/release/analytics-queue', 'migrate-legacy']);
  assert.equal(repeated.transferred, 0);
  assert.equal(repeated.previouslyTransferred, 1);
  assert.equal(await redis.xlen(stream), 1);
  assert.equal(await redis.hget(`bull:analytics-events:${job}`, 'data'), JSON.stringify(event));
  console.log(
    'PASS BullMQ → Rust migration is atomic, idempotent, and preserves the original payload',
  );
  // Remove only the fake source job to simulate a Rust-only delivery for reverse replay.
  await redis.del(`bull:analytics-events:${job}`);
  await redis.lrem('bull:analytics-events:wait', 0, job);
  const dry = await run(['bun', 'web/scripts/rollback-rust-queue.ts']);
  assert.equal(dry.found, 1);
  assert.equal(dry.copied, 0);
  assert.equal(await redis.exists(`bull:analytics-events:${job}`), 0);
  await run(['bun', 'web/scripts/rollback-rust-queue.ts', '--apply']);
  await run(['bun', 'web/scripts/rollback-rust-queue.ts', '--apply']);
  assert.equal(await redis.llen('bull:analytics-events:wait'), 1);
  assert.deepEqual(JSON.parse((await redis.hget(`bull:analytics-events:${job}`, 'data'))!), event);
  assert.equal(await redis.xlen(stream), 1);
  console.log(
    'PASS Rust → BullMQ rollback has a read-only preview and stable IDs without deleting source events',
  );
} finally {
  const keys = await redis.keys('*');
  if (keys.length) await redis.del(...keys);
  redis.disconnect();
}

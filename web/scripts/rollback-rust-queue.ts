// Keep operational paths stable when invoked from either the repository or web/.
process.chdir(new URL('../..', import.meta.url).pathname);
import Redis from 'ioredis';
import { Queue } from 'bullmq';

const url = process.env.REDIS_URL;
if (!url) throw new Error('REDIS_URL is required.');
const apply = process.argv.includes('--apply');
const redis = new Redis(url, { maxRetriesPerRequest: null });
const stream = process.env.EVENT_STREAM ?? 'analytics:events:v2';
const queue = apply ? new Queue('analytics-events', { connection: redis }) : undefined;
let found = 0,
  copied = 0,
  invalid = 0;
try {
  for (const source of [stream, `${stream}:failed`]) {
    let cursor = '-';
    for (;;) {
      const entries = await redis.xrange(source, cursor, '+', 'COUNT', 100);
      if (!entries.length) break;
      for (const [id, fields] of entries) {
        found++;
        cursor = `(${id}`;
        const offset = fields.indexOf('data');
        let event;
        try {
          event = JSON.parse(fields[offset + 1]!);
        } catch {
          invalid++;
          continue;
        }
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const environment = event.version === 1 ? event.siteId : event.environmentId;
        if (![1, 2, 3].includes(event.version) || !uuid.test(event.id) || !uuid.test(environment)) {
          invalid++;
          continue;
        }
        if (queue) {
          await queue.add('ingest', event, {
            jobId: `${environment}-${event.id}`,
            attempts: 10,
            backoff: { type: 'exponential', delay: 1000 },
            removeOnComplete: { age: 86400, count: 10000 },
            removeOnFail: false,
          });
          copied++;
        }
      }
    }
  }
  console.log(
    JSON.stringify({
      mode: apply ? 'apply' : 'read-only',
      found,
      copied,
      invalidRetained: invalid,
      sourceRecordsPreserved: true,
    }),
  );
  if (invalid) process.exitCode = 1;
} finally {
  await queue?.close();
  redis.disconnect();
}

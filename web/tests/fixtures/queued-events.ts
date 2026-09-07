import Redis from 'ioredis';
import type { Client } from 'pg';

export type EventMessage = { id: string; siteId: string; [key: string]: unknown };

/** Feed disposable fixture events through the actual Rust worker, never a JS ingest implementation. */
export async function ingest(db: Client, events: EventMessage[]) {
  if (!events.length) return { inserted: 0 };
  const production = process.argv.includes('--production');
  const url = process.env[production ? 'PRODUCTION_REDIS_URL' : 'REDIS_URL'];
  if (!url) throw new Error('An explicit Redis URL is required for queued fixtures.');
  const owners = await db.query(
    'select u.email from sites s join "user" u on u.id=s.owner_id where s.id=any($1::uuid[])',
    [[...new Set(events.map((event) => event.siteId))]],
  );
  if (owners.rows.some((row) => !/^(browser-|delete-qa-).*@example\.com$/.test(row.email)))
    throw new Error('Queued fixtures require a disposable QA account.');
  const redis = new Redis(url, { maxRetriesPerRequest: 1 });
  const stream = process.env.EVENT_STREAM ?? 'analytics:events:v2';
  const ids = events.map((event) => event.id);
  const count = async () =>
    Number(
      (await db.query('select count(*) n from events where id=any($1::uuid[])', [ids])).rows[0].n,
    );
  try {
    const before = await count();
    const queueIds: string[] = [];
    for (const event of events)
      queueIds.push((await redis.xadd(stream, '*', 'data', JSON.stringify(event)))!);
    const deadline = Date.now() + 180000;
    while (queueIds.length) {
      const id = queueIds[0]!;
      if (!(await redis.xrange(stream, id, id)).length) queueIds.shift();
      else {
        if (Date.now() > deadline) throw new Error('Rust worker did not finish queued fixtures.');
        await Bun.sleep(100);
      }
    }
    return { inserted: (await count()) - before };
  } finally {
    redis.disconnect();
  }
}

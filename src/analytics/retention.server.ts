import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.server';

/** Bounded work per scheduled invocation. A full chunk is logged for backlog monitoring. */
export async function retain(db: Database, now = new Date()) {
  const rawCutoff = new Date(now.getTime() - 30 * 86400000).toISOString();
  const visitorCutoff = rawCutoff.slice(0, 10);
  const summaryCutoff = new Date(now.getTime() - 729 * 86400000).toISOString().slice(0, 10);
  const totals: Record<string, number> = {
    activity_events: 0,
    events: 0,
    daily_visitors: 0,
    daily_stats: 0,
    rate_limit: 0,
    session: 0,
    verification: 0,
    abuse_sources: 0,
    abuse_daily: 0,
  };
  const predicates = {
    activity_events: sql`received_at < ${rawCutoff}::timestamptz`,
    events: sql`received_at < ${rawCutoff}::timestamptz`,
    daily_visitors: sql`day < ${visitorCutoff}::date`,
    daily_stats: sql`day < ${summaryCutoff}::date`,
    rate_limit: sql`last_request < ${now.getTime() - 86400000}`,
    session: sql`expires_at < ${now.toISOString()}::timestamp`,
    verification: sql`expires_at < ${now.toISOString()}::timestamp`,
    abuse_sources: sql`updated_at < ${new Date(now.getTime() - 2 * 86400000).toISOString()}::timestamptz`,
    abuse_daily: sql`day < ${new Date(now.getTime() - 90 * 86400000).toISOString().slice(0, 10)}::date`,
  };
  for (const [table, predicate] of Object.entries(predicates)) {
    for (let pass = 0; pass < 10; pass++) {
      // Table names come exclusively from the fixed list above.
      const name = sql.identifier(table);
      const result = await db.execute(
        sql`delete from ${name} where ctid in (select ctid from ${name} where ${predicate} limit 10000)`,
      );
      totals[table]! += result.rowCount ?? 0;
      if ((result.rowCount ?? 0) < 10000) break;
    }
  }
  return { deleted: totals, backlogPossible: Object.values(totals).some((n) => n >= 100000) };
}

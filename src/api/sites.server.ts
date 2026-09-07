import { and, count, eq } from 'drizzle-orm';
import type { Database } from '../db/client.server';
import { sites, user } from '../db/schema';
import { HttpError } from '../lib/http';
import { WEBSITE_LIMIT } from '../billing/allowance';

export async function ownedSite(db: Database, ownerId: string, id: string) {
  const [site] = await db
    .select()
    .from(sites)
    .where(and(eq(sites.id, id), eq(sites.ownerId, ownerId)))
    .limit(1);
  if (!site) throw new HttpError(404, 'site_not_found', 'Website not found.');
  return site;
}

export async function createSite(
  db: Database,
  ownerId: string,
  input: { name: string; domain: string },
) {
  return db.transaction(async (tx) => {
    // Serialize quota checks for one owner, including simultaneous requests.
    await tx.select({ id: user.id }).from(user).where(eq(user.id, ownerId)).for('update');
    const [total] = await tx
      .select({ count: count() })
      .from(sites)
      .where(eq(sites.ownerId, ownerId));
    if (total!.count >= WEBSITE_LIMIT)
      throw new HttpError(409, 'site_limit', `Pro supports up to ${WEBSITE_LIMIT} websites.`);
    const [created] = await tx
      .insert(sites)
      .values({ ownerId, ...input })
      .onConflictDoNothing()
      .returning();
    if (!created) throw new HttpError(409, 'site_exists', 'You already added this domain.');
    return created;
  });
}

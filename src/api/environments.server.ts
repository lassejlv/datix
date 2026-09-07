import { and, count, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client.server';
import { environments, sites } from '../db/schema';
import { HttpError } from '../lib/http';
import type { z } from 'zod';
import type { createEnvironmentSchema, updateEnvironmentSchema } from '../lib/validation';

export async function withEnvironments(db: Database, rows: (typeof sites.$inferSelect)[]) {
  if (!rows.length) return [];
  const values = await db
    .select()
    .from(environments)
    .where(
      inArray(
        environments.siteId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(environments.createdAt, environments.id);
  return rows.map((site) => ({
    ...site,
    environments: values
      .filter((environment) => environment.siteId === site.id)
      .sort((a, b) => Number(b.id === site.id) - Number(a.id === site.id)),
  }));
}

// Call only after checking ownership of the parent site.
export async function siteEnvironment(db: Database, siteId: string, id = siteId) {
  const [environment] = await db
    .select()
    .from(environments)
    .where(and(eq(environments.id, id), eq(environments.siteId, siteId)))
    .limit(1);
  if (!environment) throw new HttpError(404, 'environment_not_found', 'Environment not found.');
  return environment;
}

function environmentConflict(error: unknown): never {
  const detail = error as { code?: string; cause?: { code?: string } };
  if (detail.code === '23505' || detail.cause?.code === '23505')
    throw new HttpError(
      409,
      'environment_exists',
      'This website already has an environment with that name.',
    );
  throw error;
}

export async function createEnvironment(
  db: Database,
  site: typeof sites.$inferSelect,
  input: z.infer<typeof createEnvironmentSchema>,
) {
  try {
    return await db.transaction(async (tx) => {
      const [parent] = await tx
        .select({ id: sites.id })
        .from(sites)
        .where(eq(sites.id, site.id))
        .for('update');
      if (!parent) throw new HttpError(404, 'site_not_found', 'Website not found.');
      const [total] = await tx
        .select({ count: count() })
        .from(environments)
        .where(eq(environments.siteId, site.id));
      if (total!.count >= 20)
        throw new HttpError(
          409,
          'environment_limit',
          'A website can have at most 20 environments.',
        );
      const [created] = await tx
        .insert(environments)
        .values({
          siteId: site.id,
          name: input.name,
          trackingSettings: input.trackingSettings ?? {},
          trackingMode: input.trackingMode ?? 'cookieless',
          domain: input.domain ?? site.domain,
          allowLocalhost: input.allowLocalhost ?? false,
        })
        .returning();
      return created!;
    });
  } catch (error) {
    environmentConflict(error);
  }
}

export async function updateEnvironment(
  db: Database,
  siteId: string,
  id: string,
  input: z.infer<typeof updateEnvironmentSchema>,
) {
  try {
    return await db.transaction(async (tx) => {
      // Match the parent's lock order used by creation and cascading deletion.
      await tx.select({ id: sites.id }).from(sites).where(eq(sites.id, siteId)).for('update');
      if (id === siteId && input.domain !== undefined)
        throw new HttpError(
          400,
          'default_domain_immutable',
          'Use a separate environment for a different domain.',
        );
      const [updated] = await tx
        .update(environments)
        .set(input)
        .where(and(eq(environments.id, id), eq(environments.siteId, siteId)))
        .returning();
      if (!updated) throw new HttpError(404, 'environment_not_found', 'Environment not found.');
      if (id === siteId) {
        // Keep the legacy default-environment settings API consistent.
        await tx
          .update(sites)
          .set({
            enabled: updated.enabled,
            allowLocalhost: updated.allowLocalhost,
          })
          .where(eq(sites.id, siteId));
      }
      return updated;
    });
  } catch (error) {
    environmentConflict(error);
  }
}

export async function deleteEnvironment(db: Database, siteId: string, id: string) {
  if (id === siteId)
    throw new HttpError(
      409,
      'default_environment',
      'The default environment cannot be deleted. Delete the website to remove all its environments.',
    );
  const removed = await db
    .delete(environments)
    .where(and(eq(environments.id, id), eq(environments.siteId, siteId)))
    .returning({ id: environments.id });
  if (!removed.length) throw new HttpError(404, 'environment_not_found', 'Environment not found.');
}

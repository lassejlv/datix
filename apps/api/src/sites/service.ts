import * as Effect from 'effect/Effect';
import { and, eq, asc, inArray, sql } from 'drizzle-orm';
import { sites, environments } from '@datix/db/primary-schema';
import { Infrastructure } from '../platform/resources';
import { attempt, ApiError, invalid, attemptSync } from '../shared/errors';
import { allowance, subscriptionRequired } from '../billing/service';
import { decode, id, domain, CreateSite, UpdateSite, EnvironmentInput } from '../shared/validation';

const missing = () =>
  new ApiError({ status: 404, code: 'site_not_found', message: 'Website not found.' });

export const owned = Effect.fn('owned')(function* (owner: string, key: string) {
  const r = yield* Infrastructure;

  const rows = yield* attempt(() =>
    r.db
      .select()
      .from(sites)
      .where(and(eq(sites.id, id(key)), eq(sites.ownerId, owner))),
  );

  if (!rows[0]) return yield* missing();

  return rows[0];
});

export const listSites = Effect.fn('listSites')(function* (owner: string, key?: string) {
  const r = yield* Infrastructure;

  return yield* attempt(async () => {
    const rows = await r.db
      .select()
      .from(sites)
      .where(key ? and(eq(sites.ownerId, owner), eq(sites.id, id(key))) : eq(sites.ownerId, owner))
      .orderBy(asc(sites.createdAt), asc(sites.id))
      .limit(100);

    if (key && !rows.length) throw missing();

    const envs = rows.length
      ? await r.db
          .select()
          .from(environments)
          .where(
            inArray(
              environments.siteId,
              rows.map((s) => s.id),
            ),
          )
          .orderBy(asc(environments.createdAt), asc(environments.id))
      : [];

    return rows.map((site) => ({
      ...site,
      environments: envs
        .filter((e) => e.siteId === site.id)
        .sort((a, b) => Number(b.id === site.id) - Number(a.id === site.id)),
    }));
  });
});

export const createSite = Effect.fn('createSite')(function* (owner: string, body: unknown) {
  const r = yield* Infrastructure;
  const input = yield* attemptSync(() => decode(CreateSite, body));

  const key = yield* attempt(() =>
    r.primary.begin(async (tx) => {
      await tx`SELECT id FROM "user" WHERE id=${owner} FOR UPDATE`;
      const [count] = await tx`SELECT count(*)::int AS total FROM sites WHERE owner_id=${owner}`;
      const active = await allowance(tx, owner);

      const [onboarding] =
        await tx`SELECT EXISTS(SELECT 1 FROM account_onboarding WHERE owner_id=${owner}) AS completed`;

      if (!active && (count.total > 0 || onboarding.completed)) throw subscriptionRequired();
      if (active?.websiteLimit !== null && active && count.total >= active.websiteLimit)
        throw new ApiError({
          status: 409,
          code: 'site_limit',
          message: 'Your website allowance has been reached.',
        });

      const rows =
        await tx`INSERT INTO sites(owner_id,name,domain) VALUES(${owner},${input.name.trim()},${domain(input.domain)}) ON CONFLICT DO NOTHING RETURNING id`;

      if (!rows[0])
        throw new ApiError({
          status: 409,
          code: 'site_exists',
          message: 'You already added this domain.',
        });

      return rows[0].id as string;
    }),
  );

  return (yield* listSites(owner, key))[0];
});

export const updateSite = Effect.fn('updateSite')(function* (
  owner: string,
  key: string,
  body: unknown,
) {
  const r = yield* Infrastructure;
  const input = yield* attemptSync(() => decode(UpdateSite, body));
  if (!Object.keys(input).length) return yield* invalid('Provide a website setting to update.');
  if (
    input.creditBudget !== undefined &&
    input.creditBudget !== null &&
    Math.abs(input.creditBudget * 100 - Math.round(input.creditBudget * 100)) > 1e-5
  )
    return yield* invalid('Invalid credit budget.');
  yield* owned(owner, key);
  yield* attempt(() =>
    r.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM "user" WHERE id=${owner} FOR UPDATE`);
      await tx
        .update(sites)
        .set(input)
        .where(and(eq(sites.ownerId, owner), eq(sites.id, key)));
    }),
  );

  return (yield* listSites(owner, key))[0];
});

export const deleteSite = Effect.fn('deleteSite')(function* (owner: string, key: string) {
  const r = yield* Infrastructure;
  yield* owned(owner, key);
  yield* attempt(() => r.db.delete(sites).where(and(eq(sites.ownerId, owner), eq(sites.id, key))));
});

export const getEnvironment = Effect.fn('getEnvironment')(function* (
  owner: string,
  site: string,
  key: string,
) {
  const r = yield* Infrastructure;
  yield* owned(owner, site);

  const rows = yield* attempt(() =>
    r.db
      .select()
      .from(environments)
      .where(and(eq(environments.siteId, site), eq(environments.id, id(key)))),
  );

  if (!rows[0])
    return yield* new ApiError({
      status: 404,
      code: 'environment_not_found',
      message: 'Environment not found.',
    });

  return rows[0];
});

export const saveEnvironment = Effect.fn('saveEnvironment')(function* (
  owner: string,
  site: string,
  key: string | undefined,
  body: unknown,
) {
  const r = yield* Infrastructure;
  const input = { ...(yield* attemptSync(() => decode(EnvironmentInput, body))) };
  const website = yield* owned(owner, site);
  if (input.domain) input.domain = yield* attemptSync(() => domain(input.domain!));
  if (key === site && input.domain)
    return yield* invalid('Use a separate environment for a different domain.');
  if (!key && (!input.name || input.enabled !== undefined))
    return yield* invalid('Environment name is required; enabled cannot be set on creation.');

  return yield* attempt(() =>
    r.db.transaction(async (tx) => {
      await tx
        .select({ id: sites.id })
        .from(sites)
        .where(and(eq(sites.id, site), eq(sites.ownerId, owner)))
        .for('update');

      if (key) {
        const rows = await tx
          .update(environments)
          .set(input)
          .where(and(eq(environments.siteId, site), eq(environments.id, id(key))))
          .returning();

        if (!rows[0]) throw missing();
        if (key === site)
          await tx
            .update(sites)
            .set({ enabled: rows[0].enabled, allowLocalhost: rows[0].allowLocalhost })
            .where(eq(sites.id, site));

        return rows[0];
      }

      const existing = await tx
        .select({ id: environments.id })
        .from(environments)
        .where(eq(environments.siteId, site));

      if (existing.length >= 20)
        throw new ApiError({
          status: 409,
          code: 'environment_limit',
          message: 'A website can have at most 20 environments.',
        });

      const rows = await tx
        .insert(environments)
        .values({
          ...input,
          name: input.name!,
          siteId: site,
          domain: input.domain ?? website.domain,
        })
        .returning();

      return rows[0];
    }),
  );
});

export const deleteEnvironment = Effect.fn('deleteEnvironment')(function* (
  owner: string,
  site: string,
  key: string,
) {
  const r = yield* Infrastructure;
  yield* getEnvironment(owner, site, key);
  if (key === site)
    return yield* new ApiError({
      status: 409,
      code: 'default_environment',
      message:
        'The default environment cannot be deleted. Delete the website to remove all its environments.',
    });
  yield* attempt(() =>
    r.db.delete(environments).where(and(eq(environments.siteId, site), eq(environments.id, key))),
  );
});

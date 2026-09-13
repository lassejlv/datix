import { Effect, Schema } from 'effect';
import { Infrastructure } from '../platform/resources';
import { identity } from '../auth/service';
import { attempt, ApiError, invalid } from '../shared/errors';
import { decode, id } from '../shared/validation';
import usersSql from './sql/admin-user_select.sql' with { type: 'text' };
import sitesSql from './sql/admin-site_select.sql' with { type: 'text' };

function camel(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      typeof value === 'bigint' ? Number(value) : value,
    ]),
  );
}

const notFound = () => new ApiError({ status: 404, code: 'not_found', message: 'Not found.' });

export const admin = Effect.fn('admin')(function* (
  headers: Headers,
  resource: string,
  key: string | undefined,
  method: string,
  query: Record<string, string>,
  body?: unknown,
) {
  const r = yield* Infrastructure;
  const actor = yield* identity(headers);
  if (!actor.admin)
    return yield* new ApiError({
      status: 403,
      code: 'forbidden',
      message: 'Administrator access is required.',
    });

  return yield* attempt(async () => {
    if (resource === 'status') {
      const [counts] =
        await r.primary`SELECT (SELECT count(*) FROM "user") AS users,(SELECT count(*) FROM user_suspensions) AS suspended_users,(SELECT count(*) FROM sites) AS sites,(SELECT count(*) FROM sites s WHERE EXISTS(SELECT 1 FROM site_suspensions WHERE site_id=s.id) OR EXISTS(SELECT 1 FROM user_suspensions WHERE user_id=s.owner_id)) AS suspended_sites,(SELECT count(*) FROM environments) AS environments,(SELECT count(*) FROM session WHERE expires_at>now() AT TIME ZONE 'UTC') AS sessions,(SELECT count(*) FROM datix_schema_migrations) AS version`;

      const checks = await Promise.allSettled([
        r.analytics`SELECT 1`,
        r.redis.send('PING', []),
        r.queue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
      ]);

      const queue = checks[2].status === 'fulfilled' ? checks[2].value : null;

      return {
        status: checks.every((c) => c.status === 'fulfilled') ? 'ok' : 'degraded',
        service: { name: 'analytics', version: '1', role: r.config.role },
        dependencies: {
          database: {
            status: checks[0].status === 'fulfilled' ? 'ok' : 'unavailable',
            schemaVersion: Number(counts.version),
          },
          redis: { status: checks[1].status === 'fulfilled' ? 'ok' : 'unavailable' },
        },
        counts: {
          users: { total: Number(counts.users), suspended: Number(counts.suspended_users) },
          sites: { total: Number(counts.sites), suspended: Number(counts.suspended_sites) },
          environments: Number(counts.environments),
          activeSessions: Number(counts.sessions),
        },
        queue: {
          pending: queue
            ? Number(queue.waiting ?? 0) + Number(queue.active ?? 0) + Number(queue.delayed ?? 0)
            : null,
          failed: queue?.failed ?? null,
        },
      };
    }

    const limit = decode(
      Schema.Number.check(Schema.isInt()).check(
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(100),
      ),
      Number(query.limit ?? 50),
    );

    if (resource === 'audit') {
      const filter = decode(
        Schema.Struct({
          targetType: Schema.optional(Schema.Literals(['user', 'site'])),
          targetId: Schema.optional(
            Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(128)),
          ),
          cursor: Schema.optional(Schema.String.check(Schema.isPattern(/^\d+$/))),
          limit: Schema.optional(Schema.String),
        }),
        query,
      );

      const rows =
        await r.primary`SELECT id,actor_user_id,action,target_type,target_id,reason,metadata,created_at FROM admin_audit_log WHERE (${filter.targetType ?? null}::text IS NULL OR target_type=${filter.targetType ?? null}) AND (${filter.targetId ?? null}::text IS NULL OR target_id=${filter.targetId ?? null}) AND (${filter.cursor ?? null}::bigint IS NULL OR id<${filter.cursor ?? null}::bigint) ORDER BY id DESC LIMIT ${limit + 1}`;

      return {
        entries: rows.slice(0, limit).map(camel),
        nextCursor: rows.length > limit ? String(rows[limit - 1].id) : null,
      };
    }

    if (!['users', 'sites'].includes(resource)) throw notFound();

    const user = resource === 'users',
      source = user ? usersSql : sitesSql,
      alias = user ? 'u' : 's';

    if (key) {
      if (!user) id(key);

      if (method === 'PATCH') {
        const input = decode(
          Schema.Struct({
            suspended: Schema.Boolean,
            reason: Schema.optional(
              Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(500)),
            ),
          }),
          body,
        );

        if (input.suspended && !input.reason?.trim())
          throw invalid('A reason is required when suspending access.');
        await r.primary.begin(async (tx) => {
          const target = user
            ? await tx`SELECT id,email FROM "user" WHERE id=${key} FOR UPDATE`
            : await tx`SELECT id FROM sites WHERE id=${key}::uuid FOR UPDATE`;

          if (!target.length) throw notFound();
          if (
            user &&
            input.suspended &&
            (key === actor.id || r.config.admins.has(target[0].email.toLowerCase()))
          )
            throw new ApiError({
              status: 409,
              code: 'cannot_suspend_admin',
              message: 'Configured administrator accounts cannot be suspended.',
            });

          const table = user ? 'user_suspensions' : 'site_suspensions',
            column = user ? 'user_id' : 'site_id';

          const previous = await tx.unsafe(`SELECT reason FROM ${table} WHERE ${column}=$1`, [key]);
          let revoked = 0;
          if (input.suspended) {
            await tx.unsafe(
              `INSERT INTO ${table}(${column},reason,suspended_by) VALUES($1,$2,$3) ON CONFLICT(${column}) DO UPDATE SET reason=excluded.reason,suspended_at=now(),suspended_by=excluded.suspended_by`,
              [key, input.reason!.trim(), actor.id],
            );

            if (user) {
              const deleted = await tx`DELETE FROM session WHERE user_id=${key} RETURNING id`;
              revoked = deleted.length;
            }
          } else if (previous.length)
            await tx.unsafe(`DELETE FROM ${table} WHERE ${column}=$1`, [key]);

          if (input.suspended || previous.length) {
            const type = user ? 'user' : 'site',
              action = `${type}.${input.suspended ? (previous.length ? 'suspension_updated' : 'suspended') : 'restored'}`;

            await tx`INSERT INTO admin_audit_log(actor_user_id,action,target_type,target_id,reason,metadata) VALUES(${actor.id},${action},${type},${key},${input.reason ?? null},${JSON.stringify({ sessionsRevoked: revoked })}::text::jsonb)`;
          }
        });
      }

      const [row] = await r.primary.unsafe(`${source} WHERE ${alias}.id=$1`, [key]);
      if (!row) throw notFound();

      if (user) {
        const sites = await r.primary.unsafe(
          `${sitesSql} WHERE s.owner_id=$1 ORDER BY s.created_at DESC,s.id DESC`,
          [key],
        );

        const [billing] =
          await r.primary`SELECT subscriptions FROM billing_customers WHERE owner_id=${key} AND deleted=false ORDER BY updated_at DESC LIMIT 1`;

        return {
          user: camel(row),
          sites: sites.map(camel),
          subscriptions: billing?.subscriptions ?? [],
        };
      }

      const environments =
        await r.primary`SELECT id,name,domain,enabled,allow_localhost,tracking_mode,created_at FROM environments WHERE site_id=${key}::uuid ORDER BY created_at,id`;

      return { site: camel(row), environments: environments.map(camel) };
    }

    const options = decode(
      Schema.Struct({
        search: Schema.optional(
          Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(100)),
        ),
        status: Schema.optional(Schema.Literals(['all', 'active', 'suspended'])),
        cursor: Schema.optional(
          Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(128)),
        ),
        limit: Schema.optional(Schema.String),
      }),
      query,
    );

    if (options.cursor && !user) id(options.cursor);
    const cursor = options.cursor ?? null;

    if (cursor) {
      const rows = await r.primary.unsafe(
        `SELECT 1 FROM ${user ? '"user"' : 'sites'} WHERE id=$1`,
        [cursor],
      );

      if (!rows.length) throw invalid('Invalid cursor.');
    }

    const pattern = options.search ? `%${options.search.replace(/[\\%_]/g, '\\$&')}%` : null,
      status = options.status ?? 'all';

    const search = user
      ? 'u.id ILIKE $1 OR u.name ILIKE $1 OR u.email ILIKE $1'
      : 's.name ILIKE $1 OR s.domain ILIKE $1 OR u.email ILIKE $1';

    const suspended = user
      ? 'us.user_id IS NOT NULL'
      : '(ss.site_id IS NOT NULL OR us.user_id IS NOT NULL)';

    const rows = await r.primary.unsafe(
      `${source} WHERE ($1::text IS NULL OR ${search}) AND ($2='all' OR ($2='suspended' AND ${suspended}) OR ($2='active' AND NOT (${suspended}))) AND ($3::${user ? 'text' : 'uuid'} IS NULL OR (${alias}.created_at,${alias}.id)<(SELECT created_at,id FROM ${user ? '"user"' : 'sites'} WHERE id=$3)) ORDER BY ${alias}.created_at DESC,${alias}.id DESC LIMIT $4`,
      [pattern, status, cursor, limit + 1],
    );

    return {
      [resource]: rows.slice(0, limit).map(camel),
      nextCursor: rows.length > limit ? rows[limit - 1].id : null,
    };
  });
});

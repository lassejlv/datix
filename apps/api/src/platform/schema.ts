import type { Resources } from './resources';
import { checkMigrations } from '@datix/db/migrations';

export async function checkSchema(r: Resources) {
  await checkMigrations(r.sql);

  const [version] =
    await r.sql`SELECT current_setting('server_version_num')::int AS pg,(SELECT extversion FROM pg_extension WHERE extname='timescaledb') AS timescale`;

  if (version.pg < 180000 || !version.timescale)
    throw new Error('PostgreSQL 18 with TimescaleDB is required');

  const [settings] = await r.sql`SELECT current_setting('TimeZone') AS timezone,
    current_setting('statement_timeout')::interval > interval '0 seconds'
    AND current_setting('statement_timeout')::interval <= interval '15 seconds'
    AND current_setting('lock_timeout')::interval > interval '0 seconds'
    AND current_setting('lock_timeout')::interval <= interval '3 seconds' AS bounded`;

  if (settings.timezone !== 'UTC' || !settings.bounded)
    throw new Error('Apply runtime role settings with bun run db:runtime');

  const tables: { hypertable_name: string }[] =
    await r.sql`SELECT hypertable_name FROM timescaledb_information.hypertables WHERE hypertable_schema='public'`;

  for (const name of [
    'events',
    'activity_events',
    'diagnostic_events',
    'goal_conversions',
    'daily_stats',
    'daily_visitors',
  ])
    if (!tables.some((t) => t.hypertable_name === name))
      throw new Error(`Missing hypertable: ${name}`);

  const [role] =
    await r.sql`SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR has_schema_privilege(current_user,'public','CREATE') OR has_table_privilege(current_user,'public.datix_schema_migrations','INSERT,UPDATE,DELETE,TRUNCATE') AS privileged FROM pg_roles WHERE rolname=current_user`;

  if (!role || role.privileged) throw new Error('Use a restricted runtime role');

  const [triggers] =
    await r.sql`SELECT count(*)::int AS count FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND tgname IN('sites_default_environment','environments_analytics_cleanup','datix_session_access')`;

  if (triggers.count !== 3) throw new Error('Required lifecycle triggers missing');
}

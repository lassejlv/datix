import { SQL } from 'bun';
import { parseArgs } from 'node:util';
import { readMigrations, checkMigrations } from '../packages/database/src/migrations';
const { values } = parseArgs({
  options: { apply: { type: 'boolean' }, 'expect-host': { type: 'string' } },
  strict: true,
});
const url = new URL(process.env.DATABASE_URL_UNPOOLED ?? '');
if (url.hostname.includes('-pooler.') || url.hostname !== values['expect-host'])
  throw new Error('Pass the independently reviewed direct endpoint with --expect-host');
if (
  !['localhost', '127.0.0.1'].includes(url.hostname) &&
  !['require', 'verify-full'].includes(url.searchParams.get('sslmode') ?? '')
)
  throw new Error('TLS required');
const db = new SQL(url.toString(), { max: 1, prepare: false });
try {
  const [identity] = await db`SELECT current_database() AS database,current_user AS role`;
  if (
    identity.database !== decodeURIComponent(url.pathname.slice(1)) ||
    identity.role !== decodeURIComponent(url.username)
  )
    throw new Error('Database identity mismatch');
  if (!values.apply) {
    const exists = await db`SELECT to_regclass('public.datix_schema_migrations') AS name`;
    if (!exists[0].name) console.log('Empty migration history; run with --apply to initialize');
    else await checkMigrations(db);
  } else {
    const migrations = await readMigrations();
    await db.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout='3s'`;
      await tx`SET LOCAL statement_timeout='120s'`;
      await tx`SELECT pg_advisory_xact_lock(791343524)`;
      await tx`CREATE TABLE IF NOT EXISTS public.datix_schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`;
      const applied: { name: string; checksum: string }[] =
        await tx`SELECT name,checksum FROM public.datix_schema_migrations ORDER BY name`;
      for (const old of applied)
        if (!migrations.some((m) => m.name === old.name && m.checksum === old.checksum))
          throw new Error('Applied migration was changed or removed');
      for (const migration of migrations) {
        if (applied.some((row) => row.name === migration.name)) continue;
        for (const statement of migration.sql
          .split('--> statement-breakpoint')
          .map((s) => s.trim())
          .filter(Boolean))
          await tx.unsafe(statement);
        await tx`INSERT INTO public.datix_schema_migrations(name,checksum) VALUES(${migration.name},${migration.checksum})`;
        console.log(`Applied ${migration.name}`);
      }
    });
    await checkMigrations(db);
  }
  console.log(JSON.stringify({ host: url.hostname, ...identity, verified: true }));
} finally {
  await db.close();
}

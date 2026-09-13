import { SQL } from 'bun';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { checkMigrations } from '../packages/db/src/migrations';
import { analyticsTables, primaryTables } from './migration/tables';

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
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

try {
  await checkMigrations(db);
  const [identity] = await db`SELECT current_database() AS database,current_user AS role`;
  if (
    identity.database !== decodeURIComponent(url.pathname.slice(1)) ||
    identity.role !== decodeURIComponent(url.username)
  )
    throw new Error('Database identity mismatch');
  const existing = await db`SELECT rolname FROM pg_roles WHERE rolname='datix_runtime'`;

  if (!values.apply) {
    console.log(
      JSON.stringify({
        host: url.hostname,
        ...identity,
        runtimeRoleExists: !!existing.length,
        apply: false,
      }),
    );
  } else {
    const password = randomBytes(32).toString('hex');
    await db.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout='3s'`;
      await tx`SET LOCAL statement_timeout='30s'`;
      if (!existing.length)
        await tx.unsafe(
          `CREATE ROLE datix_runtime LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
        );

      const [role] =
        await tx`SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls AS privileged FROM pg_roles WHERE rolname='datix_runtime'`;

      const memberships =
        await tx`SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='datix_runtime'`;

      if (role.privileged || memberships.length)
        throw new Error('Existing runtime role must be unprivileged and have no role memberships');
      await tx.unsafe(`GRANT CONNECT ON DATABASE ${quote(identity.database)} TO datix_runtime`);
      await tx`REVOKE CREATE ON SCHEMA public FROM PUBLIC,datix_runtime`;
      await tx`GRANT USAGE ON SCHEMA public TO datix_runtime`;
      await tx`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM datix_runtime`;

      const tables = [
        ...primaryTables.map(([name]) => name),
        ...analyticsTables.map(([name]) => name),
        'ingestion_receipts',
        'analytics_deletions',
      ];

      await tx.unsafe(
        `GRANT SELECT,INSERT,UPDATE,DELETE ON ${tables.map((t) => `public.${quote(t)}`).join(',')} TO datix_runtime`,
      );
      await tx`GRANT SELECT ON public.datix_schema_migrations TO datix_runtime`;
      await tx`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO datix_runtime`;
      await tx`GRANT EXECUTE ON FUNCTION public.datix_retention() TO datix_runtime`;
      // Neon transaction pooling rejects these startup parameters. Role defaults apply on every pooled backend.
      await tx`ALTER ROLE datix_runtime SET timezone='UTC'`;
      await tx`ALTER ROLE datix_runtime SET statement_timeout='15s'`;
      await tx`ALTER ROLE datix_runtime SET lock_timeout='3s'`;
      await tx`ALTER ROLE datix_runtime SET idle_in_transaction_session_timeout='30s'`;
    });

    if (!existing.length) {
      const runtime = new URL(url);
      runtime.username = 'datix_runtime';
      runtime.password = password;
      if (runtime.hostname.endsWith('.neon.tech'))
        runtime.hostname = runtime.hostname.replace('.', '-pooler.');
      await mkdir('.local', { recursive: true });
      await writeFile(
        '.local/runtime.env',
        `DATABASE_URL=${JSON.stringify(runtime.toString())}\n`,
        { mode: 0o600 },
      );
      console.log('Created runtime role; connection saved to ignored .local/runtime.env');
    }

    console.log(
      JSON.stringify({
        host: url.hostname,
        database: identity.database,
        runtimeRole: 'datix_runtime',
        verified: true,
      }),
    );
  }
} finally {
  await db.close();
}

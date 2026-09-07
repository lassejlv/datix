// Keep operational paths stable when invoked from either the repository or web/.
process.chdir(new URL('../..', import.meta.url).pathname);
import { Client } from 'pg';
const production = process.argv.includes('--production');
const connectionString = process.env[production ? 'PRODUCTION_DATABASE_URL' : 'DATABASE_URL'];
if (!connectionString) throw new Error('Database URL missing');
const client = new Client({ connectionString, connectionTimeoutMillis: 10000 });
try {
  await client.connect();
  await client.query('BEGIN READ ONLY');
  const columns = await client.query(
    `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
  );
  const constraints = await client.query(
    `SELECT c.relname AS table_name, con.conname AS name, pg_get_constraintdef(con.oid) AS definition FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname, con.conname`,
  );
  const indexes = await client.query(
    `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname`,
  );
  const functions = await client.query(
    `SELECT p.proname AS name, pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' ORDER BY p.proname`,
  );
  const triggers = await client.query(
    `SELECT c.relname AS table_name, t.tgname AS name, pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,
  );
  await client.query('COMMIT');
  await Bun.write(
    'docs/database/live-schema.json',
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        source: production ? 'production' : 'development',
        columns: columns.rows,
        constraints: constraints.rows,
        indexes: indexes.rows,
        functions: functions.rows,
        triggers: triggers.rows,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify({
      tables: [...new Set(columns.rows.map((r) => r.table_name))],
      columns: columns.rowCount,
      constraints: constraints.rowCount,
    }),
  );
} catch {
  console.error('Schema inspection failed; credentials and database errors omitted.');
  process.exitCode = 1;
} finally {
  await client.end();
}

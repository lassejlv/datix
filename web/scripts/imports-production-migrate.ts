import { Client } from 'pg';
process.chdir(new URL('../..', import.meta.url).pathname);
const url = new URL(process.env.PRODUCTION_DATABASE_URL ?? '');
if (url.hostname !== process.env.PRODUCTION_DATABASE_HOST || url.username !== 'analytics_owner')
  throw new Error('Explicit matching production owner required.');
if (!['check', 'apply'].includes(process.argv[2] ?? '')) throw new Error('Use check or apply.');
const client = new Client({ connectionString: url.toString() });
await client.connect();
try {
  const before = await client.query(
    'SELECT version FROM analytics_schema_migrations ORDER BY version',
  );
  console.log(
    'Applied versions before:',
    before.rows.map((r) => r.version),
  );
  if (process.argv[2] === 'apply') {
    const child = Bun.spawn(['target/debug/analytics-db', 'upgrade'], {
      env: { ...process.env, DATABASE_URL: url.toString() },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code) throw new Error(`Upgrade failed: ${error}`);
    console.log('Schema:', JSON.parse(output));
    const grants = await client.query(
      "SELECT has_table_privilege('analytics_runtime', 'analytics_imports', 'SELECT, INSERT, UPDATE, DELETE') AS imports, has_table_privilege('analytics_runtime', 'imported_daily_stats', 'SELECT, INSERT, UPDATE, DELETE') AS daily, has_table_privilege('analytics_runtime', 'imported_breakdowns', 'SELECT, INSERT, UPDATE, DELETE') AS breakdowns",
    );
    if (!Object.values(grants.rows[0]).every(Boolean)) throw new Error('Runtime grants missing');
    console.log('Runtime permissions:', grants.rows[0]);
  }
} finally {
  await client.end();
}

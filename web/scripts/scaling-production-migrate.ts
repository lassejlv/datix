// Explicit operator command: preserves the existing database and runs atomic, checksummed upgrades.
import { Client } from 'pg';
process.chdir(new URL('../..', import.meta.url).pathname);
const command = process.argv[2];
if (!['check', 'apply'].includes(command ?? '')) throw new Error('Use check or apply.');
const url = new URL(process.env.PRODUCTION_DATABASE_URL ?? '');
if (url.hostname !== process.env.PRODUCTION_DATABASE_HOST || url.username !== 'analytics_owner')
  throw new Error('An explicitly matched production owner connection is required.');
const client = new Client({ connectionString: url.toString() });
await client.connect();
try {
  const counts = await client.query(`SELECT (SELECT count(*) FROM events)::int AS events,
    (SELECT count(*) FROM activity_events)::int AS activity,
    (SELECT count(*) FROM billing_outbox)::int AS billing_pending`);
  console.log('Before', counts.rows[0]);
  if (command === 'apply') {
    // PgBouncer transaction pooling cannot safely preserve arbitrary per-client SET statements.
    await client.query("ALTER ROLE analytics_runtime SET statement_timeout='15s'");
    await client.query("ALTER ROLE analytics_runtime SET timezone='UTC'");
    // Refresh only idle runtime backends so the new role defaults are immediately effective.
    const refreshed = await client.query(`SELECT count(*)::int AS refreshed FROM (
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname=current_database() AND usename='analytics_runtime' AND state='idle' AND pid<>pg_backend_pid()
    ) s`);
    console.log('Idle runtime connections refreshed', refreshed.rows[0].refreshed);
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
    if (code !== 0) throw new Error(`Atomic schema upgrade failed: ${error}`);
    console.log('Schema', JSON.parse(output));
    const retained = await client.query(`SELECT
      NOT EXISTS(SELECT * FROM events_unpartitioned_backup EXCEPT ALL SELECT * FROM events) AS events_preserved,
      NOT EXISTS(SELECT * FROM activity_events_unpartitioned_backup EXCEPT ALL SELECT * FROM activity_events) AS activity_preserved`);
    if (!retained.rows[0].events_preserved || !retained.rows[0].activity_preserved)
      throw new Error('Retained-row verification failed');
    console.log('Retained rows', retained.rows[0]);
  }
} finally {
  await client.end();
}

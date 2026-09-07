// Rehearse the complete baseline and upgrades on a disposable database in the isolated test branch.
import { Client } from 'pg';
process.chdir(new URL('../..', import.meta.url).pathname);
const url = new URL(process.env.TEST_DATABASE_URL ?? '');
if (
  url.hostname !== process.env.TEST_DATABASE_HOST ||
  url.hostname === new URL(process.env.DATABASE_URL ?? '').hostname
)
  throw new Error('A distinct, explicitly matched test branch is required.');
url.hostname = url.hostname.replace('-pooler.', '.');
const db = `scaling_rehearsal_${crypto.randomUUID().replaceAll('-', '')}`;
const owner = new Client({ connectionString: url.toString() });
await owner.connect();
let created = false;
try {
  await owner.query(`CREATE DATABASE "${db}"`);
  created = true;
  const target = new URL(url);
  target.pathname = `/${db}`;
  for (const command of ['init-empty', 'upgrade', 'check']) {
    const child = Bun.spawn(['target/debug/analytics-db', command], {
      env: { ...process.env, DATABASE_URL: target.toString() },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`${command}: ${error}`);
    console.log(command, JSON.parse(output));
  }
} finally {
  if (created) await owner.query(`DROP DATABASE "${db}"`);
  await owner.end();
}
console.log('PASS isolated empty-database initialization, idempotent upgrades and cleanup');

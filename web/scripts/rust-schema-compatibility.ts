// Keep operational paths stable when invoked from either the repository or web/.
process.chdir(new URL('../..', import.meta.url).pathname);
import assert from 'node:assert/strict';
import { Client } from 'pg';

const value = process.env.TEST_DATABASE_URL;
if (
  !value ||
  new URL(value).hostname !== process.env.TEST_DATABASE_HOST ||
  new URL(value).hostname === new URL(process.env.DATABASE_URL!).hostname
)
  throw new Error('An isolated Neon test branch is required.');
const client = new Client({ connectionString: value });
const name = `rust_schema_${crypto.randomUUID().replaceAll('-', '')}`;
const url = new URL(value);
url.pathname = `/${name}`;
let created = false;
async function run(command: string, expected: number) {
  const child = Bun.spawn(['target/release/analytics-db', command], {
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(child.stdout).text();
  const err = await new Response(child.stderr).text();
  assert.equal(await child.exited, expected, err);
  return out;
}
try {
  await client.connect();
  await client.query(`CREATE DATABASE ${name}`);
  created = true;
  assert.equal(JSON.parse(await run('init-empty', 0)).compatible, true);
  assert.equal(JSON.parse(await run('check', 0)).columnsChecked, 133);
  await run('init-empty', 1);
  console.log(
    'PASS SQLx baseline creates the pulled schema in an empty isolated database and refuses a second initialization',
  );
} finally {
  if (created) await client.query(`DROP DATABASE ${name} WITH (FORCE)`);
  await client.end();
}

// Keep operational paths stable when invoked from either the repository or web/.
process.chdir(new URL('../..', import.meta.url).pathname);
const url = process.env.PRODUCTION_DATABASE_URL;
if (!url || new URL(url).hostname !== process.env.PRODUCTION_DATABASE_HOST)
  throw new Error('Explicit production database required.');
const parsed = new URL(url);
const child = Bun.spawn(
  ['pg_dump', '--schema-only', '--no-owner', '--no-privileges', '--schema=public'],
  {
    env: {
      ...process.env,
      PGDATABASE: parsed.pathname.slice(1),
      PGHOST: parsed.hostname,
      PGPORT: parsed.port || '5432',
      PGUSER: decodeURIComponent(parsed.username),
      PGPASSWORD: decodeURIComponent(parsed.password),
      PGSSLROOTCERT: 'system',
      PGSSLMODE: 'verify-full',
      PGCHANNELBINDING: 'require',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  },
);
const [out, err] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
]);
if (await child.exited) {
  console.error(
    err
      .split('\n')
      .filter((line) => !/(password|postgres(?:ql)?:\/\/)/i.test(line))
      .slice(0, 5)
      .join('\n'),
  );
  throw new Error('Schema dump failed; connection details omitted.');
}
const sql = out
  .split('\n')
  .filter((line) => !line.startsWith('\\'))
  .join('\n')
  .replace('CREATE SCHEMA public;', 'CREATE SCHEMA IF NOT EXISTS public;');
await Bun.write('docs/database/schema.sql', sql);
console.log('Pulled schema definitions from production without reading table records.');

export {};

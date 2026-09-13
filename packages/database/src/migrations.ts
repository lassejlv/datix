import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import type { SQL } from 'bun';
const directory = new URL('../migrations/', import.meta.url);
export async function readMigrations() {
  const names = (await readdir(directory)).filter((n) => /^\d+_[a-z0-9_]+\.sql$/.test(n)).sort();
  return Promise.all(
    names.map(async (name) => {
      const sql = await Bun.file(new URL(name, directory)).text();
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}
export async function checkMigrations(db: SQL) {
  const expected = await readMigrations();
  const applied: { name: string; checksum: string }[] =
    await db`SELECT name,checksum FROM public.datix_schema_migrations ORDER BY name`;
  if (
    expected.length !== applied.length ||
    expected.some((m) => !applied.some((row) => row.name === m.name && row.checksum === m.checksum))
  )
    throw new Error('Schema upgrade required: migration history differs');
}

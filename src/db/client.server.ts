import { Client, type Pool } from 'pg';
import type { AppEnv } from '../runtime/types';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

export function database(client: Client | Pool) {
  return drizzle(client, { schema });
}
export type Database = ReturnType<typeof database>;

export async function withDatabase<T>(env: AppEnv, run: (db: Database) => Promise<T>): Promise<T> {
  if (env.DATABASE) return run(env.DATABASE);
  if (!env.DATABASE_URL) throw new Error('DatabaseNotConfigured');
  const client = new Client({
    connectionString: env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  });
  try {
    await client.connect();
    return await run(database(client));
  } finally {
    await client.end();
  }
}

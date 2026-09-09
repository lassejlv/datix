// Frozen compatibility fixture for migration and rollback verification.
import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Client } from 'pg';
export const database = (client: Client) => drizzle(client, { schema });
type Database = ReturnType<typeof database>;
import * as schema from './legacy-auth-schema';

export function createAuth(db: Database, env: { APP_URL: string; BETTER_AUTH_SECRET: string }) {
  return betterAuth({
    appName: 'Datix',
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    database: drizzleAdapter(db, { provider: 'pg', schema, transaction: true }),
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128 },
    user: { deleteUser: { enabled: true } },
    session: { expiresIn: 60 * 60 * 24 * 7, cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 30 },
    advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] } },
    telemetry: { enabled: false },
  });
}

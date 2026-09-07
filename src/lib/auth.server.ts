import type { AppEnv } from '../runtime/types';
import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import type { Database } from '../db/client.server';
import * as schema from '../db/schema';

export function createAuth(db: Database, env: Pick<AppEnv, 'APP_URL' | 'BETTER_AUTH_SECRET'>) {
  return betterAuth({
    appName: 'Analytics Beer',
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

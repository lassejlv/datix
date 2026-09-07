import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/node-postgres';

// Schema generation only: no connection or migration is executed here.
export const auth = betterAuth({
  database: drizzleAdapter(drizzle('postgres://unused:unused@localhost/unused'), {
    provider: 'pg',
  }),
  emailAndPassword: { enabled: true, minPasswordLength: 12 },
  rateLimit: { enabled: true, storage: 'database' },
});

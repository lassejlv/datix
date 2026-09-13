import { ensureDeletable } from '../billing/polar';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { APIError } from 'better-auth/api';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { Context, Effect, Layer } from 'effect';
import * as schema from '@datix/database/auth-schema';
import { Infrastructure } from '../platform/resources';
import { attempt, ApiError } from '../shared/errors';

function makeAuth(r: Infrastructure['Service']) {
  return betterAuth({
    baseURL: r.config.appUrl,
    secret: r.config.BETTER_AUTH_SECRET,
    logger: {
      level: 'warn',
      // Adapter errors can include SQL parameters, including session tokens.
      log: (level) => console.error('Authentication diagnostic', { level }),
    },
    database: drizzleAdapter(r.db, { provider: 'pg', schema, transaction: true }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      password: { hash: hashPassword, verify: verifyPassword },
    },
    advanced: {
      cookiePrefix: 'better-auth',
      ipAddress: { ipAddressHeaders: ['x-datix-client-ip'] },
      database: { generateId: () => crypto.randomUUID().replaceAll('-', '') },
    },
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          await ensureDeletable(r, user.id);
        },
      },
    },
    session: { cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: 'database' },
    socialProviders: {
      ...(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
        ? {
            github: {
              clientId: process.env.GITHUB_CLIENT_ID,
              clientSecret: process.env.GITHUB_CLIENT_SECRET,
            },
          }
        : {}),
      ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: process.env.GOOGLE_CLIENT_ID,
              clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            },
          }
        : {}),
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const blocked =
              await r.primary`SELECT 1 FROM user_suspensions WHERE user_id=${session.userId}`;
            if (blocked.length) throw new APIError('FORBIDDEN', { message: 'Account suspended.' });
          },
        },
      },
    },
  });
}
export class Auth extends Context.Service<Auth, ReturnType<typeof makeAuth>>()('@datix/api/Auth') {
  static readonly layer = Layer.effect(
    Auth,
    Effect.gen(function* () {
      return makeAuth(yield* Infrastructure);
    }),
  );
}
export const identity = Effect.fn('identity')(function* (headers: Headers) {
  const auth = yield* Auth;
  const r = yield* Infrastructure;
  const session = yield* attempt(() => auth.api.getSession({ headers }));
  if (!session)
    return yield* new ApiError({
      status: 401,
      code: 'unauthorized',
      message: 'Sign in to continue.',
    });
  const blocked = yield* attempt(
    () => r.primary`SELECT 1 FROM user_suspensions WHERE user_id=${session.user.id}`,
  );
  if (blocked.length)
    return yield* new ApiError({
      status: 403,
      code: 'account_suspended',
      message: 'Account suspended.',
    });
  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    admin: r.config.admins.has(session.user.email.toLowerCase()),
  };
});

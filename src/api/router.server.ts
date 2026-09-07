import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { AppEnv } from '../runtime/types';
import { protectionSummary } from '../abuse/guard.server';
import { trackingSettings } from '../lib/tracking-settings';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withDatabase, type Database } from '../db/client.server';
import { sites, environments, user } from '../db/schema';
import { createAuth } from '../lib/auth.server';
import { HttpError, json, parse, readJson, requireSameOrigin } from '../lib/http';
import { resolvePreferences } from '../lib/i18n/preferences';
import {
  breakdownSchema,
  createSiteSchema,
  createEnvironmentSchema,
  updateEnvironmentSchema,
  dateRange,
  siteIdSchema,
  updateSiteSchema,
} from '../lib/validation';
import { hash } from '../lib/privacy';
import { collect } from './collect.server';
import { createSite, ownedSite } from './sites.server';
import {
  createEnvironment,
  deleteEnvironment,
  siteEnvironment,
  updateEnvironment,
  withEnvironments,
} from './environments.server';
import { breakdown, overview, timeseries } from '../analytics/queries.server';
import { installationStatus } from '../analytics/ingest.server';
import { sessionReport } from '../analytics/sessions.server';
import { openapi } from './openapi';
import { polarWebhook } from '../billing/webhook.server';
import { billingApi, polarClient, syncCustomer } from '../billing/polar.server';
import { accountUsage } from '../billing/usage.server';

type AuthSession = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createAuth>['api']['getSession']>>
>;
type ApiContext = {
  Bindings: AppEnv;
  Variables: {
    requestId: string;
    db: Database;
    session: AuthSession;
    site: typeof sites.$inferSelect;
    environmentId: string;
    environment: typeof environments.$inferSelect;
  };
};

function methods(...allowed: string[]): MiddlewareHandler<ApiContext> {
  return async (c, next) => {
    // Hono dispatches HEAD through GET routes; retain the API's explicit method contract.
    if (!allowed.includes(c.req.method))
      throw new HttpError(405, 'method_not_allowed', `Use ${allowed.join(' or ')}.`);
    await next();
  };
}

const notFound = () => {
  throw new HttpError(404, 'not_found', 'Endpoint not found.');
};

export const apiApp = new Hono<ApiContext>();

apiApp.use('/api/*', async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);
  await next();
  const headers = new Headers(c.res.headers);
  headers.set('X-Request-Id', requestId);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (c.res.status === 429 || c.res.status === 503) headers.set('Retry-After', '60');
  const isConfig = c.req.path === '/api/tracker-config';
  if (isConfig || c.req.path === '/api/collect') {
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', isConfig ? 'GET, OPTIONS' : 'POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
    headers.set('Access-Control-Max-Age', '86400');
  }
  c.res = new Response(c.res.body, { status: c.res.status, headers });
});

apiApp.onError((error, c) => {
  const requestId = c.get('requestId');
  if (error instanceof HttpError)
    return json({ error: { code: error.code, message: error.message, requestId } }, error.status);
  // Never log credentials, headers, event payloads, query parameters, or DB error details.
  console.error(
    JSON.stringify({
      event: 'api_failure',
      requestId,
      path: c.req.routePath,
      error: error instanceof Error ? error.name : 'UnknownError',
    }),
  );
  return json(
    { error: { code: 'service_unavailable', message: 'Please retry shortly.', requestId } },
    503,
  );
});

apiApp.use('/api/openapi.json', methods('GET'));
apiApp.get('/api/openapi.json', () => json(openapi));
apiApp.use('/api/health', methods('GET'));
apiApp.get('/api/health', () => json({ status: 'ok', service: 'analytics', version: 1 }));
apiApp.use('/api/preferences', methods('GET'));
apiApp.get('/api/preferences', (c) => {
  const request = c.req.raw;
  const country = request.headers.get('x-analytics-country');
  return json(
    resolvePreferences(
      request.headers.get('cookie') ?? '',
      typeof country === 'string' ? country : undefined,
    ),
  );
});

apiApp.options('/api/tracker-config', () => new Response(null, { status: 204 }));
apiApp.use('/api/tracker-config', methods('GET'));
apiApp.get('/api/tracker-config', async (c) => {
  const url = new URL(c.req.url);
  const siteId = parse(siteIdSchema, url.searchParams.get('siteId'));
  const environmentId = parse(siteIdSchema, url.searchParams.get('environmentId') ?? siteId);
  return withDatabase(c.env, async (db) => {
    const [environment] = await db
      .select({ enabled: environments.enabled, settings: environments.trackingSettings })
      .from(environments)
      .where(and(eq(environments.id, environmentId), eq(environments.siteId, siteId)))
      .limit(1);
    if (!environment) throw new HttpError(404, 'environment_not_found', 'Environment not found.');
    return json({ enabled: environment.enabled, settings: trackingSettings(environment.settings) });
  });
});

apiApp.options('/api/collect', () => new Response(null, { status: 204 }));
apiApp.use('/api/collect', methods('POST'));
apiApp.post('/api/collect', (c) => collect(c.req.raw, c.env, (fn) => withDatabase(c.env, fn)));
apiApp.use('/api/webhooks/polar', methods('POST'));
apiApp.post('/api/webhooks/polar', (c) =>
  polarWebhook(c.req.raw, c.env.POLAR_WEBHOOK_SECRET, (fn) => withDatabase(c.env, fn)),
);

async function authHandler(c: Context<ApiContext>) {
  const request = c.req.raw;
  const env = c.env;
  const key = await hash(
    env.VISITOR_HASH_SECRET,
    request.headers.get('cf-connecting-ip') ?? 'unknown',
  );
  if (!(await env.AUTH_LIMITER.limit({ key })).success)
    throw new HttpError(429, 'rate_limited', 'Too many authentication requests.');
  let authRequest = request;
  if (request.method === 'POST') {
    requireSameOrigin(request, env.APP_URL);
    const body = await readJson(request);
    // Require a password even when Better Auth considers the session fresh.
    if (c.req.path === '/api/auth/delete-user')
      parse(z.object({ password: z.string().min(1).max(128) }).strict(), body);
    authRequest = new Request(request, { method: 'POST', body: JSON.stringify(body) });
    authRequest.headers.set('Content-Type', 'application/json');
  }
  return withDatabase(env, async (db) => {
    if (c.req.path === '/api/auth/delete-user' && env.POLAR_ACCESS_TOKEN) {
      const session = await createAuth(db, env).api.getSession({ headers: request.headers });
      if (!session) throw new HttpError(401, 'unauthorized', 'Sign in to continue.');
      const state = await syncCustomer(db, session.user.id, polarClient(env));
      if (state?.activeSubscriptions.some((s) => !s.cancelAtPeriodEnd))
        throw new HttpError(
          409,
          'cancel_subscription_first',
          'Cancel your subscription in Usage → Manage billing before deleting your account.',
        );
    }
    return createAuth(db, env).handler(authRequest);
  });
}

apiApp.all('/api/auth', notFound);
apiApp.use('/api/auth/*', methods('GET', 'POST'));
apiApp.get('/api/auth/*', authHandler);
apiApp.post('/api/auth/*', authHandler);

// Authenticate unknown subpaths too, so endpoint probing retains the same account boundary.
apiApp.use('/api/*', async (c, next) => {
  const path = c.req.path;
  const accountPath =
    path === '/api/billing' ||
    path.startsWith('/api/billing/') ||
    path === '/api/me' ||
    path === '/api/usage' ||
    path === '/api/sites' ||
    path.startsWith('/api/sites/');
  if (!accountPath) return next();
  const request = c.req.raw;
  const env = c.env;
  if (!['GET', 'HEAD'].includes(request.method)) requireSameOrigin(request, env.APP_URL);
  const ipKey = await hash(
    env.VISITOR_HASH_SECRET,
    request.headers.get('cf-connecting-ip') ?? 'unknown',
  );
  if (!(await env.API_LIMITER.limit({ key: `ip:${ipKey}` })).success)
    throw new HttpError(429, 'rate_limited', 'Too many API requests.');
  await withDatabase(env, async (db) => {
    const session = await createAuth(db, env).api.getSession({ headers: request.headers });
    if (!session) throw new HttpError(401, 'unauthorized', 'Sign in to continue.');
    if (!(await env.API_LIMITER.limit({ key: `user:${session.user.id}` })).success)
      throw new HttpError(429, 'rate_limited', 'Too many API requests.');
    c.set('db', db);
    c.set('session', session);
    await next();
  });
});

// Polar owns its route-specific validation and provider error contracts.
const billingHandler = (c: Context<ApiContext>) =>
  billingApi(c.req.raw, c.get('db'), c.env, c.get('session').user);
apiApp.get('/api/billing', billingHandler);
apiApp.post('/api/billing/sync', billingHandler);
apiApp.post('/api/billing/portal', billingHandler);
apiApp.post('/api/billing/checkout', billingHandler);
apiApp.all('/api/billing', billingHandler);
apiApp.all('/api/billing/*', billingHandler);

apiApp.use('/api/me', methods('GET'));
apiApp.get('/api/me', (c) => {
  const owner = c.get('session').user;
  return json({ user: { id: owner.id, name: owner.name, email: owner.email } });
});
apiApp.use('/api/usage', methods('GET'));
apiApp.get('/api/usage', async (c) => {
  const ownerId = c.get('session').user.id;
  return json({
    ...(await accountUsage(c.get('db'), ownerId)),
    protection: await protectionSummary(c.get('db'), ownerId),
  });
});

apiApp.use('/api/sites', methods('GET', 'POST'));
apiApp.get('/api/sites', async (c) => {
  const db = c.get('db');
  return json({
    sites: await withEnvironments(
      db,
      await db
        .select()
        .from(sites)
        .where(eq(sites.ownerId, c.get('session').user.id))
        .orderBy(sites.createdAt)
        .limit(100),
    ),
  });
});
apiApp.post('/api/sites', async (c) => {
  const db = c.get('db');
  const site = await createSite(
    db,
    c.get('session').user.id,
    parse(createSiteSchema, await readJson(c.req.raw)),
  );
  return json({ site: (await withEnvironments(db, [site!]))[0] }, 201);
});

const loadSite: MiddlewareHandler<ApiContext> = async (c, next) => {
  const id = parse(siteIdSchema, c.req.param('siteId'));
  c.set('site', await ownedSite(c.get('db'), c.get('session').user.id, id));
  await next();
};

apiApp.use('/api/sites/:siteId', loadSite, methods('GET', 'PATCH', 'DELETE'));
apiApp.get('/api/sites/:siteId', async (c) =>
  json({ site: (await withEnvironments(c.get('db'), [c.get('site')]))[0] }),
);
apiApp.patch('/api/sites/:siteId', async (c) => {
  const db = c.get('db');
  const id = c.get('site').id;
  const ownerId = c.get('session').user.id;
  const update = parse(updateSiteSchema, await readJson(c.req.raw));
  const [updated] = await db.transaction(async (tx) => {
    await tx.select({ id: user.id }).from(user).where(eq(user.id, ownerId)).for('update');
    return tx
      .update(sites)
      .set(update)
      .where(and(eq(sites.id, id), eq(sites.ownerId, ownerId)))
      .returning();
  });
  if (!updated) throw new HttpError(404, 'site_not_found', 'Website not found.');
  return json({ site: (await withEnvironments(db, [updated]))[0] });
});
apiApp.delete('/api/sites/:siteId', async (c) => {
  await c
    .get('db')
    .delete(sites)
    .where(and(eq(sites.id, c.get('site').id), eq(sites.ownerId, c.get('session').user.id)));
  return new Response(null, { status: 204 });
});

apiApp.use('/api/sites/:siteId/environments', loadSite, methods('GET', 'POST'));
apiApp.get('/api/sites/:siteId/environments', async (c) =>
  json({ environments: (await withEnvironments(c.get('db'), [c.get('site')]))[0]!.environments }),
);
apiApp.post('/api/sites/:siteId/environments', async (c) =>
  json(
    {
      environment: await createEnvironment(
        c.get('db'),
        c.get('site'),
        parse(createEnvironmentSchema, await readJson(c.req.raw)),
      ),
    },
    201,
  ),
);

apiApp.use(
  '/api/sites/:siteId/environments/:environmentId',
  loadSite,
  async (c, next) => {
    c.set('environmentId', parse(siteIdSchema, c.req.param('environmentId')));
    await next();
  },
  methods('GET', 'PATCH', 'DELETE'),
  async (c, next) => {
    c.set(
      'environment',
      await siteEnvironment(c.get('db'), c.get('site').id, c.get('environmentId')),
    );
    await next();
  },
);
apiApp.get('/api/sites/:siteId/environments/:environmentId', (c) =>
  json({ environment: c.get('environment') }),
);
apiApp.patch('/api/sites/:siteId/environments/:environmentId', async (c) =>
  json({
    environment: await updateEnvironment(
      c.get('db'),
      c.get('site').id,
      c.get('environmentId'),
      parse(updateEnvironmentSchema, await readJson(c.req.raw)),
    ),
  }),
);
apiApp.delete('/api/sites/:siteId/environments/:environmentId', async (c) => {
  await deleteEnvironment(c.get('db'), c.get('site').id, c.get('environmentId'));
  return new Response(null, { status: 204 });
});

const loadReportEnvironment: MiddlewareHandler<ApiContext> = async (c, next) => {
  const params = new URL(c.req.url).searchParams;
  const siteId = c.get('site').id;
  c.set(
    'environment',
    await siteEnvironment(
      c.get('db'),
      siteId,
      params.has('environment') ? parse(siteIdSchema, params.get('environment')) : siteId,
    ),
  );
  await next();
};
for (const operation of ['installation', 'overview', 'timeseries', 'breakdown', 'sessions'])
  apiApp.use(`/api/sites/:siteId/${operation}`, loadSite, methods('GET'), loadReportEnvironment);

apiApp.get('/api/sites/:siteId/installation', async (c) =>
  json(await installationStatus(c.get('db'), c.get('environment').id)),
);
apiApp.get('/api/sites/:siteId/overview', async (c) =>
  json(
    await overview(
      c.get('db'),
      c.get('environment').id,
      dateRange(new URL(c.req.url).searchParams),
    ),
  ),
);
apiApp.get('/api/sites/:siteId/timeseries', async (c) =>
  json(
    await timeseries(
      c.get('db'),
      c.get('environment').id,
      dateRange(new URL(c.req.url).searchParams),
    ),
  ),
);
apiApp.get('/api/sites/:siteId/sessions', async (c) => {
  const params = new URL(c.req.url).searchParams;
  return json(await sessionReport(c.get('db'), c.get('environment').id, dateRange(params), params));
});
apiApp.get('/api/sites/:siteId/breakdown', async (c) => {
  const params = new URL(c.req.url).searchParams;
  const range = dateRange(params);
  const dimension = parse(breakdownSchema, params.get('dimension') ?? 'path');
  const limit = parse(z.coerce.number().int().min(1).max(100), params.get('limit') ?? 10);
  return json(await breakdown(c.get('db'), c.get('environment').id, range, dimension, limit));
});

apiApp.all('/api/*', notFound);
apiApp.notFound(notFound);

export async function api(request: Request, env: AppEnv): Promise<Response> {
  return apiApp.fetch(request, env);
}

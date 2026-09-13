import { Effect, type ManagedRuntime } from 'effect';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { timingSafeEqual } from 'node:crypto';
import { Infrastructure, readiness } from '../platform/resources';
import { Auth, identity } from '../auth/service';
import { ApiError, invalid } from '../shared/errors';
import { usage, requireSubscription } from '../billing/service';
import {
  listSites,
  createSite,
  updateSite,
  deleteSite,
  getEnvironment,
  saveEnvironment,
  deleteEnvironment,
} from '../sites/service';
import { billingOperation, webhook } from '../billing/polar';
import { imports } from '../imports';
import { telemetry } from '../analytics/diagnostics';
import { admin } from '../admin/service';
import { readFeature, configureFeature, deleteGoal } from '../analytics/features';
import { sessions } from '../analytics/sessions';
import { report } from '../analytics/reports';
import { hash } from '../analytics/tracking';
import { collect, trackerConfig } from '../analytics/ingestion';
export async function createApp(
  runtime: ManagedRuntime.ManagedRuntime<Infrastructure | Auth, ApiError>,
) {
  const r = await runtime.runPromise(Infrastructure);
  const auth = await runtime.runPromise(Auth);
  const run = <A>(effect: Effect.Effect<A, ApiError, Infrastructure | Auth>) =>
    runtime.runPromise(effect);

  const app = new Hono<{
    Bindings: {
      ip?: string;
    };
    Variables: {
      owner: string;
      ip: string;
      country: string;
    };
  }>();
  app.use(secureHeaders({ crossOriginResourcePolicy: 'cross-origin' }));
  app.use('*', async (c, next) => {
    const expected = process.env.CLOUDFLARE_ORIGIN_SECRET;
    const supplied = c.req.header('x-analytics-origin-key');
    const trusted =
      !!expected &&
      !!supplied &&
      Buffer.byteLength(expected) === Buffer.byteLength(supplied) &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
    c.set(
      'ip',
      trusted
        ? (c.req.header('cf-connecting-ip') ?? c.env?.ip ?? 'unknown')
        : (c.env?.ip ?? 'unknown'),
    );
    c.set(
      'country',
      trusted && /^[A-Z]{2}$/.test(c.req.header('cf-ipcountry') ?? '')
        ? c.req.header('cf-ipcountry')!
        : '',
    );
    if (process.env.NODE_ENV !== 'production' || process.env.EXTERNAL_EFFECTS !== 'enabled')
      c.header('x-robots-tag', 'noindex, nofollow');
    c.header(
      'content-security-policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    );
    await next();
  });
  app.use('/api/*', async (c, next) =>
    bodyLimit({
      maxSize: /\/imports(?:\/preview)?$/.test(c.req.path)
        ? 10 * 1024 * 1024
        : c.req.path === '/api/webhooks/polar'
          ? 256 * 1024
          : 16 * 1024,
      onError: (c) =>
        c.json({ error: { code: 'body_too_large', message: 'Request body is too large.' } }, 413),
    })(c, next),
  );
  app.use('/api/*', async (c, next) => {
    c.header('cache-control', 'no-store');
    c.header('x-request-id', crypto.randomUUID());
    const publicTracker = ['/api/collect', '/api/telemetry', '/api/tracker-config'].includes(
      c.req.path,
    );
    if (publicTracker) {
      c.header('access-control-allow-origin', '*');
      c.header('access-control-allow-methods', 'GET, POST, OPTIONS');
      c.header('access-control-allow-headers', 'Content-Type');
      if (c.req.method === 'OPTIONS') return c.body(null, 204);
    }
    if (c.req.method === 'HEAD')
      return c.json({ error: { code: 'method_not_allowed', message: 'Use GET.' } }, 405);
    const account = /^\/api\/(auth|sites|me|usage|billing|admin|onboarding)(\/|$)/.test(c.req.path);
    if (account) {
      const config = r.config;
      if (!['GET', 'HEAD'].includes(c.req.method) && c.req.header('origin') !== config.appUrl)
        throw new ApiError({
          status: 403,
          code: 'invalid_origin',
          message: 'Use the application origin for account mutations.',
        });
      if (!c.req.path.startsWith('/api/auth/')) {
        const user = await run(identity(c.req.raw.headers));
        c.set('owner', user.id);
        const count = Number(
          await r.redis.send('EVAL', [
            "local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],60) end;return n",
            '1',
            `${r.config.queuePrefix}:account:${hash(r.config.BETTER_AUTH_SECRET, user.id)}`,
          ]),
        );
        if (count > 600)
          throw new ApiError({
            status: 429,
            code: 'rate_limited',
            message: 'Too many requests. Try again in a minute.',
          });
        if (c.req.path.startsWith('/api/sites/')) await run(requireSubscription(user.id));
        if (c.req.path === '/api/sites' && c.req.method === 'GET') {
          const completed =
            await r.primary`SELECT 1 FROM account_onboarding WHERE owner_id=${user.id}`;
          if (completed.length) await run(requireSubscription(user.id));
        }
      }
    }
    await next();
  });
  app.onError((error, c) => {
    const e =
      error instanceof ApiError
        ? error
        : new ApiError({
            status: 503,
            code: 'unavailable',
            message: 'Service temporarily unavailable.',
          });
    if (!(error instanceof ApiError)) console.error('Request failed', error.name);
    return c.json({ error: { code: e.code, message: e.message } }, e.status as 400);
  });
  const jsonBody = async (request: Request) => {
    if (
      !['application/json', 'text/plain'].includes(
        (request.headers.get('content-type') ?? '').split(';')[0]!,
      )
    )
      throw invalid('Send JSON with application/json or text/plain.');
    try {
      return await request.json();
    } catch {
      throw invalid('Request body must be valid JSON.');
    }
  };
  app.get('/api/health', (c) => c.json({ status: 'ok', service: 'analytics', version: 1 }));
  app.get('/health/ready', async (c) => c.json(await run(readiness())));
  app.get(
    '/api/openapi.json',
    () =>
      new Response(Bun.file('config/openapi.json'), {
        headers: { 'content-type': 'application/json' },
      }),
  );
  app.get('/internal/metrics', async (c) => {
    const expected = process.env.METRICS_TOKEN,
      supplied = c.req.header('authorization');
    if (
      !expected ||
      !supplied ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(`Bearer ${expected}`) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(`Bearer ${expected}`))
    )
      return c.notFound();
    const counts = await r.queue.getJobCounts('active', 'waiting', 'failed', 'delayed');
    c.header('content-type', 'text/plain; version=0.0.4');
    return c.body(
      Object.entries(counts)
        .map(([state, count]) => `datix_queue_jobs{state="${state}"} ${count}`)
        .join('\n') + '\n',
    );
  });
  app.get('/api/preferences', async (c) => {
    const cookies = Object.fromEntries(
      (c.req.header('cookie') ?? '').split(';').map((s) => s.trim().split('=')),
    );
    const country = c.get('country');
    return c.json({
      locale: ['en', 'da', 'de'].includes(cookies['ab-language'] ?? '')
        ? cookies['ab-language']
        : country === 'DK'
          ? 'da'
          : ['DE', 'AT'].includes(country)
            ? 'de'
            : 'en',
      theme: ['light', 'dark', 'system'].includes(cookies['ab-theme'] ?? '')
        ? cookies['ab-theme']
        : 'system',
      oauth: ['github', 'google'].filter((provider) => {
        const prefix = provider.toUpperCase();
        return process.env[`${prefix}_CLIENT_ID`] && process.env[`${prefix}_CLIENT_SECRET`];
      }),
    });
  });
  app.on(['GET', 'POST'], '/api/auth/*', (c) => {
    const headers = new Headers(c.req.raw.headers);
    headers.set('x-datix-client-ip', c.get('ip'));
    const request = new Request(c.req.raw, { headers });
    return auth.handler(request);
  });
  app.get('/api/me', async (c) => c.json({ user: await run(identity(c.req.raw.headers)) }));
  app.get('/api/usage', async (c) => c.json(await run(usage(c.get('owner')))));
  app.post('/api/onboarding/complete', async (c) => {
    await run(requireSubscription(c.get('owner')));
    await r.primary`INSERT INTO account_onboarding(owner_id) VALUES(${c.get('owner')}) ON CONFLICT DO NOTHING`;
    return c.json({ onboardingCompleted: true });
  });
  app.get('/api/sites', async (c) => c.json({ sites: await run(listSites(c.get('owner'))) }));
  app.post('/api/sites', async (c) =>
    c.json({ site: await run(createSite(c.get('owner'), await jsonBody(c.req.raw))) }, 201),
  );
  app.get('/api/sites/:site', async (c) =>
    c.json({ site: (await run(listSites(c.get('owner'), c.req.param('site'))))[0] }),
  );
  app.patch('/api/sites/:site', async (c) =>
    c.json({
      site: await run(updateSite(c.get('owner'), c.req.param('site'), await jsonBody(c.req.raw))),
    }),
  );
  app.delete('/api/sites/:site', async (c) => {
    await run(deleteSite(c.get('owner'), c.req.param('site')));
    return c.body(null, 204);
  });
  app.get('/api/sites/:site/environments', async (c) =>
    c.json({
      environments: (await run(listSites(c.get('owner'), c.req.param('site'))))[0]!.environments,
    }),
  );
  app.post('/api/sites/:site/environments', async (c) =>
    c.json(
      {
        environment: await run(
          saveEnvironment(
            c.get('owner'),
            c.req.param('site'),
            undefined,
            await jsonBody(c.req.raw),
          ),
        ),
      },
      201,
    ),
  );
  app.get('/api/sites/:site/environments/:environment', async (c) =>
    c.json({
      environment: await run(
        getEnvironment(c.get('owner'), c.req.param('site'), c.req.param('environment')),
      ),
    }),
  );
  app.patch('/api/sites/:site/environments/:environment', async (c) =>
    c.json({
      environment: await run(
        saveEnvironment(
          c.get('owner'),
          c.req.param('site'),
          c.req.param('environment'),
          await jsonBody(c.req.raw),
        ),
      ),
    }),
  );
  app.delete('/api/sites/:site/environments/:environment', async (c) => {
    await run(deleteEnvironment(c.get('owner'), c.req.param('site'), c.req.param('environment')));
    return c.body(null, 204);
  });
  for (const kind of ['overview', 'timeseries', 'breakdown', 'installation'])
    app.get(`/api/sites/:site/${kind}`, async (c) =>
      c.json(await run(report(c.get('owner'), c.req.param('site')!, kind, c.req.query()))),
    );
  app.get('/api/sites/:site/sessions', async (c) =>
    c.json(await run(sessions(c.get('owner'), c.req.param('site'), c.req.query()))),
  );
  app.get('/api/tracker-config', async (c) =>
    c.json(
      await run(
        trackerConfig(
          c.req.query('siteId') ?? '',
          c.req.query('environmentId') ?? c.req.query('siteId') ?? '',
        ),
      ),
    ),
  );
  app.post('/api/collect', async (c) => {
    const ip = c.get('ip');
    const country = c.get('country');
    return c.json(
      await run(collect(await jsonBody(c.req.raw), c.req.raw.headers, ip, country)),
      202,
    );
  });
  app.get('/api/sites/:site/environments/:environment/features/:feature', async (c) =>
    c.json(
      await run(
        readFeature(
          c.get('owner'),
          c.req.param('site'),
          c.req.param('environment'),
          c.req.param('feature'),
          c.req.query(),
        ),
      ),
    ),
  );
  app.post('/api/sites/:site/environments/:environment/features/:feature', async (c) =>
    c.json(
      await run(
        configureFeature(
          c.get('owner'),
          c.req.param('site'),
          c.req.param('environment'),
          c.req.param('feature'),
          await jsonBody(c.req.raw),
        ),
      ),
    ),
  );
  app.delete('/api/sites/:site/environments/:environment/features/goals/:goal', async (c) =>
    c.json(
      await run(
        deleteGoal(
          c.get('owner'),
          c.req.param('site'),
          c.req.param('environment'),
          c.req.param('goal'),
        ),
      ),
    ),
  );
  app.get('/api/admin/:resource', async (c) =>
    c.json(
      await run(admin(c.req.raw.headers, c.req.param('resource'), undefined, 'GET', c.req.query())),
    ),
  );
  app.get('/api/admin/:resource/:id', async (c) =>
    c.json(
      await run(
        admin(c.req.raw.headers, c.req.param('resource'), c.req.param('id'), 'GET', c.req.query()),
      ),
    ),
  );
  app.patch('/api/admin/:resource/:id', async (c) =>
    c.json(
      await run(
        admin(
          c.req.raw.headers,
          c.req.param('resource'),
          c.req.param('id'),
          'PATCH',
          c.req.query(),
          await jsonBody(c.req.raw),
        ),
      ),
    ),
  );
  app.post('/api/telemetry', async (c) =>
    c.json(await run(telemetry(await jsonBody(c.req.raw), c.req.raw.headers, c.get('ip'))), 202),
  );
  app.get('/api/sites/:site/environments/:environment/imports', async (c) =>
    c.json(
      await run(
        imports(
          c.get('owner'),
          c.req.param('site'),
          c.req.param('environment'),
          'list',
          c.req.query(),
        ),
      ),
    ),
  );
  app.post('/api/sites/:site/environments/:environment/imports/preview', async (c) =>
    c.json(
      await run(
        imports(
          c.get('owner'),
          c.req.param('site'),
          c.req.param('environment'),
          'preview',
          c.req.query(),
          c.req.raw,
        ),
      ),
    ),
  );
  app.post('/api/sites/:site/environments/:environment/imports', async (c) => {
    const result = await run(
      imports(
        c.get('owner'),
        c.req.param('site'),
        c.req.param('environment'),
        'create',
        c.req.query(),
        c.req.raw,
      ),
    );
    return c.json(result, result.duplicate ? 200 : 201);
  });
  app.delete('/api/sites/:site/environments/:environment/imports/:id', async (c) => {
    await run(
      imports(
        c.get('owner'),
        c.req.param('site'),
        c.req.param('environment'),
        'delete',
        c.req.query(),
        undefined,
        c.req.param('id'),
      ),
    );
    return c.body(null, 204);
  });
  app.on(['GET', 'POST'], '/api/billing', async (c) =>
    c.json(await run(billingOperation(c.get('owner'), '', c.req.method, null))),
  );
  app.on(['GET', 'POST'], '/api/billing/:operation', async (c) =>
    c.json(
      await run(
        billingOperation(
          c.get('owner'),
          c.req.param('operation'),
          c.req.method,
          c.req.param('operation') === 'checkout' ? await jsonBody(c.req.raw) : null,
        ),
      ),
    ),
  );
  app.post('/api/webhooks/polar', async (c) =>
    c.json(await run(webhook(c.req.raw.headers, await c.req.text()))),
  );
  app.all('/api/*', (c) => c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404));
  app.use('*', serveStatic({ root: 'apps/web/dist/client' }));
  app.get('*', serveStatic({ path: 'apps/web/dist/client/index.html' }));
  return app;
}

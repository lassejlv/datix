import type * as ManagedRuntime from 'effect/ManagedRuntime';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { timingSafeEqual } from 'node:crypto';
import { Infrastructure, readiness } from '../platform/resources';
import { ApiError } from '../shared/errors';

export async function createWorkerApp(
  runtime: ManagedRuntime.ManagedRuntime<Infrastructure, ApiError>,
) {
  const r = await runtime.runPromise(Infrastructure);
  const app = new Hono<{ Bindings: { ip?: string } }>();

  app.use(secureHeaders({ crossOriginResourcePolicy: 'cross-origin' }));
  app.use('*', async (c, next) => {
    if (process.env.NODE_ENV !== 'production' || process.env.EXTERNAL_EFFECTS !== 'enabled')
      c.header('x-robots-tag', 'noindex, nofollow');
    c.header(
      'content-security-policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    );
    await next();
  });
  app.use('/api/*', async (c, next) => {
    c.header('cache-control', 'no-store');
    c.header('x-request-id', crypto.randomUUID());
    if (c.req.method === 'HEAD')
      return c.json({ error: { code: 'method_not_allowed', message: 'Use GET.' } }, 405);
    await next();
  });
  app.onError((error, c) => {
    const failure =
      error instanceof ApiError
        ? error
        : new ApiError({
            status: 503,
            code: 'unavailable',
            message: 'Service temporarily unavailable.',
          });

    if (!(error instanceof ApiError)) console.error('Request failed', error.name);

    return c.json(
      { error: { code: failure.code, message: failure.message } },
      failure.status as 400,
    );
  });
  app.get('/api/health', (c) => c.json({ status: 'ok', service: 'analytics', version: 1 }));
  app.get('/health/ready', async (c) => c.json(await runtime.runPromise(readiness())));
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

  return app;
}

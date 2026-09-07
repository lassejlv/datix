import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { resolve } from 'node:path';
import { apiApp } from '../api/router.server';
import type { AppEnv } from './types';

const frontendPages = new Set(['/', '/pricing', '/signin', '/signup', '/dashboard', '/usage']);

function frontendRoute(path: string) {
  return (
    frontendPages.has(path.replace(/\/$/, '') || '/') ||
    /^\/site\/[^/]+(?:\/[^/]+(?:\/[^/]+)?)?\/?$/.test(path)
  );
}

export function createHttpApp(options: { assetRoot: string; ready: () => Promise<void> }) {
  const app = new Hono<{ Bindings: AppEnv }>();
  const root = resolve(options.assetRoot);
  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    await next();
  });
  app.get('/health/ready', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      await options.ready();
      return c.json({ status: 'ok', runtime: 'bun', service: 'app' });
    } catch {
      return c.json({ status: 'unavailable' }, 503);
    }
  });
  // Keep the API's JSON errors and method handling separate from SPA fallback.
  app.all('/api', (c) => apiApp.fetch(c.req.raw, c.env));
  app.all('/api/*', (c) => apiApp.fetch(c.req.raw, c.env));
  app.use('*', async (c, next) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.text('Not found', 404);
    }
    if (
      path.includes('\\') ||
      path.includes('\0') ||
      path.split('/').some((part) => part.startsWith('.'))
    )
      return c.text('Not found', 404);
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD')
      return c.json({ error: { code: 'method_not_allowed', message: 'Use GET or HEAD.' } }, 405);
    await next();
  });
  app.get(
    '*',
    serveStatic({
      root,
      onFound(path, c) {
        c.header(
          'Cache-Control',
          path.endsWith('/index.html')
            ? 'no-cache'
            : c.req.path.startsWith('/assets/')
              ? 'public, max-age=31536000, immutable'
              : 'public, max-age=300',
        );
      },
    }),
  );
  app.get('*', async (c) => {
    const path = c.req.path;
    if (/\.[^/]+$/.test(path) || path.startsWith('/assets/') || path.startsWith('/media/'))
      return c.text('Not found', 404);
    const shell = Bun.file(resolve(root, 'index.html'));
    if (!(await shell.exists())) return c.text('Frontend build unavailable', 503);
    return new Response(shell, {
      status: frontendRoute(path) ? 200 : 404,
      headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-cache' },
    });
  });
  app.onError(() => {
    console.error(JSON.stringify({ event: 'http_request_failed' }));
    return Response.json(
      { error: { code: 'server_error', message: 'Request failed.' } },
      { status: 500 },
    );
  });
  return app;
}

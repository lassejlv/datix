import { resolve, sep } from 'node:path';
import { runtime, required } from './environment.server';
import { normalizeRequest } from './request.server';

const app = runtime();
const proxySecret = process.env.RAILWAY_ENVIRONMENT_ID
  ? required('CLOUDFLARE_ORIGIN_SECRET')
  : undefined;
await app.ready();
// Vite builds the SSR entry; Bun serves it and the generated client assets.
const entry = resolve('dist/server/server.js');
const { default: handler } = await import(entry);
const assetRoot = resolve('dist/client');
const server = Bun.serve({
  hostname: '0.0.0.0',
  port: Number(process.env.PORT ?? 3000),
  idleTimeout: 60,
  maxRequestBodySize: 1024 * 1024,
  async fetch(incoming, server) {
    const request = normalizeRequest(
      incoming,
      server.requestIP(incoming)?.address ?? 'unknown',
      !!process.env.RAILWAY_ENVIRONMENT_ID,
      proxySecret,
    );
    const pathname = new URL(request.url).pathname;
    if (pathname === '/health/ready') {
      try {
        await app.ready();
        return Response.json({ status: 'ok', runtime: 'bun' });
      } catch {
        return Response.json({ status: 'unavailable' }, { status: 503 });
      }
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      let decoded: string;
      try {
        decoded = decodeURIComponent(pathname);
      } catch {
        return new Response('Bad request', { status: 400 });
      }
      const path = resolve(assetRoot, `.${decoded}`);
      if (path.startsWith(assetRoot + sep)) {
        const file = Bun.file(path);
        if (await file.exists()) {
          const response = new Response(request.method === 'HEAD' ? null : file, {
            headers: {
              'content-type': file.type,
              'content-length': String(file.size),
              'cache-control': pathname.startsWith('/assets/')
                ? 'public, max-age=31536000, immutable'
                : 'public, max-age=300',
              'x-content-type-options': 'nosniff',
            },
          });
          return response;
        }
      }
    }
    return handler.fetch(request);
  },
  error() {
    console.error(JSON.stringify({ event: 'http_request_failed' }));
    return Response.json(
      { error: { code: 'server_error', message: 'Request failed.' } },
      { status: 500 },
    );
  },
});
console.log(JSON.stringify({ event: 'web_started', runtime: Bun.version, port: server.port }));
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await server.stop();
    await app.close();
    process.exit(0);
  });

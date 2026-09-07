import { runtime, required } from './environment.server';
import { normalizeRequest } from './request.server';
import { createHttpApp } from './http.server';
import { startJobs } from './jobs.server';

const app = runtime();
const proxySecret = process.env.RAILWAY_ENVIRONMENT_ID
  ? required('CLOUDFLARE_ORIGIN_SECRET')
  : undefined;
await app.ready();
const jobs = await startJobs(app);
let stopping = false;
const http = createHttpApp({
  assetRoot: 'dist/client',
  async ready() {
    if (stopping) throw new Error('ShuttingDown');
    await app.ready();
    jobs.ready();
  },
});
const server = Bun.serve({
  hostname: '0.0.0.0',
  port: Number(process.env.PORT ?? 3000),
  idleTimeout: 60,
  maxRequestBodySize: 1024 * 1024,
  fetch(incoming, server) {
    const request = normalizeRequest(
      incoming,
      server.requestIP(incoming)?.address ?? 'unknown',
      !!process.env.RAILWAY_ENVIRONMENT_ID,
      proxySecret,
    );
    return http.fetch(request, app.env);
  },
  error() {
    console.error(JSON.stringify({ event: 'http_request_failed' }));
    return Response.json(
      { error: { code: 'server_error', message: 'Request failed.' } },
      { status: 500 },
    );
  },
});
console.log(
  JSON.stringify({
    event: 'app_started',
    framework: 'hono',
    runtime: Bun.version,
    port: server.port,
  }),
);
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await server.stop();
    await jobs.close();
    await app.close();
    process.exit(0);
  });

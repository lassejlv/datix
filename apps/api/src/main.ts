import { createApp } from './http/app';
import { Infrastructure } from './platform/resources';
import { createRuntime } from './platform/runtime';

const runtime = createRuntime();
try {
  const resources = await runtime.runPromise(Infrastructure);
  const app = await createApp(runtime);
  let stopping = false;
  const server = Bun.serve({
    port: resources.config.port,
    hostname: '0.0.0.0',
    maxRequestBodySize: 10 * 1024 * 1024,
    fetch(request, server) {
      if (stopping) return new Response('Draining', { status: 503 });
      if (
        resources.config.role === 'worker' &&
        !['/health/ready', '/api/health', '/internal/metrics'].includes(
          new URL(request.url).pathname,
        )
      )
        return new Response(null, { status: 404 });
      return app.fetch(request, { ip: server.requestIP(request)?.address });
    },
  });
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 85_000);
    timeout.unref();
    await server.stop(false);
    await runtime.dispose();
    clearTimeout(timeout);
    process.exit(0);
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  console.info(`Datix ${resources.config.role} listening on ${server.port}`);
} catch {
  console.error(
    'Startup failed; check database migrations, runtime grants, and service configuration.',
  );
  await runtime.dispose();
  process.exit(1);
}

import { afterEach, expect, test } from 'bun:test';
import { createWorkerApp } from '../src/http/worker-app';
import { Infrastructure } from '../src/platform/resources';

const originalToken = process.env.METRICS_TOKEN;

afterEach(() => {
  if (originalToken === undefined) delete process.env.METRICS_TOKEN;
  else process.env.METRICS_TOKEN = originalToken;
});

test('worker role keeps health and protected queue metrics without loading the full API', async () => {
  const resources = {
    queue: {
      getJobCounts: async () => ({ active: 1, waiting: 2, failed: 3, delayed: 4 }),
    },
  };

  const runtime = {
    runPromise: async (effect: unknown) =>
      effect === Infrastructure
        ? resources
        : { status: 'ok', runtime: 'bun', service: 'app', role: 'worker' },
  } as unknown as Parameters<typeof createWorkerApp>[0];

  const app = await createWorkerApp(runtime);

  const health = await app.request('/api/health');
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ status: 'ok', service: 'analytics', version: 1 });
  expect((await app.request('/api/health', { method: 'HEAD' })).status).toBe(405);
  expect((await app.request('/health/ready')).status).toBe(200);

  process.env.METRICS_TOKEN = 'worker-metrics-test-token';
  expect((await app.request('/internal/metrics')).status).toBe(404);

  const metrics = await app.request('/internal/metrics', {
    headers: { authorization: 'Bearer worker-metrics-test-token' },
  });

  expect(metrics.status).toBe(200);
  expect(await metrics.text()).toContain('datix_queue_jobs{state="failed"} 3');
});

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpApp } from '../../src/runtime/http.server';
import type { AppEnv } from '../../src/runtime/types';

const directory = await mkdtemp(join(tmpdir(), 'analytics-hono-http-'));
const assetRoot = join(directory, 'public');
const shell = '<!doctype html><html><body><div id="root">Analytics shell</div></body></html>';
await mkdir(join(assetRoot, 'assets'), { recursive: true });
await mkdir(join(assetRoot, 'media'), { recursive: true });
await mkdir(join(assetRoot, 'api'), { recursive: true });
await Promise.all([
  writeFile(join(assetRoot, 'index.html'), shell),
  writeFile(join(assetRoot, 'assets', 'app-123.js'), 'window.analyticsApp = true;'),
  writeFile(join(assetRoot, 'media', 'mascot.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>'),
  writeFile(join(assetRoot, 'tracker.js'), 'window.analyticsTracker = true;'),
  writeFile(join(assetRoot, '.env'), 'private-root-fixture'),
  writeFile(join(assetRoot, 'assets', '.env'), 'private-nested-fixture'),
  writeFile(join(assetRoot, 'api', 'accidental.txt'), 'private-api-fixture'),
  writeFile(join(directory, 'outside.txt'), 'private-outside-fixture'),
]);
afterAll(() => rm(directory, { recursive: true, force: true }));

const allow = { limit: async () => ({ success: true }) };
const env: AppEnv = {
  APP_URL: 'https://analytics.example',
  BETTER_AUTH_SECRET: 'http-unit-test-auth-secret-with-more-than-32-characters',
  VISITOR_HASH_SECRET: 'http-unit-test-visitor-secret-with-more-than-32-characters',
  EVENTS: { send: async () => {} },
  COLLECT_LIMITER: allow,
  AUTH_LIMITER: allow,
  API_LIMITER: allow,
};
const app = createHttpApp({ assetRoot, ready: async () => {} });
function request(path: string, options?: RequestInit) {
  return app.fetch(new Request(`${env.APP_URL}${path}`, options), env);
}

describe('Hono frontend and API boundary', () => {
  test('direct frontend navigation and HEAD serve the built shell', async () => {
    for (const path of ['/', '/pricing', '/signin', '/signup', '/dashboard', '/usage', '/site/abc']) {
      const response = await request(`${path}?source=direct`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(await response.text()).toBe(shell);
      const head = await request(path, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe('');
    }
  });

  test('unknown browser routes retain a 404 status while rendering the client shell', async () => {
    const response = await request('/this-page-does-not-exist');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toBe(shell);
  });

  test('serves built assets and the public tracker with their actual content', async () => {
    for (const [path, content, type] of [
      ['/assets/app-123.js', 'window.analyticsApp = true;', 'javascript'],
      ['/media/mascot.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml'],
      ['/tracker.js', 'window.analyticsTracker = true;', 'javascript'],
    ]) {
      const response = await request(path!);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(type!);
      expect(await response.text()).toBe(content!);
      const head = await request(path!, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe('');
    }
  });

  test('missing assets never receive the HTML shell', async () => {
    for (const path of ['/assets/missing.js', '/media/missing.svg']) {
      const response = await request(path);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('Analytics shell');
    }
    const missingTrackerApp = createHttpApp({
      assetRoot: join(assetRoot, 'media'),
      ready: async () => {},
    });
    const response = await missingTrackerApp.fetch(new Request(`${env.APP_URL}/tracker.js`), env);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('Analytics shell');
  });

  test('dotfiles and encoded traversal cannot read files or receive the shell', async () => {
    for (const path of [
      '/.env',
      '/assets/.env',
      '/assets/%2eenv',
      '/assets/%2e%2e%2f%2eenv',
      '/assets/%2e%2e%2f%2e%2e%2foutside.txt',
    ]) {
      const response = await request(path);
      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body).not.toContain('private-');
      expect(body).not.toContain('Analytics shell');
    }
  });

  test('frontend POST requests do not serve a document', async () => {
    const response = await request('/dashboard', { method: 'POST' });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toContain('Analytics shell');
  });

  test('API misses stay JSON and never expose a file under the API prefix', async () => {
    for (const path of ['/api', '/api/does-not-exist', '/api/accidental.txt']) {
      const response = await request(path);
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      const body = await response.json();
      expect(body.error.code).toBe('not_found');
      expect(body.error.requestId).toBe(response.headers.get('x-request-id'));
      expect(body.error.requestId).toBeTruthy();
    }
  });

  test('public API methods preserve the existing 405 contract and request IDs', async () => {
    const response = await request('/api/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', service: 'analytics', version: 1 });
    expect(response.headers.get('x-request-id')).toBeTruthy();
    for (const method of ['POST', 'HEAD']) {
      const denied = await request('/api/health', { method });
      expect(denied.status).toBe(405);
      expect(denied.headers.get('x-request-id')).toBeTruthy();
      if (method !== 'HEAD') expect((await denied.json()).error.code).toBe('method_not_allowed');
    }
  });

  test('only tracker endpoints accept cross-origin preflights', async () => {
    for (const [path, methods] of [
      ['/api/collect', 'POST, OPTIONS'],
      ['/api/tracker-config', 'GET, OPTIONS'],
    ]) {
      const response = await request(path!, {
        method: 'OPTIONS',
        headers: { Origin: 'https://tracked.example' },
      });
      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('access-control-allow-methods')).toBe(methods!);
      expect(response.headers.get('access-control-allow-headers')).toBe('Content-Type');
      expect(response.headers.get('x-request-id')).toBeTruthy();
    }
    const health = await request('/api/health', { method: 'OPTIONS' });
    expect(health.status).toBe(405);
    expect(health.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('Hono runtime readiness', () => {
  test('successful dependency checks report the combined Bun app as ready', async () => {
    let checks = 0;
    const readyApp = createHttpApp({ assetRoot, ready: async () => { checks++; } });
    const response = await readyApp.fetch(new Request(`${env.APP_URL}/health/ready`), env);
    expect(checks).toBe(1);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', runtime: 'bun', service: 'app' });
  });

  test('dependency failures return 503 without disclosing the dependency error', async () => {
    const failingApp = createHttpApp({
      assetRoot,
      ready: async () => { throw new Error('private-dependency-connection-string'); },
    });
    const response = await failingApp.fetch(new Request(`${env.APP_URL}/health/ready`), env);
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.text()).not.toContain('private-dependency');
  });
});

describe('Hono preferences endpoint', () => {
  test('uses trusted country with English and system theme fallbacks', async () => {
    for (const [country, locale] of [['DK', 'da'], ['DE', 'de'], ['AT', 'de'], ['US', 'en']]) {
      const response = await request('/api/preferences', {
        headers: { 'x-analytics-country': country! },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ locale: locale!, theme: 'system' });
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    const response = await request('/api/preferences', { headers: { 'cf-ipcountry': 'DK' } });
    expect(await response.json()).toEqual({ locale: 'en', theme: 'system' });
  });

  test('manual cookie choices take precedence over country', async () => {
    const response = await request('/api/preferences', {
      headers: {
        'x-analytics-country': 'DK',
        cookie: 'other=value; ab-language=de; ab-theme=dark',
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ locale: 'de', theme: 'dark' });
  });

  test('invalid preferences fall back safely and mutation methods are rejected', async () => {
    const response = await request('/api/preferences', {
      headers: {
        'x-analytics-country': 'DE',
        cookie: 'ab-language=invalid; ab-theme=invalid',
      },
    });
    expect(await response.json()).toEqual({ locale: 'de', theme: 'system' });
    const denied = await request('/api/preferences', { method: 'POST' });
    expect(denied.status).toBe(405);
    expect((await denied.json()).error.code).toBe('method_not_allowed');
  });
});

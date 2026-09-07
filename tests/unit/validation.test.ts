import { describe, expect, test } from 'bun:test';
import { collectSchema, dateRange, domainSchema, updateSiteSchema } from '../../src/lib/validation';
import { deviceType, hash, pageUrl, referrerHost } from '../../src/lib/privacy';
import { readJson } from '../../src/lib/http';

describe('collection boundaries', () => {
  test('domain normalization accepts hostnames, rejects URLs and wildcards', () => {
    expect(domainSchema.parse(' Example.COM. ')).toBe('example.com');
    for (const input of [
      'https://example.com',
      '*.example.com',
      'example.com:3000',
      'example.com/path',
      'localhost',
      '-bad.com',
    ])
      expect(domainSchema.safeParse(input).success).toBe(false);
  });
  test('collection has no arbitrary metadata or client timestamps', () => {
    const body = {
      siteId: crypto.randomUUID(),
      id: crypto.randomUUID(),
      type: 'pageview',
      url: 'https://example.com',
    };
    expect(collectSchema.safeParse(body).success).toBe(true);
    expect(
      collectSchema.safeParse({ ...body, properties: { email: 'private@example.com' } }).success,
    ).toBe(false);
    expect(collectSchema.safeParse({ ...body, timestamp: '2020-01-01' }).success).toBe(false);
  });
  test('URL and origin must agree; query strings and fragments are discarded', () => {
    expect(
      pageUrl(
        'https://example.com/pricing?email=private#hash',
        'example.com',
        'https://example.com',
      ),
    ).toBe('/pricing');
    for (const origin of [null, 'https://attacker.com', 'https://www.example.com'])
      expect(() => pageUrl('https://example.com/', 'example.com', origin)).toThrow();
    expect(() =>
      pageUrl(
        'https://example.com.attacker.com/',
        'example.com',
        'https://example.com.attacker.com',
      ),
    ).toThrow();
    expect(() =>
      pageUrl(`https://example.com/${'😀'.repeat(180)}`, 'example.com', 'https://example.com'),
    ).toThrow();
  });
  test('localhost requires opt-in and exact HTTP origin agreement', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      for (const scheme of ['http', 'https']) {
        const origin = `${scheme}://${host}:5173`;
        const url = `${origin}/local-test?secret=discard#fragment`;
        expect(() => pageUrl(url, 'example.com', origin)).toThrow();
        expect(pageUrl(url, 'example.com', origin, true)).toBe('/local-test');
        for (const wrong of [null, 'null', 'https://example.com', `${scheme}://${host}:3000`]) {
          expect(() => pageUrl(url, 'example.com', wrong, true)).toThrow();
        }
      }
    }
    for (const origin of [
      'http://localhost.attacker.com',
      'http://app.localhost',
      'http://192.168.1.2',
      'http://0.0.0.0',
      'http://[::2]',
      'ftp://localhost',
    ]) {
      expect(() => pageUrl(`${origin}/`, 'example.com', origin, true)).toThrow();
    }
    expect(() =>
      pageUrl('http://user:pass@localhost/', 'example.com', 'http://localhost', true),
    ).toThrow();
    expect(pageUrl('https://example.com/normal', 'example.com', 'https://example.com', true)).toBe(
      '/normal',
    );
  });
  test('localhost setting accepts only booleans', () => {
    for (const value of [true, false])
      expect(updateSiteSchema.parse({ allowLocalhost: value })).toEqual({ allowLocalhost: value });
    for (const value of ['true', 'false', 1, null])
      expect(updateSiteSchema.safeParse({ allowLocalhost: value }).success).toBe(false);
  });
  test('referrers retain only hostname and device classification is coarse', () => {
    expect(referrerHost('https://search.example/query?secret=value')).toBe('search.example');
    expect(referrerHost('javascript:alert(1)')).toBe('');
    expect(deviceType('Mozilla iPhone Mobile')).toBe('mobile');
    expect(deviceType('Mozilla iPad')).toBe('tablet');
  });
  test('visitor hashes are scoped by day and site', async () => {
    const first = await hash('secret', JSON.stringify(['site-a', '2026-09-06', 'ip', 'ua']));
    expect(first).toHaveLength(64);
    expect(await hash('secret', JSON.stringify(['site-a', '2026-09-06', 'ip', 'ua']))).toBe(first);
    expect(await hash('secret', JSON.stringify(['site-b', '2026-09-06', 'ip', 'ua']))).not.toBe(
      first,
    );
    expect(await hash('secret', JSON.stringify(['site-a', '2026-09-07', 'ip', 'ua']))).not.toBe(
      first,
    );
  });
  test('rejects streamed oversize bodies without trusting content-length', async () => {
    const request = new Request('http://localhost', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x'.repeat(9000),
    });
    await expect(readJson(request)).rejects.toMatchObject({ status: 413 });
    await expect(
      readJson(
        new Request('http://localhost', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{',
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

test('date range validation rejects impossible, future, reversed and excessive ranges', () => {
  const now = new Date('2026-09-06T12:00:00Z');
  expect(dateRange(new URLSearchParams(), now).days).toBe(30);
  for (const query of [
    'from=2026-02-30',
    'to=2026-09-07',
    'from=2026-09-05&to=2026-09-04',
    'from=2024-01-01',
    'from=invalid',
  ])
    expect(() => dateRange(new URLSearchParams(query), now)).toThrow();
  expect(dateRange(new URLSearchParams('from=2026-09-06&to=2026-09-06'), now).days).toBe(1);
});

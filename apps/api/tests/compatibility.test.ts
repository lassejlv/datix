import { expect, test } from 'bun:test';
import { createHmac, scryptSync } from 'node:crypto';
import { verifyPassword } from 'better-auth/crypto';
import { normalize, units } from '../src/analytics/tracking';
import { dateRange } from '../src/analytics/reports';
import { decode, CreateSite } from '../src/shared/validation';

const site = 'b7018349-6db1-45ca-9bc2-d7b5f81b1a89';
const input = {
  siteId: site,
  id: '9a46202a-9b1d-46f6-b91d-3e46639bfc9a',
  type: 'pageview' as const,
  url: 'https://example.com/pricing?email=private@example.com#secret',
};
const env = {
  domain: 'example.com',
  allow_localhost: false,
  tracking_mode: 'cookieless',
  tracking_settings: {},
};
test('Better Auth accepts existing Rust password hashes', async () => {
  const password = 'Migraté Å password',
    salt = '0123456789abcdef0123456789abcdef';
  const digest = scryptSync(password.normalize('NFKC'), salt, 64, {
    N: 16384,
    r: 16,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  }).toString('hex');
  expect(await verifyPassword({ password, hash: `${salt}:${digest}` })).toBe(true);
  expect(await verifyPassword({ password: 'wrong', hash: `${salt}:${digest}` })).toBe(false);
});
test('visitor identity, credit units and URL privacy preserve the tracker contract', () => {
  const value = normalize(
    input,
    'https://example.com',
    'Firefox/1',
    '127.0.0.2',
    'DK',
    'secret',
    env,
    new Date('2026-09-12T12:00:00Z'),
  )!;
  expect(value.visitor).toBe(
    createHmac('sha256', 'secret')
      .update(JSON.stringify([site, '2026-09-12', '127.0.0.2', 'Firefox/1']))
      .digest('hex'),
  );
  expect(value.path).toBe('/pricing');
  expect(units(value)).toBe(100);
  expect(JSON.stringify(value)).not.toContain('private@example.com');
  expect(() =>
    normalize(input, 'https://attacker.com', 'Firefox', 'ip', '', 'secret', env),
  ).toThrow();
  expect(
    normalize(input, 'https://example.com', 'Firefox', 'ip', '', 'secret', {
      ...env,
      tracking_settings: { pageview: false },
    }),
  ).toBeNull();
  expect(() =>
    normalize(input, 'https://example.com', 'Firefox', 'ip', '', 'secret', {
      ...env,
      tracking_mode: 'sessions',
    }),
  ).toThrow();
});
test('request validation rejects extra fields and invalid report ranges', () => {
  expect(() =>
    decode(CreateSite, { name: 'Test', domain: 'example.com', ownerId: 'attacker' }),
  ).toThrow();
  expect(() => dateRange({ from: '2026-02-30', to: '2026-03-01' })).toThrow();
  expect(() => dateRange({ from: '2024-01-01', to: '2026-01-01' })).toThrow();
});

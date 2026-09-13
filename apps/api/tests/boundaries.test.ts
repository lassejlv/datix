import { expect, test } from 'bun:test';
import { zipSync, strToU8 } from 'fflate';
import { csv, parse } from '../src/imports/parse';
import { canonicalFingerprint } from '../src/imports/fingerprint';
import { detect } from '../src/analytics/abuse';
import { createHash, createHmac } from 'node:crypto';
import { acknowledged, verifyWebhook } from '../src/billing/polar';
import { sanitize } from '../src/analytics/diagnostics';

const daily = 'date,visitors,pageviews\n2026-09-01,3,4\n';
test('CSV handles quoting and rejects malformed records and impossible dates', () => {
  expect(csv('name,value\r\n"a,b","c""d"\r\n')).toEqual([
    ['name', 'value'],
    ['a,b', 'c"d'],
  ]);
  expect(() => csv('name\n"unterminated')).toThrow();
  expect(() =>
    parse('plausible', 'imported_visitors.csv', strToU8(daily.replace('2026-09-01', '2026-02-30'))),
  ).toThrow();
});
test('import fingerprints preserve canonical JSON semantics without copying the payload', () => {
  const value = {
    z: [3, undefined, { b: 'two', a: 1 }],
    a: { omitted: undefined, kept: true },
  };

  const canonical = (nested: unknown): unknown => {
    if (Array.isArray(nested)) return nested.map(canonical);
    if (nested && typeof nested === 'object')
      return Object.fromEntries(
        Object.entries(nested)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, canonical(entry)]),
      );

    return nested;
  };

  expect(canonicalFingerprint(value)).toBe(
    createHash('sha256')
      .update(JSON.stringify(canonical(value)))
      .digest('hex'),
  );
});
test('Plausible ZIP preserves counts and removes sensitive path query strings', () => {
  const data = zipSync({
    'imported_visitors.csv': strToU8(daily),
    'imported_pages.csv': strToU8(
      'date,page,pageviews\n2026-09-01,/z?secret=private,2\n2026-09-01,/a,1\n2026-09-01,/z#fragment,2\n',
    ),
  });

  const value = parse('plausible', 'export.zip', data);
  expect(value.days[0]).toEqual({ day: '2026-09-01', pageviews: 4, visitors: 3, custom: 0 });
  expect(value.breakdowns).toEqual([
    { day: '2026-09-01', dimension: 'path', value: '/a', count: 1 },
    { day: '2026-09-01', dimension: 'path', value: '/z', count: 4 },
  ]);
  const corrupt = data.slice();
  const view = new DataView(corrupt.buffer);

  for (let i = 0; i < corrupt.length - 4; i++)
    if (view.getUint32(i, true) === 0x02014b50) {
      corrupt[i + 16] ^= 1;
      break;
    }

  expect(() => parse('plausible', 'export.zip', corrupt)).toThrow();
  expect(() =>
    parse('plausible', 'export.zip', zipSync({ '../imported_visitors.csv': strToU8(daily) })),
  ).toThrow();
});
test('GA4 requires the explicitly supported daily web export', () => {
  expect(
    parse('ga4', 'daily.csv', strToU8('Date,Views,Total users\n20260901,4,3\n')).days[0]?.visitors,
  ).toBe(3);
  expect(() =>
    parse('ga4', 'daily.csv', strToU8('Date,Views,Active users\n20260901,4,3\n')),
  ).toThrow();
});
test('abuse rules preserve repeated-activity limits and monotonic buckets', () => {
  let value = detect(60000, true, 'same');
  for (let i = 1; i < 21; i++) value = detect(60000, true, 'same', value.source, value.traffic);
  expect(value.reason).toBe('repeated_activity');
  const delayed = detect(0, true, 'other', value.source, { start: 9, events: 4, custom: 0 });
  expect(delayed.source.minute).toBe(1);
  expect(delayed.traffic.start).toBe(9);
});
test('billing only removes usage after a complete acknowledgment', () => {
  expect(acknowledged({ inserted: 3, duplicates: 7 }, 10)).toBe(true);
  for (const value of [
    { inserted: 3, duplicates: 6 },
    { inserted: -1, duplicates: 11 },
    { inserted: '10' },
    { inserted: 11 },
    null,
  ])
    expect(acknowledged(value, 10)).toBe(false);
});
test('diagnostics remove URL secrets and email addresses', () => {
  const value = sanitize(
    'Failure at https://example.com/a?token=secret#fragment for person@example.com',
    500,
  );

  expect(value).not.toContain('token');
  expect(value).not.toContain('person@example.com');
  expect(value).toContain('https://example.com/a');
});

test('webhooks authenticate exact bytes and reject stale or forged signatures', async () => {
  const secret = 'whsec_test-polar-secret-kept-as-plain-text';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const id = 'event-123';

  const body = JSON.stringify({
    type: 'customer.deleted',
    timestamp: new Date().toISOString(),
    data: {
      id: '11111111-1111-4111-8111-111111111111',
      created_at: new Date().toISOString(),
      modified_at: null,
      metadata: {},
      external_id: 'datix-user',
      email: 'fixture@example.test',
      email_verified: true,
      type: 'individual',
      name: 'Fixture',
      billing_name: null,
      billing_address: null,
      tax_id: null,
      organization_id: '22222222-2222-4222-8222-222222222222',
      deleted_at: new Date().toISOString(),
      avatar_url: null,
    },
  });

  const signature = createHmac('sha256', secret)
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');

  const headers = new Headers({
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': 'v1,' + signature,
  });

  const event = await verifyWebhook(headers, body, secret);
  expect(event.type).toBe('customer.deleted');
  expect(event.timestamp).toBeInstanceOf(Date);
  await expect(verifyWebhook(headers, body + ' ', secret)).rejects.toThrow();
  await expect(verifyWebhook(headers, body, 'different-secret')).rejects.toThrow();
  headers.set('webhook-timestamp', '1');
  await expect(verifyWebhook(headers, body, secret)).rejects.toThrow();
});

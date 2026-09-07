import { describe, expect, test } from 'bun:test';
import { normalizeRequest } from '../../src/runtime/request.server';

describe('Railway proxy boundary', () => {
  test('ignores spoofed Cloudflare and internal headers on direct requests', () => {
    const request = normalizeRequest(
      new Request('https://analytics.beer/api/collect', {
        headers: {
          'x-real-ip': '198.51.100.7',
          'cf-connecting-ip': '192.0.2.1',
          'cf-ipcountry': 'DK',
          'x-analytics-country': 'DE',
        },
      }),
      '10.0.0.1',
      true,
    );
    expect(request.headers.get('cf-connecting-ip')).toBe('198.51.100.7');
    expect(request.headers.get('x-analytics-country')).toBeNull();
  });
  test('requires an authenticated Cloudflare origin for country and visitor IP', () => {
    for (const peer of ['198.51.100.7', '2001:db8::1']) {
      const request = normalizeRequest(
        new Request('https://analytics.beer', {
          headers: {
            'x-real-ip': peer,
            'cf-connecting-ip': peer,
            'cf-ipcountry': 'DK',
            'x-analytics-origin-key': 'test-origin-secret',
          },
        }),
        '10.0.0.1',
        true,
        'test-origin-secret',
      );
      expect(request.headers.get('cf-connecting-ip')).toBe(peer);
      expect(request.headers.get('x-analytics-country')).toBe('DK');
      expect(request.headers.get('x-analytics-origin-key')).toBeNull();
    }
  });
  test('matching visitor headers and a forged origin key cannot authenticate country', () => {
    const request = normalizeRequest(
      new Request('https://analytics.beer', {
        headers: {
          'x-real-ip': '198.51.100.7',
          'cf-connecting-ip': '198.51.100.7',
          'cf-ipcountry': 'DE',
          'x-analytics-origin-key': 'forged-origin-key',
        },
      }),
      '10.0.0.1',
      true,
      'test-origin-secret',
    );
    expect(request.headers.get('x-analytics-country')).toBeNull();
    expect(request.headers.get('x-analytics-origin-key')).toBeNull();
  });
  test('local development trusts the socket instead of forwarded headers', () => {
    const request = normalizeRequest(
      new Request('http://localhost', {
        headers: {
          'x-real-ip': '172.64.1.1',
          'cf-connecting-ip': '192.0.2.1',
          'cf-ipcountry': 'DK',
        },
      }),
      '127.0.0.1',
      false,
    );
    expect(request.headers.get('cf-connecting-ip')).toBe('127.0.0.1');
    expect(request.headers.get('x-analytics-country')).toBeNull();
  });
});

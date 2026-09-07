import { isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';

function verifiedOrigin(header: string | null, secret: string | undefined) {
  if (!header || !secret) return false;
  const received = Buffer.from(header);
  const expected = Buffer.from(secret);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function normalizeRequest(
  request: Request,
  peer: string,
  railway: boolean,
  cloudflareSecret?: string,
) {
  // Railway resolves X-Real-IP to the visitor even behind Cloudflare. Its value
  // cannot establish which proxy supplied the country header; authenticate the
  // Cloudflare request transform instead. Direct Railway requests ignore it.
  const remote = railway ? (request.headers.get('x-real-ip') ?? peer) : peer;
  const trustedCloudflare =
    railway && verifiedOrigin(request.headers.get('x-analytics-origin-key'), cloudflareSecret);
  const forwarded = request.headers.get('cf-connecting-ip') ?? '';
  const clientIP = trustedCloudflare && isIP(forwarded) ? forwarded : remote;
  const country = trustedCloudflare ? (request.headers.get('cf-ipcountry') ?? '') : '';
  const headers = new Headers(request.headers);
  headers.set('cf-connecting-ip', isIP(clientIP) ? clientIP : 'unknown');
  headers.delete('x-analytics-origin-key');
  headers.delete('cf-ipcountry');
  headers.delete('x-analytics-country');
  if (/^[A-Z]{2}$/.test(country) && !['XX', 'T1'].includes(country))
    headers.set('x-analytics-country', country);
  return new Request(request, { headers });
}

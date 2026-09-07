import { HttpError } from './http';

export async function hash(secret: string, input: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(input));
  return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function pageUrl(
  value: string,
  domain: string,
  origin: string | null,
  allowLocalhost = false,
) {
  const url = new URL(value);
  const local = allowLocalhost && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.hostname !== domain && !local) ||
    url.origin !== origin
  )
    throw new HttpError(
      403,
      'invalid_site_origin',
      'The event URL and Origin must match an allowed host for this website.',
    );
  if (url.pathname.length > 2048)
    throw new HttpError(
      400,
      'invalid_path',
      'The encoded URL path must be at most 2048 characters.',
    );
  return url.pathname;
}

export function referrerHost(value?: string) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname.length <= 253
      ? url.hostname
      : '';
  } catch {
    return '';
  }
}
export function deviceType(ua: string) {
  return /ipad|tablet/i.test(ua)
    ? 'tablet'
    : /mobile|iphone|android/i.test(ua)
      ? 'mobile'
      : 'desktop';
}
export function isBot(ua: string) {
  return /bot\b|crawler|spider|headless|lighthouse|pagespeed|pingdom/i.test(ua);
}

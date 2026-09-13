import { Polar } from '@polar-sh/sdk';
import { HTTPClient } from '@polar-sh/sdk/lib/http';
import { ResourceNotFound } from '@polar-sh/sdk/models/errors/resourcenotfound';
import { ApiError } from '../shared/errors';
import catalog from './catalog';

export const unconfigured = () =>
  new ApiError({
    status: 503,
    code: 'billing_unconfigured',
    message: 'Billing is temporarily unavailable.',
  });

export function polarClient() {
  if (process.env.EXTERNAL_EFFECTS !== 'enabled' || !process.env.POLAR_ACCESS_TOKEN)
    throw unconfigured();

  const base = process.env.POLAR_API_URL ?? 'https://api.polar.sh';
  if (
    !['https://api.polar.sh', 'https://sandbox-api.polar.sh'].includes(base) ||
    (base === 'https://sandbox-api.polar.sh') !== !!process.env.POLAR_SANDBOX_IDS
  )
    throw unconfigured();

  const httpClient = new HTTPClient();
  httpClient.addHook('beforeRequest', (request) => {
    request.headers.set('Polar-Version', catalog.apiVersion);
  });

  return new Polar({
    accessToken: process.env.POLAR_ACCESS_TOKEN,
    server: base === 'https://sandbox-api.polar.sh' ? 'sandbox' : 'production',
    timeoutMs: 10000,
    // Durable outbox retries own delivery; do not retry checkout creation implicitly.
    retryConfig: { strategy: 'none' },
    httpClient,
  });
}

export async function optionalResource<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof ResourceNotFound) return null;
    throw error;
  }
}

import { afterEach, expect, spyOn, test } from 'bun:test';
import { optionalResource, polarClient } from '../src/billing/client';
import catalog from '../src/billing/catalog';

const keys = [
  'EXTERNAL_EFFECTS',
  'POLAR_ACCESS_TOKEN',
  'POLAR_API_URL',
  'POLAR_SANDBOX_IDS',
] as const;

const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
let fetchMock: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;

afterEach(() => {
  fetchMock?.mockRestore();

  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

function configured() {
  process.env.EXTERNAL_EFFECTS = 'enabled';
  process.env.POLAR_ACCESS_TOKEN = 'test-token';
  delete process.env.POLAR_API_URL;
  delete process.env.POLAR_SANDBOX_IDS;
}

test('Polar SDK serializes usage IDs and dates, pins the API version, and reads acknowledgments', async () => {
  configured();
  let sent: Request | undefined;
  fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL) => {
        sent = input as Request;

        return Response.json({ inserted: 0, duplicates: 1 });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  const result = await (
    await polarClient()
  ).events.ingest({
    events: [
      {
        externalId: 'datix-usage-stable-id',
        externalCustomerId: 'owner-id',
        name: catalog.meter.eventName,
        timestamp: new Date('2026-09-13T12:00:00Z'),
        metadata: { quantity: 3 },
      },
    ],
  });

  expect(result).toEqual({ inserted: 0, duplicates: 1 });
  expect(sent!.url).toBe('https://api.polar.sh/v1/events/ingest');
  expect(sent!.headers.get('authorization')).toBe('Bearer test-token');
  expect(sent!.headers.get('Polar-Version')).toBe(catalog.apiVersion);
  expect(await sent!.json()).toEqual({
    events: [
      {
        external_id: 'datix-usage-stable-id',
        external_customer_id: 'owner-id',
        name: catalog.meter.eventName,
        timestamp: '2026-09-13T12:00:00.000Z',
        metadata: { quantity: 3 },
      },
    ],
  });
});

test('only typed missing resources become null; provider failures are not retried or treated as absence', async () => {
  configured();
  fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ error: 'ResourceNotFound', detail: 'Missing' }, { status: 404 }),
  );
  expect(
    await optionalResource(
      (await polarClient()).customers.getStateExternal({ externalId: 'missing' }),
    ),
  ).toBeNull();
  fetchMock.mockResolvedValue(Response.json({ detail: 'Unavailable' }, { status: 503 }));
  await expect(
    optionalResource((await polarClient()).customers.getStateExternal({ externalId: 'owner' })),
  ).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('external effects and sandbox mapping gates are enforced before any Polar request', async () => {
  configured();
  process.env.EXTERNAL_EFFECTS = 'disabled';
  await expect(polarClient()).rejects.toThrow();
  process.env.EXTERNAL_EFFECTS = 'enabled';
  process.env.POLAR_API_URL = 'https://sandbox-api.polar.sh';
  await expect(polarClient()).rejects.toThrow();
  process.env.POLAR_API_URL = 'https://untrusted.example';
  await expect(polarClient()).rejects.toThrow();
});

test('Polar SDK validates customer state and converts provider dates and names', async () => {
  configured();
  fetchMock = spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      id: '11111111-1111-4111-8111-111111111111',
      created_at: '2026-09-13T12:00:00Z',
      modified_at: null,
      metadata: {},
      external_id: 'owner-id',
      email: 'fixture@example.test',
      email_verified: true,
      type: 'individual',
      name: 'Fixture',
      billing_name: null,
      billing_address: null,
      tax_id: null,
      organization_id: catalog.organizationId,
      deleted_at: null,
      avatar_url: null,
      active_subscriptions: [],
      granted_benefits: [],
      active_meters: [],
    }),
  );
  const state = await (await polarClient()).customers.getStateExternal({ externalId: 'owner-id' });
  expect(state.externalId).toBe('owner-id');
  expect(state.organizationId).toBe(catalog.organizationId);
  expect(state.createdAt.toISOString()).toBe('2026-09-13T12:00:00.000Z');
  expect(state.activeSubscriptions).toEqual([]);
  fetchMock.mockResolvedValue(Response.json({ id: state.id }));
  await expect(
    (await polarClient()).customers.getStateExternal({ externalId: 'owner-id' }),
  ).rejects.toThrow();
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client } from 'pg';
import { api } from '../../src/api/router.server';
import {
  customerState,
  polarTestSecret,
  signedWebhook,
  trialSubscription,
} from '../fixtures/polar';

const connectionString = process.env.TEST_DATABASE_URL;
if (
  !connectionString ||
  new URL(connectionString).hostname !== process.env.TEST_DATABASE_HOST ||
  new URL(connectionString).hostname === new URL(process.env.DATABASE_URL!).hostname
)
  throw new Error('Use the isolated Neon test branch.');
const client = new Client({ connectionString });
const prefix = `polar-${crypto.randomUUID()}`;
const ownerId = prefix;
const ids: string[] = [];
const env = {
  APP_URL: 'http://localhost:3000',
  POLAR_WEBHOOK_SECRET: polarTestSecret,
  HYPERDRIVE: { connectionString },
} as unknown as Env;
const send = (
  payload: unknown,
  id = `${prefix}-${crypto.randomUUID()}`,
  overrides: Record<string, string> = {},
  requestEnv = env,
) => {
  ids.push(id);
  const body = JSON.stringify(payload);
  return api(
    new Request(`${env.APP_URL}/api/webhooks/polar`, {
      method: 'POST',
      body,
      headers: { ...signedWebhook(body, id), ...overrides },
    }),
    requestEnv,
  );
};
const state = async (customerId: string) =>
  (await client.query('select * from billing_customers where customer_id = $1', [customerId]))
    .rows[0];
beforeAll(async () => {
  await client.connect();
  await client.query(
    'insert into "user" (id, name, email, created_at, updated_at) values ($1, $2, $3, now(), now())',
    [ownerId, 'Webhook QA', `${prefix}@example.com`],
  );
});
afterAll(async () => {
  await client.query('delete from billing_webhook_events where id = any($1::text[])', [ids]);
  await client.query('delete from billing_customers where customer_id like $1', [`${prefix}%`]);
  await client.query('delete from "user" where id = $1', [ownerId]);
  await client.end();
});

describe('Polar webhooks', () => {
  test('requires POST, a configured secret, a fresh signature, and exact signed bytes', async () => {
    expect((await api(new Request(`${env.APP_URL}/api/webhooks/polar`), env)).status).toBe(405);
    const payload = customerState(`${prefix}-invalid`, ownerId);
    expect(
      (await send(payload, undefined, {}, { ...env, POLAR_WEBHOOK_SECRET: undefined })).status,
    ).toBe(503);
    expect((await send(payload, undefined, { 'webhook-signature': 'v1,invalid' })).status).toBe(
      403,
    );
    expect((await send(payload, undefined, { 'webhook-timestamp': '1' })).status).toBe(403);
    const body = JSON.stringify(payload);
    const signed = signedWebhook(body);
    expect(
      (
        await api(
          new Request(`${env.APP_URL}/api/webhooks/polar`, {
            method: 'POST',
            body: body + ' ',
            headers: signed,
          }),
          env,
        )
      ).status,
    ).toBe(403);
    expect(await state(payload.data.id)).toBeUndefined();
  });

  test('persists trial state once under concurrent retries without storing email or raw payload', async () => {
    const payload = customerState(`${prefix}-trial`, ownerId);
    payload.data.active_subscriptions = [trialSubscription()];
    const eventId = `${prefix}-duplicate`;
    const responses = await Promise.all([send(payload, eventId), send(payload, eventId)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const results = await Promise.all(responses.map((r) => r.json() as Promise<any>));
    expect(results.filter((r) => r.duplicate)).toHaveLength(1);
    const saved = await state(payload.data.id);
    expect(saved.owner_id).toBe(ownerId);
    expect(saved.subscriptions[0].status).toBe('trialing');
    expect(saved.subscriptions[0].trialEnd).toBe(payload.data.active_subscriptions[0]!.trial_end);
    expect(JSON.stringify(saved)).not.toContain(payload.data.email);
    expect(JSON.stringify(saved)).not.toContain('billing_address');
    expect(
      (
        await client.query('select count(*)::int as n from billing_webhook_events where id=$1', [
          eventId,
        ])
      ).rows[0].n,
    ).toBe(1);
  });

  test('ignores older snapshots including sub-millisecond timestamps, then clears ended subscriptions', async () => {
    const payload = customerState(`${prefix}-ordering`, ownerId, '2026-09-07T09:00:00.000002Z');
    payload.data.active_subscriptions = [trialSubscription()];
    expect((await send(payload)).status).toBe(200);
    const older = customerState(payload.data.id, ownerId, '2026-09-07T09:00:00.000001Z');
    expect(await (await send(older)).json()).toMatchObject({ applied: false });
    expect((await state(payload.data.id)).subscriptions).toHaveLength(1);
    const ended = customerState(payload.data.id, ownerId, '2026-09-07T09:00:00.000003Z');
    expect((await send(ended)).status).toBe(200);
    expect((await state(payload.data.id)).subscriptions).toEqual([]);
  });

  test('retains cancellation until the period ends and clears deleted customers', async () => {
    const payload = customerState(`${prefix}-deleted`, ownerId, '2026-09-07T09:00:00Z');
    const subscription = trialSubscription();
    subscription.cancel_at_period_end = true;
    payload.data.active_subscriptions = [subscription];
    expect((await send(payload)).status).toBe(200);
    expect((await state(payload.data.id)).subscriptions[0].cancelAtPeriodEnd).toBe(true);
    payload.timestamp = '2026-09-07T10:00:00Z';
    payload.data.deleted_at = payload.timestamp;
    expect((await send({ ...payload, type: 'customer.deleted' })).status).toBe(200);
    expect(await state(payload.data.id)).toMatchObject({
      deleted: true,
      owner_id: null,
      subscriptions: [],
    });
  });

  test('rejects another organization and never links by email', async () => {
    const payload = customerState(`${prefix}-unknown`, null);
    payload.data.email = `${prefix}@example.com`;
    expect((await send(payload)).status).toBe(200);
    expect((await state(payload.data.id)).owner_id).toBeNull();
    payload.data.organization_id = crypto.randomUUID();
    expect((await send(payload)).status).toBe(403);
  });

  test('returns retryable failure on unavailable storage, then accepts the retry', async () => {
    const payload = customerState(`${prefix}-retry`, ownerId);
    const id = `${prefix}-storage`;
    const response = await send(payload, id, {}, {
      ...env,
      HYPERDRIVE: { connectionString: 'postgres://invalid:invalid@127.0.0.1:1/invalid' },
    } as unknown as Env);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(
      (await client.query('select id from billing_webhook_events where id=$1', [id])).rows,
    ).toHaveLength(0);
    expect((await send(payload, id)).status).toBe(200);
  });

  test('rejects malformed signed payloads and oversized streamed bodies', async () => {
    expect((await send({ type: 'customer.state_changed', data: {} })).status).toBe(400);
    const body = 'x'.repeat(256 * 1024 + 1);
    const response = await api(
      new Request(`${env.APP_URL}/api/webhooks/polar`, { method: 'POST', body }),
      env,
    );
    expect(response.status).toBe(413);
  });
});

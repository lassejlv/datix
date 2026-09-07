import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { Client } from 'pg';
import { customerState, signedWebhook, trialSubscription } from '../tests/fixtures/polar';

const secretFile = process.env.POLAR_WEBHOOK_SECRET_FILE;
if (!secretFile)
  throw new Error('Set POLAR_WEBHOOK_SECRET_FILE to the protected signing-secret file.');
const secret = (await readFile(secretFile, 'utf8')).trim();
const connectionString = process.env.PRODUCTION_DATABASE_URL;
if (
  !connectionString ||
  new URL(connectionString).hostname !== process.env.PRODUCTION_DATABASE_HOST
)
  throw new Error('Set the explicit production database hostname.');
const client = new Client({ connectionString });
const endpoint = 'https://analytics.beer/api/webhooks/polar';
const prefix = `webhook-qa-${crypto.randomUUID()}`;
const customerId = crypto.randomUUID();
const eventIds: string[] = [];
const deliver = async (payload: unknown, id = `${prefix}-${eventIds.length}`, invalid = false) => {
  eventIds.push(id);
  const body = JSON.stringify(payload);
  const headers = signedWebhook(body, id, secret);
  if (invalid) headers['webhook-signature'] = 'v1,invalid';
  const response = await fetch(endpoint, { method: 'POST', headers, body });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};
await client.connect();
try {
  assert.equal((await fetch(endpoint)).status, 405);
  const payload = customerState(customerId, null);
  payload.data.active_subscriptions = [trialSubscription()];
  const valid = await deliver(payload);
  assert.equal(valid.status, 200);
  assert.equal(valid.body.applied, true);
  const duplicate = await deliver(payload, eventIds[0]);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  const older = await deliver(
    customerState(customerId, null, new Date(Date.now() - 60000).toISOString()),
  );
  assert.equal(older.status, 200);
  assert.equal(older.body.applied, false);
  const saved = (
    await client.query('select * from billing_customers where customer_id=$1', [customerId])
  ).rows[0];
  assert.equal(saved.owner_id, null);
  assert.equal(saved.subscriptions[0].status, 'trialing');
  assert.equal(JSON.stringify(saved).includes('webhook-fixture@example.com'), false);
  assert.equal((await deliver(payload, undefined, true)).status, 403);
  payload.timestamp = new Date().toISOString();
  payload.data.deleted_at = payload.timestamp;
  const deleted = await deliver({ ...payload, type: 'customer.deleted' });
  assert.equal(deleted.status, 200);
  const final = (
    await client.query('select * from billing_customers where customer_id=$1', [customerId])
  ).rows[0];
  assert.equal(final.deleted, true);
  assert.deepEqual(final.subscriptions, []);
  const result = {
    endpoint,
    verifiedAt: new Date().toISOString(),
    signatureValidation: 'passed',
    durableState: 'passed',
    duplicateDelivery: 'passed',
    olderDelivery: 'passed',
    deletion: 'passed',
    source:
      'Locally signed disposable fixture sent to the live Worker; no Polar customer or purchase created.',
  };
  await mkdir('artifacts/polar', { recursive: true });
  await writeFile('artifacts/polar/webhook-production.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await client.query('delete from billing_webhook_events where id=any($1::text[])', [eventIds]);
  await client.query('delete from billing_customers where customer_id=$1', [customerId]);
  await client.end();
}

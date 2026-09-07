import { Webhook } from 'standardwebhooks';

export const polarTestSecret = 'polar-webhook-integration-test-secret';

export function customerState(
  customerId: string,
  externalId: string | null,
  timestamp = new Date().toISOString(),
) {
  return {
    type: 'customer.state_changed',
    timestamp,
    data: {
      id: customerId,
      type: 'individual',
      created_at: timestamp,
      modified_at: timestamp,
      metadata: {},
      external_id: externalId,
      email: 'webhook-fixture@example.com',
      email_verified: false,
      name: null,
      billing_name: null,
      billing_address: null,
      tax_id: null,
      organization_id: '4f109880-3be1-48f8-a8b2-bea2f101634f',
      deleted_at: null as string | null,
      avatar_url: null,
      active_subscriptions: [] as ReturnType<typeof trialSubscription>[],
      granted_benefits: [],
      active_meters: [],
    },
  };
}

export function trialSubscription() {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    created_at: now,
    modified_at: now,
    metadata: {},
    status: 'trialing',
    amount: 900,
    currency: 'usd',
    recurring_interval: 'month',
    current_period_start: now,
    current_period_end: new Date(Date.now() + 14 * 86400000).toISOString(),
    trial_start: now,
    trial_end: new Date(Date.now() + 14 * 86400000).toISOString(),
    cancel_at_period_end: false,
    canceled_at: null,
    started_at: now,
    ends_at: null,
    product_id: '19e7f3f6-aaaa-4000-8000-000000000000',
    discount_id: null,
    meters: [],
  };
}

export function signedWebhook(
  body: string,
  id: string = crypto.randomUUID(),
  secret = polarTestSecret,
  timestamp = new Date(),
) {
  return {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
    'webhook-signature': new Webhook(Buffer.from(secret).toString('base64')).sign(
      id,
      timestamp,
      body,
    ),
  };
}

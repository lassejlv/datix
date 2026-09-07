import type { Client } from 'pg';
import type { BillingSubscription } from '../../src/billing/types';
import catalog from '../../../config/polar-catalog.json';

export const testProId = 'a0de3cc9-ea92-4e95-b23e-b8d9240685aa';
export const testLargerProId = '6821b12a-ddc7-449c-8348-8d80d1b24c23';
export const testAnnualProId = catalog.products.find(
  (product) =>
    product.metadata.plan === 'pro' &&
    product.metadata.monthly_events === 100000 &&
    product.recurring_interval === 'year',
)!.id;

/** Disposable database fixture only; this does not create a Polar subscription. */
export async function seedPro(
  client: Client,
  ownerId: string,
  overrides: Partial<BillingSubscription> = {},
) {
  const now = new Date();
  const subscription: BillingSubscription = {
    id: crypto.randomUUID(),
    productId: testAnnualProId,
    status: 'active',
    currentPeriodStart: new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1)).toISOString(),
    currentPeriodEnd: new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1)).toISOString(),
    trialEnd: null,
    cancelAtPeriodEnd: false,
    endsAt: null,
    ...overrides,
  };
  await client.query(
    `insert into billing_customers (customer_id, owner_id, subscriptions, occurred_at) values ($1,$2,$3,now())
    on conflict (customer_id) do update set owner_id=excluded.owner_id, subscriptions=excluded.subscriptions, deleted=false, occurred_at=excluded.occurred_at`,
    [`qa-billing-${ownerId}`, ownerId, JSON.stringify([subscription])],
  );
  return subscription;
}

export async function cleanupPro(client: Client, ownerIds: string[]) {
  await client.query('delete from billing_customers where customer_id=any($1::text[])', [
    ownerIds.map((id) => `qa-billing-${id}`),
  ]);
}

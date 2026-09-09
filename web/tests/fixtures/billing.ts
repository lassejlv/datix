import type { Client } from 'pg';
import type { BillingSubscription } from '../../src/billing/types';
export const testProId = 'basic';
export const testLargerProId = 'pro';
export const testAnnualProId = 'basic_annual';

/** Disposable database fixture only; this does not create an Autumn subscription. */
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
    `insert into billing_customers (customer_id, owner_id, subscriptions, occurred_at, provider) values ($1,$2,$3,now(),'autumn')
    on conflict (customer_id) do update set owner_id=excluded.owner_id, subscriptions=excluded.subscriptions, deleted=false, occurred_at=excluded.occurred_at, updated_at=now()`,
    [`qa-billing-${ownerId}`, ownerId, JSON.stringify([subscription])],
  );
  return subscription;
}

export async function cleanupPro(client: Client, ownerIds: string[]) {
  await client.query('delete from billing_customers where customer_id=any($1::text[])', [
    ownerIds.map((id) => `qa-billing-${id}`),
  ]);
}

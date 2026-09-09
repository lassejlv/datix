import type { Client } from 'pg';
import type { BillingSubscription } from '../../src/billing/types';
import catalog from '../../../config/polar-catalog.json';
export const testProId = catalog.plans.find((p) => p.id === 'basic')!.productId;
export const testLargerProId = catalog.plans.find((p) => p.id === 'pro')!.productId;
export const testAnnualProId = catalog.plans.find((p) => p.id === 'basic_annual')!.productId;

/** Disposable database fixture only; this does not create a Polar subscription. */
export async function seedPro(
  client: Client,
  ownerId: string,
  overrides: Partial<BillingSubscription> = {},
) {
  const now = new Date();
  const subscription: BillingSubscription = {
    id: crypto.randomUUID(),
    productId: testProId,
    status: 'active',
    currentPeriodStart: new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1)).toISOString(),
    currentPeriodEnd: new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1)).toISOString(),
    trialEnd: null,
    cancelAtPeriodEnd: false,
    endsAt: null,
    entitlements: {
      name: 'Basic',
      eventLimit: 10000000,
      websiteLimit: 10,
      used: 0,
      remaining: 10000000,
      localBaseline: 0,
      pending: 0,
      periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
      periodEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
    },
    ...overrides,
  };
  await client.query(
    `insert into billing_customers (customer_id, owner_id, subscriptions, occurred_at, provider, organization_id) values ($1,$2,$3,now(),'polar',$4)
    on conflict (customer_id) do update set owner_id=excluded.owner_id, subscriptions=excluded.subscriptions, deleted=false, occurred_at=excluded.occurred_at, updated_at=now()`,
    [`qa-billing-${ownerId}`, ownerId, JSON.stringify([subscription]), catalog.organizationId],
  );
  return subscription;
}

export async function cleanupPro(client: Client, ownerIds: string[]) {
  await client.query('delete from billing_customers where customer_id=any($1::text[])', [
    ownerIds.map((id) => `qa-billing-${id}`),
  ]);
}

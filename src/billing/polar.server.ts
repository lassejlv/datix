import type { AppEnv } from '../runtime/types';
import { Polar } from '@polar-sh/sdk';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import catalog from '../../config/polar-catalog.json';
import type { Database } from '../db/client.server';
import { billingCheckouts, billingCustomers, user } from '../db/schema';
import { HttpError, parse, readJson, json } from '../lib/http';
import { POLAR_ORGANIZATION_ID } from './webhook.server';
import { accountUsage } from './usage.server';

export function polarClient(env: Pick<AppEnv, 'POLAR_ACCESS_TOKEN'>) {
  if (!env.POLAR_ACCESS_TOKEN)
    throw new HttpError(503, 'billing_unconfigured', 'Billing is temporarily unavailable.');
  return new Polar({
    accessToken: env.POLAR_ACCESS_TOKEN,
    timeoutMs: 8000,
    retryConfig: { strategy: 'none' },
  });
}
const monthly = catalog.products.filter(
  (p) => p.metadata.plan === 'pro' && p.recurring_interval === 'month' && !p.is_archived,
);
const selection = z
  .object({
    events: z.number().int(),
    interval: z.literal('month'),
    locale: z.enum(['en', 'da', 'de']).optional(),
  })
  .strict();
export const checkoutSelection = (input: unknown) => {
  const value = parse(selection, input);
  const product = monthly.find((p) => p.metadata.monthly_events === value.events);
  if (!product) throw new HttpError(400, 'invalid_plan', 'Select an available monthly plan.');
  return {
    productId: product.id,
    locale: value.locale ?? 'en',
    allowTrial: value.events === 100000,
  };
};
const missing = (error: unknown) =>
  typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 404;

export async function syncCustomer(db: Database, ownerId: string, polar: Polar) {
  const occurredAt = new Date().toISOString();
  let state;
  try {
    state = await polar.customers.getStateExternal({ externalId: ownerId });
  } catch (error) {
    if (missing(error)) {
      await db
        .update(billingCustomers)
        .set({ deleted: true, subscriptions: [], occurredAt, updatedAt: new Date() })
        .where(
          and(
            eq(billingCustomers.ownerId, ownerId),
            sql`${billingCustomers.occurredAt} < ${occurredAt}::timestamptz`,
          ),
        );
      return null;
    }
    throw error;
  }
  if (state.organizationId !== POLAR_ORGANIZATION_ID || state.externalId !== ownerId)
    throw new HttpError(502, 'invalid_billing_customer', 'Billing customer could not be verified.');
  const snapshot = {
    customerId: state.id,
    ownerId,
    deleted: state.deletedAt !== null,
    occurredAt,
    updatedAt: new Date(),
    subscriptions: state.deletedAt
      ? []
      : state.activeSubscriptions.map((s) => ({
          id: s.id,
          productId: s.productId,
          status: s.status,
          currentPeriodStart: s.currentPeriodStart.toISOString(),
          currentPeriodEnd: s.currentPeriodEnd.toISOString(),
          trialEnd: s.trialEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: s.cancelAtPeriodEnd,
          endsAt: s.endsAt?.toISOString() ?? null,
        })),
  };
  await db
    .insert(billingCustomers)
    .values(snapshot)
    .onConflictDoUpdate({
      target: billingCustomers.customerId,
      set: snapshot,
      // A webhook received while the API request was in flight remains authoritative.
      setWhere: sql`${billingCustomers.occurredAt} < ${occurredAt}::timestamptz`,
    });
  return state;
}

export async function billingApi(
  request: Request,
  db: Database,
  env: AppEnv,
  owner: { id: string; email: string; name: string },
  polar = polarClient(env),
) {
  const path = new URL(request.url).pathname;
  if (path === '/api/billing' && request.method === 'GET') {
    const rows = await db
      .select({ id: billingCustomers.customerId })
      .from(billingCustomers)
      .where(and(eq(billingCustomers.ownerId, owner.id), eq(billingCustomers.deleted, false)))
      .limit(1);
    return json({ hasCustomer: rows.length > 0 });
  }
  if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST.');
  if (path === '/api/billing/sync') {
    await syncCustomer(db, owner.id, polar);
    return json(await accountUsage(db, owner.id));
  }
  if (path === '/api/billing/portal') {
    const state = await syncCustomer(db, owner.id, polar);
    if (!state || state.deletedAt)
      throw new HttpError(404, 'no_billing_customer', 'Start a plan before opening billing.');
    const session = await polar.customerSessions.create({
      externalCustomerId: owner.id,
      returnUrl: `${env.APP_URL}/usage`,
    });
    return json({ url: session.customerPortalUrl });
  }
  if (path !== '/api/billing/checkout')
    throw new HttpError(404, 'not_found', 'Endpoint not found.');
  const plan = checkoutSelection(await readJson(request));
  // Serialize attempts and reuse an open checkout for the selected plan.
  return db.transaction(async (tx) => {
    await tx.select({ id: user.id }).from(user).where(eq(user.id, owner.id)).for('update');
    const state = await syncCustomer(tx as unknown as Database, owner.id, polar);
    if (state?.activeSubscriptions.length) {
      const portal = await polar.customerSessions.create({
        externalCustomerId: owner.id,
        returnUrl: `${env.APP_URL}/usage`,
      });
      return json({ url: portal.customerPortalUrl });
    }
    const [saved] = await tx
      .select()
      .from(billingCheckouts)
      .where(eq(billingCheckouts.ownerId, owner.id));
    if (saved) {
      let current;
      try {
        current = await polar.checkouts.get({ id: saved.checkoutId });
      } catch (error) {
        if (!missing(error)) throw error;
      }
      if (
        current &&
        current.organizationId === POLAR_ORGANIZATION_ID &&
        current.externalCustomerId === owner.id
      ) {
        if (
          (current.status === 'confirmed' || current.status === 'succeeded') &&
          Date.now() - current.createdAt.getTime() < 300000
        )
          throw new HttpError(
            409,
            'billing_pending',
            'Your checkout is being activated. Return to Usage and refresh shortly.',
          );
        if (
          current.status === 'open' &&
          current.expiresAt > new Date() &&
          current.products.length === 1 &&
          current.productId === plan.productId
        ) {
          if (!plan.allowTrial && current.allowTrial !== false)
            current = await polar.checkouts.update({
              id: current.id,
              checkoutUpdate: { allowTrial: false },
            });
          return json({ url: current.url });
        }
      }
    }
    const recovered = await polar.checkouts.list({
      externalCustomerId: owner.id,
      organizationId: POLAR_ORGANIZATION_ID,
      status: 'open',
      limit: 100,
    });
    const open = recovered.result.items.find(
      (c) =>
        c.expiresAt > new Date() &&
        c.externalCustomerId === owner.id &&
        c.organizationId === POLAR_ORGANIZATION_ID &&
        c.products.length === 1 &&
        c.productId === plan.productId,
    );
    if (open) {
      await tx
        .insert(billingCheckouts)
        .values({ ownerId: owner.id, checkoutId: open.id })
        .onConflictDoUpdate({ target: billingCheckouts.ownerId, set: { checkoutId: open.id } });
      const verified =
        !plan.allowTrial && open.allowTrial !== false
          ? await polar.checkouts.update({ id: open.id, checkoutUpdate: { allowTrial: false } })
          : open;
      return json({ url: verified.url });
    }
    const product = await polar.products.get({ id: plan.productId });
    if (
      product.organizationId !== POLAR_ORGANIZATION_ID ||
      product.isArchived ||
      product.visibility === 'draft'
    )
      throw new HttpError(409, 'plan_unavailable', 'This plan is not available yet.');
    // Create the immutable customer mapping before checkout so provider-side recovery
    // can find open sessions by external customer ID even before payment.
    const customer =
      state ??
      (await polar.customers.create({
        externalId: owner.id,
        email: owner.email,
        name: owner.name,
      }));
    const checkout = await polar.checkouts.create({
      products: [plan.productId],
      allowTrial: plan.allowTrial,
      customerId: customer.id,
      externalCustomerId: owner.id,
      customerEmail: owner.email,
      customerName: owner.name,
      successUrl: `${env.APP_URL}/usage?checkout_id={CHECKOUT_ID}`,
      returnUrl: `${env.APP_URL}/usage`,
      locale: plan.locale,
    });
    await tx
      .insert(billingCheckouts)
      .values({ ownerId: owner.id, checkoutId: checkout.id })
      .onConflictDoUpdate({ target: billingCheckouts.ownerId, set: { checkoutId: checkout.id } });
    return json({ url: checkout.url });
  });
}

import { Effect, Schema, Clock } from 'effect';
import { validateEvent, WebhookVerificationError } from '@polar-sh/sdk/webhooks';
import type { Customer } from '@polar-sh/sdk/models/components/customer';
import type { PresentmentCurrency } from '@polar-sh/sdk/models/components/presentmentcurrency';
import type { CustomerState } from '@polar-sh/sdk/models/components/customerstate';
import { polarClient, optionalResource, unconfigured } from './client';
import { Infrastructure, type Resources } from '../platform/resources';
import { attempt, ApiError, invalid, unavailable, attemptSync } from '../shared/errors';
import { decode } from '../shared/validation';
import { usage } from './service';
import catalog from './catalog';

function verifyCustomer<T extends Customer | CustomerState>(customer: T, owner: string): T {
  if (customer.externalId !== owner || customer.organizationId !== catalog.organizationId)
    throw new ApiError({
      status: 502,
      code: 'invalid_billing_customer',
      message: 'Billing customer could not be verified.',
    });

  return customer;
}

function subscriptions(customer: CustomerState) {
  if (customer.deletedAt) return [];
  if (!customer.activeSubscriptions || !customer.grantedBenefits) throw unavailable();

  const grant = (id: string, type: string) =>
    customer.grantedBenefits!.find((g) => g.benefitId === id && g.benefitType === type);

  const websites = grant(catalog.websitesBenefitId, 'custom')?.benefitMetadata?.included;
  if (
    !grant(catalog.analyticsBenefitId, 'custom') ||
    typeof websites !== 'number' ||
    !Number.isSafeInteger(websites) ||
    websites < 0
  )
    return [];

  return customer.activeSubscriptions.flatMap((row) => {
    const plan = catalog.plans.find((p) => p.productId === row.productId);
    if (
      !plan ||
      !plan.checkoutEnabled ||
      row.currency !== catalog.currency ||
      row.recurringInterval !== plan.interval ||
      !['active', 'trialing'].includes(row.status)
    )
      return [];

    const properties = grant(plan.eventsBenefitId, 'meter_credit')?.properties as
      | Record<string, unknown>
      | undefined;

    if (!properties) return [];

    const count =
      Object.keys(properties).length === 0
        ? plan.events
        : properties.last_credited_meter_id === catalog.meter.id
          ? properties.last_credited_units
          : null;

    const limit = typeof count === 'number' ? count * 100 : 0,
      start = row.currentPeriodStart.getTime(),
      end = row.currentPeriodEnd.getTime();

    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      !(Date.now() >= start && Date.now() < end) ||
      (row.status === 'trialing' && !row.trialEnd)
    )
      return [];

    return [
      {
        id: row.id,
        productId: row.productId,
        status: row.status,
        currentPeriodStart: row.currentPeriodStart.toISOString(),
        currentPeriodEnd: row.currentPeriodEnd.toISOString(),
        trialEnd: row.trialEnd?.toISOString() ?? null,
        endsAt: row.endsAt?.toISOString() ?? null,
        cancelAtPeriodEnd: row.cancelAtPeriodEnd,
        entitlements: {
          name: plan.name,
          eventLimit: limit,
          websiteLimit: websites,
          used: 0,
          remaining: limit,
          localBaseline: 0,
          pending: 0,
          periodStart: row.currentPeriodStart.toISOString(),
          periodEnd: row.currentPeriodEnd.toISOString(),
        },
      },
    ];
  });
}

async function save(
  db: Bun.SQL | Bun.TransactionSQL,
  owner: string,
  customer: CustomerState | null,
  at: string,
) {
  const subs = customer ? subscriptions(customer) : [],
    deleted = !customer || !!customer.deletedAt;

  const rows =
    await db`INSERT INTO billing_customers(customer_id,owner_id,subscriptions,deleted,occurred_at,updated_at,provider,organization_id,sync_attempted_at) VALUES(${`polar:${catalog.organizationId}:${owner}`},${owner},${JSON.stringify(subs)}::text::jsonb,${deleted},${at},now(),'polar',${catalog.organizationId}::uuid,now()) ON CONFLICT(customer_id) DO UPDATE SET subscriptions=excluded.subscriptions,deleted=excluded.deleted,occurred_at=excluded.occurred_at,updated_at=excluded.updated_at,sync_attempted_at=excluded.sync_attempted_at WHERE billing_customers.provider='polar' AND billing_customers.organization_id=excluded.organization_id AND billing_customers.owner_id=excluded.owner_id AND billing_customers.occurred_at<excluded.occurred_at RETURNING customer_id`;

  return rows.length > 0;
}

async function sync(r: Resources, owner: string) {
  return r.primary.begin(async (tx) => {
    await tx`SELECT id FROM "user" WHERE id=${owner} FOR UPDATE`;

    const at = new Date().toISOString(),
      value = await optionalResource(
        polarClient().customers.getStateExternal({ externalId: owner }),
      ),
      customer = value ? verifyCustomer(value, owner) : null;

    await save(tx, owner, customer, at);

    return customer?.deletedAt ? null : customer;
  });
}

async function portal(r: Resources, customer: string) {
  const response = await polarClient().customerSessions.create({
    customerId: customer,
    returnUrl: r.config.appUrl + '/dashboard',
  });

  if (response?.customerId !== customer || typeof response.customerPortalUrl !== 'string')
    throw unavailable();

  return { url: response.customerPortalUrl };
}

async function hasSubscription(customer: string, includeCanceling: boolean) {
  for (let page = 1; page <= 100; page++) {
    const response = await polarClient().subscriptions.list({
      customerId: customer,
      organizationId: catalog.organizationId,
      limit: 100,
      page,
    });

    const result = response.result;

    for (const row of result.items) {
      if (row.customerId !== customer) throw unavailable();
      if (
        !['canceled', 'unpaid', 'incomplete_expired'].includes(row.status) &&
        (includeCanceling || !row.cancelAtPeriodEnd)
      )
        return true;
    }

    if (page >= result.pagination.maxPage) return false;
  }

  throw unavailable();
}

export const billingOperation = Effect.fn('billingOperation')(function* (
  owner: string,
  path: string,
  method: string,
  body: unknown,
) {
  const r = yield* Infrastructure;

  if (!path && method === 'GET') {
    const rows = yield* attempt(
      () =>
        r.primary`SELECT 1 FROM billing_customers WHERE owner_id=${owner} AND provider='polar' AND organization_id=${catalog.organizationId}::uuid AND deleted=false`,
    );

    return { hasCustomer: !!rows.length };
  }

  if (method !== 'POST')
    return yield* new ApiError({ status: 405, code: 'method_not_allowed', message: 'Use POST.' });

  if (path === 'sync') {
    if (process.env.EXTERNAL_EFFECTS === 'enabled') yield* attempt(() => sync(r, owner));

    return yield* usage(owner);
  }

  return yield* attempt(async () => {
    if (path === 'portal') {
      const customer = await sync(r, owner);
      if (!customer)
        throw new ApiError({
          status: 404,
          code: 'no_billing_customer',
          message: 'Start a plan before opening billing.',
        });

      return portal(r, customer.id);
    }

    if (path !== 'checkout')
      throw new ApiError({ status: 404, code: 'not_found', message: 'Endpoint not found.' });

    const selection = decode(
      Schema.Struct({
        events: Schema.Number.check(Schema.isInt()),
        interval: Schema.Literals(['month', 'year']),
        locale: Schema.optional(Schema.Literals(['en', 'da', 'de'])),
      }),
      body,
    );

    const plan = catalog.plans.find(
      (p) => p.events === selection.events && p.interval === selection.interval,
    );

    if (!plan) throw invalid('Select an available plan.');
    if (!plan.checkoutEnabled)
      throw new ApiError({
        status: 409,
        code: 'plan_unavailable',
        message: 'Yearly billing is not available yet. Choose a monthly plan.',
      });
    let customer: Customer | CustomerState | null = await sync(r, owner);
    if (customer && (await hasSubscription(customer.id, true))) return portal(r, customer.id);

    return r.primary.begin(async (tx) => {
      const [user] = await tx`SELECT id,name,email FROM "user" WHERE id=${owner} FOR UPDATE`;
      if (!user) throw unavailable();
      const options = { locale: selection.locale ?? 'en', currency: catalog.currency };

      const [cached] =
        await tx`SELECT checkout_id FROM billing_checkouts WHERE owner_id=${owner} AND provider='polar' AND organization_id=${catalog.organizationId}::uuid AND plan_id=${plan.productId} AND checkout_options=${JSON.stringify(options)}::text::jsonb AND created_at>now()-interval '10 minutes'`;

      if (cached && customer) {
        const checkout = await optionalResource(
          polarClient().checkouts.get({ id: cached.checkout_id }),
        );

        if (
          checkout &&
          ['open', 'confirmed'].includes(String(checkout.status)) &&
          checkout.expiresAt.getTime() > Date.now() &&
          checkout.productId === plan.productId &&
          checkout.customerId === customer.id &&
          checkout.currency === catalog.currency &&
          typeof checkout.url === 'string'
        )
          return { url: checkout.url };
      }

      if (!customer)
        customer = verifyCustomer(
          await polarClient().customers.create({
            type: 'individual',
            externalId: owner,
            organizationId: catalog.organizationId,
            email: user.email,
            name: user.name,
            locale: options.locale,
          }),
          owner,
        );

      const checkout = await polarClient().checkouts.create({
        products: [plan.productId],
        customerId: customer.id,
        externalCustomerId: owner,
        currency: catalog.currency as PresentmentCurrency,
        locale: options.locale,
        allowTrial: plan.trialDays > 0,
        successUrl: r.config.appUrl + '/dashboard?checkout_id={CHECKOUT_ID}',
        returnUrl: r.config.appUrl + '/dashboard',
      });

      if (
        !checkout ||
        checkout.productId !== plan.productId ||
        checkout.customerId !== customer.id ||
        checkout.currency !== catalog.currency ||
        typeof checkout.url !== 'string' ||
        typeof checkout.id !== 'string'
      )
        throw unavailable();
      await tx`INSERT INTO billing_checkouts(owner_id,checkout_id,organization_id,plan_id,checkout_url,checkout_options) VALUES(${owner},${checkout.id},${catalog.organizationId}::uuid,${plan.productId},${checkout.url},${JSON.stringify(options)}::text::jsonb) ON CONFLICT(owner_id) DO UPDATE SET checkout_id=excluded.checkout_id,organization_id=excluded.organization_id,plan_id=excluded.plan_id,checkout_url=excluded.checkout_url,checkout_options=excluded.checkout_options,created_at=now()`;

      return { url: checkout.url };
    });
  });
});

export function verifyWebhook(headers: Headers, body: string, secret: string) {
  try {
    return validateEvent(body, Object.fromEntries(headers.entries()), secret);
  } catch (error) {
    if (error instanceof WebhookVerificationError)
      throw new ApiError({
        status: 400,
        code: 'invalid_webhook_signature',
        message: 'Invalid webhook signature.',
      });
    throw invalid('Invalid webhook payload.');
  }
}

export const webhook = Effect.fn('webhook')(function* (headers: Headers, body: string) {
  const r = yield* Infrastructure;
  const secret = process.env.POLAR_WEBHOOK_SECRET;
  if (!secret || process.env.EXTERNAL_EFFECTS !== 'enabled') return yield* unconfigured();
  const value = yield* attemptSync(() => verifyWebhook(headers, body, secret));
  const id = headers.get('webhook-id')!;

  if (value.type !== 'customer.state_changed' && value.type !== 'customer.deleted')
    return { received: true, handled: false };
  if (
    !Number.isFinite(value.timestamp.getTime()) ||
    value.timestamp.getTime() > (yield* Clock.currentTimeMillis) + 300000
  )
    return yield* invalid('Invalid webhook event timestamp.');
  if (typeof value.data.externalId !== 'string') return { received: true, handled: false };

  const owner = value.data.externalId;
  yield* attemptSync(() => verifyCustomer(value.data, owner));

  return yield* attempt(() =>
    r.primary.begin(async (tx) => {
      const rows =
        await tx`INSERT INTO billing_webhook_events(id,type,occurred_at) VALUES(${`polar:${catalog.organizationId}:${id}`},${value.type},${value.timestamp.toISOString()}) ON CONFLICT DO NOTHING RETURNING id`;

      if (!rows.length) return { received: true, duplicate: true };
      const user = await tx`SELECT id FROM "user" WHERE id=${owner} FOR UPDATE`;
      if (!user.length) return { received: true, updated: false };

      return {
        received: true,
        updated: await save(
          tx,
          owner,
          value.type === 'customer.deleted' ? null : verifyCustomer(value.data, owner),
          value.timestamp.toISOString(),
        ),
      };
    }),
  );
});

export async function ensureDeletable(r: Resources, owner: string) {
  const cached =
    await r.primary`SELECT 1 FROM billing_customers WHERE owner_id=${owner} AND deleted=false AND provider='polar' AND organization_id=${catalog.organizationId}::uuid`;

  if (process.env.EXTERNAL_EFFECTS !== 'enabled') {
    if (cached.length) throw unconfigured();

    return;
  }

  const customer = await sync(r, owner);
  if (customer && (await hasSubscription(customer.id, false)))
    throw new ApiError({
      status: 409,
      code: 'cancel_subscription_first',
      message: 'Cancel your subscription in Usage → Manage billing before deleting your account.',
    });
}

export function acknowledged(value: unknown, count: number) {
  if (!value || typeof value !== 'object') return false;

  const row = value as Record<string, unknown>,
    inserted = row.inserted,
    duplicates = row.duplicates ?? 0;

  return (
    count > 0 &&
    Number.isSafeInteger(inserted) &&
    Number.isSafeInteger(duplicates) &&
    Number(inserted) >= 0 &&
    Number(duplicates) >= 0 &&
    Number(inserted) + Number(duplicates) === count
  );
}

/** Stable external IDs make partial acknowledgments safe to retry. */
export const drainBilling = Effect.fn('drainBilling')(function* () {
  const r = yield* Infrastructure;
  if (process.env.EXTERNAL_EFFECTS !== 'enabled') return;
  const lease = crypto.randomUUID();

  const rows = yield* attempt(() =>
    r.primary.begin(async (tx) => {
      const pending =
        await tx`SELECT id,owner_id FROM billing_outbox WHERE provider='polar' AND organization_id=${catalog.organizationId}::uuid AND available_at<=now() ORDER BY available_at,id LIMIT 10 FOR UPDATE SKIP LOCKED`;

      for (const row of pending)
        await tx`UPDATE billing_outbox SET lease_id=${lease}::uuid,available_at=now()+interval '120 seconds',attempts=attempts+1,delivery_started_at=coalesce(delivery_started_at,now()) WHERE id=${row.id}::uuid`;

      return pending;
    }),
  );

  for (const owner of new Set<string>(rows.map((row: { owner_id: string }) => row.owner_id))) {
    yield* attempt(() =>
      r.primary.begin(async (tx) => {
        const user = await tx`SELECT id FROM "user" WHERE id=${owner} FOR UPDATE`;
        if (!user.length) return;

        const batch =
          await tx`SELECT id,event_type,event_count::text,occurred_at,attempts FROM billing_outbox WHERE owner_id=${owner} AND lease_id=${lease}::uuid FOR UPDATE`;

        if (!batch.length) return;

        const events = batch.map(
          (row: { id: string; event_type: string; event_count: string; occurred_at: Date }) => {
            const quantity = Number(row.event_count);
            if (!Number.isFinite(quantity) || quantity <= 0) throw unavailable();

            return {
              externalId: `datix-usage-${row.id}`,
              name: catalog.meter.eventName,
              externalCustomerId: owner,
              timestamp: row.occurred_at,
              metadata: { [catalog.meter.quantityProperty]: quantity, event_type: row.event_type },
            };
          },
        );

        const result = await polarClient()
          .events.ingest({ events })
          .catch(() => null);

        if (acknowledged(result, batch.length))
          await tx`DELETE FROM billing_outbox WHERE owner_id=${owner} AND lease_id=${lease}::uuid AND provider='polar' AND organization_id=${catalog.organizationId}::uuid`;
        else
          await tx`UPDATE billing_outbox SET lease_id=NULL,available_at=now()+least(3600,30*power(2,least(7,greatest(0,attempts-1))))*interval '1 second' WHERE owner_id=${owner} AND lease_id=${lease}::uuid`;
      }),
    );
  }
});

export const refreshBilling = Effect.fn('refreshBilling')(function* () {
  const r = yield* Infrastructure;
  if (process.env.EXTERNAL_EFFECTS !== 'enabled') return;

  const rows = yield* attempt(
    () =>
      r.primary`SELECT owner_id FROM billing_customers WHERE provider='polar' AND organization_id=${catalog.organizationId}::uuid AND deleted=false AND (sync_attempted_at IS NULL OR sync_attempted_at<now()-interval '60 seconds') ORDER BY sync_attempted_at NULLS FIRST LIMIT 16`,
  );

  for (const row of rows) {
    yield* attempt(
      () =>
        r.primary`UPDATE billing_customers SET sync_attempted_at=now() WHERE owner_id=${row.owner_id} AND provider='polar' AND organization_id=${catalog.organizationId}::uuid`,
    );
    yield* attempt(() => sync(r, row.owner_id)).pipe(
      Effect.catch(() => Effect.sync(() => console.error('Billing refresh failed'))),
    );
  }
});

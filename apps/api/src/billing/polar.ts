import { Effect, Schema, Clock } from 'effect';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Infrastructure, type Resources } from '../platform/resources';
import { attempt, ApiError, invalid, unavailable, attemptSync } from '../shared/errors';
import { decode, Id } from '../shared/validation';
import { usage } from './service';
import catalog from './catalog';

const unconfigured = () =>
  new ApiError({
    status: 503,
    code: 'billing_unconfigured',
    message: 'Billing is temporarily unavailable.',
  });

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);

const Subscription = Schema.Struct({
  id: Id,
  product_id: Id,
  currency: Schema.String,
  recurring_interval: Schema.String,
  status: Schema.String,
  current_period_start: Schema.String,
  current_period_end: Schema.String,
  trial_end: Schema.NullOr(Schema.String),
  ends_at: Schema.NullOr(Schema.String),
  cancel_at_period_end: Schema.Boolean,
});

const Customer = Schema.Struct({
  id: Id,
  external_id: Schema.String,
  organization_id: Id,
  deleted_at: Schema.optional(Schema.NullOr(Schema.String)),
  active_subscriptions: Schema.optional(Schema.Array(Subscription)),
  granted_benefits: Schema.optional(
    Schema.Array(
      Schema.Struct({
        benefit_id: Id,
        benefit_type: Schema.String,
        benefit_metadata: Schema.optional(JsonObject),
        properties: Schema.optional(JsonObject),
      }),
    ),
  ),
});

function verifyCustomer(value: unknown, owner: string) {
  const c = Schema.decodeUnknownSync(Customer)(value);
  if (c.external_id !== owner || c.organization_id !== catalog.organizationId)
    throw new ApiError({
      status: 502,
      code: 'invalid_billing_customer',
      message: 'Billing customer could not be verified.',
    });

  return c;
}

function subscriptions(customer: typeof Customer.Type) {
  if (customer.deleted_at) return [];
  if (!customer.active_subscriptions || !customer.granted_benefits) throw unavailable();

  const grant = (id: string, type: string) =>
    customer.granted_benefits!.find((g) => g.benefit_id === id && g.benefit_type === type);

  const websites = grant(catalog.websitesBenefitId, 'custom')?.benefit_metadata?.included;
  if (
    !grant(catalog.analyticsBenefitId, 'custom') ||
    typeof websites !== 'number' ||
    !Number.isSafeInteger(websites) ||
    websites < 0
  )
    return [];

  return customer.active_subscriptions.flatMap((row) => {
    const plan = catalog.plans.find((p) => p.productId === row.product_id);
    if (
      !plan ||
      !plan.checkoutEnabled ||
      row.currency !== catalog.currency ||
      row.recurring_interval !== plan.interval ||
      !['active', 'trialing'].includes(row.status)
    )
      return [];
    const properties = grant(plan.eventsBenefitId, 'meter_credit')?.properties;
    if (!properties) return [];

    const count =
      Object.keys(properties).length === 0
        ? plan.events
        : properties.last_credited_meter_id === catalog.meter.id
          ? properties.last_credited_units
          : null;

    const limit = typeof count === 'number' ? count * 100 : 0,
      start = Date.parse(row.current_period_start),
      end = Date.parse(row.current_period_end);

    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      !(Date.now() >= start && Date.now() < end) ||
      (row.status === 'trialing' && !row.trial_end)
    )
      return [];

    return [
      {
        id: row.id,
        productId: row.product_id,
        status: row.status,
        currentPeriodStart: row.current_period_start,
        currentPeriodEnd: row.current_period_end,
        trialEnd: row.trial_end,
        endsAt: row.ends_at,
        cancelAtPeriodEnd: row.cancel_at_period_end,
        entitlements: {
          name: plan.name,
          eventLimit: limit,
          websiteLimit: websites,
          used: 0,
          remaining: limit,
          localBaseline: 0,
          pending: 0,
          periodStart: row.current_period_start,
          periodEnd: row.current_period_end,
        },
      },
    ];
  });
}

async function request(method: string, path: string, body?: unknown) {
  if (process.env.EXTERNAL_EFFECTS !== 'enabled' || !process.env.POLAR_ACCESS_TOKEN)
    throw unconfigured();
  const base = process.env.POLAR_API_URL ?? 'https://api.polar.sh';
  if (
    !['https://api.polar.sh', 'https://sandbox-api.polar.sh'].includes(base) ||
    (base === 'https://sandbox-api.polar.sh') !== !!process.env.POLAR_SANDBOX_IDS
  )
    throw unconfigured();

  const response = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${process.env.POLAR_ACCESS_TOKEN}`,
      'Polar-Version': catalog.apiVersion,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });

  if (response.status === 404) return null;
  if (!response.ok) throw unavailable();

  return Schema.decodeUnknownSync(JsonObject)(await response.json());
}

async function save(
  db: Bun.SQL | Bun.TransactionSQL,
  owner: string,
  customer: typeof Customer.Type | null,
  at: string,
) {
  const subs = customer ? subscriptions(customer) : [],
    deleted = !customer || !!customer.deleted_at;

  const rows =
    await db`INSERT INTO billing_customers(customer_id,owner_id,subscriptions,deleted,occurred_at,updated_at,provider,organization_id,sync_attempted_at) VALUES(${`polar:${catalog.organizationId}:${owner}`},${owner},${JSON.stringify(subs)}::text::jsonb,${deleted},${at},now(),'polar',${catalog.organizationId}::uuid,now()) ON CONFLICT(customer_id) DO UPDATE SET subscriptions=excluded.subscriptions,deleted=excluded.deleted,occurred_at=excluded.occurred_at,updated_at=excluded.updated_at,sync_attempted_at=excluded.sync_attempted_at WHERE billing_customers.provider='polar' AND billing_customers.organization_id=excluded.organization_id AND billing_customers.owner_id=excluded.owner_id AND billing_customers.occurred_at<excluded.occurred_at RETURNING customer_id`;

  return rows.length > 0;
}

async function sync(r: Resources, owner: string) {
  return r.primary.begin(async (tx) => {
    await tx`SELECT id FROM "user" WHERE id=${owner} FOR UPDATE`;

    const at = new Date().toISOString(),
      value = await request('GET', `/v1/customers/external/${encodeURIComponent(owner)}/state`),
      customer = value ? verifyCustomer(value, owner) : null;

    await save(tx, owner, customer, at);

    return customer?.deleted_at ? null : customer;
  });
}

async function portal(r: Resources, customer: string) {
  const response = await request('POST', '/v1/customer-sessions/', {
    customer_id: customer,
    return_url: r.config.appUrl + '/dashboard',
  });

  if (response?.customer_id !== customer || typeof response.customer_portal_url !== 'string')
    throw unavailable();

  return { url: response.customer_portal_url };
}

async function hasSubscription(customer: string, includeCanceling: boolean) {
  for (let page = 1; page <= 100; page++) {
    const response = await request(
      'GET',
      `/v1/subscriptions/?customer_id=${customer}&organization_id=${catalog.organizationId}&limit=100&page=${page}`,
    );

    const result = Schema.decodeUnknownSync(
      Schema.Struct({
        items: Schema.Array(
          Schema.Struct({
            customer_id: Id,
            status: Schema.String,
            cancel_at_period_end: Schema.Boolean,
          }),
        ),
        pagination: Schema.Struct({ max_page: Schema.Number.check(Schema.isInt()) }),
      }),
    )(response);

    for (const row of result.items) {
      if (row.customer_id !== customer) throw unavailable();
      if (
        !['canceled', 'unpaid', 'incomplete_expired'].includes(row.status) &&
        (includeCanceling || !row.cancel_at_period_end)
      )
        return true;
    }

    if (page >= result.pagination.max_page) return false;
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
    let customer = await sync(r, owner);
    if (customer && (await hasSubscription(customer.id, true))) return portal(r, customer.id);

    return r.primary.begin(async (tx) => {
      const [user] = await tx`SELECT id,name,email FROM "user" WHERE id=${owner} FOR UPDATE`;
      if (!user) throw unavailable();
      const options = { locale: selection.locale ?? 'en', currency: catalog.currency };

      const [cached] =
        await tx`SELECT checkout_id FROM billing_checkouts WHERE owner_id=${owner} AND provider='polar' AND organization_id=${catalog.organizationId}::uuid AND plan_id=${plan.productId} AND checkout_options=${JSON.stringify(options)}::text::jsonb AND created_at>now()-interval '10 minutes'`;

      if (cached && customer) {
        const checkout = await request('GET', `/v1/checkouts/${cached.checkout_id}`);
        if (
          checkout &&
          ['open', 'confirmed'].includes(String(checkout.status)) &&
          Date.parse(String(checkout.expires_at)) > Date.now() &&
          checkout.product_id === plan.productId &&
          checkout.customer_id === customer.id &&
          checkout.currency === catalog.currency &&
          typeof checkout.url === 'string'
        )
          return { url: checkout.url };
      }

      if (!customer)
        customer = verifyCustomer(
          await request('POST', '/v1/customers/', {
            external_id: owner,
            email: user.email,
            name: user.name,
            locale: options.locale,
          }),
          owner,
        );

      const checkout = await request('POST', '/v1/checkouts/', {
        products: [plan.productId],
        customer_id: customer.id,
        external_customer_id: owner,
        currency: catalog.currency,
        locale: options.locale,
        allow_trial: plan.trialDays > 0,
        success_url: r.config.appUrl + '/dashboard?checkout_id={CHECKOUT_ID}',
        return_url: r.config.appUrl + '/dashboard',
      });

      if (
        !checkout ||
        checkout.product_id !== plan.productId ||
        checkout.customer_id !== customer.id ||
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
  const id = headers.get('webhook-id') ?? '',
    timestamp = headers.get('webhook-timestamp') ?? '',
    key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');

  if (key.length < 32) throw unconfigured();
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
  if (
    !id ||
    id.length > 200 ||
    !/^\d+$/.test(timestamp) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
    !(headers.get('webhook-signature') ?? '').split(/\s+/).some((sig) => {
      if (!sig.startsWith('v1,')) return false;
      const received = Buffer.from(sig.slice(3), 'base64');

      return received.length === expected.length && timingSafeEqual(received, expected);
    })
  )
    throw new ApiError({
      status: 400,
      code: 'invalid_webhook_signature',
      message: 'Invalid webhook signature.',
    });

  return id;
}

export const webhook = Effect.fn('webhook')(function* (headers: Headers, body: string) {
  const r = yield* Infrastructure;
  const secret = process.env.POLAR_WEBHOOK_SECRET;
  if (!secret || process.env.EXTERNAL_EFFECTS !== 'enabled') return yield* unconfigured();
  const id = yield* attemptSync(() => verifyWebhook(headers, body, secret));

  const value = yield* attemptSync(() =>
    Schema.decodeUnknownSync(
      Schema.Struct({ type: Schema.String, timestamp: Schema.String, data: JsonObject }),
    )(JSON.parse(body)),
  );

  if (!['customer.state_changed', 'customer.deleted'].includes(value.type))
    return { received: true, handled: false };
  if (
    !Number.isFinite(Date.parse(value.timestamp)) ||
    Date.parse(value.timestamp) > (yield* Clock.currentTimeMillis) + 300000
  )
    return yield* invalid('Invalid webhook event timestamp.');
  if (typeof value.data.external_id !== 'string') return { received: true, handled: false };

  const owner = value.data.external_id,
    customer = yield* attemptSync(() => verifyCustomer(value.data, owner));

  return yield* attempt(() =>
    r.primary.begin(async (tx) => {
      const rows =
        await tx`INSERT INTO billing_webhook_events(id,type,occurred_at) VALUES(${`polar:${catalog.organizationId}:${id}`},${value.type},${value.timestamp}) ON CONFLICT DO NOTHING RETURNING id`;

      if (!rows.length) return { received: true, duplicate: true };
      const user = await tx`SELECT id FROM "user" WHERE id=${owner} FOR UPDATE`;
      if (!user.length) return { received: true, updated: false };

      return {
        received: true,
        updated: await save(
          tx,
          owner,
          value.type === 'customer.deleted' ? null : customer,
          value.timestamp,
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
              external_id: `datix-usage-${row.id}`,
              name: catalog.meter.eventName,
              external_customer_id: owner,
              timestamp: row.occurred_at.toISOString(),
              metadata: { [catalog.meter.quantityProperty]: quantity, event_type: row.event_type },
            };
          },
        );

        const result = await request('POST', '/v1/events/ingest', { events }).catch(() => null);
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

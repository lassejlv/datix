import { Effect, Schema } from 'effect';
import { protection } from '../analytics/abuse';
import type { SQL } from 'bun';
import { Infrastructure } from '../platform/resources';
import { ApiError, attempt } from '../shared/errors';
import catalog from './catalog';
const Units = Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0));
const Entitlement = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  eventLimit: Schema.NullOr(Units),
  websiteLimit: Schema.NullOr(Units),
  used: Units,
  remaining: Schema.NullOr(Units),
  localBaseline: Units,
  pending: Units,
  periodStart: Schema.String,
  periodEnd: Schema.String,
});
const Subscription = Schema.Struct({
  status: Schema.String,
  currentPeriodEnd: Schema.String,
  trialEnd: Schema.optional(Schema.NullOr(Schema.String)),
  endsAt: Schema.optional(Schema.NullOr(Schema.String)),
  entitlements: Entitlement,
});
export const subscriptionRequired = () =>
  new ApiError({
    status: 402,
    code: 'subscription_required',
    message: 'An active subscription is required.',
  });
export async function allowance(db: SQL | Bun.TransactionSQL, owner: string, now = Date.now()) {
  const rows =
    await db`SELECT subscriptions FROM billing_customers WHERE owner_id=${owner} AND deleted=false AND provider='polar' AND organization_id=${catalog.organizationId}::uuid AND (${process.env.EXTERNAL_EFFECTS !== 'enabled'} OR updated_at>now()-interval '5 minutes')`;
  const active = (
    rows as {
      subscriptions: unknown[];
    }[]
  )
    .flatMap((r: { subscriptions: unknown[] }) => r.subscriptions)
    .flatMap((raw: unknown) => {
      try {
        const s = Schema.decodeUnknownSync(Subscription)(raw);
        const e = s.entitlements;
        const end = Math.min(
          Date.parse(e.periodEnd),
          Date.parse(s.currentPeriodEnd),
          s.endsAt ? Date.parse(s.endsAt) : Infinity,
          s.status === 'trialing' && s.trialEnd ? Date.parse(s.trialEnd) : Infinity,
        );
        const start = Date.parse(e.periodStart);
        if (
          !['active', 'trialing'].includes(s.status) ||
          !(now >= start && now < end) ||
          (e.remaining === null) !== (e.eventLimit === null)
        )
          return [];
        return [
          {
            ...e,
            trial: s.status === 'trialing',
            period: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
          },
        ];
      } catch {
        return [];
      }
    });
  return (
    active.sort(
      (a, b) =>
        (b.eventLimit ?? Infinity) - (a.eventLimit ?? Infinity) ||
        Date.parse(b.period.start) - Date.parse(a.period.start),
    )[0] ?? null
  );
}
export const requireSubscription = Effect.fn('requireSubscription')(function* (owner: string) {
  const r = yield* Infrastructure;
  const active = yield* attempt(() => allowance(r.primary, owner));
  if (!active) return yield* subscriptionRequired();
  return active;
});
export const usage = Effect.fn('usage')(function* (owner: string) {
  const r = yield* Infrastructure;
  return yield* attempt(async () => {
    const active = await allowance(r.primary, owner);
    const sites =
      await r.primary`SELECT s.id,s.name,s.domain,s.credit_budget,EXISTS(SELECT 1 FROM environments e WHERE e.site_id=s.id AND e.enabled) AS enabled,EXISTS(SELECT 1 FROM site_suspensions ss WHERE ss.site_id=s.id) AS suspended FROM sites s WHERE owner_id=${owner} ORDER BY created_at,id`;
    const rows = active
      ? await r.primary`SELECT site_id,(events*100)::bigint AS units FROM billing_organization_usage WHERE owner_id=${owner} AND period_start=${active.period.start} AND organization_id=${catalog.organizationId}::uuid`
      : [];
    const local = rows.reduce(
      (
        n: number,
        row: {
          units: unknown;
        },
      ) => n + Number(row.units),
      0,
    );
    const reserved = active ? active.pending + Math.max(0, local - active.localBaseline) : 0;
    const remaining = active
      ? active.remaining === null
        ? null
        : Math.max(0, active.remaining - reserved)
      : 0;
    const reason = !active
      ? 'subscription_required'
      : remaining !== null && remaining < 15
        ? 'event_limit'
        : null;
    const [onboarding] =
      await r.primary`SELECT EXISTS(SELECT 1 FROM account_onboarding WHERE owner_id=${owner}) AS completed`;
    return {
      onboardingCompleted: onboarding.completed,
      protection: await protection(r.primary, owner),
      plan: active
        ? {
            name: active.name,
            trial: active.trial,
            eventLimit: active.eventLimit === null ? null : active.eventLimit / 100,
            websiteLimit: active.websiteLimit,
          }
        : null,
      period: active?.period ?? null,
      events: {
        used: active ? (active.used + reserved) / 100 : 0,
        remaining: remaining === null ? null : remaining / 100,
      },
      paused: reason !== null,
      pauseReason: reason,
      websites: sites.map((s: Record<string, unknown>, i: number) => {
        const units = Number(rows.find((x: { site_id: string }) => x.site_id === s.id)?.units ?? 0);
        const budget = s.credit_budget === null ? null : Number(s.credit_budget);
        const pause = s.suspended
          ? 'admin_suspended'
          : !s.enabled
            ? 'disabled'
            : (reason ??
              (active?.websiteLimit !== null && active && i >= active.websiteLimit
                ? 'website_limit'
                : budget !== null && budget * 100 - units < 15
                  ? 'website_budget'
                  : null));
        return {
          id: s.id,
          name: s.name,
          domain: s.domain,
          creditBudget: budget,
          events: units / 100,
          paused: pause !== null,
          pauseReason: pause,
        };
      }),
    };
  });
});

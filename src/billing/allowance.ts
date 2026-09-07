import catalog from '../../config/polar-catalog.json';
import type { BillingSubscription } from './types';

export const WEBSITE_LIMIT = 10;
export const proPlans = new Map(
  catalog.products.flatMap((product) =>
    !product.is_archived &&
    product.metadata.plan === 'pro' &&
    typeof product.metadata.monthly_events === 'number'
      ? [
          [
            product.id,
            {
              name: 'Pro',
              eventLimit: product.metadata.monthly_events,
              websiteLimit: WEBSITE_LIMIT,
            },
          ] as const,
        ]
      : [],
  ),
);

function addMonth(origin: Date, months: number) {
  const result = new Date(origin);
  result.setUTCDate(1);
  result.setUTCMonth(origin.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(origin.getUTCDate(), lastDay));
  return result;
}

/** Monthly allowances, including annual subscriptions, anchored to the billing period. */
export function allowancePeriod(subscription: BillingSubscription, now: Date) {
  if (!subscription.currentPeriodStart) return null;
  const origin = new Date(subscription.currentPeriodStart);
  const end = Math.min(
    Date.parse(subscription.currentPeriodEnd),
    subscription.status === 'trialing' && subscription.trialEnd
      ? Date.parse(subscription.trialEnd)
      : Infinity,
    subscription.endsAt ? Date.parse(subscription.endsAt) : Infinity,
  );
  if (
    !Number.isFinite(origin.getTime()) ||
    !Number.isFinite(end) ||
    now.getTime() < origin.getTime() ||
    now.getTime() >= end
  )
    return null;
  let months =
    (now.getUTCFullYear() - origin.getUTCFullYear()) * 12 +
    now.getUTCMonth() -
    origin.getUTCMonth();
  if (addMonth(origin, months).getTime() > now.getTime()) months--;
  const start = addMonth(origin, months);
  return {
    start: start.toISOString(),
    end: new Date(Math.min(addMonth(origin, months + 1).getTime(), end)).toISOString(),
  };
}

export function activeAllowance(subscriptions: BillingSubscription[], now: Date) {
  return (
    subscriptions
      .flatMap((subscription) => {
        const plan = proPlans.get(subscription.productId);
        const period = allowancePeriod(subscription, now);
        if (!plan || !period || !['active', 'trialing'].includes(subscription.status)) return [];
        return [{ ...plan, period, subscription, trial: subscription.status === 'trialing' }];
      })
      .sort(
        (a, b) => b.eventLimit - a.eventLimit || b.period.start.localeCompare(a.period.start),
      )[0] ?? null
  );
}

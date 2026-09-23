import catalog from '../../../polar-catalog.json';
import type { Copy, Translate } from './i18n/translations';

// The Rust checkout allowlist and every displayed price share the verified catalog.
// Legacy plans still grant access to existing subscriptions but are never offered.
export const billingPlans = catalog.plans
  .filter((plan) => !plan.legacy)
  .map((plan) => ({
    id: plan.id,
    name: plan.name,
    events: plan.events,
    price: plan.price / 100,
    free: plan.price === 0,
    websites: plan.websites,
    environments: plan.environments,
    // Polar prices overage in cents per credit; display it per 1,000 credits.
    overagePer1k: plan.overageUnitAmount === null ? null : Number(plan.overageUnitAmount) * 10,
  }));

export type BillingPlan = (typeof billingPlans)[number];

export const billingPlanDescriptions: Record<string, Copy> = {
  free: 'For a personal site or a side project.',
  pro: 'For growing products. Pay only for what you use beyond your included credits.',
};

export const billingCurrency = () => catalog.currency;

export const freePlan = billingPlans.find((plan) => plan.free)!;

export const overagePlan = billingPlans.find((plan) => plan.overagePer1k !== null)!;

export function billingPrice(plan: BillingPlan, locale: string) {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: billingCurrency(),
    maximumFractionDigits: 0,
  }).format(plan.price);
}

/** Allowance lines shared by the public pricing page and the in-app plan picker. */
export function billingAllowance(
  plan: BillingPlan,
  t: Translate,
  number: (value: number) => string,
  locale: string,
) {
  return [
    plan.overagePer1k === null
      ? t('{count} credits per month', { count: number(plan.events) })
      : t('{count} credits included per month', { count: number(plan.events) }),
    ...(plan.overagePer1k === null
      ? []
      : [
          t('Then {price} per 1,000 credits', {
            price: billingAmount(plan.overagePer1k, locale),
          }),
        ]),
    plan.websites === 1 ? t('1 website') : t('{count} websites', { count: plan.websites }),
  ];
}

/** Formats small usage prices such as $0.04 without rounding them to whole units. */
export function billingAmount(amount: number, locale: string) {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: billingCurrency(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

import catalog from '../../../config/polar-catalog.json';

// The Rust checkout allowlist and every displayed price share the verified catalog.
export const billingPlans = catalog.plans
  .filter((plan) => plan.interval === 'month')
  .map((plan) => {
    const annual = catalog.plans.find(
      (candidate) => candidate.events === plan.events && candidate.interval === 'year',
    )!;
    return {
      id: plan.id,
      name: plan.name,
      events: plan.events,
      price: plan.price / 100,
      yearlyPrice: annual.price / 100,
      websites: plan.websites,
      monthlyAvailable: plan.checkoutEnabled,
      yearlyAvailable: annual.checkoutEnabled,
    };
  });

export const billingCurrency = () => catalog.currency;
export const billingAvailable = (plan: (typeof billingPlans)[number], yearly = false) =>
  yearly ? plan.yearlyAvailable : plan.monthlyAvailable;
export function billingPrice(plan: (typeof billingPlans)[number], locale: string, yearly = false) {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: billingCurrency(),
    maximumFractionDigits: 0,
  }).format(yearly ? plan.yearlyPrice : plan.price);
}

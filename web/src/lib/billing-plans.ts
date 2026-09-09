export const billingPlans = [
  {
    id: 'basic',
    name: 'Basic',
    events: 100_000,
    price: 9,
    prices: { usd: 9, dkk: 59, eur: 9 },
    websites: 10,
  },
  {
    id: 'pro',
    name: 'Pro',
    events: 1_000_000,
    price: 49,
    prices: { usd: 49, dkk: 329, eur: 49 },
    websites: 10,
  },
  {
    id: 'ultra',
    name: 'Ultra',
    events: 5_000_000,
    price: 149,
    prices: { usd: 149, dkk: 999, eur: 149 },
    websites: 10,
  },
] as const;
export const billingCurrency = (locale: string) =>
  locale === 'da' ? 'dkk' : locale === 'de' ? 'eur' : 'usd';
export function billingPrice(plan: (typeof billingPlans)[number], locale: string, yearly = false) {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: billingCurrency(locale),
    maximumFractionDigits: 0,
  }).format(plan.prices[billingCurrency(locale)] * (yearly ? 10 : 1));
}

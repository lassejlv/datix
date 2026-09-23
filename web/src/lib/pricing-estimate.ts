import { billingCurrency, freePlan, overagePlan } from './billing-plans';

/** Production rates. Localhost is cheaper and is not part of this estimate. */
export const pageviewCredits = 1;

export const eventCredits = 0.5;

export const calculatorLimits = {
  pageviews: 100_000,
  events: 50_000,
} as const;

export function clampTraffic(value: number, max: number) {
  if (!Number.isFinite(value)) return 0;

  return Math.min(max, Math.max(0, Math.round(value)));
}

export function creditsFor(pageviews: number, events: number) {
  return pageviews * pageviewCredits + events * eventCredits;
}

export type PricingEstimate = {
  planId: string;
  planName: string;
  price: number;
  credits: number;
  remaining: number;
  extraCredits: number;
};

/** Free while the allowance holds. After that, Pro’s base price plus catalog overage. */
export function estimatePricing(pageviews: number, events: number): PricingEstimate {
  const credits = creditsFor(pageviews, events);

  if (credits <= freePlan.events) {
    return {
      planId: freePlan.id,
      planName: freePlan.name,
      price: 0,
      credits,
      remaining: freePlan.events - credits,
      extraCredits: 0,
    };
  }

  const extraCredits = Math.max(0, credits - overagePlan.events);
  const rate = overagePlan.overagePer1k ?? 0;

  return {
    planId: overagePlan.id,
    planName: overagePlan.name,
    price: overagePlan.price + (extraCredits / 1000) * rate,
    credits,
    remaining: Math.max(0, overagePlan.events - credits),
    extraCredits,
  };
}

/** Whole amounts stay as $20. Amounts with cents keep two digits. */
export function formatEstimatePrice(amount: number, locale: string) {
  const cents = Math.round(amount * 100);
  const whole = cents % 100 === 0;

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: billingCurrency(),
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(cents / 100);
}

import { describe, expect, test } from 'bun:test';
import { freePlan, overagePlan } from '../../src/lib/billing-plans';
import {
  calculatorLimits,
  clampTraffic,
  creditsFor,
  estimatePricing,
  formatEstimatePrice,
} from '../../src/lib/pricing-estimate';

describe('pricing calculator', () => {
  test('a pageview is one credit and another event is half', () => {
    expect(creditsFor(10_000, 2_000)).toBe(11_000);
    expect(creditsFor(0, 1)).toBe(0.5);
  });

  test('traffic stays inside the slider range', () => {
    expect(clampTraffic(Number.NaN, 10)).toBe(0);
    expect(clampTraffic(-4.2, 10)).toBe(0);
    expect(clampTraffic(3.6, 10)).toBe(4);
    expect(clampTraffic(40, calculatorLimits.pageviews)).toBe(40);
    expect(clampTraffic(calculatorLimits.pageviews + 1, calculatorLimits.pageviews)).toBe(
      calculatorLimits.pageviews,
    );
  });

  test('Free covers the allowance and Pro takes over after it', () => {
    expect(estimatePricing(freePlan.events, 0)).toMatchObject({
      planId: 'free',
      price: 0,
      extraCredits: 0,
      remaining: 0,
    });
    expect(estimatePricing(freePlan.events + 1, 0)).toMatchObject({
      planId: 'pro',
      price: overagePlan.price,
      extraCredits: 0,
    });
  });

  test('Pro overage follows the catalog rate per 1,000 credits', () => {
    const extra = 25_000;
    const estimate = estimatePricing(overagePlan.events + extra, 0);

    expect(estimate.extraCredits).toBe(extra);
    expect(estimate.price).toBeCloseTo(
      overagePlan.price + (extra / 1000) * overagePlan.overagePer1k!,
    );
    expect(estimate.remaining).toBe(0);
  });

  test('whole prices drop the cents and partial prices keep them', () => {
    expect(formatEstimatePrice(20, 'en')).toBe('$20');
    expect(formatEstimatePrice(20.5, 'en')).toBe('$20.50');
    expect(formatEstimatePrice(0, 'en')).toBe('$0');
  });
});

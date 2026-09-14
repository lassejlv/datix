import { describe, expect, test } from 'bun:test';
import {
  billingPlans,
  billingPrice,
  billingCurrency,
  billingAvailable,
} from '../../src/lib/billing-plans';
import catalog from '../../../config/polar-catalog.json';

describe('Polar pricing', () => {
  test('all locales display the same USD amounts from the backend catalog', () => {
    expect(billingCurrency()).toBe('usd');
    expect(billingPlans.map((p) => p.price)).toEqual([9, 49, 149]);
    expect(billingPlans.map((p) => p.yearlyPrice)).toEqual([90, 490, 1490]);

    for (const locale of ['en', 'da', 'de']) {
      for (const plan of billingPlans) {
        expect(billingPrice(plan, locale)).toContain('$');
        expect(billingPrice(plan, locale, true)).toContain('$');
        expect(catalog.plans.find((p) => p.id === plan.id)?.price).toBe(plan.price * 100);
      }
    }
  });
  test('monthly plans are selectable while annual draft prices remain previews', () => {
    expect(billingPlans.map((p) => p.events)).toEqual([15000, 500000, 5000000]);

    for (const plan of billingPlans) {
      expect(billingAvailable(plan)).toBe(true);
      expect(billingAvailable(plan, true)).toBe(false);
    }
  });
});

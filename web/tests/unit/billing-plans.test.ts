import { describe, expect, test } from 'bun:test';
import {
  billingAllowance,
  billingAmount,
  billingPlans,
  billingPrice,
  billingCurrency,
  freePlan,
  overagePlan,
} from '../../src/lib/billing-plans';
import { translate } from '../../src/lib/i18n/translations';
import catalog from '../../../polar-catalog.json';

describe('Polar pricing', () => {
  test('only current plans are offered, with amounts from the backend catalog', () => {
    expect(billingCurrency()).toBe('usd');
    expect(billingPlans.map((p) => [p.id, p.price, p.events, p.websites])).toEqual([
      ['free', 0, 15000, 1],
      ['pro', 20, 50000, 10],
    ]);

    for (const locale of ['en', 'da', 'de']) {
      for (const plan of billingPlans) {
        expect(billingPrice(plan, locale)).toContain('$');
        expect(catalog.plans.find((p) => p.id === plan.id)?.price).toBe(plan.price * 100);
      }
    }
  });
  test('Pro overage is shown per 1,000 credits from the metered unit price', () => {
    expect(freePlan.id).toBe('free');
    expect(freePlan.overagePer1k).toBeNull();
    expect(overagePlan.id).toBe('pro');
    expect(overagePlan.overagePer1k).toBeCloseTo(0.04, 10);
    expect(billingAmount(overagePlan.overagePer1k!, 'en')).toBe('$0.04');

    const t = (text: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
      translate('en', text, values);

    const number = (value: number) => value.toLocaleString('en');

    expect(billingAllowance(freePlan, t, number, 'en')).toEqual([
      '15,000 credits per month',
      '1 website',
    ]);
    expect(billingAllowance(overagePlan, t, number, 'en')).toEqual([
      '50,000 credits included per month',
      'Then $0.04 per 1,000 credits',
      '10 websites',
    ]);
  });
  test('legacy plans stay in the catalog but are never offered', () => {
    const legacy = catalog.plans.filter((plan) => plan.legacy);

    expect(legacy.map((plan) => plan.id)).toEqual(['legacy_basic', 'legacy_pro', 'legacy_ultra']);

    for (const plan of legacy) {
      expect(billingPlans.some((offered) => offered.id === plan.id)).toBe(false);
    }
  });
});

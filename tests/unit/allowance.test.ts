import { expect, test } from 'bun:test';
import { activeAllowance, allowancePeriod } from '../../src/billing/allowance';
import type { BillingSubscription } from '../../src/billing/types';

const subscription: BillingSubscription = {
  id: 'test',
  productId: 'a0de3cc9-ea92-4e95-b23e-b8d9240685aa',
  status: 'active',
  currentPeriodStart: '2026-01-31T12:00:00Z',
  currentPeriodEnd: '2027-01-31T12:00:00Z',
  trialEnd: null,
  cancelAtPeriodEnd: false,
  endsAt: null,
};
test('monthly allowances preserve month-end anchors across short months and annual billing', () => {
  expect(allowancePeriod(subscription, new Date('2026-02-28T11:59:59Z'))).toEqual({
    start: '2026-01-31T12:00:00.000Z',
    end: '2026-02-28T12:00:00.000Z',
  });
  expect(allowancePeriod(subscription, new Date('2026-02-28T12:00:00Z'))).toEqual({
    start: '2026-02-28T12:00:00.000Z',
    end: '2026-03-31T12:00:00.000Z',
  });
  expect(allowancePeriod(subscription, new Date('2026-03-31T12:00:00Z'))).toEqual({
    start: '2026-03-31T12:00:00.000Z',
    end: '2026-04-30T12:00:00.000Z',
  });
});
test('only known active Pro products and unexpired trials grant collection', () => {
  const now = new Date('2026-02-01T00:00:00Z');
  expect(activeAllowance([subscription], now)?.eventLimit).toBe(100000);
  for (const status of ['past_due', 'canceled', 'unpaid', 'incomplete', 'paused'])
    expect(activeAllowance([{ ...subscription, status }], now)).toBeNull();
  for (const productId of [
    'unknown',
    'cc71df7e-5ecf-41e6-973d-04f89d404b87',
    'cb2ad4c0-aa8f-47df-815f-aff8796f95cc',
  ])
    expect(activeAllowance([{ ...subscription, productId }], now)).toBeNull();
  expect(
    activeAllowance(
      [{ ...subscription, status: 'trialing', trialEnd: '2026-02-14T00:00:00Z' }],
      now,
    )?.trial,
  ).toBe(true);
  expect(
    activeAllowance([{ ...subscription, status: 'trialing', trialEnd: now.toISOString() }], now),
  ).toBeNull();
  expect(activeAllowance([{ ...subscription, currentPeriodStart: undefined }], now)).toBeNull();
  expect(activeAllowance([{ ...subscription, cancelAtPeriodEnd: true }], now)).not.toBeNull();
  expect(activeAllowance([subscription], new Date(subscription.currentPeriodEnd))).toBeNull();
});

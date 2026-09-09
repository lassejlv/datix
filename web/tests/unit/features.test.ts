import { expect, test } from 'bun:test';
import { featureSettings } from '../../src/lib/features';
test('only Web Vitals starts enabled and explicit opt-outs persist', () => {
  expect(featureSettings()).toEqual({
    goals: false,
    errors: false,
    webVitals: true,
    geography: false,
    pulse: false,
  });
  expect(featureSettings({ webVitals: false, goals: true })).toEqual({
    goals: true,
    errors: false,
    webVitals: false,
    geography: false,
    pulse: false,
  });
});

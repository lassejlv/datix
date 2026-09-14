import { expect, test } from 'bun:test';
import { trackingSettings } from '../../src/lib/tracking-settings';

test('clicks, downloads and scroll depth are opt-in without changing explicit choices', () => {
  const defaults = trackingSettings();
  expect(defaults.click).toBe(false);
  expect(defaults.download).toBe(false);
  expect(defaults.scroll).toBe(false);
  expect(defaults.pageview).toBe(true);
  expect(
    trackingSettings({ click: true, download: true, scroll: true, pageview: false }),
  ).toMatchObject({ click: true, download: true, scroll: true, pageview: false });
});

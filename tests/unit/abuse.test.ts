import { expect, test } from 'bun:test';
import {
  detectActivity,
  learnBaseline,
  type SourceActivity,
  type TrafficWindow,
} from '../../src/abuse/detection';
const now = Date.UTC(2026, 8, 7, 12, 0, 1);
const baseline = learnBaseline(
  Array.from({ length: 7 }, () => ({
    pageviews: 900,
    customEvents: 100,
    visitors: 400,
    blocked: 0,
  })),
);

test('learning excludes incomplete/empty and attacked days; medians resist outliers', () => {
  expect(
    learnBaseline([
      { pageviews: 900, customEvents: 100, visitors: 400, blocked: 0 },
      { pageviews: 1000, customEvents: 100, visitors: 500, blocked: 0 },
      { pageviews: 999999, customEvents: 999999, visitors: 1, blocked: 99 },
      { pageviews: 0, customEvents: 0, visitors: 0, blocked: 0 },
    ]),
  ).toMatchObject({ days: 2, dailyEvents: 1050 });
  expect(baseline.days).toBe(7);
});

test('fresh event IDs cannot bypass reload protection; a new minute recovers', () => {
  let previous: SourceActivity | undefined;
  for (let i = 0; i < 21; i++) {
    const result = detectActivity({
      now: now + i * 100,
      previous,
      signature: 'same-page',
      pageview: true,
      baseline: learnBaseline([]),
    });
    expect(result.reason).toBe(i < 20 ? null : 'repeated_activity');
    previous = result.source;
  }
  expect(
    detectActivity({ now: now + 60000, previous, signature: 'same-page', pageview: true, baseline })
      .reason,
  ).toBeNull();
});

test('history catches abnormal source activity earlier, but accepts a diverse viral spike', () => {
  let previous: SourceActivity | undefined;
  let traffic: TrafficWindow = { start: Math.floor(now / 300000), events: 350, custom: 0 };
  for (let i = 0; i < 11; i++) {
    const result = detectActivity({
      now,
      previous,
      traffic,
      signature: 'reload',
      pageview: true,
      baseline,
    });
    expect(result.reason).toBe(i < 10 ? null : 'unusual_activity');
    previous = result.source;
    traffic = result.traffic;
  }
  for (let i = 0; i < 1000; i++) {
    const result = detectActivity({ now, traffic, signature: 'landing', pageview: true, baseline });
    expect(result.reason).toBeNull();
    traffic = result.traffic;
  }
  const newSite = detectActivity({
    now,
    previous: { ...previous!, repeats: 10 },
    traffic,
    signature: 'reload',
    pageview: true,
    baseline: learnBaseline([]),
  });
  expect(newSite.reason).toBeNull();
});

test('a changed event mix needs both historical deviation and an excessive local source', () => {
  let previous: SourceActivity | undefined;
  const traffic = { start: Math.floor(now / 300000), events: 500, custom: 500 };
  for (let i = 0; i < 31; i++) {
    const result = detectActivity({
      now,
      previous,
      traffic,
      signature: `action-${i}`,
      pageview: false,
      baseline,
    });
    expect(result.reason).toBe(i < 30 ? null : 'unusual_activity');
    previous = result.source;
  }
  expect(
    detectActivity({
      now,
      previous,
      traffic,
      signature: 'next',
      pageview: false,
      baseline: { ...baseline, customShare: 0.99 },
    }).reason,
  ).toBeNull();
});

test('sustained spam hits hourly and daily limits even with changing patterns', () => {
  const first = detectActivity({ now, signature: 'a', pageview: false, baseline });
  expect(
    detectActivity({
      now,
      previous: { ...first.source, hourEvents: 1200 },
      signature: 'b',
      pageview: false,
      baseline,
    }).reason,
  ).toBe('source_limit');
  expect(
    detectActivity({
      now,
      previous: { ...first.source, dayEvents: 6000 },
      signature: 'b',
      pageview: false,
      baseline,
    }).reason,
  ).toBe('source_limit');
  expect(
    detectActivity({
      now: now + 86400000,
      previous: { ...first.source, dayEvents: 6000 },
      signature: 'b',
      pageview: false,
      baseline,
    }).reason,
  ).toBeNull();
});

test('out-of-order arrivals cannot rewind a source counter and reopen its allowance', () => {
  const recent = detectActivity({
    now: now + 60000,
    signature: 'next',
    pageview: false,
    baseline,
  }).source;
  const result = detectActivity({
    now,
    previous: { ...recent, minuteEvents: 180 },
    signature: 'older',
    pageview: false,
    baseline,
  });
  expect(result.reason).toBe('source_limit');
  expect(result.source.minute).toBe(recent.minute);
});

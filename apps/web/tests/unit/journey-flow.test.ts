import { expect, test } from 'bun:test';
import { journeyStops } from '../../src/lib/journey-flow';
import type { Activity } from '../../src/lib/visitor-journey';

const event = (id: string, kind: string, path: string) => ({ id, kind, path }) as Activity;

test('journeys keep repeat navigation and actions in their observed order', () => {
  const events = [
    event('1', 'pageview', '/'),
    event('2', 'click', '/'),
    event('3', 'pageview', '/docs'),
    event('4', 'custom', '/docs'),
    event('5', 'pageview', '/'),
    event('6', 'pageview', '/'),
  ];

  const stops = journeyStops(events);
  expect(stops.map((stop) => stop.path)).toEqual(['/', '/docs', '/', '/']);
  expect(
    stops.flatMap((stop) => [
      ...(stop.page ? [stop.page.id] : []),
      ...stop.actions.map((action) => action.id),
    ]),
  ).toEqual(events.map((event) => event.id));
});

test('actions without a preceding pageview add context without inventing navigation', () => {
  const stops = journeyStops([
    event('1', 'click', '/docs'),
    event('2', 'scroll', '/help'),
    event('3', 'pageview', '/help'),
  ]);

  expect(stops.map((stop) => stop.page?.id ?? null)).toEqual([null, null, '3']);
  expect(stops[0]!.actions[0]!.id).toBe('1');
  expect(stops[1]!.actions[0]!.id).toBe('2');
  expect(journeyStops([])).toEqual([]);
});

test('loading another batch extends the last page without losing its actions', () => {
  const first = [event('1', 'pageview', '/docs'), event('2', 'click', '/docs')];
  const next = [event('3', 'click', '/docs'), event('4', 'pageview', '/help')];
  const stops = journeyStops([...first, ...next]);
  expect(stops).toHaveLength(2);
  expect(stops[0]!.actions.map((event) => event.id)).toEqual(['2', '3']);
});

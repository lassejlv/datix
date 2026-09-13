import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { landingSearchSchema, reportSearchSchema } from '../../src/lib/search-params';

test('landing search schema keeps supported values and removes unknown input', () => {
  expect(
    v.parse(landingSearchSchema, {
      auth: 'signup',
      site: 'site-1',
      environment: 'production',
      view: 'overview',
      ignored: 'value',
    }),
  ).toEqual({
    auth: 'signup',
    site: 'site-1',
    environment: 'production',
    view: 'overview',
  });

  expect(
    v.parse(landingSearchSchema, {
      auth: 'reset-password',
      site: 123,
      environment: ['production'],
      view: null,
    }),
  ).toEqual({ auth: undefined, site: undefined, environment: undefined, view: undefined });
});

test('report search schema preserves the existing date-shape sanitizer', () => {
  expect(
    v.parse(reportSearchSchema, {
      from: '2026-09-01',
      to: '2026-09-12',
      tab: 'paths',
      ignored: 'value',
    }),
  ).toEqual({ from: '2026-09-01', to: '2026-09-12', tab: 'paths' });

  expect(
    v.parse(reportSearchSchema, {
      from: 'September 1',
      to: 20260912,
      tab: ['paths'],
    }),
  ).toEqual({ from: undefined, to: undefined, tab: undefined });
});

test('search schemas accept missing input without adding errors', () => {
  expect(v.safeParse(landingSearchSchema, {})).toMatchObject({ success: true });
  expect(v.parse(landingSearchSchema, {})).toEqual({
    auth: undefined,
    site: undefined,
    environment: undefined,
    view: undefined,
  });
  expect(v.parse(reportSearchSchema, {})).toEqual({
    from: undefined,
    to: undefined,
    tab: undefined,
  });
});

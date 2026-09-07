import { trackingSettingsSchema } from './tracking-settings';
import { z } from 'zod';
import {
  anonymousActivitySchema,
  sessionContextSchema,
  trackingModeSchema,
} from './session-tracking';
import { HttpError } from './http';

export const siteIdSchema = z.uuid();
export const domainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .transform((s) => s.toLowerCase().replace(/\.$/, ''))
  .refine(
    (s) => /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s),
    'Use a hostname such as example.com, without a scheme, path, port or wildcard.',
  );
export const createSiteSchema = z
  .object({ name: z.string().trim().min(1).max(80), domain: domainSchema })
  .strict();
export const creditBudgetSchema = z.number().min(0.15).max(1000000000).multipleOf(0.01).nullable();
export const updateSiteSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    creditBudget: creditBudgetSchema.optional(),
    enabled: z.boolean().optional(),
    allowLocalhost: z.boolean().optional(),
  })
  .strict()
  .refine((s) => Object.keys(s).length > 0, 'Provide a website setting to update.');
const environmentNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[^\u0000-\u001f\u007f]+$/, 'Use a name without control characters.');
export const createEnvironmentSchema = z
  .object({
    name: environmentNameSchema,
    trackingMode: trackingModeSchema.optional(),
    trackingSettings: trackingSettingsSchema.optional(),
    domain: domainSchema.optional(),
    allowLocalhost: z.boolean().optional(),
  })
  .strict();
export const updateEnvironmentSchema = z
  .object({
    name: environmentNameSchema.optional(),
    trackingMode: trackingModeSchema.optional(),
    trackingSettings: trackingSettingsSchema.optional(),
    domain: domainSchema.optional(),
    enabled: z.boolean().optional(),
    allowLocalhost: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Provide an environment setting to update.');
export const collectSchema = z.discriminatedUnion('type', [
  z
    .object({
      siteId: z.uuid(),
      environmentId: z.uuid().optional(),
      session: sessionContextSchema.optional(),
      activity: anonymousActivitySchema.optional(),
      id: z.uuid(),
      type: z.literal('pageview'),
      url: z.url().max(2048),
      referrer: z.string().max(2048).optional(),
    })
    .strict(),
  z
    .object({
      siteId: z.uuid(),
      environmentId: z.uuid().optional(),
      session: sessionContextSchema.optional(),
      activity: anonymousActivitySchema.optional(),
      id: z.uuid(),
      type: z.literal('event'),
      name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/),
      url: z.url().max(2048),
      referrer: z.string().max(2048).optional(),
    })
    .strict(),
]);
export const breakdownSchema = z.enum(['path', 'referrer', 'country', 'device', 'event']);
export const DAY_MS = 86400000;

export function dateRange(params: URLSearchParams, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const end = params.get('to') ?? today;
  const start =
    params.get('from') ?? new Date(Date.parse(today) - 29 * DAY_MS).toISOString().slice(0, 10);
  for (const date of [start, end]) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date
    )
      throw new HttpError(
        400,
        'invalid_date',
        'Dates must be real UTC calendar dates in YYYY-MM-DD format.',
      );
  }
  const days = (Date.parse(end) - Date.parse(start)) / DAY_MS + 1;
  if (days < 1 || days > 366 || end > today || Date.parse(start) < Date.parse(today) - 729 * DAY_MS)
    throw new HttpError(
      400,
      'invalid_range',
      'Choose 1–366 days within the last 730 days, ending no later than today.',
    );
  return { from: start, to: end, days, timezone: 'UTC' as const };
}

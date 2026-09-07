import { z } from 'zod';

export const trackingModeSchema = z.enum(['cookieless', 'sessions', 'local']);
export const activityKindSchema = z.enum([
  'pageview',
  'custom',
  'click',
  'outbound',
  'download',
  'form_submit',
  'scroll',
  'engagement',
]);
export const activityDetailsSchema = z
  .object({
    clientTime: z.number().int().min(0).max(8640000000000000).optional(),
    sequence: z.number().int().min(0).max(2147483647).optional(),
    // Explicit labels or a structural element path, never text or form values.
    target: z
      .string()
      .max(160)
      .regex(/^[a-zA-Z0-9_.:()> -]*$/)
      .optional(),
    destination: z.url().max(2048).optional(),
    scrollDepth: z.number().int().min(0).max(100).optional(),
    activeSeconds: z.number().int().min(0).max(30).optional(),
    x: z.number().int().min(0).max(100).optional(),
    y: z.number().int().min(0).max(100).optional(),
    viewportWidth: z.number().int().min(0).max(20000),
    viewportHeight: z.number().int().min(0).max(20000),
    screenWidth: z.number().int().min(0).max(20000),
    screenHeight: z.number().int().min(0).max(20000),
    language: z
      .string()
      .max(35)
      .regex(/^[a-zA-Z0-9-]*$/),
  })
  .strict();
export const anonymousActivitySchema = z
  .object({
    kind: activityKindSchema,
    details: activityDetailsSchema,
  })
  .strict();
export const sessionContextSchema = z
  .object({
    consent: z.literal(true),
    storage: z.enum(['cookie', 'local']).optional(),
    visitorId: z.uuid(),
    sessionId: z.uuid(),
    kind: activityKindSchema,
    details: activityDetailsSchema,
  })
  .strict();
export type ActivityDetails = z.infer<typeof activityDetailsSchema>;

import { z } from 'zod';

export const trackingSettingLabels = {
  pageview: 'Pageviews',
  custom: 'Custom events',
  click: 'Clicks',
  outbound: 'Outbound links',
  download: 'Downloads',
  form_submit: 'Form submissions',
  scroll: 'Scroll depth',
  engagement: 'Engagement time',
  referrer: 'Referrer websites',
  country: 'Country',
  device: 'Device, browser and operating system',
  dimensions: 'Screen and viewport size',
  language: 'Browser language',
  coordinates: 'Click positions',
} as const;
export type TrackingSettings = Record<keyof typeof trackingSettingLabels, boolean>;
export const defaultTrackingSettings = Object.fromEntries(
  Object.keys(trackingSettingLabels).map((key) => [key, true]),
) as TrackingSettings;
export const trackingSettingsSchema = z
  .object({
    pageview: z.boolean(),
    custom: z.boolean(),
    click: z.boolean(),
    outbound: z.boolean(),
    download: z.boolean(),
    form_submit: z.boolean(),
    scroll: z.boolean(),
    engagement: z.boolean(),
    referrer: z.boolean(),
    country: z.boolean(),
    device: z.boolean(),
    dimensions: z.boolean(),
    language: z.boolean(),
    coordinates: z.boolean(),
  })
  .strict();
export function trackingSettings(value?: Partial<TrackingSettings> | null): TrackingSettings {
  return { ...defaultTrackingSettings, ...value };
}

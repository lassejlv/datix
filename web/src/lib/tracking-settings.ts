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
  Object.keys(trackingSettingLabels).map((key) => [
    key,
    !['click', 'download', 'scroll'].includes(key),
  ]),
) as TrackingSettings;
export function trackingSettings(value?: Partial<TrackingSettings> | null): TrackingSettings {
  return { ...defaultTrackingSettings, ...value };
}

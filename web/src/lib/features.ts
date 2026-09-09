export const featureDefinitions = [
  {
    key: 'goals',
    page: 'goals',
    label: 'Goals',
    description: 'Track signups, purchases, and other single-step conversions.',
  },
  {
    key: 'errors',
    page: 'errors',
    label: 'Error Tracking',
    description: 'Find JavaScript errors and see how many visitors they affect.',
  },
  {
    key: 'webVitals',
    page: 'web-vitals',
    label: 'Web Vitals',
    description: 'Measure loading speed, responsiveness, and visual stability.',
  },
  {
    key: 'geography',
    page: 'globe',
    label: 'Globe',
    description: 'Explore your visitors on an interactive Earth.',
  },
  {
    key: 'pulse',
    page: 'pulse',
    label: 'Pulse',
    description: 'Monitor availability and send outage alerts to a webhook.',
  },
] as const;
export type FeatureKey = (typeof featureDefinitions)[number]['key'];
export type FeaturePage = (typeof featureDefinitions)[number]['page'];
export type FeatureSettings = Record<FeatureKey, boolean>;
export function featureSettings(raw?: Partial<FeatureSettings>): FeatureSettings {
  return {
    goals: raw?.goals ?? false,
    errors: raw?.errors ?? false,
    webVitals: raw?.webVitals ?? true,
    geography: raw?.geography ?? false,
    pulse: raw?.pulse ?? false,
  };
}
export function isFeaturePage(page: string): page is FeaturePage {
  return featureDefinitions.some((feature) => feature.page === page);
}

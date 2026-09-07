import type { EventMessage } from '../analytics/ingest.server';
import { trackingSettings, type TrackingSettings } from './tracking-settings';

export function applyTrackingPolicy(
  event: EventMessage,
  settings: Partial<TrackingSettings>,
): EventMessage | null {
  const policy = trackingSettings(settings);
  const kind =
    event.version === 3 ? event.activity.kind : event.type === 'pageview' ? 'pageview' : 'custom';
  if (!policy[kind]) return null;
  const clean = {
    ...event,
    referrer: policy.referrer ? event.referrer : '',
    country: policy.country ? event.country : '',
    device: policy.device ? event.device : ('' as const),
  };
  if (clean.version === 3) {
    clean.activity = {
      ...clean.activity,
      browser: policy.device ? clean.activity.browser : '',
      os: policy.device ? clean.activity.os : '',
      details: { ...clean.activity.details },
    };
    const details = clean.activity.details;
    if (!policy.dimensions)
      Object.assign(details, {
        viewportWidth: 0,
        viewportHeight: 0,
        screenWidth: 0,
        screenHeight: 0,
      });
    if (!policy.language) details.language = '';
    if (!policy.coordinates) {
      delete details.x;
      delete details.y;
    }
  }
  return clean;
}

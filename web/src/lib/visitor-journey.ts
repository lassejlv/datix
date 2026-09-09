import { translate, type Copy } from './i18n/translations';
import type { Locale } from './i18n/preferences';
import type { ActivityDetails } from './session-tracking';
export type Visit = {
  id: string;
  visitorKey: string;
  daily: boolean;
  startedAt: string;
  lastSeenAt: string;
  pageviews: number;
  clicks: number;
  events: number;
  activeSeconds: number;
  entryPath: string;
  country: string;
  device: string;
};
export type Activity = {
  id: string;
  receivedAt: string;
  occurredAt: string;
  kind: string;
  name: string;
  path: string;
  browser: string;
  os: string;
  device: string;
  country: string;
  referrer: string;
  details: ActivityDetails;
};
export type VisitReport = {
  summary: {
    sessions: number;
    visitors: number;
    averageActiveSeconds: number;
    clicks: number;
  };
  sessions: Visit[];
  hasMore: boolean;
  nextOffset: number;
  nextCursor?: string | null;
};
const animals = ['Robin', 'Rabbit', 'Cat', 'Fish', 'Squirrel', 'Turtle'] as const;
const moods = ['Curious', 'Sunny', 'Gentle', 'Bright', 'Cosy', 'Little'] as const;
export function visitorAlias(key: string, locale: Locale = 'en') {
  let hash = 0;
  for (const char of key) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  const animal = animals[hash % animals.length]!;
  return {
    animal,
    name: translate(
      locale,
      `${moods[Math.floor(hash / animals.length) % moods.length]} ${animal}` as Copy,
    ),
  };
}
export const activeDuration = (seconds: number) =>
  seconds >= 60
    ? `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`
    : `${Math.floor(seconds)}s`;
export const visitDate = (value: string) =>
  new Date(value).toLocaleString('en-GB', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
export function activityTitle(event: Activity, locale: Locale = 'en') {
  switch (event.kind) {
    case 'pageview':
      return translate(locale, 'Opened a page');
    case 'click':
      return translate(locale, 'Clicked an element');
    case 'outbound':
      return translate(locale, 'Clicked an external link');
    case 'download':
      return translate(locale, 'Clicked a download');
    case 'form_submit':
      return translate(locale, 'Submitted a form');
    case 'scroll':
      return translate(locale, 'Scrolled to {depth}%', { depth: event.details.scrollDepth ?? 0 });
    case 'custom':
      return event.name || translate(locale, 'Triggered an event');
    default:
      return translate(locale, 'Spent time on the page');
  }
}

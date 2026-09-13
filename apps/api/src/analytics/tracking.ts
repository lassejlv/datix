import * as Schema from 'effect/Schema';
import { createHmac } from 'node:crypto';
import { decode, Id } from '../shared/validation';
import { invalid } from '../shared/errors';

export const trackingKeys = [
  'pageview',
  'custom',
  'click',
  'outbound',
  'download',
  'form_submit',
  'scroll',
  'engagement',
  'referrer',
  'country',
  'device',
  'dimensions',
  'language',
  'coordinates',
] as const;

export function settings(raw: Record<string, boolean> = {}) {
  return Object.fromEntries(
    trackingKeys.map((key) => [key, raw[key] ?? !['click', 'download', 'scroll'].includes(key)]),
  );
}

const integer = (max: number) =>
  Schema.Number.check(Schema.isInt()).check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(max),
  );

const Details = Schema.Struct({
  clientTime: Schema.optional(integer(8640000000000000)),
  sequence: Schema.optional(integer(2147483647)),
  target: Schema.optional(
    Schema.String.check(Schema.isMaxLength(160), Schema.isPattern(/^[a-zA-Z0-9_.:()> -]*$/)),
  ),
  destination: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
  scrollDepth: Schema.optional(integer(100)),
  activeSeconds: Schema.optional(integer(30)),
  x: Schema.optional(integer(100)),
  y: Schema.optional(integer(100)),
  viewportWidth: integer(20000),
  viewportHeight: integer(20000),
  screenWidth: integer(20000),
  screenHeight: integer(20000),
  language: Schema.String.check(Schema.isMaxLength(35), Schema.isPattern(/^[a-zA-Z0-9-]*$/)),
});

const Kind = Schema.Literals([
  'pageview',
  'custom',
  'click',
  'outbound',
  'download',
  'form_submit',
  'scroll',
  'engagement',
]);

const Activity = Schema.Struct({ kind: Kind, details: Details });

const Session = Schema.Struct({
  kind: Kind,
  details: Details,
  visitorId: Id,
  sessionId: Id,
  consent: Schema.optional(Schema.Boolean),
  storage: Schema.optional(Schema.Literals(['cookie', 'local'])),
});

export const Input = Schema.Struct({
  siteId: Id,
  environmentId: Schema.optional(Id),
  id: Id,
  type: Schema.Literals(['pageview', 'event']),
  name: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/))),
  url: Schema.String.check(Schema.isMaxLength(2048)),
  referrer: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
  session: Schema.optional(Session),
  activity: Schema.optional(Activity),
});

export const hash = (secret: string, value: unknown) =>
  createHmac('sha256', secret).update(JSON.stringify(value)).digest('hex');

export function normalize(
  body: unknown,
  origin: string,
  ua: string,
  ip: string,
  country: string,
  secret: string,
  env: {
    domain: string;
    allow_localhost: boolean;
    tracking_mode: string;
    tracking_settings: Record<string, boolean>;
  },
  now = new Date(),
) {
  const input = decode(Input, body);
  if ((input.type === 'pageview') === (input.name !== undefined))
    throw invalid('Invalid event name.');
  const url = new URL(input.url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.origin !== origin ||
    (url.hostname !== env.domain && !(local && env.allow_localhost))
  )
    throw invalid('The event URL and Origin must match an allowed host for this website.');
  if (
    (env.tracking_mode !== 'cookieless') !== !!input.session ||
    (input.activity && env.tracking_mode !== 'cookieless') ||
    (input.session &&
      (input.session.storage ?? 'cookie') !== (env.tracking_mode === 'local' ? 'local' : 'cookie'))
  )
    throw invalid("Use the current environment script for this environment's tracking mode.");

  const environment = input.environmentId ?? input.siteId,
    day = now.toISOString().slice(0, 10);

  const visitor = hash(
    secret,
    input.session ? [environment, day, input.session.visitorId] : [environment, day, ip, ua],
  );

  const raw = input.session ?? input.activity;
  let activity;

  if (raw) {
    if ((input.type === 'pageview') !== (raw.kind === 'pageview'))
      throw invalid('Activity kind does not match the event.');

    const details = {
      ...raw.details,
      clientTime:
        raw.details.clientTime && Math.abs(raw.details.clientTime - now.getTime()) <= 300000
          ? raw.details.clientTime
          : now.getTime(),
      activeSeconds: raw.kind === 'engagement' ? (raw.details.activeSeconds ?? 0) : 0,
    };

    if (details.destination) {
      const target = new URL(details.destination);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
        throw invalid('Use an HTTP destination.');
      target.search = '';
      target.hash = '';
      details.destination = target.toString();
    }

    activity = {
      sessionKey: input.session
        ? hash(secret, [environment, input.session.visitorId, input.session.sessionId])
        : visitor,
      visitorKey: input.session ? hash(secret, [environment, input.session.visitorId]) : visitor,
      kind: raw.kind,
      browser: ua.includes('Edg/')
        ? 'Edge'
        : ua.includes('Firefox/')
          ? 'Firefox'
          : ua.includes('Chrome/')
            ? 'Chrome'
            : ua.includes('Safari/')
              ? 'Safari'
              : 'Other',
      os: ua.includes('Android')
        ? 'Android'
        : /iPhone|iPad/.test(ua)
          ? 'iOS'
          : ua.includes('Windows')
            ? 'Windows'
            : ua.includes('Macintosh')
              ? 'macOS'
              : ua.includes('Linux')
                ? 'Linux'
                : 'Other',
      details,
    };
  }

  let referrer = '';

  try {
    const ref = new URL(input.referrer ?? '');
    if (['http:', 'https:'].includes(ref.protocol)) referrer = ref.hostname;
  } catch {}

  return applyPolicy(
    {
      version: activity ? 3 : 2,
      siteId: input.siteId,
      environmentId: environment,
      id: input.id,
      receivedAt: now.toISOString(),
      day,
      type: input.type,
      name: input.name ?? '',
      path: url.pathname,
      referrer,
      country,
      device: /iPad|Tablet/i.test(ua)
        ? 'tablet'
        : /Mobile|iPhone|Android/i.test(ua)
          ? 'mobile'
          : 'desktop',
      visitor,
      localhost: local,
      activity,
    },
    env.tracking_settings,
  );
}

export type Event = NonNullable<ReturnType<typeof normalize>>;

type Envelope = {
  version: number;
  siteId: string;
  environmentId: string;
  id: string;
  receivedAt: string;
  day: string;
  type: string;
  name: string;
  path: string;
  referrer: string;
  country: string;
  device: string;
  visitor: string;
  localhost: boolean;
  activity?: {
    sessionKey: string;
    visitorKey: string;
    kind: string;
    browser: string;
    os: string;
    details: typeof Details.Type;
  };
};

export function applyPolicy(input: Envelope, raw: Record<string, boolean>): Envelope | null {
  const policy = settings(raw),
    event = structuredClone(input);

  if (!policy[event.activity?.kind ?? (event.type === 'pageview' ? 'pageview' : 'custom')])
    return null;
  if (!policy.referrer) event.referrer = '';
  if (!policy.country) event.country = '';
  if (!policy.device) event.device = '';

  if (event.activity) {
    const a = event.activity;
    const d = { ...a.details };

    if (!policy.device) {
      a.browser = '';
      a.os = '';
    }

    if (!policy.dimensions) {
      d.viewportWidth = d.viewportHeight = d.screenWidth = d.screenHeight = 0;
    }

    if (!policy.language) d.language = '';

    if (!policy.coordinates) {
      delete d.x;
      delete d.y;
    }

    a.details = d;
  }

  return event;
}

export function units(event: Event) {
  return event.activity?.kind === 'engagement'
    ? 0
    : event.type === 'pageview'
      ? event.localhost
        ? 30
        : 100
      : event.localhost
        ? 15
        : 50;
}

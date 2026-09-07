import type { AppEnv } from '../runtime/types';
import { applyTrackingPolicy } from '../lib/tracking-policy.server';
import { guardActivity } from '../abuse/guard.server';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.server';
import { environments, sites } from '../db/schema';
import { accountUsage } from '../billing/usage.server';
import { collectSchema } from '../lib/validation';
import { HttpError, json, parse, readJson } from '../lib/http';
import { deviceType, hash, isBot, pageUrl, referrerHost } from '../lib/privacy';
import type { EventMessage } from '../analytics/ingest.server';

export async function collect(
  request: Request,
  env: AppEnv,
  run: <T>(fn: (db: Database) => Promise<T>) => Promise<T>,
  now = new Date(),
) {
  const input = parse(collectSchema, await readJson(request));
  const ua = request.headers.get('user-agent')?.slice(0, 512) ?? '';
  if (request.headers.get('dnt') === '1' || isBot(ua))
    return json({ accepted: false, reason: 'excluded' }, 202);
  const receivedAt = now.toISOString();
  const day = receivedAt.slice(0, 10);
  const environmentId = input.environmentId ?? input.siteId;
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const visitor = await hash(
    env.VISITOR_HASH_SECRET,
    JSON.stringify(
      input.session ? [environmentId, day, input.session.visitorId] : [environmentId, day, ip, ua],
    ),
  );
  const limited = await env.COLLECT_LIMITER.limit({ key: await hash(env.VISITOR_HASH_SECRET, ip) });
  if (!limited.success) throw new HttpError(429, 'rate_limited', 'Too many events.');
  const site = await run(async (db) => {
    const [environment] = await db
      .select({
        trackingMode: environments.trackingMode,
        trackingSettings: environments.trackingSettings,
        domain: environments.domain,
        enabled: environments.enabled,
        allowLocalhost: environments.allowLocalhost,
        ownerId: sites.ownerId,
      })
      .from(environments)
      .innerJoin(sites, eq(sites.id, environments.siteId))
      .where(and(eq(environments.id, environmentId), eq(environments.siteId, input.siteId)))
      .limit(1);
    if (!environment) return null;
    const usage = await accountUsage(db, environment.ownerId);
    return {
      ...environment,
      pauseReason: usage.websites.find((site) => site.id === input.siteId)?.pauseReason ?? null,
    };
  });
  if (!site?.enabled) throw new HttpError(404, 'site_not_found', 'Website is unavailable.');
  const path = pageUrl(input.url, site.domain, request.headers.get('origin'), site.allowLocalhost);
  if (site.pauseReason) return json({ accepted: false, reason: site.pauseReason }, 202);
  if (
    (site.trackingMode !== 'cookieless') !== !!input.session ||
    (!!input.activity && site.trackingMode !== 'cookieless') ||
    (input.session &&
      (input.session.storage ?? 'cookie') !== (site.trackingMode === 'local' ? 'local' : 'cookie'))
  )
    throw new HttpError(
      400,
      'tracking_mode_mismatch',
      'Use the current environment script. Session mode requires explicit analytics consent.',
    );
  const context = input.session ?? input.activity;
  if (context && (input.type === 'pageview') !== (context.kind === 'pageview'))
    throw new HttpError(400, 'invalid_activity', 'Activity kind does not match the event.');
  const activity = context
    ? {
        sessionKey: input.session
          ? await hash(
              env.VISITOR_HASH_SECRET,
              JSON.stringify([environmentId, input.session.visitorId, input.session.sessionId]),
            )
          : visitor,
        visitorKey: input.session
          ? await hash(
              env.VISITOR_HASH_SECRET,
              JSON.stringify([environmentId, input.session.visitorId]),
            )
          : visitor,
        kind: context.kind,
        browser: /Edg\//.test(ua)
          ? 'Edge'
          : /Firefox\//.test(ua)
            ? 'Firefox'
            : /Chrome\//.test(ua)
              ? 'Chrome'
              : /Safari\//.test(ua)
                ? 'Safari'
                : 'Other',
        os: /Android/.test(ua)
          ? 'Android'
          : /iPhone|iPad/.test(ua)
            ? 'iOS'
            : /Windows/.test(ua)
              ? 'Windows'
              : /Macintosh/.test(ua)
                ? 'macOS'
                : /Linux/.test(ua)
                  ? 'Linux'
                  : 'Other',
        details: {
          ...context.details,
          clientTime:
            context.details.clientTime !== undefined &&
            Math.abs(context.details.clientTime - Date.parse(receivedAt)) <= 300000
              ? context.details.clientTime
              : Date.parse(receivedAt),
          activeSeconds: context.kind === 'engagement' ? (context.details.activeSeconds ?? 0) : 0,
        },
      }
    : undefined;
  if (activity?.details.destination) {
    const destination = new URL(activity.details.destination);
    if (
      !['http:', 'https:'].includes(destination.protocol) ||
      destination.username ||
      destination.password
    )
      throw new HttpError(400, 'invalid_destination', 'Use an HTTP destination.');
    destination.search = '';
    destination.hash = '';
    activity.details.destination = destination.href;
  }
  const country =
    request.headers.get('x-analytics-country') ??
    (typeof request.cf?.country === 'string' && /^[A-Z]{2}$/.test(request.cf.country)
      ? request.cf.country
      : '');
  const message: EventMessage = {
    ...(activity
      ? { version: 3 as const, environmentId, activity }
      : environmentId === input.siteId
        ? { version: 1 as const }
        : { version: 2 as const, environmentId }),
    localhost: ['localhost', '127.0.0.1', '[::1]'].includes(new URL(input.url).hostname),
    siteId: input.siteId,
    id: input.id,
    receivedAt,
    day,
    type: input.type,
    name: input.type === 'event' ? input.name : '',
    path,
    referrer: referrerHost(input.referrer),
    country,
    device: deviceType(ua),
    visitor,
  };
  // A 202 is sent only after the durable queue confirms the write.
  const filtered = applyTrackingPolicy(message, site.trackingSettings);
  if (!filtered) return json({ accepted: false, reason: 'event_disabled' }, 202);
  const source = await hash(
    env.VISITOR_HASH_SECRET,
    JSON.stringify(['abuse-source', environmentId, day, ip]),
  );
  const signature = await hash(
    env.VISITOR_HASH_SECRET,
    JSON.stringify(['abuse-pattern', environmentId, input.type, context?.kind, message.name, path]),
  );
  const protection = await run((db) =>
    guardActivity(db, {
      environmentId,
      // Never use client-provided visitor/session IDs or user-agent for a source limit.
      source,
      signature,
      pageview: input.type === 'pageview',
      now,
    }),
  );
  if (protection.blocked) return json({ accepted: false, reason: 'spam_detected' }, 202);
  await env.EVENTS.send(filtered);
  return json({ accepted: true }, 202);
}

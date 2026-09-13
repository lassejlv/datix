import { Effect } from 'effect';
import { guard } from './abuse';
import { Infrastructure } from '../platform/resources';
import { attempt, ApiError, attemptSync } from '../shared/errors';
import { id, decode } from '../shared/validation';
import { Input, normalize, hash, settings, units, applyPolicy, type Event } from './tracking';
import { allowance } from '../billing/service';
import catalog from '../billing/catalog';
export const trackerConfig = Effect.fn('trackerConfig')(function* (site: string, key: string) {
  const r = yield* Infrastructure;
  const rows = yield* attempt(
    () =>
      r.primary`SELECT e.*,NOT EXISTS(SELECT 1 FROM site_suspensions WHERE site_id=s.id) AND NOT EXISTS(SELECT 1 FROM user_suspensions WHERE user_id=s.owner_id) AS permitted FROM environments e JOIN sites s ON s.id=e.site_id WHERE e.site_id=${id(site)}::uuid AND e.id=${id(key)}::uuid`,
  );
  if (!rows[0])
    return yield* new ApiError({
      status: 404,
      code: 'environment_not_found',
      message: 'Environment not found.',
    });
  const env = rows[0];
  return {
    enabled: env.enabled && env.permitted,
    settings: settings(env.tracking_settings),
    features: { goals: false, errors: false, webVitals: true, ...env.feature_settings },
  };
});
export const collect = Effect.fn('collect')(function* (
  body: unknown,
  headers: Headers,
  ip: string,
  country: string,
) {
  const r = yield* Infrastructure;
  const input = yield* attemptSync(() => decode(Input, body));
  const ua = (headers.get('user-agent') ?? '').slice(0, 512);
  if (headers.get('dnt') === '1' || /bot|crawler|spider|headless|lighthouse|curl|wget/i.test(ua))
    return { accepted: false, reason: 'excluded' };
  const key = input.environmentId ?? input.siteId;
  return yield* attempt(async () => {
    const secret = process.env.VISITOR_HASH_SECRET ?? r.config.BETTER_AUTH_SECRET;
    const rate = Number(
      await r.redis.send('EVAL', [
        "local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],60) end;return n",
        '1',
        `${r.config.queuePrefix}:collect:${hash(secret, ip)}`,
      ]),
    );
    if (rate > 120)
      throw new ApiError({
        status: 429,
        code: 'rate_limited',
        message: 'Too many requests. Try again in a minute.',
      });
    const result = await r.primary.begin(async (tx) => {
      const rows =
        await tx`SELECT e.*,s.owner_id,s.credit_budget FROM environments e JOIN sites s ON s.id=e.site_id WHERE e.id=${key}::uuid AND s.id=${input.siteId}::uuid`;
      const env = rows[0];
      if (!env)
        throw new ApiError({
          status: 404,
          code: 'environment_not_found',
          message: 'Environment not found.',
        });
      await tx`SELECT id FROM "user" WHERE id=${env.owner_id} FOR UPDATE`;
      const [current] =
        await tx`SELECT e.*,s.credit_budget,EXISTS(SELECT 1 FROM user_suspensions WHERE user_id=s.owner_id) OR EXISTS(SELECT 1 FROM site_suspensions WHERE site_id=s.id) AS suspended FROM environments e JOIN sites s ON s.id=e.site_id WHERE e.id=${key}::uuid AND s.id=${input.siteId}::uuid FOR KEY SHARE OF s,e`;
      if (!current || !current.enabled || current.suspended)
        return { accepted: false, reason: current?.suspended ? 'admin_suspended' : 'disabled' };
      const event = normalize(input, headers.get('origin') ?? '', ua, ip, country, secret, current);
      if (!event) return { accepted: false, reason: 'event_disabled' };
      const active = await allowance(tx, env.owner_id);
      if (!active) return { accepted: false, reason: 'subscription_required' };
      const sites =
        await tx`SELECT id FROM sites WHERE owner_id=${env.owner_id} ORDER BY created_at,id`;
      if (
        active.websiteLimit !== null &&
        sites.findIndex((s: { id: string }) => s.id === input.siteId) >= active.websiteLimit
      )
        return { accepted: false, reason: 'website_limit' };
      const [duplicate] =
        await tx`SELECT 1 FROM ingestion_receipts WHERE environment_id=${key}::uuid AND event_id=${input.id}::uuid`;
      if (duplicate) return { accepted: true, owner: env.owner_id };
      if (await guard(r, tx, event, ip, secret))
        return { accepted: false, reason: 'spam_detected' };
      const usage =
        await tx`SELECT site_id,(events*100)::bigint AS units FROM billing_organization_usage WHERE owner_id=${env.owner_id} AND organization_id=${catalog.organizationId}::uuid AND period_start=${active.period.start}`;
      const used = usage.reduce(
        (
          n: number,
          row: {
            units: unknown;
          },
        ) => n + Number(row.units),
        0,
      );
      const reserved = active.pending + Math.max(0, used - active.localBaseline),
        cost = units(event);
      if (
        active.remaining !== null &&
        (active.remaining - reserved < cost || active.remaining - reserved === 0)
      )
        return { accepted: false, reason: 'event_limit' };
      const siteUsed = Number(
        usage.find((row: { site_id: string }) => row.site_id === input.siteId)?.units ?? 0,
      );
      if (
        current.credit_budget !== null &&
        Number(current.credit_budget) * 100 - siteUsed < Math.max(15, cost)
      )
        return { accepted: false, reason: 'website_budget' };
      await tx`INSERT INTO ingestion_receipts(environment_id,event_id,owner_id,site_id,period_start,period_end,units,payload) VALUES(${key}::uuid,${input.id}::uuid,${env.owner_id},${input.siteId}::uuid,${active.period.start},${active.period.end},${cost},${JSON.stringify(event)}::text::jsonb)`;
      if (cost)
        await tx`INSERT INTO billing_organization_usage(owner_id,site_id,organization_id,period_start,period_end,events) VALUES(${env.owner_id},${input.siteId}::uuid,${catalog.organizationId}::uuid,${active.period.start},${active.period.end},${cost / 100}) ON CONFLICT(owner_id,period_start,site_id,organization_id) DO UPDATE SET events=billing_organization_usage.events+excluded.events`;
      return { accepted: true, owner: env.owner_id };
    });
    if (result.accepted && result.owner) {
      // A queue outage cannot erase the committed receipt; the recovery loop will enqueue it.
      await r.queue.add('deliver', { owner: result.owner }).catch(() => {});
    }
    return result.accepted ? { accepted: true } : { accepted: false, reason: result.reason };
  });
});
export const deliver = Effect.fn('deliver')(function* (owner: string) {
  const r = yield* Infrastructure;
  yield* attempt(() =>
    r.primary.begin(async (tx) => {
      const ownerRows = await tx`SELECT id FROM "user" WHERE id=${owner} FOR UPDATE`;
      if (!ownerRows.length) return;
      const receipts =
        await tx`SELECT * FROM ingestion_receipts WHERE owner_id=${owner} AND state='pending' ORDER BY created_at,environment_id,event_id LIMIT ${r.config.batchSize} FOR UPDATE`;
      if (!receipts.length) return;
      const rows =
        await tx`SELECT e.*,NOT EXISTS(SELECT 1 FROM site_suspensions WHERE site_id=s.id) AND NOT EXISTS(SELECT 1 FROM user_suspensions WHERE user_id=s.owner_id) AS permitted FROM environments e JOIN sites s ON s.id=e.site_id WHERE s.owner_id=${owner} ORDER BY s.id,e.id FOR KEY SHARE OF s,e`;
      {
        const analytics = tx;
        for (const receipt of receipts) {
          const raw = receipt.payload as Event;
          if (
            !raw ||
            raw.id !== receipt.event_id ||
            raw.siteId !== receipt.site_id ||
            (raw.environmentId ?? raw.siteId) !== receipt.environment_id ||
            units(raw) !== receipt.units
          )
            throw new Error('Invalid ingestion receipt');
          const env = rows.find((row: { id: string }) => row.id === receipt.environment_id);
          const event =
            env?.enabled && env.permitted && (!raw.localhost || env.allow_localhost)
              ? applyPolicy(raw, env.tracking_settings)
              : null;
          if (!event) {
            await analytics`DELETE FROM events WHERE site_id=${receipt.environment_id}::uuid AND id=${receipt.event_id}::uuid`;
            await analytics`DELETE FROM activity_events WHERE environment_id=${receipt.environment_id}::uuid AND id=${receipt.event_id}::uuid`;
            await analytics`DELETE FROM goal_conversions WHERE environment_id=${receipt.environment_id}::uuid AND event_id=${receipt.event_id}::uuid`;
            if (receipt.units)
              await tx`UPDATE billing_organization_usage SET events=greatest(0,events-${receipt.units / 100}) WHERE owner_id=${owner} AND site_id=${receipt.site_id}::uuid AND period_start=${new Date(receipt.period_start).toISOString()} AND organization_id=${catalog.organizationId}::uuid`;
          } else {
            if (event.activity?.kind !== 'engagement')
              await analytics`INSERT INTO events(site_id,id,received_at,day,type,name,path,referrer,country,device,visitor) VALUES(${receipt.environment_id}::uuid,${event.id}::uuid,${event.receivedAt},${event.day},${event.type},${event.name},${event.path},${event.referrer},${event.country},${event.device},${event.visitor}) ON CONFLICT DO NOTHING`;
            const a = event.activity;
            if (a)
              await analytics`INSERT INTO activity_events(environment_id,id,session_key,visitor_key,received_at,kind,name,path,referrer,country,device,browser,os,details) VALUES(${receipt.environment_id}::uuid,${event.id}::uuid,${a.sessionKey},${a.visitorKey},${event.receivedAt},${a.kind},${event.name},${event.path},${event.referrer},${event.country},${event.device},${a.browser},${a.os},${JSON.stringify(a.details)}::text::jsonb) ON CONFLICT DO NOTHING`;
            if (env.feature_settings.goals && a?.kind !== 'engagement') {
              const goals =
                await tx`SELECT id FROM conversion_goals WHERE environment_id=${receipt.environment_id}::uuid AND created_at<=${event.receivedAt} AND ((match_type='page' AND ${event.type}='pageview' AND match_value=${event.path}) OR (match_type='event' AND ${event.type}='event' AND match_value=${event.name}))`;
              for (const goal of goals)
                await analytics`INSERT INTO goal_conversions(goal_id,environment_id,event_id,received_at,day,visitor,path) VALUES(${goal.id}::uuid,${receipt.environment_id}::uuid,${event.id}::uuid,${event.receivedAt},${event.day},${event.visitor},${event.path}) ON CONFLICT DO NOTHING`;
            }
            if (receipt.units)
              await tx`INSERT INTO billing_outbox(owner_id,event_type,event_count,occurred_at,provider,organization_id) VALUES(${owner},${event.type},${receipt.units / 100},${event.receivedAt},'polar',${catalog.organizationId}::uuid)`;
          }
          await tx`UPDATE ingestion_receipts SET state=${event ? 'delivered' : 'cancelled'},payload=NULL WHERE environment_id=${receipt.environment_id}::uuid AND event_id=${receipt.event_id}::uuid AND state='pending'`;
        }
      }
    }),
  );
});

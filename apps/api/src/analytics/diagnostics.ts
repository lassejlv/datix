import { Effect, Schema, Clock } from 'effect';
import { Infrastructure } from '../platform/resources';
import { attempt, invalid, ApiError, attemptSync } from '../shared/errors';
import { decode, Id } from '../shared/validation';
import { hash, settings } from './tracking';
import { allowance } from '../billing/service';
const Input = Schema.Struct({
  siteId: Id,
  environmentId: Id,
  id: Id,
  pageId: Id,
  url: Schema.String.check(Schema.isMaxLength(2048)),
  kind: Schema.Literals(['error', 'vital']),
  payload: Schema.Unknown,
  consent: Schema.Boolean,
});
export function sanitize(value: string, max: number) {
  return (
    value
      // eslint-disable-next-line no-control-regex -- Reject control characters at the privacy boundary.
      .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '')
      .slice(0, max)
      .replace(/https?:\/\/[^\s)"']+/g, (value) => {
        try {
          const url = new URL(value);
          url.search = '';
          url.hash = '';
          url.username = '';
          url.password = '';
          return url.toString();
        } catch {
          return '';
        }
      })
      .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '[redacted]')
      .replace(/["'][^"'\n]*["']|\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]')
      .slice(0, max)
  );
}
function payload(kind: string, value: unknown) {
  if (kind === 'vital') {
    const input = decode(
      Schema.Struct({
        name: Schema.Literals(['CLS', 'LCP', 'INP']),
        value: Schema.Number.check(
          Schema.isGreaterThanOrEqualTo(0),
          Schema.isLessThanOrEqualTo(1800000),
        ),
      }),
      value,
    );
    if (input.name === 'CLS' && input.value > 100) throw invalid('Invalid Web Vital.');
    return input;
  }
  const input = decode(
      Schema.Struct({
        message: Schema.String,
        source: Schema.optional(Schema.String),
        stack: Schema.optional(Schema.String),
        line: Schema.optional(Schema.Number.check(Schema.isInt())),
        column: Schema.optional(Schema.Number.check(Schema.isInt())),
      }),
      value,
    ),
    message = sanitize(input.message, 500);
  if (!message.trim()) throw invalid('An error needs a message.');
  return {
    message,
    source: sanitize(input.source ?? '', 512),
    stack: sanitize(input.stack ?? '', 2000),
    line: Math.max(0, Math.min(1000000, input.line ?? 0)),
    column: Math.max(0, Math.min(1000000, input.column ?? 0)),
  };
}
export type Diagnostic = {
  site: string;
  env: string;
  id: string;
  page: string;
  at: string;
  kind: string;
  path: string;
  device: string;
  visitor: string;
  fingerprint: string;
  payload: ReturnType<typeof payload>;
  consent: boolean;
};
export const telemetry = Effect.fn('telemetry')(function* (
  body: unknown,
  headers: Headers,
  ip: string,
) {
  const r = yield* Infrastructure;
  const input = yield* attemptSync(() => decode(Input, body)),
    ua = (headers.get('user-agent') ?? '').slice(0, 512);
  if (headers.get('dnt') === '1' || /bot|crawler|spider|headless|lighthouse|curl|wget/i.test(ua))
    return { accepted: false };
  return yield* attempt(async () => {
    const secret = process.env.VISITOR_HASH_SECRET ?? r.config.BETTER_AUTH_SECRET;
    const count = Number(
      await r.redis.send('EVAL', [
        "local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],60) end;return n",
        '1',
        `${r.config.queuePrefix}:diagnostics:${hash(secret, ip)}`,
      ]),
    );
    if (count > 60)
      throw new ApiError({
        status: 429,
        code: 'rate_limited',
        message: 'Too many requests. Try again in a minute.',
      });
    const [env] =
      await r.primary`SELECT e.*,s.owner_id FROM environments e JOIN sites s ON s.id=e.site_id WHERE e.id=${input.environmentId}::uuid AND s.id=${input.siteId}::uuid`;
    if (!env) throw invalid('Environment not found.');
    if (
      !env.enabled ||
      !(
        env.feature_settings[input.kind === 'error' ? 'errors' : 'webVitals'] ??
        input.kind === 'vital'
      ) ||
      !(await allowance(r.primary, env.owner_id))
    )
      return { accepted: false };
    const page = new URL(input.url),
      local = ['localhost', '127.0.0.1', '[::1]'].includes(page.hostname);
    if (
      !['http:', 'https:'].includes(page.protocol) ||
      page.username ||
      page.password ||
      page.origin !== headers.get('origin') ||
      (page.hostname !== env.domain && !(local && env.allow_localhost))
    )
      throw invalid('Invalid website origin.');
    const data = payload(input.kind, input.payload),
      at = new Date().toISOString(),
      fields = data as Record<string, unknown>;
    const diagnostic: Diagnostic = {
      site: input.siteId,
      env: input.environmentId,
      id: input.id,
      page: input.pageId,
      at,
      kind: input.kind,
      path: page.pathname,
      device: settings(env.tracking_settings).device
        ? /iPad|Tablet/i.test(ua)
          ? 'tablet'
          : /Mobile|iPhone|Android/i.test(ua)
            ? 'mobile'
            : 'desktop'
        : '',
      visitor: hash(secret, [env.id, at.slice(0, 10), ip, ua]),
      fingerprint: hash(secret, [
        env.id,
        fields.name ?? null,
        fields.message ?? null,
        fields.source ?? null,
        fields.line ?? null,
      ]),
      payload: data,
      consent: input.consent,
    };
    await r.queue.add('diagnostic', { diagnostic });
    return { accepted: true };
  });
});
export const ingestDiagnostic = Effect.fn('ingestDiagnostic')(function* (d: Diagnostic) {
  const r = yield* Infrastructure;
  const now = yield* Clock.currentTimeMillis;
  if (Date.parse(d.at) < now - 30 * 86400000 || Date.parse(d.at) > now + 60000) return;
  const clean = payload(d.kind, d.payload);
  yield* attempt(() =>
    r.primary.begin(async (tx) => {
      const [owner] =
        await tx`SELECT s.owner_id FROM sites s JOIN environments e ON e.site_id=s.id WHERE s.id=${d.site}::uuid AND e.id=${d.env}::uuid`;
      if (!owner) return;
      await tx`SELECT id FROM "user" WHERE id=${owner.owner_id} FOR UPDATE`;
      const active = await allowance(tx, owner.owner_id);
      if (!active) return;
      const sites =
        await tx`SELECT id FROM sites WHERE owner_id=${owner.owner_id} ORDER BY created_at,id`;
      if (
        active.websiteLimit !== null &&
        sites.findIndex((s: { id: string }) => s.id === d.site) >= active.websiteLimit
      )
        return;
      const feature = d.kind === 'error' ? 'errors' : 'webVitals';
      const [row] =
        await tx`SELECT e.enabled AND s.enabled AND coalesce((e.feature_settings->>${feature})::boolean,${feature}='webVitals') AND (e.tracking_mode='cookieless' OR ${d.consent}) AND NOT EXISTS(SELECT 1 FROM user_suspensions WHERE user_id=s.owner_id) AND NOT EXISTS(SELECT 1 FROM site_suspensions WHERE site_id=s.id) AS allowed FROM environments e JOIN sites s ON s.id=e.site_id WHERE e.id=${d.env}::uuid AND s.id=${d.site}::uuid FOR KEY SHARE OF s,e`;
      if (!row?.allowed) return;
      const previous =
        await tx`SELECT * FROM diagnostic_events WHERE environment_id=${d.env}::uuid AND id=${d.id}::uuid ORDER BY received_at DESC LIMIT 1`;
      if (previous.length) {
        const old = previous[0];
        if (
          old.kind !== 'vital' ||
          d.kind !== 'vital' ||
          old.page_id !== d.page ||
          old.payload.name !== ('name' in clean ? clean.name : undefined) ||
          new Date(old.received_at).getTime() >= Date.parse(d.at)
        )
          return;
        await tx`DELETE FROM diagnostic_events WHERE environment_id=${d.env}::uuid AND id=${d.id}::uuid AND received_at=${old.received_at}`;
      }
      await tx`INSERT INTO diagnostic_events(environment_id,id,page_id,received_at,kind,path,device,visitor,fingerprint,payload) VALUES(${d.env}::uuid,${d.id}::uuid,${d.page}::uuid,${d.at},${d.kind},${d.path},${d.device},${d.visitor},${d.fingerprint},${JSON.stringify(clean)}::text::jsonb) ON CONFLICT DO NOTHING`;
    }),
  );
});

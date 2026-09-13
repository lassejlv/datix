import { Effect, Schema } from 'effect';
import { Infrastructure } from '../platform/resources';
import { attempt, invalid, ApiError, attemptSync } from '../shared/errors';
import { getEnvironment } from '../sites/service';
import { dateRange } from './reports';
import { overview } from './overview';
import { decode, Id, Name, id } from '../shared/validation';
import native from './sql/native.sql' with { type: 'text' };
const missing = () =>
  new ApiError({ status: 404, code: 'not_found', message: 'Feature not found.' });
export const configureFeature = Effect.fn('configureFeature')(function* (
  owner: string,
  site: string,
  key: string,
  feature: string,
  body: unknown,
) {
  const r = yield* Infrastructure;
  const env = yield* getEnvironment(owner, site, key);
  return yield* attempt(() =>
    r.primary.begin(async (tx) => {
      await tx`SELECT id FROM environments WHERE id=${env.id}::uuid FOR UPDATE`;
      if (feature === 'goals') {
        const input = decode(
          Schema.Struct({
            name: Name,
            matchType: Schema.Literals(['event', 'page']),
            matchValue: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(2048)),
          }),
          body,
        );
        if (
          input.matchType === 'event'
            ? !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(input.matchValue)
            : !input.matchValue.startsWith('/') || /[?#]/.test(input.matchValue)
        )
          throw invalid('Use an event name or a page path without a query string.');
        const [count] =
          await tx`SELECT count(*)::int AS n FROM conversion_goals WHERE environment_id=${env.id}::uuid`;
        if (count.n >= 20) throw invalid('An environment can have up to 20 goals.');
        const [row] =
          await tx`INSERT INTO conversion_goals(environment_id,name,match_type,match_value) VALUES(${env.id}::uuid,${input.name.trim()},${input.matchType},${input.matchValue}) ON CONFLICT DO NOTHING RETURNING id,name,match_type AS "matchType",match_value AS "matchValue"`;
        if (!row) throw invalid('A goal already tracks this conversion.');
        return { goal: row };
      }
      if (feature === 'annotations') {
        const input = decode(
          Schema.Union([
            Schema.Struct({
              action: Schema.Literal('create'),
              day: Schema.String,
              label: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(120)),
            }),
            Schema.Struct({ action: Schema.Literal('delete'), id: Id }),
          ]),
          body,
        );
        if (input.action === 'delete') {
          const rows =
            await tx`DELETE FROM overview_annotations WHERE environment_id=${env.id}::uuid AND id=${input.id}::uuid RETURNING id`;
          if (!rows.length) throw missing();
          return { deleted: true };
        }
        const range = dateRange({ from: input.day, to: input.day });
        const [count] =
          await tx`SELECT count(*)::int AS n FROM overview_annotations WHERE environment_id=${env.id}::uuid`;
        if (count.n >= 500) throw invalid('An environment can have up to 500 annotations.');
        const [row] =
          await tx`INSERT INTO overview_annotations(environment_id,day,label) VALUES(${env.id}::uuid,${range.from},${input.label.trim()}) RETURNING id,day::text,label`;
        return { annotation: row };
      }
      if (feature === 'errors') {
        const input = decode(
          Schema.Struct({ fingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/i)) }),
          body,
        );
        const exists =
          await r.analytics`SELECT 1 FROM diagnostic_events WHERE environment_id=${env.id}::uuid AND fingerprint=${input.fingerprint} AND kind='error' LIMIT 1`;
        if (exists.length)
          await tx`INSERT INTO error_resolutions(environment_id,fingerprint) VALUES(${env.id}::uuid,${input.fingerprint}) ON CONFLICT(environment_id,fingerprint) DO UPDATE SET resolved_at=now()`;
        return { resolved: true };
      }
      throw missing();
    }),
  );
});
export const deleteGoal = Effect.fn('deleteGoal')(function* (
  owner: string,
  site: string,
  key: string,
  goal: string,
) {
  const r = yield* Infrastructure;
  const env = yield* getEnvironment(owner, site, key);
  const rows = yield* attempt(
    () =>
      r.primary`DELETE FROM conversion_goals WHERE environment_id=${env.id}::uuid AND id=${id(goal)}::uuid RETURNING id`,
  );
  if (!rows.length) return yield* missing();
  return { deleted: true };
});
export const readFeature = Effect.fn('readFeature')(function* (
  owner: string,
  site: string,
  key: string,
  feature: string,
  query: Record<string, string>,
) {
  const r = yield* Infrastructure;
  const env = yield* getEnvironment(owner, site, key),
    range = yield* attemptSync(() => dateRange(query));
  if (feature === 'overview') return yield* overview(owner, site, key, query);
  return yield* attempt(async () => {
    const rows = await r.analytics.begin(async (tx) => {
      await tx`SET TRANSACTION READ ONLY`;
      if (feature === 'live')
        return tx`WITH recent AS MATERIALIZED (SELECT * FROM events WHERE site_id=${env.id}::uuid AND day>=current_date-1 AND received_at>now()-interval '5 minutes') SELECT jsonb_build_object('active',(SELECT count(DISTINCT(day,visitor)) FROM recent),'recent',coalesce((SELECT jsonb_agg(jsonb_build_object('path',path,'country',country,'at',received_at) ORDER BY received_at DESC) FROM (SELECT * FROM recent ORDER BY received_at DESC,id LIMIT 10) r),'[]'::jsonb))::text AS data`;
      if (feature === 'goals')
        return tx`SELECT goal_id,count(*)::bigint AS conversions,count(DISTINCT(day,visitor))::bigint AS visitors FROM goal_conversions WHERE environment_id=${env.id}::uuid AND day BETWEEN ${range.from} AND ${range.to} GROUP BY goal_id`;
      if (feature === 'web-vitals')
        return tx`SELECT jsonb_build_object('name',payload->>'name','device',device,'samples',count(*),'p75',percentile_cont(0.75) WITHIN GROUP(ORDER BY (payload->>'value')::double precision))::text AS data FROM diagnostic_events WHERE environment_id=${env.id}::uuid AND kind='vital' AND received_at>=${range.from}::date AND received_at<${range.to}::date+interval '1 day' GROUP BY payload->>'name',device ORDER BY payload->>'name',device`;
      if (feature === 'errors')
        return tx`SELECT jsonb_build_object('fingerprint',fingerprint,'message',(array_agg(payload->>'message' ORDER BY received_at DESC))[1],'source',(array_agg(payload->>'source' ORDER BY received_at DESC))[1],'stack',(array_agg(payload->>'stack' ORDER BY received_at DESC))[1],'path',(array_agg(path ORDER BY received_at DESC))[1],'occurrences',count(*),'visitors',count(DISTINCT(received_at::date,visitor)),'lastSeen',max(received_at),'resolved',false)::text AS data FROM diagnostic_events WHERE environment_id=${env.id}::uuid AND kind='error' AND received_at>=${range.from}::date AND received_at<${range.to}::date+interval '1 day' GROUP BY fingerprint ORDER BY max(received_at) DESC LIMIT 100`;
      throw missing();
    });
    if (feature === 'live') return JSON.parse(rows[0].data);
    if (feature === 'goals') {
      const definitions =
        await r.primary`SELECT id,name,match_type AS "matchType",match_value AS "matchValue",created_at AS "createdAt" FROM conversion_goals WHERE environment_id=${env.id}::uuid ORDER BY created_at,id`;
      const totals = await r.analytics.begin(async (tx) => {
        await tx`SET TRANSACTION READ ONLY`;
        return tx.unsafe(
          `${native} SELECT coalesce(sum(visitors),0)::bigint AS visitors FROM native`,
          [env.id, range.from, range.to],
        );
      });
      return {
        goals: definitions.map((goal: { id: string }) => {
          const count = rows.find((row: { goal_id: string }) => row.goal_id === goal.id);
          return {
            ...goal,
            conversions: Number(count?.conversions ?? 0),
            visitors: Number(count?.visitors ?? 0),
          };
        }),
        visitors: Number(totals[0].visitors),
      };
    }
    const items = rows.map((row: { data: string }) => JSON.parse(row.data));
    if (feature === 'errors') {
      const resolved =
        await r.primary`SELECT fingerprint,resolved_at FROM error_resolutions WHERE environment_id=${env.id}::uuid`;
      for (const item of items)
        item.resolved = resolved.some(
          (row: { fingerprint: string; resolved_at: Date }) =>
            row.fingerprint === item.fingerprint &&
            row.resolved_at.getTime() >= Date.parse(item.lastSeen),
        );
    }
    return { items };
  });
});

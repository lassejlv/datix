import { Effect, Schema } from 'effect';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Infrastructure } from '../platform/resources';
import { attempt, invalid, ApiError, attemptSync } from '../shared/errors';
import { getEnvironment } from '../sites/service';
import { dateRange } from './reports';
import { decode, id } from '../shared/validation';
import { hash } from './tracking';
import activity from './sql/activity.sql' with { type: 'text' };
import grouped from './sql/grouped.sql' with { type: 'text' };
import summaries from './sql/session_summaries.sql' with { type: 'text' };
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Cursor = Schema.Struct({
  version: Schema.Literal(1),
  scope: Hash,
  at: Schema.String,
  key: Schema.String,
  tie: Schema.String,
  sequence: Schema.Number.check(Schema.isInt()),
});
function signature(secret: string, payload: string) {
  return createHmac('sha256', secret).update(`session-cursor-v1:${payload}`).digest();
}
export const sessions = Effect.fn('sessions')(function* (
  owner: string,
  site: string,
  query: Record<string, string>,
) {
  const r = yield* Infrastructure;
  const env = yield* getEnvironment(owner, site, query.environment ?? site),
    range = yield* attemptSync(() => dateRange(query));
  const offset = yield* attemptSync(() =>
    decode(
      Schema.Number.check(Schema.isInt()).check(
        Schema.isGreaterThanOrEqualTo(0),
        Schema.isLessThanOrEqualTo(100000),
      ),
      Number(query.offset ?? 0),
    ),
  );
  const visitor = query.visitor ? yield* attemptSync(() => decode(Hash, query.visitor)) : null,
    session = query.session ? yield* attemptSync(() => decode(Hash, query.session)) : null;
  if (offset && query.cursor) return yield* invalid('Use a cursor or an offset, not both.');
  const secret = r.config.BETTER_AUTH_SECRET,
    scope = hash(secret, ['session-cursor-v1', env.id, range.from, range.to, visitor, session]);
  let cursor: typeof Cursor.Type | null = null;
  if (query.cursor) {
    try {
      const [payload, sig] = query.cursor.split('.');
      if (!payload || !sig || query.cursor.length > 2048) return yield* invalid();
      const actual = Buffer.from(sig, 'base64url'),
        expected = signature(secret, payload);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
        return yield* invalid();
      cursor = yield* attemptSync(() =>
        decode(Cursor, JSON.parse(Buffer.from(payload, 'base64url').toString())),
      );
      if (cursor.scope !== scope || !Number.isFinite(Date.parse(cursor.at)))
        return yield* invalid();
    } catch {
      return yield* invalid('Invalid pagination cursor for this report.');
    }
  }
  const next = (
    row:
      | {
          occurredAt?: string;
          lastSeenAt?: string;
          id: string;
          visitorKey?: string;
          details?: {
            sequence?: number;
          };
        }
      | undefined,
    detail: boolean,
  ) => {
    if (!row) return null;
    const payload = Buffer.from(
      JSON.stringify({
        version: 1,
        scope,
        at: row[detail ? 'occurredAt' : 'lastSeenAt'],
        key: row.id,
        tie: row.visitorKey ?? '',
        sequence: row.details?.sequence ?? 0,
      }),
    ).toString('base64url');
    return `${payload}.${signature(secret, payload).toString('base64url')}`;
  };
  return yield* attempt(() =>
    r.analytics.begin(async (tx) => {
      await tx`SET TRANSACTION READ ONLY`;
      if (session) {
        if (cursor) id(cursor.key);
        const rows = await tx.unsafe(
          `${activity} SELECT jsonb_build_object('id',id,'receivedAt',received_at,'occurredAt',occurred_at,'kind',kind,'name',name,'path',path,'referrer',referrer,'country',country,'device',device,'browser',browser,'os',os,'details',details)::text AS data FROM activity WHERE session_key=$5 AND kind<>'engagement' AND ($6::timestamptz IS NULL OR (occurred_at,coalesce((details->>'sequence')::int,0),id)>($6,$7,$8::uuid)) ORDER BY occurred_at,coalesce((details->>'sequence')::int,0),id LIMIT 201 OFFSET $9`,
          [
            env.id,
            range.from,
            range.to,
            visitor,
            session,
            cursor?.at ?? null,
            cursor?.sequence ?? 0,
            cursor?.key ?? null,
            offset,
          ],
        );
        if (!rows.length && !offset && !cursor)
          throw new ApiError({
            status: 404,
            code: 'session_not_found',
            message: 'Session not found in this environment and date range.',
          });
        const hasMore = rows.length > 200,
          events = rows.slice(0, 200).map((row: { data: string }) => JSON.parse(row.data));
        return {
          events,
          hasMore,
          nextOffset: offset + 200,
          nextCursor: hasMore ? next(events.at(-1), true) : null,
        };
      }
      const rows = await tx.unsafe(
        `${activity}, grouped AS MATERIALIZED (${grouped}) ${summaries}`,
        [
          env.id,
          range.from,
          range.to,
          visitor,
          cursor?.at ?? null,
          cursor?.key ?? null,
          cursor?.tie ?? null,
          offset,
        ],
      );
      const result = JSON.parse(Object.values(rows[0])[0] as string),
        hasMore = result.sessions.length > 50;
      result.sessions = result.sessions.slice(0, 50);
      return {
        ...result,
        range,
        retentionDays: 30,
        hasMore,
        nextOffset: offset + 50,
        nextCursor: hasMore ? next(result.sessions.at(-1), false) : null,
      };
    }),
  );
});

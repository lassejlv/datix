import { SQL } from 'bun';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { checkMigrations } from '../packages/database/src/migrations';
import { primaryTables, analyticsTables } from './migration/tables';
import { openTarget, identity, type Target } from './migration/target';

type Plan = {
  source: Target;
  sourceAnalytics?: Target;
  target: Target;
  rawFrom: string;
  batchSize?: number;
};

const { values } = parseArgs({
  options: {
    plan: { type: 'string' },
    apply: { type: 'boolean' },
    verify: { type: 'boolean' },
    'source-quiesced': { type: 'boolean' },
    snapshot: { type: 'boolean' },
    'targets-quiesced': { type: 'boolean' },
    report: { type: 'string' },
  },
  strict: true,
});

if (!values.plan)
  throw new Error('Use --plan <reviewed-json-file>. Default mode is read-only inventory.');
if (values.apply && values.verify) throw new Error('Choose --apply or --verify');
if (
  values.apply &&
  (!values['targets-quiesced'] ||
    Number(!!values['source-quiesced']) + Number(!!values.snapshot) !== 1)
)
  throw new Error('StopTargetWritersAndChooseSnapshotOrQuiescedSource');
const plan: Plan = await Bun.file(values.plan).json();
if (
  !/^\d{4}-\d{2}-\d{2}$/.test(plan.rawFrom) ||
  !Number.isFinite(Date.parse(plan.rawFrom)) ||
  new Date(plan.rawFrom).toISOString().slice(0, 10) !== plan.rawFrom ||
  plan.rawFrom > new Date().toISOString().slice(0, 10)
)
  throw new Error('ReviewFirstCompleteRawDay');
const batchSize = plan.batchSize ?? 500;
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 2000)
  throw new Error('BatchSizeMustBe1To2000');

const endpoint = (target: Target) =>
  `${target.host.replace('-pooler.', '.')}:${target.port}/${target.database}`;

if (endpoint(plan.source) === endpoint(plan.target))
  throw new Error('SourceAndTargetsMustBeDistinct');
if (plan.sourceAnalytics && endpoint(plan.target) === endpoint(plan.sourceAnalytics))
  throw new Error('SourceAndTargetsMustBeDistinct');
const digest = createHash('sha256').update(JSON.stringify(plan)).digest('hex');

const source = openTarget(plan.source, false),
  primary = openTarget(plan.target, true);

const analytics = primary;
const sourceAnalytics = plan.sourceAnalytics ? openTarget(plan.sourceAnalytics, false) : null;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

const list = (names: readonly string[], prefix = '') =>
  names.map((n) => `${prefix}${quote(n)}`).join(',');

const tableName = (table: string) => `public.${quote(table)}`;

const report: Record<string, unknown> = {
  plan: digest,
  mode: values.apply
    ? values.snapshot
      ? 'copy_snapshot'
      : 'copy_quiesced'
    : values.verify
      ? 'verify'
      : 'inventory',
  rawFrom: plan.rawFrom,
  startedAt: new Date().toISOString(),
  tables: [],
};

const results = report.tables as Record<string, unknown>[];
type Connection = SQL;
type Column = { name: string; generated: string };

async function columns(db: Connection, table: string): Promise<Column[]> {
  return db`select column_name as name,is_generated as generated from information_schema.columns where table_schema='public' and table_name=${table} order by ordinal_position`;
}

async function copyTable(
  src: Connection,
  target: SQL,
  table: string,
  keys: readonly string[],
  receipt = false,
) {
  const targetColumns = await columns(target, table),
    sourceColumns = receipt ? targetColumns : await columns(src, table);

  if (!sourceColumns.length || !targetColumns.length) throw new Error(`MissingTable:${table}`);
  const names = sourceColumns.filter((c) => c.generated === 'NEVER').map((c) => c.name);
  if (
    names.some((name) => !targetColumns.some((c) => c.name === name)) ||
    keys.some((key) => !names.includes(key))
  )
    throw new Error(`SchemaMismatch:${table}`);

  const from = receipt
    ? `(select r.environment_id,r.id as event_id,s.owner_id,e.site_id,min(r.received_at) as period_start,
    max(r.received_at)+interval '1 day' as period_end,0::int as units,null::jsonb as payload,'delivered'::text as state,min(r.received_at) as created_at
    from event_receipts r join environments e on e.id=r.environment_id join sites s on s.id=e.site_id group by r.environment_id,r.id,s.owner_id,e.site_id)`
    : tableName(table);

  const where =
    !plan.sourceAnalytics && table === 'daily_stats'
      ? 't.day < $1::date'
      : !plan.sourceAnalytics && table === 'events'
        ? `$1::date IS NOT NULL AND NOT EXISTS(SELECT 1 FROM activity_events a WHERE a.environment_id=t.site_id AND a.id=t.id AND a.kind='engagement')`
        : '$1::date IS NOT NULL';

  const [{ count }] = await src.unsafe(
    `select count(*)::text as count from ${from} t where ${where}`,
    [plan.rawFrom],
  );

  const entry = {
    table,
    store: 'neon',
    rows: count,
    verified: 0,
    batches: 0,
  };

  results.push(entry);

  if (!values.apply && !values.verify) {
    console.log(JSON.stringify(entry));

    return;
  }

  const cursorRecord = receipt
    ? 'jsonb_to_record($2::jsonb) as c(environment_id uuid,event_id uuid)'
    : `jsonb_populate_record(null::${tableName(table)},$2::jsonb) c`;

  let cursor: string | null = null,
    copied = 0;

  const updates = names.filter((name) => !keys.includes(name));

  const conflict = updates.length
    ? `do update set ${updates.map((n) => `${quote(n)}=excluded.${quote(n)}`).join(',')}`
    : 'do nothing';

  while (true) {
    const batch: { data: string }[] = await src.unsafe(
      `select to_jsonb(r)::text as data from (select ${list(names, 't.')} from ${from} t where ${where}
      and ($2::jsonb is null or row(${list(keys, 't.')}) > (select ${list(keys, 'c.')} from ${cursorRecord}))
      order by ${list(keys, 't.')} limit $3) r`,
      [plan.rawFrom, cursor, batchSize],
    );

    if (!batch.length) break;
    const data = `[${batch.map((r) => r.data).join(',')}]`;
    if (Buffer.byteLength(data) > 16 * 1024 * 1024)
      throw new Error(`BatchTooLarge:reduceBatchSize:${table}`);
    await target.begin(async (tx) => {
      if (values.apply)
        await tx.unsafe(
          `insert into ${tableName(table)} (${list(names)}) overriding system value
        select ${list(names)} from jsonb_populate_recordset(null::${tableName(table)},$1::jsonb)
        on conflict (${list(keys)}) ${conflict}`,
          [data],
        );

      const [{ matched }] = await tx.unsafe(
        `with incoming as (select * from jsonb_populate_recordset(null::${tableName(table)},$1::jsonb))
        select count(*)::int as matched from incoming i join ${tableName(table)} t on ${keys.map((k) => `t.${quote(k)}=i.${quote(k)}`).join(' and ')}
        where row(${list(names, 't.')}) is not distinct from row(${list(names, 'i.')})`,
        [data],
      );

      if (matched !== batch.length) throw new Error(`DataReconciliationFailed:${table}`);
    });
    copied += batch.length;
    entry.verified = copied;
    entry.batches++;
    cursor = batch.at(-1)!.data;
    if (entry.batches % 20 === 0) console.log(JSON.stringify({ table, copied, total: count }));
  }

  const [{ count: targetCount }] = await target.unsafe(
    `select count(*)::text as count from ${tableName(table)}`,
  );

  if (BigInt(targetCount) !== BigInt(count) || BigInt(copied) !== BigInt(count))
    throw new Error(`RowCountMismatch:${table}`);
  console.log(JSON.stringify(entry));
}

try {
  report.targets = await Promise.all([
    identity(source, plan.source),
    ...(sourceAnalytics && plan.sourceAnalytics
      ? [identity(sourceAnalytics, plan.sourceAnalytics)]
      : []),
    identity(primary, plan.target),
  ]);
  await checkMigrations(primary);
  await source.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (src) => {
    const [snapshot] =
      await src`select transaction_timestamp() as at,current_setting('transaction_read_only') as read_only`;

    if (snapshot.read_only !== 'on') throw new Error('SourceMustBeReadOnly');
    report.snapshotAt = snapshot.at;

    if (!sourceAnalytics) {
      // Full retained days must reconcile before their legacy totals can be omitted.
      const [{ mismatches }] = await src.unsafe(
        `with raw as (select site_id,day,count(*) filter(where type='pageview') as pageviews,
      count(*) filter(where type='event') as custom_events,count(distinct visitor) filter(where type='pageview') as visitors from events e where day >= $1::date AND NOT EXISTS(SELECT 1 FROM activity_events a WHERE a.environment_id=e.site_id AND a.id=e.id AND a.kind='engagement') group by site_id,day),
      totals as (select site_id,day,pageviews,custom_events,visitors from daily_stats where dimension='total' and day >= $1::date)
      select count(*)::int as mismatches from raw full join totals using(site_id,day)
      where coalesce(raw.pageviews,0)<>coalesce(totals.pageviews,0) or coalesce(raw.custom_events,0)<>coalesce(totals.custom_events,0) or coalesce(raw.visitors,0)<>coalesce(totals.visitors,0)`,
        [plan.rawFrom],
      );

      if (mismatches) throw new Error('RawHistoryDoesNotReconcile:chooseACompleteRawFromDay');
    }

    if (values.apply)
      await primary.begin(async (tx) => {
        const [{ journal }] =
          await tx`select to_regclass('public.datix_copy_state')::text as journal`;

        if (!journal) {
          for (const [target, tables] of [
            [tx, [...primaryTables, ['ingestion_receipts', []], ['analytics_deletions', []]]],
            [tx, analyticsTables],
          ] as const) {
            for (const [table] of tables) {
              const [{ exists }] = await target.unsafe(
                `select exists(select 1 from ${tableName(table)} limit 1) as exists`,
              );

              if (exists) throw new Error(`FirstCopyRequiresEmptyTargets:${table}`);
            }
          }

          await tx`create table datix_copy_state(plan_hash text primary key,started_at timestamptz not null default now(),completed_at timestamptz)`;
          await tx`insert into datix_copy_state(plan_hash) values(${digest})`;
        } else {
          const rows = await tx`select plan_hash from datix_copy_state`;
          if (rows.length !== 1 || rows[0].plan_hash !== digest)
            throw new Error('ResumeRequiresIdenticalReviewedPlan');
        }
      });
    for (const [table, keys] of primaryTables) await copyTable(src, primary, table, keys);

    if (sourceAnalytics) {
      await sourceAnalytics.begin(
        'ISOLATION LEVEL REPEATABLE READ READ ONLY',
        async (analyticsSource) => {
          report.analyticsSnapshotAt = (
            await analyticsSource`select transaction_timestamp() as at`
          )[0].at;
          for (const [table, keys] of analyticsTables)
            await copyTable(analyticsSource, analytics, table, keys);
        },
      );
      await copyTable(src, primary, 'ingestion_receipts', ['environment_id', 'event_id']);
      await copyTable(src, primary, 'analytics_deletions', ['environment_id']);
    } else {
      for (const [table, keys] of analyticsTables) await copyTable(src, analytics, table, keys);
      await copyTable(src, primary, 'ingestion_receipts', ['environment_id', 'event_id'], true);
    }

    if (values.apply) {
      await primary`select setval(pg_get_serial_sequence('admin_audit_log','id'),greatest(coalesce(max(id),1),1),count(*)>0) from admin_audit_log`;
      await primary`update datix_copy_state set completed_at=now() where plan_hash=${digest}`;
    }
  });
  report.completedAt = new Date().toISOString();
  report.ok = true;
  console.log(
    JSON.stringify({ ok: true, plan: digest, tables: results.length, mode: report.mode }),
  );
} catch (error) {
  report.ok = false;

  if (error instanceof SQL.PostgresError) {
    report.databaseCode = error.errno;
    if (plan.source.host === '127.0.0.1' && process.env.COPY_LOCAL_DIAGNOSTICS === '1')
      console.error(error.message);
  }

  report.error =
    error instanceof Error
      ? error.name === 'Error'
        ? error.message
        : error.name
      : 'MigrationFailed';
  console.error(JSON.stringify({ ok: false, error: report.error }));
  process.exitCode = 1;
} finally {
  if (values.report) await Bun.write(resolve(values.report), JSON.stringify(report, null, 2));
  await Promise.allSettled([source.close(), sourceAnalytics?.close(), primary.close()]);
}

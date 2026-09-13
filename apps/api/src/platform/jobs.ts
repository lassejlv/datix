import { Clock, Effect, Layer, Schedule, Schema } from 'effect';
import { Worker } from 'bullmq';
import { Infrastructure } from './resources';
import { attempt, invalid } from '../shared/errors';
import { deliver } from '../analytics/ingestion';
import { ingestDiagnostic, type Diagnostic } from '../analytics/diagnostics';
import { cleanDeletedEnvironments, retain } from '../analytics/maintenance';
import { drainBilling, refreshBilling } from '../billing/polar';

const Delivery = Schema.Struct({ owner: Schema.NonEmptyString });
const startWorker = Effect.fn('startWorker')(function* () {
  const r = yield* Infrastructure;
  if (r.config.role === 'api') return;
  const clock = yield* Clock.Clock;
  const worker = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const worker = new Worker<{ owner?: string; diagnostic?: Diagnostic }>(
        'ingestion',
        (job) =>
          Effect.runPromise(
            Effect.gen(function* () {
              if (job.name === 'diagnostic' && job.data.diagnostic) {
                yield* ingestDiagnostic(job.data.diagnostic);
                return;
              }
              if (job.name !== 'deliver') return yield* invalid('Invalid ingestion job.');
              const data = yield* Schema.decodeUnknownEffect(Delivery)(job.data).pipe(
                Effect.mapError(() => invalid('Invalid delivery job.')),
              );
              yield* deliver(data.owner);
            }).pipe(Effect.provideService(Infrastructure, r), Effect.uninterruptible),
          ),
        {
          connection: r.queueConnection,
          prefix: r.config.queuePrefix,
          concurrency: r.config.workers,
        },
      );
      worker.on('error', () => console.error('Ingestion worker connection error'));
      return worker;
    }),
    (worker) =>
      Effect.promise(async () => {
        r.workerHealthy = () => false;
        await worker.close();
      }),
  );
  yield* attempt(() => worker.waitUntilReady());
  let recoveredAt = yield* Clock.currentTimeMillis,
    maintenanceAt = 0;
  r.workerHealthy = () =>
    worker.isRunning() &&
    !worker.isPaused() &&
    clock.currentTimeMillisUnsafe() - recoveredAt < 120_000;
  const recover = Effect.gen(function* () {
    const owners = yield* attempt(
      () =>
        r.sql`SELECT owner_id FROM ingestion_receipts WHERE state='pending' GROUP BY owner_id ORDER BY min(created_at) LIMIT 16`,
    );
    for (const row of owners)
      yield* attempt(() =>
        r.queue.add('deliver', { owner: row.owner_id }, { deduplication: { id: row.owner_id } }),
      );
    yield* cleanDeletedEnvironments();
    recoveredAt = yield* Clock.currentTimeMillis;
    yield* drainBilling();
    if (recoveredAt - maintenanceAt > 60_000) {
      yield* refreshBilling();
      yield* retain();
      maintenanceAt = yield* Clock.currentTimeMillis;
    }
  }).pipe(
    // Native SQL must finish its transaction before shutdown releases the connection pool.
    Effect.uninterruptible,
    Effect.catch((error) => Effect.logError('Background recovery failed; retrying', error.code)),
    Effect.repeat(Schedule.spaced('10 seconds')),
  );
  yield* Effect.forkScoped(recover);
});
export const WorkersLive = Layer.effectDiscard(startWorker());

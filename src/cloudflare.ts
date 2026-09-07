import { flushUsage } from './billing/delivery.server';
import handler from '@tanstack/react-start/server-entry';
import { api } from './api/router.server';
import { withDatabase } from './db/client.server';
import { consume } from './analytics/queue.server';
import { retain } from './analytics/retention.server';

export default {
  fetch(request, env) {
    if (new URL(request.url).pathname.startsWith('/api/')) return api(request, env);
    return handler.fetch(request);
  },
  queue: consume,
  async scheduled(controller, env) {
    if (controller.cron === '* * * * *') {
      await flushUsage(env, 5);
      return;
    }
    const result = await withDatabase(env, (db) => retain(db));
    console.log(JSON.stringify({ event: 'retention', ...result }));
  },
} satisfies ExportedHandler<Env>;

import { resolve } from 'node:path';

process.chdir(resolve(import.meta.dir, '..'));
const appUrl = process.env.DEV_APP_URL ?? 'http://localhost:3000';

const common = {
  ...process.env,
  APP_URL: appUrl,
  NODE_ENV: 'development',
  EXTERNAL_EFFECTS: 'disabled',
  BILLING_STATE_MODE: 'snapshot',
  QUEUE_PREFIX: 'datix-dev',
};

const api = Bun.spawn(['bun', '--watch', 'apps/api/src/main.ts'], {
  env: { ...common, PORT: process.env.DEV_API_PORT ?? '3001' },
  stdout: 'inherit',
  stderr: 'inherit',
});

const web = Bun.spawn(
  [
    'bun',
    'run',
    'dev:frontend',
    '--',
    '--host',
    '127.0.0.1',
    '--port',
    new URL(appUrl).port || '3000',
  ],
  { cwd: 'apps/web', env: common, stdout: 'inherit', stderr: 'inherit' },
);

function stop() {
  api.kill('SIGTERM');
  web.kill('SIGTERM');
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
await Promise.race([api.exited, web.exited]);
stop();
await Promise.all([api.exited, web.exited]);

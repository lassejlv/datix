import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

const root = resolve(import.meta.dir, '../..');
process.chdir(root);

// Do not inherit the root .env (production), even when invoked by `bun run dev`.
const file = resolve(root, process.env.DATIX_DEV_ENV ?? '.local/rust.env');
const configured = parseEnv(await Bun.file(file).text());
const database = new URL(configured.DATABASE_URL ?? 'invalid:');

if (
  database.hostname !== 'ep-sweet-sun-b1ynkxmz-pooler.c-5.eu-central-1.aws.neon.tech' ||
  database.pathname !== '/datix' ||
  !configured.QUEUE_PREFIX?.startsWith('datix-rust-dev-')
)
  throw new Error('Development requires the isolated Rust Neon branch and a dev queue prefix.');

const os = Object.fromEntries(
  ['PATH', 'HOME', 'TMPDIR', 'TERM', 'LANG', 'RUSTUP_HOME', 'CARGO_HOME']
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]!]),
);

const appUrl = new URL(process.env.DEV_APP_URL ?? 'http://localhost:3000');

if (appUrl.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(appUrl.hostname))
  throw new Error('DEV_APP_URL must be a local HTTP origin.');

const apiPort = process.env.DEV_API_PORT ?? '3001';

const runtime: Record<string, string> = {
  ...os,
  ...configured,
  APP_URL: appUrl.origin,
  PORT: apiPort,
  SERVICE_ROLE: 'combined',
  EXTERNAL_EFFECTS: 'disabled',
  BILLING_STATE_MODE: 'snapshot',
};

delete runtime.DATABASE_URL_UNPOOLED;

const children: Bun.Subprocess[] = [];
let stopping = false;

function stop() {
  stopping = true;

  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  }
}

function spawn(command: string[], env: Record<string, string>) {
  const child = Bun.spawn(command, { cwd: root, env, stdout: 'inherit', stderr: 'inherit' });
  children.push(child);

  return child;
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);

const build = spawn(['cargo', 'build', '--locked', '-p', 'datix-api'], os);
const buildCode = await build.exited;

if (buildCode !== 0 || stopping) process.exit(buildCode || 0);

const vitals = spawn(['bun', '--no-env-file', 'web/scripts/build-vitals.ts'], os);
const vitalsCode = await vitals.exited;

if (vitalsCode !== 0 || stopping) process.exit(vitalsCode || 0);

const api = spawn([resolve(root, 'target/debug/datix-api')], runtime);

const web = spawn(
  [
    'bun',
    '--no-env-file',
    'web/node_modules/vite/bin/vite.js',
    '--config',
    'web/vite.config.ts',
    '--host',
    '127.0.0.1',
    '--port',
    appUrl.port || '3000',
    '--strictPort',
  ],
  { ...os, DEV_API_PORT: apiPort },
);

const code = await Promise.race([api.exited, web.exited]);
stop();
await Promise.all(children.map((child) => child.exited));
process.exitCode = code;

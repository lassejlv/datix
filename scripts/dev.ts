const frontendPort = process.env.DEV_PORT ?? '3000';
const apiPort = process.env.DEV_API_PORT ?? '3001';
const env = {
  ...process.env,
  APP_URL: process.env.APP_URL ?? `http://localhost:${frontendPort}`,
  DEV_API_PORT: apiPort,
};
const backend = Bun.spawn([process.execPath, '--watch', 'src/runtime/web.ts'], {
  env: { ...env, PORT: apiPort },
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
const frontend = Bun.spawn(
  [
    process.execPath,
    '--bun',
    'vite',
    'dev',
    '--host',
    '127.0.0.1',
    '--port',
    frontendPort,
    '--strictPort',
  ],
  { env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
);
let stopping = false;
async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  frontend.kill('SIGTERM');
  backend.kill('SIGTERM');
  await Promise.allSettled([frontend.exited, backend.exited]);
  process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void stop(0));
await Promise.race([frontend.exited, backend.exited]).then((code) => stop(code));

export {};

// Keep operational paths stable when invoked from either the repository or web/.
process.chdir(new URL('../..', import.meta.url).pathname);
// Runs only against the explicitly configured isolated Neon test branch.
const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  new URL(url).hostname !== process.env.TEST_DATABASE_HOST ||
  new URL(url).hostname === new URL(process.env.DATABASE_URL!).hostname
)
  throw new Error('An isolated test branch is required.');
const command = process.argv.slice(2);
if (!command.length) throw new Error('Provide a command.');
const child = Bun.spawn(command, {
  env: {
    ...process.env,
    DATABASE_URL: url,
    REDIS_URL: 'redis://127.0.0.1:6394',
    PORT: '3057',
    APP_URL: 'http://localhost:3057',
    EVENT_STREAM: 'analytics:rust-qa:events',
    POLAR_ACCESS_TOKEN: '',
    POLAR_WEBHOOK_SECRET: '',
    QA_BASE_URL: 'http://localhost:3057',
    SMOKE_BASE_URL: 'http://127.0.0.1:3057',
    SMOKE_APP_ORIGIN: 'http://localhost:3057',
  },
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
process.exit(await child.exited);

export {};

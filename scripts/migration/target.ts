import { SQL } from 'bun';

export type Target = {
  host: string;
  port: number;
  database: string;
  role: string;
  urlEnv: string;
  projectId?: string;
  branchId?: string;
};

export function openTarget(target: Target, writable: boolean) {
  for (const name of ['host', 'database', 'role', 'urlEnv'] as const)
    if (typeof target[name] !== 'string' || !target[name])
      throw new Error(`MissingReviewedTarget:${name}`);
  const value = process.env[target.urlEnv];
  if (!value) throw new Error(`MissingURLVariable:${target.urlEnv}`);
  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== target.host ||
    +(url.port || '5432') !== target.port ||
    decodeURIComponent(url.username) !== target.role ||
    decodeURIComponent(url.pathname.slice(1)) !== target.database
  )
    throw new Error('ReviewedTargetMismatch');
  if (url.hostname.includes('-pooler.')) throw new Error('UseDirectMigrationEndpoint');
  if (writable && url.hostname.startsWith('ep-soft-morning-b18e39wv'))
    throw new Error('ProductionTargetForbidden');
  const privateHost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!privateHost && !['require', 'verify-full'].includes(url.searchParams.get('sslmode') ?? ''))
    throw new Error('RemoteDatabaseRequiresTLS');
  url.searchParams.set(
    'options',
    `-c default_transaction_read_only=${writable ? 'off' : 'on'} -c timezone=UTC -c statement_timeout=60000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=180000`,
  );

  return new SQL(url.toString(), {
    max: 1,
    prepare: false,
    connectionTimeout: 10,
    connection: {
      application_name: 'datix-data-copy',
    },
  });
}

export async function identity(db: SQL, expected: Target) {
  const [actual] =
    await db`select current_database() as database,current_user as role,inet_server_addr()::text as address`;

  if (actual.database !== expected.database || actual.role !== expected.role)
    throw new Error('LiveDatabaseIdentityMismatch');

  return {
    host: expected.host,
    database: actual.database,
    role: actual.role,
    address: actual.address,
  };
}

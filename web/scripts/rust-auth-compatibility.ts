// Keep operational paths stable when invoked from either the repository or web/.
process.chdir(new URL('../..', import.meta.url).pathname);
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { database, createAuth } from '../tests/fixtures/legacy-auth';
const client = new Client({ connectionString: process.env.DATABASE_URL });
const origin = process.env.APP_URL!;
const legacy = createAuth(database(client), {
  APP_URL: origin,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET!,
});
const email = `rust-compat-${crypto.randomUUID()}@example.com`;
const password = 'Migration café ① password';
let userId = '';
const cookie = (r: Response) =>
  r.headers
    .getSetCookie()
    .map((s) => s.split(';')[0])
    .join('; ');
const legacyRequest = (path: string, body: unknown, cookie = '') =>
  legacy.handler(
    new Request(`${origin}/api/auth/${path}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
  );
const rustRequest = (path: string, body?: unknown, cookie = '') =>
  fetch(`http://127.0.0.1:3057/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
try {
  await client.connect();
  const signup = await legacyRequest('sign-up/email', {
    email,
    password,
    name: 'Legacy migration fixture',
  });
  assert.equal(signup.status, 200);
  userId = ((await signup.json()) as any).user.id;
  const oldCookie = cookie(signup);
  const me = await rustRequest('me', undefined, oldCookie);
  assert.equal(me.status, 200);
  assert.equal(((await me.json()) as any).user.id, userId);
  console.log('PASS Rust accepts an actual Better Auth session cookie and database session');
  const signin = await rustRequest('auth/sign-in/email', { email, password });
  assert.equal(signin.status, 200);
  const newCookie = cookie(signin);
  console.log(
    'PASS Rust signs in an existing Better Auth password including Unicode normalization',
  );
  const nextPassword = 'New migration café ② password';
  const change = await rustRequest(
    'auth/change-password',
    { currentPassword: password, newPassword: nextPassword, revokeOtherSessions: true },
    newCookie,
  );
  assert.equal(change.status, 200);
  assert.equal((await rustRequest('me', undefined, oldCookie)).status, 401);
  assert.equal((await rustRequest('me', undefined, newCookie)).status, 401);
  assert.equal((await rustRequest('me', undefined, cookie(change))).status, 200);
  console.log(
    'PASS Password change rotates the current cookie and immediately revokes prior sessions',
  );
  const rollbackSignin = await legacyRequest('sign-in/email', { email, password: nextPassword });
  assert.equal(rollbackSignin.status, 200);
  console.log(
    'PASS Old backend accepts the Rust-written password, preserving rollback compatibility',
  );
  const legacySession = await legacy.api.getSession({
    headers: new Headers({ cookie: cookie(change) }),
  });
  assert.equal(legacySession?.user.id, userId);
  console.log('PASS Old backend accepts Rust-created signed cookies and sessions');
  const temporary = await rustRequest('auth/sign-in/email', {
    email,
    password: nextPassword,
    rememberMe: false,
  });
  assert.equal(temporary.status, 200);
  const sessionCookie = temporary.headers
    .getSetCookie()
    .find((value) => value.includes('session_token='))!;
  assert.ok(!sessionCookie.includes('Max-Age'));
  assert.ok(temporary.headers.getSetCookie().some((value) => value.includes('dont_remember=')));
  const temporarySession = await rustRequest('auth/get-session', undefined, cookie(temporary));
  assert.equal(temporarySession.status, 200);
  assert.equal(temporarySession.headers.getSetCookie().length, 0);
  const expiry = new Date(((await temporarySession.json()) as any).session.expiresAt).getTime();
  assert.ok(expiry > Date.now() + 23 * 3600000 && expiry <= Date.now() + 24 * 3600000);
  assert.equal((await rustRequest('auth/list-sessions', undefined, cookie(temporary))).status, 200);
  console.log(
    'PASS Non-remembered sessions use browser cookies and a one-day expiry without silent renewal',
  );
} finally {
  if (userId) await client.query('delete from "user" where id=$1 and email=$2', [userId, email]);
  await client.end();
}

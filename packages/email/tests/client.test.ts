import { expect, test } from 'bun:test';
import { createEmail } from '../src/client';

test('email uses EMAIL_FROM by default and preserves explicit sender overrides', async () => {
  const email = createEmail({
    CLOUDFLARE_API_TOKEN: 'test-token',
    CLOUDFLARE_ACCOUNT_ID: 'test-account',
    EMAIL_FROM: ' default@example.com ',
    EXTERNAL_EFFECTS: 'enabled',
    BILLING_STATE_MODE: 'live',
  });

  const senders: unknown[] = [];

  email.adapter('cloudflare').send = async (message) => {
    senders.push(message.from);

    return { adapter: 'cloudflare', id: 'test-id' };
  };

  const message = { to: 'recipient@example.com', subject: 'Test', text: 'Test' };

  await email.send(message);
  await email.send({ ...message, from: 'override@example.com' });
  expect(senders).toEqual(['default@example.com', 'override@example.com']);
});

test('email rejects sends with no default or explicit sender', async () => {
  const email = createEmail({
    CLOUDFLARE_API_TOKEN: 'test-token',
    CLOUDFLARE_ACCOUNT_ID: 'test-account',
    EMAIL_FROM: ' ',
  });

  await expect(
    email.send({ to: 'recipient@example.com', subject: 'Test', text: 'Test' }),
  ).rejects.toThrow('Email requires EMAIL_FROM or an explicit from address');
});

test('email setup requires Cloudflare credentials', () => {
  expect(() => createEmail({})).toThrow('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID');
});

test('disabled external effects and snapshots prevent email delivery', async () => {
  for (const mode of [
    {},
    { EXTERNAL_EFFECTS: 'disabled' },
    { EXTERNAL_EFFECTS: 'enabled', BILLING_STATE_MODE: 'snapshot' },
  ]) {
    const email = createEmail({
      CLOUDFLARE_API_TOKEN: 'test-token',
      CLOUDFLARE_ACCOUNT_ID: 'test-account',
      ...mode,
    });

    // Fail if the guard ever allows the SDK to reach the provider.
    email.adapter('cloudflare').send = async () => {
      throw new Error('Unexpected provider call');
    };

    await expect(
      email.send({
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test',
        text: 'Test',
      }),
    ).rejects.toMatchObject({ cause: { message: 'External email sending is disabled' } });
  }
});

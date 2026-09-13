import { mock } from 'bun:test';

// Loaded only by the integration subprocess; tokens stay in the parent's memory.
if (process.env.NODE_ENV !== 'test' || !process.send)
  throw new Error('Integration email capture requires the isolated test subprocess');

mock.module('@datix/email', () => ({
  async sendVerificationEmail(data: { user: { email: string }; url: string }) {
    process.send!({ email: data.user.email, url: data.url });
  },
}));

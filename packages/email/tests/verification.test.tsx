import { expect, test } from 'bun:test';
import { renderEmail } from '@opencoredev/email-sdk/react';
import { VerificationEmail } from '../src/verification';

test('verification email renders safe HTML and usable plain text in both themes', async () => {
  const url =
    'https://datix.example/api/auth/verify-email?token=test-token&callbackURL=%2Fdashboard';

  for (const theme of ['light', 'dark'] as const) {
    const content = await renderEmail(
      <VerificationEmail name={'<script>alert("test")</script>'} url={url} theme={theme} />,
    );

    expect(content.html).toContain('Verify email address');
    expect(content.html).not.toContain('<script>');
    expect(content.html).toContain('&lt;script&gt;');
    expect(content.text).toContain(url);
    expect(content.text).toContain('one hour');
  }
});

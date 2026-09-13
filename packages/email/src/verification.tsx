import {
  EmailButton,
  EmailCard,
  EmailHeading,
  EmailText,
  ShadcnEmail,
  renderEmail,
} from '@opencoredev/email-sdk/react';
import { createEmail } from './client';

export type VerificationEmailProps = {
  name: string;
  url: string;
  theme?: 'light' | 'dark';
};

export function VerificationEmail({ name, url, theme = 'light' }: VerificationEmailProps) {
  return (
    <ShadcnEmail preview="Verify your email to get started with Datix." theme={theme}>
      <EmailCard>
        <EmailText muted>Datix</EmailText>
        <EmailHeading>Verify your email address</EmailHeading>
        <EmailText>
          Hi {name}, confirm your email address to finish creating your Datix account.
        </EmailText>
        <EmailButton href={url}>Verify email address</EmailButton>
        <EmailText>This link expires in one hour.</EmailText>
        <EmailText muted>
          If the button doesn’t work, copy and paste this link into your browser:
        </EmailText>
        <EmailText style={{ overflowWrap: 'anywhere' }}>
          <a href={url}>{url}</a>
        </EmailText>
        <EmailText muted>If you didn’t request this email, you can ignore it.</EmailText>
      </EmailCard>
    </ShadcnEmail>
  );
}

export async function sendVerificationEmail({
  user,
  url,
}: {
  user: { name: string; email: string };
  url: string;
}) {
  const content = await renderEmail(<VerificationEmail name={user.name} url={url} />);

  await createEmail().send({
    to: user.email,
    subject: 'Verify your Datix email address',
    ...content,
  });
}

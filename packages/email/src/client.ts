import {
  createEmailClient,
  type EmailMessage,
  type EmailSendOptions,
} from '@opencoredev/email-sdk';
import { cloudflare } from '@opencoredev/email-sdk/cloudflare';

type EmailInput = Omit<EmailMessage, 'from'> & { from?: EmailMessage['from'] } & (
    | { text: string; html?: string }
    | { html: string; text?: string }
  );

export function createEmail(env: NodeJS.ProcessEnv = process.env) {
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;

  if (!apiToken?.trim() || !accountId?.trim())
    throw new Error('Email requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID');

  const client = createEmailClient({
    adapters: [cloudflare({ apiToken, accountId })],
    retry: { maxAttempts: 1 },
    telemetry: false,
    plugins: [
      {
        id: 'datix-external-effects',
        middleware: [
          {
            beforeSend() {
              if (env.EXTERNAL_EFFECTS !== 'enabled' || env.BILLING_STATE_MODE === 'snapshot')
                throw new Error('External email sending is disabled');
            },
          },
        ],
      },
    ],
  });

  return {
    ...client,
    async send(message: EmailInput, options?: EmailSendOptions<'cloudflare'>) {
      const from = message.from ?? env.EMAIL_FROM?.trim();

      if (!from) throw new Error('Email requires EMAIL_FROM or an explicit from address');

      return client.send({ ...message, from }, options);
    },
  };
}

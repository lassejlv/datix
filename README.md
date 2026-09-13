# Datix

Bun, Hono, Effect v4, and Vite+ monorepo with a React frontend and Neon/TimescaleDB.

See [AGENTS.md](AGENTS.md) for development commands and essential operational guidance.

## Email

`packages/email` (`@datix/email`) owns the Email SDK client and React Email templates.
It exports `createEmail()`, a lazy client using
Cloudflare's HTTP adapter. Set `CLOUDFLARE_API_TOKEN` (with Email Sending permissions)
and `CLOUDFLARE_ACCOUNT_ID`, and enable Email Sending for the sender domain in Cloudflare.
Sending requires `EXTERNAL_EFFECTS=enabled` and a non-snapshot `BILLING_STATE_MODE`.

Set `EMAIL_FROM` to your default sender, then call `email.send({ to, subject, text })`.
An explicit `from` overrides `EMAIL_FROM`; omitting both raises an error. Use plain email
addresses and a sender on your configured domain. SDK retries and telemetry are disabled;
delivery errors propagate to the caller.

New email/password accounts must verify their email before signing in. Signup and
unverified sign-in attempts send a verification link; the inbox screen also supports resending.
Links expire after one hour and sign the user in after verification. Existing unverified
sessions are blocked from protected API routes. Verified OAuth emails satisfy the requirement.
Configure email delivery before enabling registrations; disabled external effects block sending.

For configuration validation without sending, run `EMAIL_SDK_TELEMETRY=0 bun run --cwd packages/email email-sdk doctor --adapter cloudflare`.
The SDK's `send --dry-run` command validates a message without sending it.

`bun run test:integration` captures verification links in the test subprocess without sending mail.

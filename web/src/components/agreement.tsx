import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useLocation } from '@tanstack/react-router';
import { ApiError, apiClient, errorText, write, type User } from '../lib/client';
import { matchesAgreement, type AgreementStatus } from '../lib/legal';
import { Brand } from './brand';
import { Alert } from './ui/alert';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Spinner } from './ui/spinner';

function useAgreement() {
  const [status, setStatus] = useState<AgreementStatus | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    void apiClient<AgreementStatus>('/legal/agreement', { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) {
          setStatus(value);
          setError('');
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorText(error));
      });

    return () => controller.abort();
  }, [revision]);

  return { status, setStatus, error, refresh };
}

export function AgreementGate({
  user,
  onSignedOut,
  account,
  children,
}: {
  user: User;
  onSignedOut: () => void;
  account: ReactNode;
  children: ReactNode;
}) {
  const agreement = useAgreement();
  const pathname = useLocation({ select: (location) => location.pathname });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);
  const { setStatus, refresh } = agreement;

  useEffect(() => {
    const revoked = () => {
      setStatus(null);
      refresh();
    };

    window.addEventListener('datix:agreement-required', revoked);

    return () => window.removeEventListener('datix:agreement-required', revoked);
  }, [setStatus, refresh]);

  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!agreement.status || busy) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');

    try {
      if (!(await matchesAgreement(agreement.status.current))) {
        setChanged(true);
        throw new Error(
          'The agreement has changed. Reload this page and review the current documents.',
        );
      }

      const result = await apiClient<AgreementStatus>(
        '/legal/agreement',
        write('POST', {
          ...agreement.status.current,
          customerName: data.get('customerName'),
          customerRole: data.get('customerRole'),
          signerName: data.get('signerName'),
          signerTitle: data.get('signerTitle'),
          accepted: data.get('accepted') === 'on',
        }),
      );

      agreement.setStatus(result);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'agreement_changed') setChanged(true);
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function accountAction(action: 'sign-out' | 'portal') {
    setBusy(true);
    setError('');

    try {
      if (action === 'sign-out') {
        await apiClient('/auth/sign-out', write('POST', {}));
        onSignedOut();
      } else {
        const result = await apiClient<{ url: string }>('/billing/portal', write('POST', {}));
        window.location.assign(result.url);
      }
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  if (agreement.status?.acceptance && !agreement.error) return children;

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="mx-auto flex max-w-[720px] items-center justify-between gap-4 px-6 py-5">
        <a href="/" aria-label="Datix home">
          <Brand />
        </a>
        <Button variant="ghost" disabled={busy} onClick={() => void accountAction('sign-out')}>
          Sign out
        </Button>
      </header>
      <main className="mx-auto max-w-[720px] px-6 pt-8 pb-16">
        {error && <Alert className="mb-5">{error}</Alert>}
        {pathname === '/account' ? (
          <>
            <a className="mb-6 inline-block text-sm underline" href="/dashboard">
              Back to agreement
            </a>
            {account}
          </>
        ) : agreement.error ? (
          <Alert>
            {agreement.error}
            <Button className="mt-4" onClick={agreement.refresh}>
              Try again
            </Button>
          </Alert>
        ) : !agreement.status ? (
          <div role="status" className="flex items-center gap-3">
            <Spinner /> Loading your agreement…
          </div>
        ) : (
          <section lang="en" aria-labelledby="agreement-title">
            <h1 id="agreement-title" className="text-2xl font-medium tracking-tight">
              Your analytics agreement
            </h1>
            <p className="mt-3 text-sm leading-6 text-secondary-ink">
              Confirm who uses Datix and who can accept on their behalf. Collection and imports are
              paused until you accept. The agreement covers every website in this account.
            </p>
            <div className="my-6 rounded-lg border border-border p-4 text-sm leading-6">
              <p>Review the English documents before continuing:</p>
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
                <a className="underline" href="/terms" target="_blank" rel="noopener">
                  Terms of service ↗
                </a>
                <a className="underline" href="/dpa" target="_blank" rel="noopener">
                  Data Processing Agreement ↗
                </a>
                <a className="underline" href="/privacy" target="_blank" rel="noopener">
                  Privacy policy ↗
                </a>
                <a className="underline" href="/api/dpa/download" download>
                  Download documents
                </a>
              </div>
              <p className="mt-2 text-secondary-ink">
                DPA {agreement.status.current.dpaVersion} · Terms{' '}
                {agreement.status.current.termsVersion}
              </p>
            </div>
            <form onSubmit={accept} className="space-y-5">
              <label className="block space-y-2 text-sm" htmlFor="agreement-customer">
                <span>Customer legal name</span>
                <Input
                  id="agreement-customer"
                  name="customerName"
                  autoComplete="organization"
                  required
                  maxLength={200}
                  placeholder="Company name, or your legal name as a sole trader"
                />
              </label>
              <fieldset className="space-y-2 text-sm">
                <legend className="mb-2">The customer acts as</legend>
                <label className="flex items-start gap-3">
                  <input
                    className="mt-1"
                    type="radio"
                    name="customerRole"
                    value="controller"
                    defaultChecked
                  />
                  <span>Controller — analytics for your own websites</span>
                </label>
                <label className="flex items-start gap-3">
                  <input className="mt-1" type="radio" name="customerRole" value="processor" />
                  <span>Processor — authorized analytics for another organization</span>
                </label>
              </fieldset>
              <div className="grid gap-5 sm:grid-cols-2">
                <label className="block space-y-2 text-sm" htmlFor="agreement-signer">
                  <span>Your full name</span>
                  <Input
                    id="agreement-signer"
                    name="signerName"
                    autoComplete="name"
                    defaultValue={user.name}
                    required
                    maxLength={200}
                  />
                </label>
                <label className="block space-y-2 text-sm" htmlFor="agreement-title-input">
                  <span>Your role or job title</span>
                  <Input
                    id="agreement-title-input"
                    name="signerTitle"
                    autoComplete="organization-title"
                    required
                    maxLength={120}
                    placeholder="Owner, director, or authorized representative"
                  />
                </label>
              </div>
              <p className="text-sm text-secondary-ink">
                Accepted from your verified account: {user.email}
              </p>
              <label className="flex items-start gap-3 text-sm leading-6">
                <input type="checkbox" name="accepted" required className="mt-1.5 shrink-0" />
                <span>
                  I have authority to bind this customer and agree to the Terms of Service and Data
                  Processing Agreement. If acting as a processor, I have the controller's
                  authorization to appoint Datix. I understand that this does not replace visitors'
                  analytics consent.
                </span>
              </label>
              {changed ? (
                <Button onClick={() => window.location.reload()}>Reload current documents</Button>
              ) : (
                <Button type="submit" loading={busy} disabled={busy}>
                  Accept and continue
                </Button>
              )}
            </form>
            <p className="mt-8 text-sm leading-6 text-secondary-ink">
              Need a separate signed agreement or help correcting customer details? Contact{' '}
              <a className="underline" href="mailto:hello@usedatix.com">
                hello@usedatix.com
              </a>
              .
            </p>
          </section>
        )}
        <nav
          className="mt-8 flex flex-wrap items-center gap-4 border-t border-border pt-5 text-sm"
          aria-label="Account options"
        >
          <a className="underline" href="/account">
            Account settings and deletion
          </a>
          <Button variant="link" disabled={busy} onClick={() => void accountAction('portal')}>
            Manage billing / cancel
          </Button>
        </nav>
      </main>
    </div>
  );
}

export function AgreementHistory() {
  const { status, error, refresh } = useAgreement();

  return (
    <section
      lang="en"
      className="mt-8 border-t border-border pt-6 text-sm"
      aria-labelledby="agreement-history"
    >
      <h2 id="agreement-history" className="font-medium">
        Your agreements
      </h2>
      <p className="mt-2 text-secondary-ink">
        Download the accepted text and your acceptance record. Open the file to print or save a PDF.
      </p>
      {error ? (
        <Alert className="mt-3">
          {error}
          <Button onClick={refresh}>Try again</Button>
        </Alert>
      ) : !status ? (
        <p className="mt-3" role="status">
          Loading agreements…
        </p>
      ) : status.history.length ? (
        <ul className="mt-4 space-y-4">
          {status.history.map((receipt) => (
            <li key={receipt.id}>
              <a
                className="underline"
                href={`/api/legal/agreement/${receipt.id}/download`}
                download
              >
                {receipt.customerName} — DPA {receipt.dpaVersion}
              </a>
              <p className="mt-1 text-secondary-ink">
                Accepted by {receipt.signerName} ·{' '}
                {new Date(receipt.acceptedAt).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3">
          No recorded acceptance.{' '}
          <a className="underline" href="/dashboard">
            Review and accept the agreement
          </a>
          .
        </p>
      )}
    </section>
  );
}

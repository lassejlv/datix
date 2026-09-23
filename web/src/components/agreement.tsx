import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useLocation } from '@tanstack/react-router';
import { ApiError, apiClient, errorText, write, type User } from '../lib/client';
import { agreementChanged, matchesAgreement, type AgreementStatus } from '../lib/legal';
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

/** Rejects stale browser builds before recording acceptance of documents the user did not see. */
async function submitAgreement(
  status: AgreementStatus,
  path: '/legal/terms' | '/legal/agreement',
  fields: Record<string, FormDataEntryValue | boolean | null>,
) {
  if (!(await matchesAgreement(status.current))) {
    throw new ApiError(
      409,
      'The agreement has changed. Reload this page and review the current documents.',
      'agreement_changed',
    );
  }

  return apiClient<AgreementStatus>(path, write('POST', { ...status.current, ...fields }));
}

function AgreementDocuments({ status }: { status: AgreementStatus }) {
  return (
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
        Terms {status.current.termsVersion} · DPA {status.current.dpaVersion}
      </p>
    </div>
  );
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
    window.addEventListener(agreementChanged, refresh);

    return () => {
      window.removeEventListener('datix:agreement-required', revoked);
      window.removeEventListener(agreementChanged, refresh);
    };
  }, [setStatus, refresh]);

  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!agreement.status || busy) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');

    try {
      agreement.setStatus(
        await submitAgreement(agreement.status, '/legal/terms', {
          accepted: data.get('accepted') === 'on',
        }),
      );
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

  if (agreement.status?.terms.accepted && !agreement.error) return children;

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
              Back to the Terms
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
            <Spinner /> Loading the Terms…
          </div>
        ) : (
          <section lang="en" aria-labelledby="agreement-title">
            <h1 id="agreement-title" className="text-2xl font-medium tracking-tight">
              Accept the Terms of Service
            </h1>
            <p className="mt-3 text-sm leading-6 text-secondary-ink">
              Collection and imports are paused until you accept the current Terms. They include our
              Data Processing Agreement, which covers every website in this account.
            </p>
            <AgreementDocuments status={agreement.status} />
            <form onSubmit={accept} className="space-y-5">
              <p className="text-sm text-secondary-ink">
                Accepted from your verified account: {user.email}
              </p>
              <label className="flex items-start gap-3 text-sm leading-6">
                <input type="checkbox" name="accepted" required className="mt-1.5 shrink-0" />
                <span>
                  I agree to the Terms of Service, including the Data Processing Agreement that
                  forms part of them, for myself or the organization I represent. I understand that
                  this does not replace visitors' analytics consent.
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
              Need a DPA that names your organization? Sign it any time in{' '}
              <a className="underline" href="/account">
                account settings
              </a>
              . For a separately signed agreement, contact{' '}
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

/** Optional signed DPA. The DPA already applies through the Terms; signing names the customer. */
export function DataProcessingAgreement({ user }: { user: User }) {
  const { status, setStatus, error, refresh } = useAgreement();
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);
  const signed = status?.acceptance ?? null;

  async function sign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!status || busy) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setFormError('');

    try {
      setStatus(
        await submitAgreement(status, '/legal/agreement', {
          customerName: data.get('customerName'),
          customerRole: data.get('customerRole'),
          signerName: data.get('signerName'),
          signerTitle: data.get('signerTitle'),
          accepted: data.get('accepted') === 'on',
        }),
      );
      // Signing also accepts the current Terms, which can lift the agreement gate.
      window.dispatchEvent(new Event(agreementChanged));
    } catch (error) {
      if (error instanceof ApiError && error.code === 'agreement_changed') setChanged(true);
      setFormError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      lang="en"
      className="mt-8 border-t border-border pt-6 text-sm"
      aria-labelledby="dpa-title"
    >
      <h2 id="dpa-title" className="font-medium">
        Data Processing Agreement
      </h2>
      <p className="mt-2 leading-6 text-secondary-ink">
        The DPA is part of the Terms of Service and already applies to your account. Signing it is
        optional: it records your organization's legal name and representative and gives you a
        signed copy to download.
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
      ) : (
        <>
          {signed ? (
            <p className="mt-4 rounded-lg border border-border p-4 leading-6">
              Signed for <strong>{signed.customerName}</strong> by {signed.signerName} on{' '}
              {new Date(signed.acceptedAt).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC.{' '}
              <a className="underline" href={`/api/legal/agreement/${signed.id}/download`} download>
                Download signed copy
              </a>
            </p>
          ) : (
            <details className="mt-4 rounded-lg border border-border p-4">
              <summary className="cursor-pointer font-medium">Sign the DPA</summary>
              <AgreementDocuments status={status} />
              <form onSubmit={sign} className="space-y-5">
                <label className="block space-y-2" htmlFor="agreement-customer">
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
                <fieldset className="space-y-2">
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
                  <label className="block space-y-2" htmlFor="agreement-signer">
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
                  <label className="block space-y-2" htmlFor="agreement-title-input">
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
                <p className="text-secondary-ink">
                  Signed from your verified account: {user.email}
                </p>
                <label className="flex items-start gap-3 leading-6">
                  <input type="checkbox" name="accepted" required className="mt-1.5 shrink-0" />
                  <span>
                    I have authority to bind this customer and agree to the Data Processing
                    Agreement and the Terms of Service it forms part of. If acting as a processor, I
                    have the controller's authorization to appoint Datix.
                  </span>
                </label>
                {formError && <Alert>{formError}</Alert>}
                {changed ? (
                  <Button type="button" onClick={() => window.location.reload()}>
                    Reload current documents
                  </Button>
                ) : (
                  <Button type="submit" loading={busy} disabled={busy}>
                    Sign DPA
                  </Button>
                )}
              </form>
            </details>
          )}
          {status.history.length > 0 && (
            <>
              <h3 className="mt-6 font-medium">Signed agreements</h3>
              <ul className="mt-3 space-y-4">
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
                      Signed by {receipt.signerName} ·{' '}
                      {new Date(receipt.acceptedAt).toLocaleString('en-GB', { timeZone: 'UTC' })}{' '}
                      UTC
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )}
          {status.terms.acceptedAt && (
            <p className="mt-6 text-secondary-ink">
              Current Terms {status.current.termsVersion} accepted on{' '}
              {new Date(status.terms.acceptedAt).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC.
            </p>
          )}
        </>
      )}
    </section>
  );
}

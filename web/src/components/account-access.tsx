import { useEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { apiClient, errorText, write, type Site, type User } from '../lib/client';
import { siteRoute } from '../lib/dashboard-route';
import { BillingActions } from './billing-actions';
import { Brand } from './brand';
import { WelcomeOnboarding } from './onboarding';
import { AddSiteDialog, Installation } from './site-panels';
import { useSitePreferences } from './site-preferences';
import { useAccountUsage } from './usage';
import { Alert } from './ui/alert';
import { Button } from './ui/button';
import { Spinner } from './ui/spinner';

export function AccountAccess({
  user,
  onSignedOut,
  children,
}: {
  user: User;
  onSignedOut: () => void;
  children: (usage: ReturnType<typeof useAccountUsage>) => ReactNode;
}) {
  const { t, message: messageText } = useSitePreferences();
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const usage = useAccountUsage(pathname);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState('');

  async function signout() {
    setSigningOut(true);
    setError('');
    try {
      await apiClient('/auth/sign-out', write('POST', {}));
      onSignedOut();
      void navigate({ to: '/signin', replace: true });
    } catch (error) {
      setError(errorText(error));
    } finally {
      setSigningOut(false);
    }
  }

  // Never mount workspace routes while access is unknown or a refresh has failed.
  // Only the server's verified subscription grants access, including active trials.
  if (usage.data?.plan && !usage.error) return children(usage);

  return (
    <div className="min-h-dvh w-full bg-background text-foreground">
      <header className="mx-auto flex w-full max-w-[680px] items-center justify-between gap-4 px-4 py-5 md:px-6">
        <Brand />
        <Button variant="ghost" disabled={signingOut} onClick={signout}>
          {t('Sign out')}
        </Button>
      </header>
      <main className="mx-auto w-full max-w-[680px] px-4 pt-5 pb-10 md:px-6 md:pt-8">
        {error && <Alert className="mb-5">{messageText(error)}</Alert>}
        {usage.error ? (
          <Alert>
            <p>{messageText(usage.error)}</p>
            <Button className="mt-4" variant="outline" onClick={usage.refresh}>
              {t('Try again')}
            </Button>
          </Alert>
        ) : !usage.data ? (
          <div role="status" className="flex items-center gap-3 py-12 text-secondary-ink">
            <Spinner /> {t('Checking your subscription…')}
          </div>
        ) : !usage.data.onboardingCompleted ? (
          <AccountOnboarding user={user} onCompleted={usage.refresh} />
        ) : (
          <PlanRequired refresh={usage.refresh} />
        )}
      </main>
    </div>
  );
}

function PlanRequired({ refresh }: { refresh: () => void }) {
  const { t } = useSitePreferences();
  return (
    <section aria-labelledby="plan-required-title">
      <h1 id="plan-required-title" className="text-[22px] font-medium tracking-tight">
        {t('Choose a plan to continue')}
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-secondary-ink">
        {t('An active subscription or trial is required to use your workspace.')}
      </p>
      <BillingActions active={false} refresh={refresh} />
    </section>
  );
}

function AccountOnboarding({ user, onCompleted }: { user: User; onCompleted: () => void }) {
  const { t, message: messageText } = useSitePreferences();
  const navigate = useNavigate();
  const [sites, setSites] = useState<Site[] | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void apiClient<{ sites: Site[] }>('/sites', { signal: controller.signal })
      .then(({ sites }) => {
        setSites(sites);
        setError('');
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorText(error));
      });
    return () => controller.abort();
  }, [revision]);
  const site = sites?.[0];
  const environment = site?.environments.find((environment) => environment.id === site.id);
  async function complete() {
    setBusy(true);
    setError('');
    try {
      await apiClient('/onboarding/complete', write('POST', {}));
      onCompleted();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {error && (
        <Alert className="mb-5">
          {messageText(error)}
          {!sites && (
            <Button variant="outline" className="mt-3" onClick={() => setRevision((v) => v + 1)}>
              {t('Try again')}
            </Button>
          )}
        </Alert>
      )}
      {!sites ? (
        <div role="status" className="flex items-center gap-3 py-12 text-secondary-ink">
          <Spinner /> {t('Loading your workspace…')}
        </div>
      ) : site && environment ? (
        <>
          <div className="mb-6">
            <h1 className="text-[22px] font-medium tracking-tight">{t('Connect your website')}</h1>
            <p className="mt-2 text-sm leading-relaxed text-secondary-ink">
              {t('Install the script on {domain}, then choose your plan.', {
                domain: environment.domain,
              })}
            </p>
          </div>
          <Installation
            site={site}
            environment={environment}
            guided
            awaitingPlan
            onDashboard={() => {}}
            onUpdated={() => {}}
          />
          <p className="mb-4 text-sm leading-relaxed text-secondary-ink">
            {t(
              'Tracking starts when your subscription or trial is active. You can check the installation afterward.',
            )}
          </p>
          <Button disabled={busy} loading={busy} onClick={complete}>
            {t('Continue to plans')}
          </Button>
        </>
      ) : (
        <WelcomeOnboarding name={user.name} onAdd={() => setAddOpen(true)} />
      )}
      <AddSiteDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={(site) => {
          setSites([site]);
          setAddOpen(false);
          void navigate({
            to: siteRoute,
            params: { siteId: site.id, environmentId: site.id, page: 'setup' },
            replace: true,
          });
        }}
      />
    </>
  );
}

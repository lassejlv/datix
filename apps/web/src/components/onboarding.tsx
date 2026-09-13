import { Alert } from './ui/alert';
import { useSitePreferences } from './site-preferences';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check } from './ui/icons';
import { Button } from './ui/button';
import { Installation } from './site-panels';
import { Step, StepList } from './steps';
import { Spinner } from './ui/spinner';
import { PageTransition } from './page-transition';
import { apiClient, errorText, type Site, type SiteEnvironment } from '../lib/client';

export function BeerBuddy({
  flying = false,
  className = '',
}: {
  flying?: boolean;
  className?: string;
}) {
  return (
    <img
      className={`object-contain ${className}`}
      src={`/media/beer-${flying ? 'flying' : 'pointing'}.webp`}
      width={480}
      height={480}
      alt=""
    />
  );
}

export function WelcomeOnboarding({ onAdd }: { name: string; onAdd: () => void }) {
  const { t } = useSitePreferences();

  return (
    <div className="max-w-[560px]">
      <h1 className="text-[22px] leading-[1.25] font-medium tracking-[-0.025em]">
        {t('Getting started')}
      </h1>
      <p className="mt-2 text-secondary-ink">
        {t('Add your website, then install the tracking script.')}
      </p>
      <div className="mt-7">
        <StepList>
          <Step
            index={1}
            title={t('Add a website')}
            description={t('Give it a name and the domain you want to measure.')}
          />
          <Step
            index={2}
            title={t('One script to install')}
            description={t('One line before the closing head tag, on every page.')}
          />
          <Step
            index={3}
            title={t('Watch traffic arrive')}
            description={t('No consent banner to add, so there is nothing else to wire up.')}
          />
        </StepList>
      </div>
      <Button className="mt-7" onClick={onAdd}>
        {t('Add your first website')}
      </Button>
      <p className="mt-3 text-xs text-secondary-ink">{t('Cookieless by default.')}</p>
    </div>
  );
}

export function SetupOnboarding({
  site,
  environment,
  onUpdated,
  onDashboard,
  onInstallation,
  onComplete,
}: {
  site: Site;
  environment: SiteEnvironment;
  onUpdated: (environment: SiteEnvironment) => void;
  onDashboard: () => void;
  onInstallation: () => void;
  onComplete: () => void;
}) {
  const { message: messageText, t } = useSitePreferences();
  const [connected, setConnected] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const successHeading = useRef<HTMLHeadingElement>(null);
  const interacted = useRef(false);
  // A successful connection comes from persisted pageviews, never a copied script.
  useEffect(() => {
    const controller = new AbortController();
    setChecking(true);
    setError('');
    apiClient<{ receiving: boolean }>(
      `/sites/${site.id}/installation?environment=${environment.id}`,
      { signal: controller.signal },
    )
      .then((status) => setConnected(status.receiving))
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorText(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false);
      });

    return () => controller.abort();
  }, [site.id, environment.id, retry]);
  useEffect(() => {
    if (connected) {
      onComplete();
      if (interacted.current) successHeading.current?.focus();
    }
  }, [connected, onComplete]);

  return (
    <div className="max-w-[640px]">
      {checking ? (
        <p role="status" className="flex items-center gap-3 py-12 text-secondary-ink">
          <Spinner className="size-4" />
          {t('Checking your connection…')}
        </p>
      ) : (
        <PageTransition view={connected ? 'connected' : 'connect'}>
          {connected ? (
            <div>
              <p className="inline-flex items-center gap-2 rounded-full bg-muted px-2.5 py-1 text-xs text-success">
                <Check size={14} /> {t('Pageview received')}
              </p>
              <h1
                ref={successHeading}
                tabIndex={-1}
                className="mt-4 text-[22px] leading-[1.25] font-medium tracking-[-0.025em] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
              >
                {t('You’re connected')}
              </h1>
              <p className="mt-2 text-secondary-ink wrap-anywhere">
                {t('{domain} is sending pageviews.', { domain: environment.domain })}
              </p>
              <div className="mt-6 flex flex-wrap gap-2">
                <Button onClick={onDashboard}>{t('Open dashboard')}</Button>
                <Button variant="ghost" onClick={onInstallation}>
                  {t('Review installation')}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="mb-7">
                <h1 className="text-[22px] leading-[1.25] font-medium tracking-[-0.025em]">
                  {t('Connect your website')}
                </h1>
                <p className="mt-2 text-secondary-ink wrap-anywhere">
                  {t('Install the script on {domain}, then check the connection.', {
                    domain: environment.domain,
                  })}
                </p>
              </div>
              {error && (
                <Alert className="mb-5">
                  {messageText(error)}
                  <Button variant="outline" className="ml-3" onClick={() => setRetry((v) => v + 1)}>
                    {t('Retry connection check')}
                  </Button>
                </Alert>
              )}
              {!environment.enabled && (
                <p role="status" className="mb-6 rounded-md bg-muted px-4 py-3 text-sm">
                  {t(
                    'Collection is paused. Resume it in Website settings before testing your connection.',
                  )}
                </p>
              )}
              <div>
                <Installation
                  site={site}
                  environment={environment}
                  onUpdated={onUpdated}
                  onDashboard={onDashboard}
                  guided
                  onConnected={() => {
                    interacted.current = true;
                    setConnected(true);
                  }}
                />
              </div>
              <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                <p className="text-xs text-secondary-ink">
                  {t('Your website is saved. You can come back to Getting started anytime.')}
                </p>
                <Button variant="ghost" onClick={onDashboard}>
                  {t('Explore dashboard first')} <ArrowRight size={14} />
                </Button>
              </div>
            </>
          )}
        </PageTransition>
      )}
    </div>
  );
}

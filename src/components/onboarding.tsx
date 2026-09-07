import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check } from './ui/icons';
import { Button } from './ui/button';
import { Installation } from './site-panels';
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
  return (
    <div className="max-w-[600px]">
      <h1 className="text-[22px] font-medium tracking-tight">Getting started</h1>
      <p className="mt-2 text-sm text-secondary-ink">
        Add your website, then install the tracking script.
      </p>
      <Button className="mt-5" onClick={onAdd}>
        Add your first website
      </Button>
      <p className="mt-3 text-xs text-secondary-ink">Cookieless by default.</p>
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
    <div className="max-w-[600px]">
      {checking ? (
        <p role="status" className="py-12 text-secondary-ink">
          Checking your connection…
        </p>
      ) : (
        <PageTransition view={connected ? 'connected' : 'connect'}>
          {connected ? (
            <div>
              <p className="mb-3 flex items-center gap-2 text-xs text-success">
                <Check size={14} /> Pageview received
              </p>
              <h1
                ref={successHeading}
                tabIndex={-1}
                className="text-[22px] font-medium tracking-tight focus-visible:outline-2 focus-visible:outline-ring"
              >
                You’re connected
              </h1>
              <p className="mt-2 text-sm text-secondary-ink wrap-anywhere">
                {environment.domain} is sending pageviews.
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                <Button onClick={onDashboard}>Open dashboard</Button>
                <Button variant="ghost" onClick={onInstallation}>
                  Review installation
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="mb-6">
                <h1 className="text-[22px] font-medium tracking-tight">Connect your website</h1>
                <p className="mt-2 text-sm text-secondary-ink wrap-anywhere">
                  Install the script on {environment.domain}, then check the connection.
                </p>
              </div>
              {error && (
                <div role="alert" className="mb-5 text-sm text-danger">
                  {error}
                  <Button variant="outline" className="ml-3" onClick={() => setRetry((v) => v + 1)}>
                    Retry connection check
                  </Button>
                </div>
              )}
              {!environment.enabled && (
                <p role="status" className="mb-5 rounded-md bg-muted p-4 text-sm">
                  Collection is paused. Resume it in Website settings before testing your
                  connection.
                </p>
              )}
              <div className="">
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
              <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-secondary-ink">
                  Your website is saved. You can come back to Getting started anytime.
                </p>
                <Button variant="ghost" onClick={onDashboard}>
                  Explore dashboard first <ArrowRight size={14} />
                </Button>
              </div>
            </>
          )}
        </PageTransition>
      )}
    </div>
  );
}

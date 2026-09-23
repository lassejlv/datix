import { PageTransition } from './page-transition';
import { Step, StepList } from './steps';
import { Alert } from './ui/alert';
import { Tabs } from './ui/tabs';
import { toast } from './ui/toast';
import { FeatureSettings } from './feature-settings';
import { useSitePreferences } from './site-preferences';
import { agentInstallationInstructions } from '../lib/agent-installation';
import { useEffect, useState, type FormEvent } from 'react';
import { Check, Copy, ArrowRight, Lock, RefreshCw, Trash2 } from './ui/icons';
import { AnalyticsImports } from './analytics-imports';
import { Button } from './ui/button';
import { Input, Textarea } from './ui/input';
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from './ui/dialog';
import { apiClient, errorText, write, type Site, type SiteEnvironment } from '../lib/client';
import { EnvironmentSettings, LocalhostSetting } from './environment-panels';
import { Link } from '@tanstack/react-router';
import { BillingActions } from './billing-actions';
import { EventCredits, PlanHeading, WebsitesUsage, type useAccountUsage } from './usage';
import type { AccountUsage } from '../billing/types';
import type { ReactNode } from 'react';

export function AddSiteDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (site: Site) => void;
}) {
  const { t, message: messageText } = useSitePreferences();

  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');

  useEffect(() => {
    if (!open) setError('');
  }, [open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    let domain = String(form.get('domain')).trim();

    try {
      if (domain.includes('://')) domain = new URL(domain).hostname;
    } catch {
      /* API validates invalid hostnames. */
    }

    domain = domain.replace(/\/$/, '');

    try {
      const result = await apiClient<{ site: Site }>(
        '/sites',
        write('POST', { name: form.get('name'), domain }),
      );

      toast.success(t('Website added.'));
      onCreated(result.site);
      onOpenChange(false);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t('Add a website')}</DialogTitle>
          <DialogDescription>
            {t('Give your website a name and tell us where to find it.')}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <div className="px-6 pb-6 flex flex-col gap-4">
            <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="site-name">
              {t('Website name')}
              <Input
                id="site-name"
                name="name"
                placeholder="My website"
                required
                maxLength={80}
                size="default"
              />
            </label>
            <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="site-domain">
              {t('Website domain')}
              <Input
                id="site-domain"
                name="domain"
                placeholder="example.com"
                required
                maxLength={2048}
                size="default"
              />
              <span className="text-[13px] leading-normal font-normal text-muted-foreground">
                {t('Use the exact domain your visitors see, including www if needed.')}
              </span>
            </label>
            {error && (
              <Alert className="text-sm leading-normal text-danger">{messageText(error)}</Alert>
            )}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>
              {t('Cancel')}
            </DialogClose>
            <Button type="submit" loading={busy}>
              {t('Add website')}
              <ArrowRight size={15} />
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export function Installation({
  site,
  environment,
  onDashboard,
  onUpdated,
  guided = false,
  awaitingPlan = false,
  onConnected,
}: {
  guided?: boolean;
  awaitingPlan?: boolean;
  onConnected?: () => void;
  site: Site;
  environment: SiteEnvironment;
  onDashboard: () => void;
  onUpdated: (environment: SiteEnvironment) => void;
}) {
  const { t, message: messageText } = useSitePreferences();

  const [origin, setOrigin] = useState(''),
    [copied, setCopied] = useState(false),
    [agentCopied, setAgentCopied] = useState(false),
    [agentFallback, setAgentFallback] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [receiving, setReceiving] = useState(false),
    [error, setError] = useState('');

  useEffect(() => setOrigin(location.origin), []);
  const code = `<script defer src="${origin}/tracker.js" data-site="${site.id}"${environment.id === site.id ? '' : ` data-environment="${environment.id}"`}${environment.trackingMode !== 'cookieless' ? ` data-mode="${environment.trackingMode}"` : ''}></script>`;

  async function check() {
    setBusy(true);
    setMessage('');
    setError('');

    try {
      const status = await apiClient<{
        receiving: boolean;
        lastReceivedAt: string | null;
      }>(`/sites/${site.id}/installation?environment=${environment.id}`);

      setReceiving(status.receiving);
      if (status.receiving) onConnected?.();
      setMessage(
        status.receiving
          ? t('Your script is working. We received a pageview.')
          : t('No pageview yet. Visit your website, wait a few seconds, then check again.'),
      );
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function setLocalhost(allowLocalhost: boolean) {
    setBusy(true);
    setError('');
    setMessage('');

    try {
      const result = await apiClient<{ environment: SiteEnvironment }>(
        `/sites/${site.id}/environments/${environment.id}`,
        write('PATCH', { allowLocalhost }),
      );

      onUpdated(result.environment);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      toast.success(t('Tracking script copied.'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t('Copy is unavailable in this browser. Select and copy the code below.'));
    }
  }

  const agentInstructions = agentInstallationInstructions(code, environment);

  async function copyAgent() {
    try {
      await navigator.clipboard.writeText(agentInstructions);
      toast.success(t('Installation instructions copied.'));
      setAgentCopied(true);
      setAgentFallback(false);
      setTimeout(() => setAgentCopied(false), 2000);
    } catch {
      setAgentFallback(true);
    }
  }

  const ExtrasContainer = guided ? 'details' : 'div';
  const local = !!origin && new URL(origin).hostname === 'localhost';

  return (
    <div className={guided ? 'w-full' : 'max-w-[640px]'}>
      {!guided && (
        <div className="mb-7">
          <h1 className="text-[22px] leading-[1.25] font-medium tracking-[-0.025em]">
            {t('Install your script')}
          </h1>
          <p className="mt-2 text-secondary-ink wrap-anywhere">
            {t('Connect {domain} to {environment}.', {
              domain: environment.domain,
              environment: environment.name,
            })}
          </p>
        </div>
      )}
      {agentFallback && (
        <label className="mb-6 block text-sm">
          {t('Copy these agent instructions manually')}
          <Textarea
            readOnly
            value={agentInstructions}
            onFocus={(event) => event.currentTarget.select()}
            className="mt-2 h-48 text-xs"
          />
        </label>
      )}
      <StepList>
        <Step
          index={1}
          title={t('Copy your tracking script')}
          description={t('This script sends traffic only to {environment} for {domain}.', {
            environment: environment.name,
            domain: environment.domain,
          })}
        >
          <div className="overflow-hidden rounded-md bg-muted">
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-2">
              <span className="truncate text-xs text-secondary-ink">{t('Tracking script')}</span>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!origin}
                  onClick={copyAgent}
                  tooltip={t('Copy installation instructions for an AI agent')}
                >
                  {agentCopied ? <Check size={14} /> : <Copy size={14} />}
                  {agentCopied ? t('Copied for agent') : t('Agent')}
                </Button>
                <Button size="sm" variant="ghost" disabled={!origin} onClick={copy}>
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? t('Copied') : t('Copy script')}
                </Button>
              </div>
            </div>
            <pre
              className="px-3 pt-1 pb-3 font-mono text-xs leading-[1.8] whitespace-pre-wrap wrap-anywhere md:text-[13px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
              tabIndex={0}
              aria-label="Tracking script"
            >
              <code className="font-mono text-[0.9em]">{code}</code>
            </pre>
          </div>
        </Step>
        <Step
          index={2}
          title={t('Add it to your website')}
          description={
            <>
              Paste it before the closing{' '}
              <code className="font-mono text-[0.9em]">&lt;/head&gt;</code> tag on every page.
            </>
          }
        >
          <p className="text-sm leading-[1.6] text-secondary-ink">
            {t(
              'Most website builders have a “Custom code” or “Head code” setting. Save your changes and publish your website.',
            )}
          </p>
          {local && (
            <p className="mt-3 rounded-md bg-muted px-4 py-3 text-[13px] leading-[1.6] text-secondary-ink">
              {t(
                'You’re running Datix locally. Use a hosted address in this script when connecting a public website.',
              )}
            </p>
          )}
        </Step>
        {!awaitingPlan && (
          <Step
            index={3}
            done={receiving}
            title={receiving ? t('You\u2019re connected') : t('Check that it\u2019s working')}
            description={t('Visit your website in a browser, then check for your first pageview.')}
          >
            <div className="flex gap-3 max-md:flex-wrap">
              {guided && (
                <Button
                  variant="outline"
                  render={
                    <a href={`https://${environment.domain}`} target="_blank" rel="noreferrer" />
                  }
                >
                  {t('Open my website')}
                  <ArrowRight size={15} />
                </Button>
              )}
              <Button onClick={check} variant={receiving ? 'outline' : 'default'} loading={busy}>
                <RefreshCw size={15} />
                {t('Check installation')}
              </Button>
              {receiving && (
                <Button onClick={onDashboard}>
                  {t('View dashboard')}
                  <ArrowRight size={15} />
                </Button>
              )}
            </div>
            {message && (
              <p
                className={`mt-3 text-sm leading-[1.6] ${receiving ? 'text-success' : 'text-secondary-ink'}`}
                role="status"
              >
                {message}
              </p>
            )}
            {error && (
              <Alert className="mt-3 text-sm leading-normal text-danger">
                {messageText(error)}
              </Alert>
            )}
          </Step>
        )}
      </StepList>
      {environment.trackingMode !== 'cookieless' && (
        <section className="mt-8 border-t border-line pt-6">
          <h2 className="text-[15px] leading-[1.4] font-medium tracking-[-0.02em]">
            {environment.trackingMode === 'local'
              ? t('Uses local storage \u2014 connect your consent banner')
              : t('Uses cookies \u2014 connect your cookie banner')}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-secondary-ink">
            {t(
              "Tracking starts as soon as this script loads, so add it only after your banner records analytics consent. To keep the script on every page instead, set window.analyticsBeerConsent to false before it loads and call this from your banner's callback with its saved choice.",
            )}
          </p>
          <pre
            aria-label="Consent integration"
            className="mt-4 rounded-md bg-muted p-3 whitespace-pre-wrap wrap-anywhere font-mono text-xs leading-relaxed"
          >{`function onAnalyticsConsentChanged(granted) {
  window.analyticsBeerConsent = granted === true;
  window.simpleAnalytics?.consent(granted === true);
}`}</pre>
          <p className="mt-3 text-sm leading-relaxed text-secondary-ink">
            {t(
              "This callback connects your existing banner; it does not display one. Provide accept and reject choices and a way to change them. Consent withdrawal deletes this environment's tracking identifiers and stops collection.",
            )}
          </p>
          <p className="mt-3 text-sm leading-relaxed text-secondary-ink">
            {environment.trackingMode === 'local'
              ? t(
                  'Identifiers are stored in local storage, with no tracking cookies. Visitor expiry: 90 days, renewed with activity. Session expiry: 30 minutes of inactivity. Expired identifiers are replaced when tracking next runs. Storage is scoped to this origin and environment.',
                )
              : t(
                  'First-party visitor cookie: 90 days, renewed with activity. Session cookie: 30 minutes of inactivity. Both are scoped to this hostname and environment.',
                )}{' '}
            Session details are retained for 30 days.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-secondary-ink">
            Add <code>data-analytics-ignore</code> to private sections or the page's{' '}
            <code>html</code> element to exclude them. Add{' '}
            <code>data-analytics-label="checkout-button"</code> for readable action labels; never
            include personal information.
          </p>
          <a
            className="mt-3 inline-block text-sm underline"
            href="https://www.datatilsynet.dk/regler-og-vejledning/cookies-og-lignende-teknologier"
            target="_blank"
            rel="noreferrer"
          >
            {t('Cookie and consent guidance')}
          </a>
        </section>
      )}
      {!awaitingPlan && (
        <ExtrasContainer className={guided ? 'mt-8' : 'mt-8 border-t border-line pt-6'}>
          {guided && (
            <summary className="mb-5 w-fit cursor-pointer text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
              {t('Testing locally or tracking custom events?')}
            </summary>
          )}
          <LocalhostSetting environment={environment} busy={busy} onChange={setLocalhost} />
          <div className="pt-2">
            <h3 className="text-[15px] font-medium tracking-[-0.02em]">
              {t('Want to track a specific action?')}
            </h3>
            <p className="mt-1.5 text-sm leading-[1.8] text-secondary-ink wrap-anywhere">
              Use{' '}
              <code className="font-mono text-[0.9em]">window.simpleAnalytics.track('signup')</code>{' '}
              after your script has loaded. Replace “signup” with a short name for the action.
            </p>
          </div>
        </ExtrasContainer>
      )}
    </div>
  );
}

type SettingsTab =
  | 'website'
  | 'environment'
  | 'tracking'
  | 'imports'
  | 'features'
  | 'usage'
  | 'billing';

function AccountUsageSection({
  usage,
  children,
}: {
  usage: ReturnType<typeof useAccountUsage>;
  children: (data: AccountUsage) => ReactNode;
}) {
  const { message: messageText, t } = useSitePreferences();

  return (
    <>
      {usage.error && (
        <Alert className="mb-5">
          {messageText(usage.error)}{' '}
          <button className="underline" onClick={usage.refresh}>
            {t('Try again')}
          </button>
        </Alert>
      )}
      {!usage.data ? (
        <p className="py-12 text-sm text-secondary-ink">
          {usage.loading ? t('Loading usage…') : t('Usage is unavailable.')}
        </p>
      ) : (
        children(usage.data)
      )}
    </>
  );
}

export function SiteSettings({
  site,
  environment,
  usage,
  initialTab,
  onEnvironmentUpdated,
  onEnvironmentDeleted,
  onUpdated,
  onDeleted,
  onViewReport,
}: {
  site: Site;
  environment: SiteEnvironment;
  usage: ReturnType<typeof useAccountUsage>;
  initialTab?: string;
  onEnvironmentUpdated: (environment: SiteEnvironment) => void;
  onEnvironmentDeleted: () => void;
  onUpdated: (site: Site) => void;
  onDeleted: () => void;
  onViewReport: (from: string, to: string) => void;
}) {
  const { t, message: messageText } = useSitePreferences();

  const tabs: readonly SettingsTab[] = [
    'website',
    'environment',
    'tracking',
    'imports',
    'features',
    'usage',
    'billing',
  ];

  const [tab, setTab] = useState<SettingsTab>(
    tabs.includes(initialTab as SettingsTab) ? (initialTab as SettingsTab) : 'website',
  );

  const labels: Record<SettingsTab, string> = {
    website: t('Website'),
    environment: t('Environment'),
    tracking: t('Tracking'),
    imports: t('Imports'),
    features: t('Features'),
    usage: t('Usage'),
    billing: t('Billing'),
  };

  const [name, setName] = useState(site.name);

  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [deleting, setDeleting] = useState(false),
    [confirm, setConfirm] = useState('');

  async function update(value: Partial<Site>) {
    setBusy(true);
    setError('');

    try {
      const result = await apiClient<{ site: Site }>(`/sites/${site.id}`, write('PATCH', value));
      onUpdated(result.site);
      toast.success(t('Changes saved.'));
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError('');

    try {
      await apiClient(`/sites/${site.id}`, { method: 'DELETE' });
      setDeleting(false);
      toast.success(t('Website deleted.'));
      onDeleted();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-[600px]">
      <div className="mb-6">
        <h1 className="text-[22px] leading-[1.25] font-medium tracking-[-0.025em]">
          {t('Website settings')}
        </h1>
        <p className="mt-2 text-secondary-ink wrap-anywhere">
          {t('Manage {domain}.', { domain: site.domain })}
        </p>
      </div>
      <Tabs
        id="settings"
        label={t('Website settings')}
        value={tab}
        items={tabs.map((value) => ({ value, label: labels[value] }))}
        onValueChange={setTab}
      />
      <PageTransition
        view={tab}
        id="settings-panel"
        role="tabpanel"
        aria-labelledby={`settings-tab-${tab}`}
        tabIndex={0}
        className="focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
      >
        {tab === 'features' && (
          <FeatureSettings
            siteId={site.id}
            environment={environment}
            onUpdated={onEnvironmentUpdated}
          />
        )}
        {tab === 'imports' && (
          <div className="relative min-h-[420px]">
            <div className="pointer-events-none blur-sm select-none" aria-hidden="true" inert>
              <AnalyticsImports
                key={environment.id}
                site={site}
                environment={environment}
                onViewReport={onViewReport}
              />
            </div>
            <div className="absolute inset-0 flex items-center justify-center bg-background/50">
              <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card px-8 py-6 text-center shadow-lg">
                <span className="flex size-12 items-center justify-center rounded-full bg-muted text-secondary-ink">
                  <Lock size={22} />
                </span>
                <p className="text-xl font-medium">{t('Coming soon')}</p>
              </div>
            </div>
          </div>
        )}
        {tab === 'usage' && (
          <AccountUsageSection usage={usage}>
            {(data) => (
              <>
                <PlanHeading
                  data={data}
                  action={
                    <Button variant="outline" onClick={() => setTab('billing')}>
                      {t('Billing')}
                    </Button>
                  }
                />
                <EventCredits data={data} />
                <div className="mt-10">
                  <WebsitesUsage data={data} refresh={usage.refresh} />
                </div>
              </>
            )}
          </AccountUsageSection>
        )}
        {tab === 'billing' && (
          <AccountUsageSection usage={usage}>
            {(data) => (
              <>
                <PlanHeading
                  data={data}
                  action={
                    <Link to="/pricing" className="text-sm underline underline-offset-4">
                      {t('View plans')}
                    </Link>
                  }
                />
                <BillingActions
                  active={Boolean(data.plan)}
                  current={data.plan?.name}
                  refresh={usage.refresh}
                />
              </>
            )}
          </AccountUsageSection>
        )}
        <div hidden={tab !== 'environment' && tab !== 'tracking'}>
          <EnvironmentSettings
            key={environment.id}
            section={tab === 'tracking' ? 'tracking' : 'environment'}
            site={site}
            environment={environment}
            onUpdated={onEnvironmentUpdated}
            onDeleted={onEnvironmentDeleted}
          />
        </div>
        <div hidden={tab !== 'website'}>
          <section className="mb-6">
            <h2 className="text-[17px] leading-[1.4] font-medium tracking-[-0.025em]">
              {t('Website details')}
            </h2>
            <form
              className="flex flex-col gap-4 mt-5 max-w-[440px]"
              onSubmit={(event) => {
                event.preventDefault();
                void update({ name });
              }}
            >
              <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="settings-name">
                {t('Website name')}
                <Input
                  id="settings-name"
                  name="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  maxLength={80}
                  size="default"
                />
              </label>
              <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="settings-domain">
                {t('Domain')}
                <Input id="settings-domain" value={site.domain} readOnly size="default" />
                <span className="text-[13px] leading-normal font-normal text-muted-foreground">
                  {t('Add an environment to track a staging or testing domain separately.')}
                </span>
              </label>
              <Button className="self-start" type="submit" loading={busy}>
                {t('Save changes')}
              </Button>
            </form>
          </section>
          {error && !deleting && (
            <Alert className="text-sm leading-normal text-danger">{messageText(error)}</Alert>
          )}
          <section className="mb-6 flex flex-col items-start gap-4 md:flex-row md:items-center md:justify-between md:gap-6 mt-7">
            <div className="min-w-0 flex-1">
              <h2 className="text-[17px] leading-[1.4] font-medium tracking-[-0.025em]">
                {t('Remove this website')}
              </h2>
              <p className="mt-1.5 text-sm leading-[1.6] text-secondary-ink wrap-anywhere">
                {t('Permanently delete this website, every environment, and all their analytics.')}
              </p>
            </div>
            <Button
              variant="destructive-outline"
              onClick={() => {
                setConfirm('');
                setError('');
                setDeleting(true);
              }}
            >
              <Trash2 size={15} />
              {t('Delete website')}
            </Button>
          </section>
        </div>
      </PageTransition>
      <Dialog
        open={deleting}
        onOpenChange={(value) => {
          if (!busy) setDeleting(value);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{t('Delete {name}?', { name: site.name })}</DialogTitle>
            <DialogDescription>
              {t(
                'Every environment and all pageviews, events, and history for {name} will be permanently deleted. This cannot be undone.',
                { name: site.domain },
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="px-6 pb-6 flex flex-col gap-4">
            <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="delete-confirm">
              {t('Type {name} to confirm', { name: site.domain })}
              <Input
                id="delete-confirm"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="off"
                size="default"
              />
            </label>
            {error && (
              <Alert className="text-sm leading-normal text-danger">{messageText(error)}</Alert>
            )}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>
              {t('Keep website')}
            </DialogClose>
            <Button
              variant="destructive"
              loading={busy}
              disabled={confirm !== site.domain}
              onClick={remove}
            >
              {t('Delete website')}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

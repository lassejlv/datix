import { agentInstallationInstructions } from '../lib/agent-installation';
import { useEffect, useState, type FormEvent } from 'react';
import { Check, Copy, ArrowRight, CircleCheck, RefreshCw, Trash2 } from './ui/icons';
import { Button } from './ui/button';
import { Input } from './ui/input';
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

export function AddSiteDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (site: Site) => void;
}) {
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
          <DialogTitle>Add a website</DialogTitle>
          <DialogDescription>
            Give your website a name and tell us where to find it.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <div className="px-6 pb-6 flex flex-col gap-4">
            <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="site-name">
              Website name
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
              Website domain
              <Input
                id="site-domain"
                name="domain"
                placeholder="example.com"
                required
                maxLength={2048}
                size="default"
              />
              <span className="text-[13px] leading-normal font-normal text-muted-foreground">
                Use the exact domain your visitors see, including www if needed.
              </span>
            </label>
            {error && (
              <p className="text-sm leading-normal text-danger" role="alert">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>Cancel</DialogClose>
            <Button type="submit" loading={busy}>
              Add website
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
  onConnected,
}: {
  guided?: boolean;
  onConnected?: () => void;
  site: Site;
  environment: SiteEnvironment;
  onDashboard: () => void;
  onUpdated: (environment: SiteEnvironment) => void;
}) {
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
          ? 'Your script is working. We received a pageview.'
          : 'No pageview yet. Visit your website, wait a few seconds, then check again.',
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
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Copy is unavailable in this browser. Select and copy the code below.');
    }
  }
  const agentInstructions = agentInstallationInstructions(code, environment);
  async function copyAgent() {
    try {
      await navigator.clipboard.writeText(agentInstructions);
      setAgentCopied(true);
      setAgentFallback(false);
      setTimeout(() => setAgentCopied(false), 2000);
    } catch {
      setAgentFallback(true);
    }
  }
  const ExtrasContainer = guided ? 'details' : 'div';
  return (
    <div className={guided ? 'w-full' : 'max-w-[600px]'}>
      {!guided && (
        <div className="mb-6">
          <h1 className="text-[22px] leading-[1.25] font-medium tracking-[-0.025em]">
            Install your script
          </h1>
          <p className="mt-2 text-secondary-ink wrap-anywhere">
            Connect {environment.domain} to {environment.name}.
          </p>
        </div>
      )}
      {agentFallback && (
        <label className="mb-5 block text-sm">
          Copy these agent instructions manually
          <textarea
            readOnly
            value={agentInstructions}
            onFocus={(event) => event.currentTarget.select()}
            className="mt-2 h-48 w-full rounded-md border border-input bg-background p-3 text-xs"
          />
        </label>
      )}
      <section className="mb-6">
        <div className="flex items-center gap-3 max-md:flex-wrap md:gap-4">
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-accent text-[13px]">
            1
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] leading-[1.4] font-medium tracking-[-0.025em]">
              Copy your tracking script
            </h2>
            <p className="mt-1.5 text-sm leading-[1.6] text-secondary-ink wrap-anywhere">
              This script sends traffic only to {environment.name} for {environment.domain}.
            </p>
          </div>
          <div className="flex gap-2 max-md:ml-10">
            <Button
              variant="outline"
              disabled={!origin}
              onClick={copyAgent}
              title="Copy installation instructions for an AI agent"
            >
              {agentCopied ? <Check size={15} /> : <Copy size={15} />}
              {agentCopied ? 'Copied for agent' : 'Agent'}
            </Button>
            <Button variant="outline" disabled={!origin} onClick={copy}>
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? 'Copied' : 'Copy script'}
            </Button>
          </div>
        </div>
        <pre
          className="mt-4 rounded-md bg-muted p-4 font-mono text-xs leading-[1.8] whitespace-pre-wrap wrap-anywhere md:p-3 md:text-[13px] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          tabIndex={0}
          aria-label="Tracking script"
        >
          <code className="font-mono text-[0.9em]">{code}</code>
        </pre>
      </section>
      <section className="mb-6">
        <div className="flex items-center gap-3 max-md:flex-wrap md:gap-4">
          <span className="grid size-7 shrink-0 place-items-center rounded-md bg-accent text-[13px]">
            2
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] leading-[1.4] font-medium tracking-[-0.025em]">
              Add it to your website
            </h2>
            <p className="mt-1.5 text-sm leading-[1.6] text-secondary-ink wrap-anywhere">
              Paste it before the closing{' '}
              <code className="font-mono text-[0.9em]">&lt;/head&gt;</code> tag on every page.
            </p>
          </div>
        </div>
        <p className="mt-1.5 pl-10 text-sm leading-[1.6] text-secondary-ink md:pl-11">
          Most website builders have a “Custom code” or “Head code” setting. Save your changes and
          publish your website.
        </p>
        {origin && new URL(origin).hostname === 'localhost' && (
          <p className="mt-4 rounded-md bg-muted px-4 py-3 text-[13px] leading-[1.6] text-secondary-ink">
            You’re running Analytics Beer locally. Use a hosted address in this script when
            connecting a public website.
          </p>
        )}
      </section>
      <section className="mb-6">
        <div className="flex items-center gap-3 max-md:flex-wrap md:gap-4">
          <span
            className={`grid size-7 shrink-0 place-items-center rounded-md bg-accent text-[13px] ${receiving ? 'text-success' : ''}`}
          >
            {receiving ? <CircleCheck size={20} /> : '3'}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] leading-[1.4] font-medium tracking-[-0.025em]">
              {receiving ? 'You’re connected' : 'Check that it’s working'}
            </h2>
            <p className="mt-1.5 text-sm leading-[1.6] text-secondary-ink wrap-anywhere">
              Visit your website in a browser, then check for your first pageview.
            </p>
          </div>
        </div>
        <div className="mt-4 flex gap-3 max-md:flex-wrap md:ml-11">
          {guided && (
            <Button
              variant="outline"
              render={<a href={`https://${environment.domain}`} target="_blank" rel="noreferrer" />}
            >
              Open my website <ArrowRight size={15} />
            </Button>
          )}
          <Button onClick={check} variant={receiving ? 'outline' : 'default'} loading={busy}>
            <RefreshCw size={15} />
            Check installation
          </Button>
          {receiving && (
            <Button onClick={onDashboard}>
              View dashboard
              <ArrowRight size={15} />
            </Button>
          )}
        </div>
        {message && (
          <p
            className={`mt-4 text-sm leading-[1.6] ${receiving ? 'text-success' : 'text-secondary-ink'}`}
            role="status"
          >
            {message}
          </p>
        )}
        {error && (
          <p className="text-sm leading-normal text-danger" role="alert">
            {error}
          </p>
        )}
      </section>
      {environment.trackingMode !== 'cookieless' && (
        <section className="mb-6 rounded-md border border-border bg-muted p-5">
          <h2 className="text-[17px] font-medium">
            {environment.trackingMode === 'local'
              ? 'Uses local storage — connect your consent banner'
              : 'Uses cookies — connect your cookie banner'}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-secondary-ink">
            No tracking identifiers or activity events are created before consent. Call this from
            your banner's analytics-consent callback, including its saved choice on every page. Pass
            false when consent is rejected or withdrawn.
          </p>
          <pre
            aria-label="Consent integration"
            className="mt-4 whitespace-pre-wrap wrap-anywhere font-mono text-xs leading-relaxed"
          >{`function onAnalyticsConsentChanged(granted) {
  window.analyticsBeerConsent = granted === true;
  window.simpleAnalytics?.consent(granted === true);
}`}</pre>
          <p className="mt-3 text-sm leading-relaxed text-secondary-ink">
            This callback connects your existing banner; it does not display one. Provide accept and
            reject choices and a way to change them. Consent withdrawal deletes this environment's
            tracking identifiers and stops collection.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-secondary-ink">
            {environment.trackingMode === 'local'
              ? 'Identifiers are stored in local storage, with no tracking cookies. Visitor expiry: 90 days, renewed with activity. Session expiry: 30 minutes of inactivity. Expired identifiers are replaced when tracking next runs. Storage is scoped to this origin and environment.'
              : 'First-party visitor cookie: 90 days, renewed with activity. Session cookie: 30 minutes of inactivity. Both are scoped to this hostname and environment.'}{' '}
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
            Cookie and consent guidance
          </a>
        </section>
      )}
      <ExtrasContainer>
        {guided && (
          <summary className="mb-5 cursor-pointer text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
            Testing locally or tracking custom events?
          </summary>
        )}
        <LocalhostSetting environment={environment} busy={busy} onChange={setLocalhost} />
        <div className="pt-2">
          <h3 className="text-[15px] font-medium tracking-[-0.025em]">
            Want to track a specific action?
          </h3>
          <p className="mt-1.5 text-sm leading-[1.8] text-secondary-ink wrap-anywhere">
            Use{' '}
            <code className="font-mono text-[0.9em]">window.simpleAnalytics.track('signup')</code>{' '}
            after your script has loaded. Replace “signup” with a short name for the action.
          </p>
        </div>
      </ExtrasContainer>
    </div>
  );
}

export function SiteSettings({
  site,
  environment,
  onEnvironmentUpdated,
  onEnvironmentDeleted,
  onUpdated,
  onDeleted,
}: {
  site: Site;
  environment: SiteEnvironment;
  onEnvironmentUpdated: (environment: SiteEnvironment) => void;
  onEnvironmentDeleted: () => void;
  onUpdated: (site: Site) => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(site.name);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(''),
    [deleting, setDeleting] = useState(false),
    [confirm, setConfirm] = useState('');
  async function update(value: Partial<Site>) {
    setBusy(true);
    setError('');
    setSaved('');
    try {
      const result = await apiClient<{ site: Site }>(`/sites/${site.id}`, write('PATCH', value));
      onUpdated(result.site);
      setSaved('Changes saved.');
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
          Website settings
        </h1>
        <p className="mt-2 text-secondary-ink wrap-anywhere">Manage {site.domain}.</p>
      </div>
      <EnvironmentSettings
        key={environment.id}
        site={site}
        environment={environment}
        onUpdated={onEnvironmentUpdated}
        onDeleted={onEnvironmentDeleted}
      />
      <section className="mb-6">
        <h2 className="text-[17px] leading-[1.4] font-medium tracking-[-0.025em]">
          Website details
        </h2>
        <form
          className="flex flex-col gap-4 mt-5 max-w-[440px]"
          onSubmit={(event) => {
            event.preventDefault();
            void update({ name });
          }}
        >
          <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="settings-name">
            Website name
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
            Domain
            <Input id="settings-domain" value={site.domain} readOnly size="default" />
            <span className="text-[13px] leading-normal font-normal text-muted-foreground">
              Add an environment to track a staging or testing domain separately.
            </span>
          </label>
          <Button className="self-start" type="submit" loading={busy}>
            Save changes
          </Button>
        </form>
      </section>
      {saved && (
        <p className="my-4 text-sm text-success" role="status">
          {saved}
        </p>
      )}
      {error && !deleting && (
        <p className="text-sm leading-normal text-danger" role="alert">
          {error}
        </p>
      )}
      <section className="mb-6 flex flex-col items-start gap-4 md:flex-row md:items-center md:justify-between md:gap-6 mt-7">
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] leading-[1.4] font-medium tracking-[-0.025em]">
            Remove this website
          </h2>
          <p className="mt-1.5 text-sm leading-[1.6] text-secondary-ink wrap-anywhere">
            Permanently delete this website, every environment, and all their analytics.
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
          Delete website
        </Button>
      </section>
      <Dialog
        open={deleting}
        onOpenChange={(value) => {
          if (!busy) setDeleting(value);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Delete {site.name}?</DialogTitle>
            <DialogDescription>
              Every environment and all pageviews, events, and history for {site.domain} will be
              permanently deleted. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="px-6 pb-6 flex flex-col gap-4">
            <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="delete-confirm">
              Type {site.domain} to confirm
              <Input
                id="delete-confirm"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="off"
                size="default"
              />
            </label>
            {error && (
              <p className="text-sm leading-normal text-danger" role="alert">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>
              Keep website
            </DialogClose>
            <Button
              variant="destructive"
              loading={busy}
              disabled={confirm !== site.domain}
              onClick={remove}
            >
              Delete website
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

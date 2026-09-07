import { trackingSettingLabels, trackingSettings } from '../lib/tracking-settings';
import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, Pause, Play, Trash2 } from './ui/icons';
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

function hostname(value: string) {
  let domain = value.trim();
  if (domain.includes('://')) {
    try {
      domain = new URL(domain).hostname;
    } catch {
      /* API validation provides the error. */
    }
  }
  return domain.replace(/\/$/, '');
}

export function AddEnvironmentDialog({
  site,
  open,
  onOpenChange,
  onCreated,
}: {
  site: Site;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (environment: SiteEnvironment) => void;
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
    try {
      const result = await apiClient<{ environment: SiteEnvironment }>(
        `/sites/${site.id}/environments`,
        write('POST', {
          name: form.get('name'),
          domain: hostname(String(form.get('domain'))),
          allowLocalhost: form.get('localhost') === 'on',
        }),
      );
      onCreated(result.environment);
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
          <DialogTitle>Add an environment</DialogTitle>
          <DialogDescription>
            Keep traffic for testing, staging, or any other environment separate from {site.domain}
            ’s production reports.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <div className="flex flex-col gap-[22px] px-6 pb-6">
            <label
              className="flex flex-col gap-2 text-sm font-medium"
              htmlFor="new-environment-name"
            >
              Environment name
              <Input
                id="new-environment-name"
                name="name"
                placeholder="Staging"
                maxLength={40}
                required
                size="lg"
              />
            </label>
            <label
              className="flex flex-col gap-2 text-sm font-medium"
              htmlFor="new-environment-domain"
            >
              Environment domain
              <Input
                id="new-environment-domain"
                name="domain"
                defaultValue={site.domain}
                placeholder="staging.example.com"
                required
                maxLength={2048}
                size="lg"
              />
              <span className="text-[13px] leading-normal font-normal text-muted-foreground">
                Use the same domain or a separate staging domain. Each environment gets its own
                script.
              </span>
            </label>
            <label
              className="flex cursor-pointer items-start gap-3 text-sm"
              htmlFor="new-environment-localhost"
            >
              <input
                id="new-environment-localhost"
                name="localhost"
                type="checkbox"
                className="mt-1 size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
              />
              Allow localhost for testing
            </label>
            {error && (
              <p className="text-sm text-danger" role="alert">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>Cancel</DialogClose>
            <Button type="submit" loading={busy}>
              Add environment
              <ArrowRight size={15} />
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export function LocalhostSetting({
  environment,
  busy,
  onChange,
}: {
  environment: SiteEnvironment;
  busy: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <section className="mb-8">
      <label
        className="flex cursor-pointer items-start gap-3 has-disabled:cursor-default"
        htmlFor="allow-localhost"
      >
        <input
          id="allow-localhost"
          type="checkbox"
          checked={environment.allowLocalhost}
          disabled={busy}
          onChange={(event) => onChange(event.target.checked)}
          aria-describedby="localhost-help"
          className="mt-1 size-4 shrink-0 cursor-pointer accent-primary disabled:cursor-default disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        />
        <span className="text-[17px] leading-[1.4] font-medium tracking-[-0.025em]">
          Allow localhost for testing
        </span>
      </label>
      <p id="localhost-help" className="mt-1.5 pl-7 text-sm leading-[1.6] text-secondary-ink">
        Accept activity from localhost, 127.0.0.1, and ::1 on any port. Test activity is included
        only in {environment.name}’s reports. Localhost pageviews use 0.3 credits; other events use
        0.15 credits. Do Not Track still prevents collection.
      </p>
    </section>
  );
}

export function EnvironmentSettings({
  site,
  environment,
  onUpdated,
  onDeleted,
}: {
  site: Site;
  environment: SiteEnvironment;
  onUpdated: (environment: SiteEnvironment) => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(environment.name),
    [domain, setDomain] = useState(environment.domain);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(''),
    [deleting, setDeleting] = useState(false),
    [confirm, setConfirm] = useState('');
  const isDefault = environment.id === site.id;
  async function update(value: Partial<SiteEnvironment>) {
    setBusy(true);
    setError('');
    setSaved('');
    try {
      const result = await apiClient<{ environment: SiteEnvironment }>(
        `/sites/${site.id}/environments/${environment.id}`,
        write('PATCH', value),
      );
      onUpdated(result.environment);
      setName(result.environment.name);
      setDomain(result.environment.domain);
      setSaved('Environment saved.');
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
      await apiClient(`/sites/${site.id}/environments/${environment.id}`, {
        method: 'DELETE',
      });
      setDeleting(false);
      onDeleted();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mb-10">
      <TrackingModeSetting
        environment={environment}
        busy={busy}
        onChange={(trackingMode) => {
          void update({ trackingMode });
        }}
      />
      <section className="mb-8" aria-labelledby="tracking-controls-heading">
        <h2 id="tracking-controls-heading" className="text-[17px] font-medium tracking-[-0.025em]">
          What to track
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-secondary-ink">
          Choose which events and details {environment.name} collects. Changes apply to new
          activity; existing reports are kept.
        </p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {Object.entries(trackingSettingLabels).map(([key, label]) => {
            const setting = key as keyof typeof trackingSettingLabels;
            return (
              <label key={key} className="flex items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={trackingSettings(environment.trackingSettings)[setting]}
                  disabled={busy}
                  onChange={(event) => {
                    void update({
                      trackingSettings: {
                        ...trackingSettings(environment.trackingSettings),
                        [setting]: event.target.checked,
                      },
                    });
                  }}
                />
                {label}
              </label>
            );
          })}
        </div>
        <p className="mt-4 text-sm text-secondary-ink">
          Production pageviews use 1 credit; other events use 0.5 credits. Engagement time is free.
        </p>
      </section>
      <section className="mb-8">
        <h2 className="text-[17px] leading-[1.4] font-medium tracking-[-0.025em]">
          Environment details
        </h2>
        <p className="mt-1.5 text-sm leading-[1.6] text-secondary-ink">
          Settings for {environment.name}.
        </p>
        <form
          className="mt-5 grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void update({
              name,
              ...(!isDefault ? { domain: hostname(domain) } : {}),
            });
          }}
        >
          <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="environment-name">
            Environment name
            <Input
              id="environment-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={40}
              size="lg"
            />
          </label>
          <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="environment-domain">
            Environment domain
            <Input
              id="environment-domain"
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              required
              readOnly={isDefault}
              maxLength={2048}
              size="lg"
            />
            {isDefault && (
              <span className="text-[13px] leading-normal font-normal text-muted-foreground">
                Add an environment to track a different domain.
              </span>
            )}
          </label>
          <Button className="justify-self-start sm:col-span-2" type="submit" loading={busy}>
            Save environment
          </Button>
        </form>
      </section>
      <section className="mb-8 flex flex-col items-start gap-4 md:flex-row md:items-center md:justify-between md:gap-6">
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] leading-[1.4] font-medium tracking-[-0.025em]">
            {environment.enabled ? 'Collection is active' : 'Collection is paused'}
          </h2>
          <p className="mt-1.5 text-sm leading-[1.6] text-secondary-ink">
            {environment.enabled
              ? `New pageviews and events are being accepted for ${environment.name}.`
              : 'Existing analytics are kept. Other environments are unaffected.'}
          </p>
        </div>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => update({ enabled: !environment.enabled })}
        >
          {environment.enabled ? <Pause size={15} /> : <Play size={15} />}
          {environment.enabled ? 'Pause collection' : 'Resume collection'}
        </Button>
      </section>
      <LocalhostSetting
        environment={environment}
        busy={busy}
        onChange={(allowLocalhost) => {
          void update({ allowLocalhost });
        }}
      />
      {saved && (
        <p className="my-4 text-sm text-success" role="status">
          {saved}
        </p>
      )}
      {error && !deleting && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}
      {!isDefault && (
        <section className="mt-8 flex flex-col items-start gap-4 md:flex-row md:items-center md:justify-between md:gap-6">
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] font-medium tracking-[-0.025em]">Remove this environment</h2>
            <p className="mt-1.5 text-sm leading-[1.6] text-secondary-ink">
              Delete {environment.name} and its traffic. Other environments are kept.
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
            Delete environment
          </Button>
        </section>
      )}
      <Dialog
        open={deleting}
        onOpenChange={(value) => {
          if (!busy) setDeleting(value);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Delete {environment.name}?</DialogTitle>
            <DialogDescription>
              All pageviews, events, and history for this environment will be permanently deleted.
              Other environments are unaffected.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-[22px] px-6 pb-6">
            <label
              className="flex flex-col gap-2 text-sm font-medium"
              htmlFor="delete-environment-confirm"
            >
              Type {environment.name} to confirm
              <Input
                id="delete-environment-confirm"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="off"
                size="lg"
              />
            </label>
            {error && (
              <p className="text-sm text-danger" role="alert">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>
              Keep environment
            </DialogClose>
            <Button
              variant="destructive"
              loading={busy}
              disabled={confirm !== environment.name}
              onClick={remove}
            >
              Delete environment
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

export function TrackingModeSetting({
  environment,
  busy,
  onChange,
}: {
  environment: SiteEnvironment;
  busy: boolean;
  onChange: (mode: SiteEnvironment['trackingMode']) => void;
}) {
  const [mode, setMode] = useState<SiteEnvironment['trackingMode']>(
      environment.trackingMode === 'local' ? 'cookieless' : environment.trackingMode,
    ),
    [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => {
    setMode(environment.trackingMode === 'local' ? 'cookieless' : environment.trackingMode);
  }, [environment.trackingMode]);
  return (
    <section className="mb-9 max-w-[640px]">
      <h2 className="text-[17px] font-medium">Tracking mode</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-secondary-ink">
        Choose how {environment.name} measures visits. After changing modes, replace the script on
        your website.
      </p>
      <label className="mt-4 flex max-w-[440px] flex-col gap-2 text-sm font-medium">
        Analytics mode
        <select
          aria-label="Analytics mode"
          className="h-11 rounded-md border border-input bg-background px-3 text-foreground"
          value={mode}
          onChange={(event) => {
            setMode(event.target.value as SiteEnvironment['trackingMode']);
            setAcknowledged(false);
          }}
        >
          <option value="cookieless">Cookieless · visitors and page journeys</option>
          <option value="sessions">Cookie-based · sessions and activity</option>
        </select>
      </label>
      {environment.trackingMode === 'local' && (
        <p className="mt-3 text-sm text-secondary-ink">
          This environment still uses the previous local-storage mode. Save Cookieless and replace
          your website script to switch to anonymous daily visitors.
        </p>
      )}
      {mode === 'cookieless' && (
        <p className="mt-3 text-sm leading-relaxed text-secondary-ink">
          Anonymous daily visitors, page journeys, browser, device, screen size, clicks, scroll
          depth, and active time. No cookies or local storage. Identities reset each UTC day; people
          sharing a network and browser may be grouped together.
        </p>
      )}
      {mode !== 'cookieless' && (
        <div className="mt-4 rounded-md border border-border bg-muted p-4 text-sm leading-relaxed">
          <p className="font-medium">
            {mode === 'local'
              ? 'Uses local storage — analytics consent is required.'
              : 'Uses cookies — a cookie banner is required.'}
          </p>
          <p className="mt-2 text-secondary-ink">
            Connect your banner before using this mode. Tracking starts only after analytics consent
            and must stop when consent is withdrawn. Explain the data collected in your cookie and
            privacy notices.
          </p>
          <p className="mt-2 text-secondary-ink">
            Includes sessions, page visits, clicks, links, downloads, form submissions, scroll
            depth, active time, browser, device, and screen size. Field values and page text are
            excluded. Detailed activity is kept for 30 days.
          </p>
          {environment.trackingMode !== mode && (
            <label className="mt-3 flex items-start gap-3">
              <input
                className="mt-1 accent-primary"
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              {mode === 'local'
                ? 'I understand that local storage requires analytics consent.'
                : 'I understand that I need a cookie banner and analytics consent.'}
            </label>
          )}
        </div>
      )}
      {mode !== environment.trackingMode && (
        <Button
          className="mt-4"
          loading={busy}
          disabled={mode !== 'cookieless' && !acknowledged}
          onClick={() => onChange(mode)}
        >
          Save tracking mode
        </Button>
      )}
      {environment.trackingMode !== 'cookieless' && (
        <p className="mt-3 text-sm text-secondary-ink">
          Get the consent integration code from Install.
        </p>
      )}
    </section>
  );
}

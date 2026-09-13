import { Alert } from './ui/alert';
import { toast } from './ui/toast';
import { Checkbox } from './ui/checkbox';
import { Select } from './ui/select';
import { useSitePreferences } from './site-preferences';
import { trackingSettingLabels, trackingSettings } from '../lib/tracking-settings';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Pause, Play, Trash2 } from './ui/icons';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { cn } from '../lib/utils';
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

const subsectionTitle = 'text-[15px] leading-[1.4] font-medium tracking-[-0.025em]';

export function SettingsGroup({
  title,
  detail,
  children,
  className,
}: {
  title: string;
  detail?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn(className)}>
      <h2 className="text-[17px] leading-[1.4] font-medium tracking-[-0.025em]">{title}</h2>
      {detail ? <p className="mt-1 wrap-anywhere text-sm text-secondary-ink">{detail}</p> : null}
      <div className="mt-5 flex flex-col gap-8">{children}</div>
    </section>
  );
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
    try {
      const result = await apiClient<{ environment: SiteEnvironment }>(
        `/sites/${site.id}/environments`,
        write('POST', {
          name: form.get('name'),
          domain: hostname(String(form.get('domain'))),
          allowLocalhost: form.get('localhost') === 'on',
        }),
      );
      toast.success(t('Environment added.'));
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
          <DialogTitle>{t('Add an environment')}</DialogTitle>
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
              {t('Environment name')}
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
              {t('Environment domain')}
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
                {t(
                  'Use the same domain or a separate staging domain. Each environment gets its own script.',
                )}
              </span>
            </label>
            <label
              className="flex cursor-pointer items-start gap-3 text-sm"
              htmlFor="new-environment-localhost"
            >
              <Checkbox id="new-environment-localhost" name="localhost" />
              {t('Allow localhost for testing')}
            </label>
            {error && <Alert className="text-sm text-danger">{messageText(error)}</Alert>}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>
              {t('Cancel')}
            </DialogClose>
            <Button type="submit" loading={busy}>
              {t('Add environment')}
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
  className,
}: {
  environment: SiteEnvironment;
  busy: boolean;
  onChange: (enabled: boolean) => void;
  className?: string;
}) {
  const { t } = useSitePreferences();
  return (
    <section className={cn(className)}>
      <label
        className="flex cursor-pointer items-start gap-3 has-disabled:cursor-default"
        htmlFor="allow-localhost"
      >
        <Checkbox
          id="allow-localhost"

          checked={environment.allowLocalhost}
          disabled={busy}
          onChange={(event) => onChange(event.target.checked)}
          aria-describedby="localhost-help"
        />
        <span className={subsectionTitle}>{t('Allow localhost for testing')}</span>
      </label>
      <p id="localhost-help" className="mt-1.5 pl-7 text-sm leading-[1.6] text-secondary-ink">
        {t(
          'Accept activity from localhost, 127.0.0.1, and ::1 on any port. Test activity is included only in {environment}’s reports. Localhost pageviews use 0.3 credits; other events use 0.15 credits. Do Not Track still prevents collection.',
          { environment: environment.name },
        )}
      </p>
    </section>
  );
}

export function EnvironmentSettings({
  section = 'environment',
  site,
  environment,
  onUpdated,
  onDeleted,
}: {
  section?: 'environment' | 'tracking';
  site: Site;
  environment: SiteEnvironment;
  onUpdated: (environment: SiteEnvironment) => void;
  onDeleted: () => void;
}) {
  const { t, message: messageText } = useSitePreferences();
  const [name, setName] = useState(environment.name),
    [domain, setDomain] = useState(environment.domain);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [deleting, setDeleting] = useState(false),
    [confirm, setConfirm] = useState('');
  const isDefault = environment.id === site.id;
  async function update(value: Partial<SiteEnvironment>) {
    setBusy(true);
    setError('');
    try {
      const result = await apiClient<{ environment: SiteEnvironment }>(
        `/sites/${site.id}/environments/${environment.id}`,
        write('PATCH', value),
      );
      onUpdated(result.environment);
      setName(result.environment.name);
      setDomain(result.environment.domain);
      toast.success(t('Environment saved.'));
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
      toast.success(t('Environment deleted.'));
      onDeleted();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mb-10">
      <div hidden={section !== 'tracking'}>
        <TrackingModeSetting
          environment={environment}
          busy={busy}
          onChange={(trackingMode) => {
            void update({ trackingMode });
          }}
        />
        <section className="mb-8" aria-labelledby="tracking-controls-heading">
          <h2
            id="tracking-controls-heading"
            className="text-[17px] font-medium tracking-[-0.025em]"
          >
            {t('What to track')}
          </h2>
          <p className="mt-1.5 text-sm leading-relaxed text-secondary-ink">
            {t(
              'Choose which events and details {environment} collects. Changes apply to new activity; existing reports are kept.',
              { environment: environment.name },
            )}
          </p>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {Object.entries(trackingSettingLabels).map(([key, label]) => {
              const setting = key as keyof typeof trackingSettingLabels;
              return (
                <label key={key} className="flex items-center gap-3 text-sm">
                  <Checkbox
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
                  {t(label)}
                </label>
              );
            })}
          </div>
          <p className="mt-4 text-sm text-secondary-ink">
            {t(
              'Production pageviews use 1 credit; other events use 0.5 credits. Engagement time is free.',
            )}
          </p>
        </section>
      </div>
      <div hidden={section !== 'environment'}>
        <section className="mb-8">
          <h2 className="text-[17px] leading-[1.4] font-medium tracking-[-0.025em]">
            {t('Environment details')}
          </h2>
          <p className="mt-1.5 text-sm leading-[1.6] text-secondary-ink">
            {t('Settings for {environment}.', { environment: environment.name })}
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
              {t('Environment name')}
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
              {t('Environment domain')}
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
                  {t('Add an environment to track a different domain.')}
                </span>
              )}
            </label>
            <Button className="justify-self-start sm:col-span-2" type="submit" loading={busy}>
              {t('Save environment')}
            </Button>
          </form>
        </section>
        <section className="mb-8 flex flex-col items-start gap-4 md:flex-row md:items-center md:justify-between md:gap-6">
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] leading-[1.4] font-medium tracking-[-0.025em]">
              {environment.enabled ? t('Collection is active') : t('Collection is paused')}
            </h2>
            <p className="mt-1.5 text-sm leading-[1.6] text-secondary-ink">
              {environment.enabled
                ? t('New pageviews and events are being accepted for {environment}.', {
                    environment: environment.name,
                  })
                : t('Existing analytics are kept. Other environments are unaffected.')}
            </p>
          </div>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => update({ enabled: !environment.enabled })}
          >
            {environment.enabled ? <Pause size={15} /> : <Play size={15} />}
            {environment.enabled ? t('Pause collection') : t('Resume collection')}
          </Button>
        </section>
        <LocalhostSetting
          environment={environment}
          busy={busy}
          onChange={(allowLocalhost) => {
            void update({ allowLocalhost });
          }}
        />
      </div>
      {error && !deleting && <Alert className="text-sm text-danger">{messageText(error)}</Alert>}
      {section === 'environment' && !isDefault && (
        <section className="mt-8 flex flex-col items-start gap-4 md:flex-row md:items-center md:justify-between md:gap-6">
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] font-medium tracking-[-0.025em]">
              {t('Remove this environment')}
            </h2>
            <p className="mt-1.5 text-sm leading-[1.6] text-secondary-ink">
              {t('Delete {environment} and its traffic. Other environments are kept.', {
                environment: environment.name,
              })}
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
            {t('Delete environment')}
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
            <DialogTitle>{t('Delete {name}?', { name: environment.name })}</DialogTitle>
            <DialogDescription>
              {t(
                'All pageviews, events, and history for this environment will be permanently deleted. Other environments are unaffected.',
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-[22px] px-6 pb-6">
            <label
              className="flex flex-col gap-2 text-sm font-medium"
              htmlFor="delete-environment-confirm"
            >
              {t('Type {name} to confirm', { name: environment.name })}
              <Input
                id="delete-environment-confirm"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="off"
                size="lg"
              />
            </label>
            {error && <Alert className="text-sm text-danger">{messageText(error)}</Alert>}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>
              {t('Keep environment')}
            </DialogClose>
            <Button
              variant="destructive"
              loading={busy}
              disabled={confirm !== environment.name}
              onClick={remove}
            >
              {t('Delete environment')}
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
  const { t } = useSitePreferences();
  const [mode, setMode] = useState<SiteEnvironment['trackingMode']>(
      environment.trackingMode === 'local' ? 'cookieless' : environment.trackingMode,
    ),
    [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => {
    setMode(environment.trackingMode === 'local' ? 'cookieless' : environment.trackingMode);
  }, [environment.trackingMode]);
  return (
    <section className="mb-9 max-w-[640px]">
      <h2 className="text-[17px] font-medium">{t('Tracking mode')}</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-secondary-ink">
        {t(
          'Choose how {environment} measures visits. After changing modes, replace the script on your website.',
          { environment: environment.name },
        )}
      </p>
      <label className="mt-4 flex max-w-[440px] flex-col gap-2 text-sm font-medium">
        {t('Analytics mode')}
        <Select
          aria-label={t('Analytics mode')}
          className="h-11 rounded-md border border-input bg-background px-3 text-foreground"
          value={mode}
          onValueChange={(value) => {
            setMode(value as SiteEnvironment['trackingMode']);
            setAcknowledged(false);
          }}
        >
          <option value="cookieless">{t('Cookieless · visitors and page journeys')}</option>
          <option value="sessions">{t('Cookie-based · sessions and activity')}</option>
        </Select>
      </label>
      {environment.trackingMode === 'local' && (
        <p className="mt-3 text-sm text-secondary-ink">
          {t(
            'This environment still uses the previous local-storage mode. Save Cookieless and replace your website script to switch to anonymous daily visitors.',
          )}
        </p>
      )}
      {mode === 'cookieless' && (
        <p className="mt-3 text-sm leading-relaxed text-secondary-ink">
          {t(
            'Anonymous daily visitors, page journeys, browser, device, screen size, clicks, scroll depth, and active time. No cookies or local storage. Identities reset each UTC day; people sharing a network and browser may be grouped together.',
          )}
        </p>
      )}
      {mode !== 'cookieless' && (
        <div className="mt-4 rounded-md border border-border bg-muted p-4 text-sm leading-relaxed">
          <p className="font-medium">
            {mode === 'local'
              ? t('Uses local storage \u2014 analytics consent is required.')
              : t('Uses cookies \u2014 a cookie banner is required.')}
          </p>
          <p className="mt-2 text-secondary-ink">
            {t(
              'Consent is your responsibility in this mode. The script starts collecting as soon as it loads, so load it only after your banner records consent, and stop collection when consent is withdrawn. Explain the data collected in your cookie and privacy notices.',
            )}
          </p>
          <p className="mt-2 text-secondary-ink">
            {t(
              'Includes sessions, page visits, clicks, links, downloads, form submissions, scroll depth, active time, browser, device, and screen size. Field values and page text are excluded. Detailed activity is kept for 30 days.',
            )}
          </p>
          {environment.trackingMode !== mode && (
            <label className="mt-3 flex items-start gap-3">
              <Checkbox
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              {t('I understand that my website must obtain consent before the script loads.')}
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
          {t('Save tracking mode')}
        </Button>
      )}
      {environment.trackingMode !== 'cookieless' && (
        <p className="mt-3 text-sm text-secondary-ink">
          {t('Get the consent integration code from Install.')}
        </p>
      )}
    </section>
  );
}

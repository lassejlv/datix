import { useState, type FormEvent } from 'react';
import { apiClient, errorText, write, type SiteEnvironment } from '../lib/client';
import { useFeatureReport, ReportStatus, EmptyFeature } from './feature-report';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { useSitePreferences } from './site-preferences';
type PulseReport = {
  monitor: null | {
    url: string;
    hasWebhook: boolean;
    state: 'up' | 'down' | 'unknown';
    checkedAt: string | null;
    latencyMs: number | null;
    statusCode: number | null;
    error: string | null;
  };
  checks: { checkedAt: string; available: boolean; latencyMs: number; statusCode: number | null }[];
  summary: { checks: number; uptime: number | null; uptime24h: number | null };
  alert: null | {
    state: string;
    deliveredAt: string | null;
    attempts: number;
    error: string | null;
  };
};
export function PulseSettings({
  siteId,
  environment,
}: {
  siteId: string;
  environment: SiteEnvironment;
}) {
  const { t, message } = useSitePreferences();
  const path = `/sites/${siteId}/environments/${environment.id}/features/pulse`;
  const [refresh, setRefresh] = useState(0);
  const { data, error } = useFeatureReport<PulseReport>(path, refresh);
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState(''),
    [saved, setSaved] = useState(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const element = event.currentTarget;
    setBusy(true);
    setFailure('');
    setSaved(false);
    try {
      await apiClient(
        path,
        write('POST', {
          url: form.get('url'),
          ...(String(form.get('webhook')).trim() ? { webhookUrl: form.get('webhook') } : {}),
          clearWebhook: form.get('clear') === 'on',
        }),
      );
      element.reset();
      setSaved(true);
      setRefresh((n) => n + 1);
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ReportStatus error={error} loading={!data}>
      <form key={refresh} onSubmit={save} className="flex max-w-xl flex-col gap-5">
        <div>
          <h2 className="text-base font-medium">{t('Pulse settings')}</h2>
          <p className="mt-1 text-sm text-secondary-ink">
            {t('Checked every minute. Two failed checks confirm an outage.')}
          </p>
        </div>
        <label className="flex flex-col gap-2 text-sm">
          {t('Monitor URL')}
          <Input
            name="url"
            type="url"
            required
            maxLength={2048}
            defaultValue={data?.monitor?.url ?? `https://${environment.domain}`}
          />
        </label>
        <label className="flex flex-col gap-2 text-sm">
          {t('Webhook URL')}
          <Input
            name="webhook"
            type="password"
            autoComplete="new-password"
            maxLength={2048}
            placeholder="https://…"
          />
          <span className="text-xs text-secondary-ink">
            {data?.monitor?.hasWebhook
              ? t('A webhook is linked. Leave blank to keep it.')
              : t('Link a webhook to receive outage and recovery alerts.')}
          </span>
        </label>
        {data?.monitor?.hasWebhook && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="clear" className="accent-primary" />
            {t('Remove linked webhook')}
          </label>
        )}
        <div>
          <Button type="submit" loading={busy}>
            {t('Save monitor')}
          </Button>
        </div>
        {failure && (
          <p role="alert" className="text-sm text-danger">
            {message(failure)}
          </p>
        )}
        {saved && (
          <p role="status" className="text-sm text-secondary-ink">
            {t('Changes saved.')}
          </p>
        )}
      </form>
    </ReportStatus>
  );
}
export function Pulse({ path, onSettings }: { path: string; onSettings: () => void }) {
  const { t, locale } = useSitePreferences();
  const { data, error } = useFeatureReport<PulseReport>(path, 0, 30000);
  const percent = (value: number | null | undefined) =>
    value == null
      ? '—'
      : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(Number(value))}%`;
  return (
    <ReportStatus error={error} loading={!data}>
      {!data?.monitor ? (
        <EmptyFeature>
          <p>{t('Add a monitor URL in Settings to start checking availability.')}</p>
          <Button className="mt-4" variant="outline" onClick={onSettings}>
            {t('Open settings')}
          </Button>
        </EmptyFeature>
      ) : (
        <>
          <div className="mb-6 flex items-center justify-between gap-3">
            <div>
              <span
                className={`mr-2 inline-block size-2 rounded-full ${data.monitor.state === 'up' ? 'bg-emerald-500' : data.monitor.state === 'down' ? 'bg-red-500' : 'bg-muted-foreground'}`}
              />
              <span className="text-sm font-medium">
                {t(
                  data.monitor.state === 'up'
                    ? 'Operational'
                    : data.monitor.state === 'down'
                      ? 'Site down'
                      : 'Waiting for checks',
                )}
              </span>
              <p className="mt-1 break-all text-sm text-secondary-ink">{data.monitor.url}</p>
            </div>
            <Button variant="outline" size="sm" onClick={onSettings}>
              {t('Settings')}
            </Button>
          </div>
          <div className="grid grid-cols-3 divide-x divide-border rounded-lg border border-border py-5">
            {[
              [t('Uptime · 24h'), percent(data.summary.uptime24h)],
              [t('Uptime · 7d'), percent(data.summary.uptime)],
              [
                t('Response time'),
                data.monitor.latencyMs == null ? '—' : `${data.monitor.latencyMs} ms`,
              ],
            ].map(([label, value]) => (
              <div key={label} className="px-4">
                <p className="text-xs text-secondary-ink">{label}</p>
                <p className="mt-2 text-xl font-medium tabular-nums">{value}</p>
              </div>
            ))}
          </div>
          <section className="mt-7">
            <h2 className="text-sm font-medium">{t('Recent checks')}</h2>
            <div className="mt-4 flex h-12 gap-0.5" aria-label={t('Recent checks')}>
              {[...data.checks].reverse().map((check) => (
                <span
                  key={check.checkedAt}
                  className={`min-w-0 flex-1 rounded-sm ${check.available ? 'bg-emerald-500/70' : 'bg-red-500/80'}`}
                  title={`${new Date(check.checkedAt).toLocaleString(locale)} · ${check.statusCode ?? '—'} · ${check.latencyMs} ms`}
                />
              ))}
            </div>
            <p className="mt-2 text-xs text-secondary-ink">
              {data.monitor.checkedAt
                ? `${t('Last checked')} ${new Date(data.monitor.checkedAt).toLocaleString(locale)}`
                : t('Waiting for checks')}
            </p>
          </section>
          {data.monitor.error && (
            <p role="status" className="mt-4 text-sm text-danger">
              {t('The latest availability check failed.')}
            </p>
          )}
          <p className="mt-6 text-sm text-secondary-ink">
            {!data.monitor.hasWebhook
              ? t('No webhook linked. Add one in Settings to receive alerts.')
              : data.alert?.deliveredAt
                ? t('Latest alert delivered.')
                : data.alert?.attempts === 5
                  ? t('Webhook delivery failed after five attempts. Check the linked URL.')
                  : data.alert
                    ? t('Alert delivery pending.')
                    : t('Webhook linked. Alerts will be sent for outages and recoveries.')}
          </p>
          <p className="mt-2 text-xs text-secondary-ink">
            {t('Uptime is based on recorded checks. Monitoring gaps are not counted.')}
          </p>
        </>
      )}
    </ReportStatus>
  );
}

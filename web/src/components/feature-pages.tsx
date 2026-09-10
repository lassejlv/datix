import { Alert } from './ui/alert';
import { toast } from './ui/toast';
import { Select } from './ui/select';
import { lazy, Suspense, useState, type FormEvent } from 'react';
import { apiClient, errorText, write, type SiteEnvironment } from '../lib/client';
import { featureDefinitions, featureSettings, type FeaturePage } from '../lib/features';
import {
  useFeatureReport,
  ReportStatus,
  EmptyFeature,
  FeatureToolbar,
  rangeQuery,
} from './feature-report';
import { useSitePreferences } from './site-preferences';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Pulse } from './pulse';
const Globe = lazy(() => import('./visitor-globe'));
export function FeaturePageView({
  page,
  siteId,
  environment,
  onSettings,
}: {
  page: FeaturePage;
  siteId: string;
  environment: SiteEnvironment;
  onSettings: () => void;
}) {
  const { t } = useSitePreferences();
  const feature = featureDefinitions.find((f) => f.page === page)!;
  const enabled = featureSettings(environment.featureSettings)[feature.key];
  const path = `/sites/${siteId}/environments/${environment.id}/features/${page}`;
  return (
    <div>
      <header className="mb-6">
        <h1 className="text-[22px] font-medium tracking-tight">{t(feature.label)}</h1>
        <p className="mt-1 text-sm text-secondary-ink">{t(feature.description)}</p>
      </header>
      {!enabled ? (
        <EmptyFeature>
          <p>{t('Enable this feature in Settings to get started.')}</p>
          <Button className="mt-4" onClick={onSettings}>
            {t('Open settings')}
          </Button>
        </EmptyFeature>
      ) : page === 'goals' ? (
        <Goals path={path} />
      ) : page === 'pulse' ? (
        <Pulse path={path} onSettings={onSettings} />
      ) : page === 'globe' ? (
        <Suspense fallback={<p>{t('Loading…')}</p>}>
          <Globe path={path} />
        </Suspense>
      ) : (
        <Diagnostics path={path} errors={page === 'errors'} />
      )}
    </div>
  );
}
type Goal = {
  id: string;
  name: string;
  matchType: 'page' | 'event';
  matchValue: string;
  conversions: number;
  visitors: number;
};
function Goals({ path }: { path: string }) {
  const { t, locale, message } = useSitePreferences();
  const [days, setDays] = useState('7'),
    [refresh, setRefresh] = useState(0),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState(''),
    [type, setType] = useState('event');
  const { data, error } = useFeatureReport<{ goals: Goal[]; visitors: number }>(
    path + rangeQuery(days),
    refresh,
  );
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    setBusy(true);
    setFailure('');
    try {
      await apiClient(
        path,
        write('POST', {
          name: fields.get('name'),
          matchType: type,
          matchValue: fields.get('value'),
        }),
      );
      toast.success(t('Goal created.'));
      form.reset();
      setRefresh((n) => n + 1);
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function remove(goal: Goal) {
    setBusy(true);
    setFailure('');
    try {
      await apiClient(`${path}/${goal.id}`, { method: 'DELETE' });
      toast.success(t('Goal deleted.'));
      setRefresh((n) => n + 1);
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <FeatureToolbar days={days} setDays={setDays} onRefresh={() => setRefresh((n) => n + 1)} />
      <ReportStatus error={error} loading={!data}>
        {data?.goals.length ? (
          <div className="divide-y divide-border rounded-lg border border-border">
            {data.goals.map((goal) => (
              <article
                key={goal.id}
                className="flex flex-wrap items-center justify-between gap-4 px-5 py-5"
              >
                <div>
                  <h2 className="text-sm font-medium">{goal.name}</h2>
                  <code className="mt-1 block break-all text-xs text-secondary-ink">
                    {goal.matchType === 'event'
                      ? `simpleAnalytics.track('${goal.matchValue}')`
                      : goal.matchValue}
                  </code>
                </div>
                <div className="flex items-center gap-5">
                  <div className="text-right">
                    <p className="text-lg font-medium tabular-nums">
                      {goal.conversions.toLocaleString(locale)}
                    </p>
                    <p className="text-xs text-secondary-ink">{t('Conversions')}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-medium tabular-nums">
                      {data.visitors
                        ? `${Math.min(100, (goal.visitors / data.visitors) * 100).toLocaleString(locale, { maximumFractionDigits: 1 })}%`
                        : '—'}
                    </p>
                    <p className="text-xs text-secondary-ink">{t('Conversion rate')}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void remove(goal)}
                    aria-label={t('Delete goal {name}', { name: goal.name })}
                  >
                    {t('Delete')}
                  </Button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyFeature>
            {t('Create your first goal to track a signup, purchase, or activation.')}
          </EmptyFeature>
        )}
        <p className="mt-3 text-xs text-secondary-ink">
          {t('Conversions start when a goal is created. Rates use daily unique visitors.')}
        </p>
      </ReportStatus>
      <form onSubmit={create} className="mt-8 max-w-xl space-y-4">
        <h2 className="text-base font-medium">{t('Create goal')}</h2>
        <label className="flex flex-col gap-2 text-sm">
          {t('Goal name')}
          <Input name="name" required maxLength={80} placeholder={t('Signup')} />
        </label>
        <label className="flex flex-col gap-2 text-sm">
          {t('Match')}
          <Select
            value={type}
            onValueChange={(value) => setType(value)}
            className="rounded-md border border-border bg-background px-3 py-2"
          >
            <option value="event">{t('Custom event')}</option>
            <option value="page">{t('Page path')}</option>
          </Select>
        </label>
        <label className="flex flex-col gap-2 text-sm">
          {t(type === 'event' ? 'Event name' : 'Page path')}
          <Input
            key={type}
            name="value"
            required
            maxLength={type === 'event' ? 64 : 2048}
            placeholder={type === 'event' ? 'signup' : '/thank-you'}
          />
        </label>
        <Button type="submit" loading={busy} disabled={(data?.goals.length ?? 0) >= 20}>
          {t('Create goal')}
        </Button>
        {failure && <Alert className="text-sm text-danger">{message(failure)}</Alert>}
      </form>
    </>
  );
}
type ErrorItem = {
  fingerprint: string;
  message: string;
  source: string;
  stack: string;
  path: string;
  occurrences: number;
  visitors: number;
  lastSeen: string;
  resolved: boolean;
};
type VitalItem = { name: 'CLS' | 'INP' | 'LCP'; device: string; samples: number; p75: number };
function Diagnostics({ path, errors }: { path: string; errors: boolean }) {
  const { t, locale, message } = useSitePreferences();
  const [days, setDays] = useState('7'),
    [refresh, setRefresh] = useState(0),
    [failure, setFailure] = useState(''),
    [busy, setBusy] = useState(false);
  const { data, error } = useFeatureReport<{ items: ErrorItem[] | VitalItem[] }>(
    path + rangeQuery(days),
    refresh,
  );
  async function resolve(fingerprint: string) {
    setBusy(true);
    setFailure('');
    try {
      await apiClient(path, write('POST', { fingerprint }));
      toast.success(t('Error resolved.'));
      setRefresh((n) => n + 1);
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <FeatureToolbar days={days} setDays={setDays} onRefresh={() => setRefresh((n) => n + 1)} />
      <ReportStatus error={error} loading={!data}>
        {!data?.items.length ? (
          <EmptyFeature>
            {t(
              errors
                ? 'No JavaScript errors recorded in this period.'
                : 'Waiting for Web Vitals. Measurements arrive from real visitors as they use and leave a page.',
            )}
          </EmptyFeature>
        ) : errors ? (
          <div className="space-y-3">
            {(data.items as ErrorItem[]).map((item) => (
              <details key={item.fingerprint} className="rounded-lg border border-border px-4 py-4">
                <summary className="cursor-pointer text-sm">
                  <span className="font-medium break-all">{item.message}</span>
                  <span className="mt-2 block text-xs text-secondary-ink">
                    {t('{count} occurrences · {visitors} visitors', {
                      count: item.occurrences.toLocaleString(locale),
                      visitors: item.visitors.toLocaleString(locale),
                    })}{' '}
                    · {t(item.resolved ? 'Resolved' : 'Open')}
                  </span>
                </summary>
                <div className="mt-4 space-y-3">
                  <p className="break-all text-xs text-secondary-ink">
                    {item.path} · {new Date(item.lastSeen).toLocaleString(locale)}
                  </p>
                  <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap break-all">
                    {item.stack || item.source || item.message}
                  </pre>
                  {!item.resolved && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void resolve(item.fingerprint)}
                    >
                      {t('Mark resolved')}
                    </Button>
                  )}
                </div>
              </details>
            ))}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            {(['LCP', 'INP', 'CLS'] as const).map((name) => {
              const rows = (data.items as VitalItem[]).filter((row) => row.name === name);
              const good = name === 'LCP' ? 2500 : name === 'INP' ? 200 : 0.1;
              const poor = name === 'LCP' ? 4000 : name === 'INP' ? 500 : 0.25;
              return (
                <section key={name} className="rounded-lg border border-border p-5">
                  <h2 className="font-medium">{name}</h2>
                  <p className="mt-1 text-xs text-secondary-ink">
                    {t(
                      name === 'LCP'
                        ? 'Loading speed'
                        : name === 'INP'
                          ? 'Responsiveness'
                          : 'Visual stability',
                    )}
                  </p>
                  {rows.length ? (
                    rows.map((row) => (
                      <div key={row.device} className="mt-5 border-t border-border pt-4">
                        <p className="text-xs text-secondary-ink">
                          {t(
                            row.device === 'mobile'
                              ? 'Mobile'
                              : row.device === 'tablet'
                                ? 'Tablet'
                                : row.device === 'desktop'
                                  ? 'Desktop'
                                  : 'Unknown device',
                          )}
                        </p>
                        <p className="mt-1 text-2xl font-medium tabular-nums">
                          {row.p75.toLocaleString(locale, {
                            maximumFractionDigits: name === 'CLS' ? 3 : 0,
                          })}
                          <span className="ml-1 text-xs text-secondary-ink">
                            {name === 'CLS' ? '' : 'ms'}
                          </span>
                        </p>
                        <p
                          className={`mt-2 text-xs ${row.p75 <= good ? 'text-emerald-600 dark:text-emerald-400' : row.p75 <= poor ? 'text-amber-600 dark:text-amber-400' : 'text-danger'}`}
                        >
                          {t(
                            row.p75 <= good
                              ? 'Good'
                              : row.p75 <= poor
                                ? 'Needs improvement'
                                : 'Poor',
                          )}
                        </p>
                        <p className="mt-1 text-xs text-secondary-ink">
                          {t('{count} measurements', { count: row.samples.toLocaleString(locale) })}
                        </p>
                      </div>
                    ))
                  ) : (
                    <p className="mt-6 text-sm text-secondary-ink">{t('No measurements yet')}</p>
                  )}
                </section>
              );
            })}
          </div>
        )}
        <p className="mt-4 text-xs text-secondary-ink">
          {t(
            errors
              ? 'Errors are grouped by message and source. A new occurrence reopens a resolved error.'
              : 'Values show the 75th percentile by device. Small samples may vary; INP requires interaction.',
          )}
        </p>
      </ReportStatus>
      {failure && <Alert className="mt-4 text-sm text-danger">{message(failure)}</Alert>}
    </>
  );
}

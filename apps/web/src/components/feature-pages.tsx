import { Alert } from './ui/alert';
import { toast } from './ui/toast';
import { Select } from './ui/select';
import { useState, type FormEvent } from 'react';
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
import { ChevronDown } from './ui/icons';
import type { Copy } from '../lib/i18n/translations';
import { Button } from './ui/button';
import { Input } from './ui/input';

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
        <h1 className="text-[22px] leading-[1.25] font-medium tracking-[-0.025em]">
          {t(feature.label)}
        </h1>
        <p className="mt-2 text-secondary-ink">{t(feature.description)}</p>
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

// Core Web Vitals thresholds, as published by web.dev.
const VITALS = {
  LCP: { caption: 'Loading speed', good: 2500, poor: 4000, unit: 'ms', digits: 0 },
  INP: { caption: 'Responsiveness', good: 200, poor: 500, unit: 'ms', digits: 0 },
  CLS: { caption: 'Visual stability', good: 0.1, poor: 0.25, unit: '', digits: 3 },
} as const;

const deviceLabels: Record<string, Copy> = {
  mobile: 'Mobile',
  tablet: 'Tablet',
  desktop: 'Desktop',
};

/** Places the measured value on the good / needs-improvement / poor scale. */
function VitalMeter({ value, good, poor }: { value: number; good: number; poor: number }) {
  const max = poor * 1.5;
  const at = (point: number) => Math.min(point / max, 1) * 100;

  return (
    <div className="relative mt-3 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
      <span className="absolute inset-y-0 left-0 bg-success/40" style={{ width: `${at(good)}%` }} />
      <span
        className="absolute inset-y-0 bg-amber-500/40"
        style={{ left: `${at(good)}%`, width: `${at(poor) - at(good)}%` }}
      />
      <span className="absolute inset-y-0 right-0 bg-danger/30" style={{ left: `${at(poor)}%` }} />
      <span
        className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
        style={{ left: `${at(value)}%` }}
      />
    </div>
  );
}

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
          <ol className="m-0 list-none p-0">
            {(data.items as ErrorItem[]).map((item) => (
              <li key={item.fingerprint} className="border-b border-line first:border-t">
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-start gap-3 py-3.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                    <span
                      aria-hidden="true"
                      className={`mt-1.5 size-1.5 shrink-0 rounded-full ${item.resolved ? 'bg-muted-foreground' : 'bg-danger'}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block text-sm break-all ${item.resolved ? 'text-secondary-ink' : 'font-medium'}`}
                      >
                        {item.message}
                      </span>
                      <span className="mt-1 block text-xs text-secondary-ink">
                        {t('{count} occurrences · {visitors} visitors', {
                          count: item.occurrences.toLocaleString(locale),
                          visitors: item.visitors.toLocaleString(locale),
                        })}{' '}
                        · {t(item.resolved ? 'Resolved' : 'Open')}
                      </span>
                    </span>
                    <ChevronDown
                      size={14}
                      className="mt-1 shrink-0 text-secondary-ink transition-transform group-open:rotate-180"
                    />
                  </summary>
                  <div className="space-y-3 pb-4 pl-[18px]">
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
              </li>
            ))}
          </ol>
        ) : (
          <div className="grid gap-x-10 gap-y-8 sm:grid-cols-3">
            {(['LCP', 'INP', 'CLS'] as const).map((name) => {
              const spec = VITALS[name];
              const rows = (data.items as VitalItem[]).filter((row) => row.name === name);

              return (
                <section key={name} className="min-w-0">
                  <div className="flex items-baseline justify-between gap-3 border-b border-line pb-2">
                    <h2 className="text-[15px] leading-[1.4] font-medium tracking-[-0.02em]">
                      {name}
                    </h2>
                    <span className="truncate text-xs text-muted-foreground">
                      {t(spec.caption)}
                    </span>
                  </div>
                  {rows.length ? (
                    rows.map((row) => (
                      <div key={row.device} className="border-b border-line py-4 last:border-0">
                        <span className="text-xs text-secondary-ink">
                          {t(deviceLabels[row.device] ?? 'Unknown device')}
                        </span>
                        <p className="mt-1 text-[26px] leading-[1.15] font-medium tracking-[-0.025em] tabular-nums">
                          {row.p75.toLocaleString(locale, { maximumFractionDigits: spec.digits })}
                          {spec.unit && (
                            <span className="ml-1 text-xs text-secondary-ink">{spec.unit}</span>
                          )}
                        </p>
                        <VitalMeter value={row.p75} good={spec.good} poor={spec.poor} />
                        <p className="mt-2 text-xs text-secondary-ink">
                          <span
                            className={
                              row.p75 <= spec.good
                                ? 'text-success'
                                : row.p75 <= spec.poor
                                  ? 'text-amber-600 dark:text-amber-400'
                                  : 'text-danger'
                            }
                          >
                            {t(
                              row.p75 <= spec.good
                                ? 'Good'
                                : row.p75 <= spec.poor
                                  ? 'Needs improvement'
                                  : 'Poor',
                            )}
                          </span>{' '}
                          ·{' '}
                          {t('{count} measurements', {
                            count: row.samples.toLocaleString(locale),
                          })}
                        </p>
                      </div>
                    ))
                  ) : (
                    <p className="py-6 text-sm text-muted-foreground">{t('No measurements yet')}</p>
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

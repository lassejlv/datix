import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { apiClient, ApiError, errorText, write, type Reports } from '../lib/client';
import { siteRoute } from '../lib/dashboard-route';
import { useSitePreferences } from './site-preferences';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { DatePicker } from './ui/date-picker';
import { Select } from './ui/select';
import {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from './ui/dialog';
import { ChevronDown } from './ui/icons';
import { CountryLabel } from './country-label';
import { Alert } from './ui/alert';

/** Quiet disclosure toggle shared by the overview's chart notes and imports detail. */
export const disclosureSummary =
  'flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring [&::-webkit-details-marker]:hidden';

export type Annotation = { id: string; day: string; label: string };

export type OverviewReport = Reports & {
  window?: { from: string; to: string; interval: 'hour' };
  previous: Pick<Reports, 'overview' | 'timeseries'> | null;
  previousRange: { from: string; to: string };
  filtered: boolean;
  partial: boolean;
  retainedFrom: string;
  annotations: Annotation[];
  goals: {
    visitors: number;
    goals: { id: string; name: string; conversions: number; visitors: number }[];
  };
};

export function LiveVisitors({
  siteId,
  environmentId,
  onExpired,
}: {
  siteId: string;
  environmentId: string;
  onExpired: () => void;
}) {
  const { t, number } = useSitePreferences();

  const [live, setLive] = useState<{
    active: number;
    recent: { path: string; country: string; at: string }[];
  } | null>(null);

  const active = live?.active ?? null;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;

    const load = async () => {
      try {
        const result = await apiClient<{
          active: number;
          recent: { path: string; country: string; at: string }[];
        }>(`/sites/${siteId}/environments/${environmentId}/features/live`, {
          signal: controller.signal,
        });

        if (!controller.signal.aborted) setLive(result);
      } catch (error) {
        if (!controller.signal.aborted) {
          setLive(null);
          if (error instanceof ApiError && error.status === 401) onExpired();
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(load, 30_000);
      }
    };

    void load();

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [siteId, environmentId, onExpired]);

  return (
    <Dialog>
      <DialogTrigger
        className="inline-flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs text-secondary-ink hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
        title={t('Visitors active in the last 5 minutes across this environment')}
      >
        <span
          className={`size-1.5 rounded-full ${active === null ? 'bg-muted-foreground' : 'bg-emerald-500'}`}
        />
        {active === null ? t('Live view') : t('{count} live', { count: number(active) })}
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t('Live view')}</DialogTitle>
          <DialogDescription>
            {t('Visitors active in the last 5 minutes across this environment')}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {live ? (
            <>
              <p className="mb-4 text-2xl tabular-nums">
                {t('{count} live', { count: number(live.active) })}
              </p>
              <ol className="space-y-3">
                {live.recent.map((event, index) => (
                  <li
                    key={`${event.at}:${index}`}
                    className="flex items-center justify-between gap-4 text-sm"
                  >
                    <span className="min-w-0 truncate">{event.path}</span>
                    <CountryLabel code={event.country} />
                  </li>
                ))}
              </ol>
              {!live.recent.length && (
                <p className="text-sm text-secondary-ink">{t('No visitors yet')}</p>
              )}
            </>
          ) : (
            <p className="text-sm text-secondary-ink">
              {t('Live data is temporarily unavailable.')}
            </p>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

export function OverviewGoal({
  report,
  siteId,
  environmentId,
}: {
  report: OverviewReport;
  siteId: string;
  environmentId: string;
}) {
  const { t, number } = useSitePreferences();
  const storageKey = `datix-primary-goal:${environmentId}`;

  const [selected, setSelected] = useState(() => {
    try {
      return localStorage.getItem(storageKey) ?? '';
    } catch {
      return '';
    }
  });

  const goal = report.goals.goals.find((g) => g.id === selected) ?? report.goals.goals[0];

  return (
    <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
      {goal ? (
        <>
          <Select
            aria-label={t('Primary goal')}
            value={goal.id}
            onValueChange={(id) => {
              setSelected(id);

              try {
                localStorage.setItem(storageKey, id);
              } catch {
                /* Selection remains available for this visit. */
              }
            }}
          >
            {report.goals.goals.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
          <span>{t('{count} conversions', { count: number(goal.conversions) })}</span>
          <span className="text-secondary-ink">
            {report.goals.visitors
              ? t('{rate}% conversion rate', {
                  rate: number(Math.round((goal.visitors / report.goals.visitors) * 1000) / 10),
                })
              : t('No visitors yet')}
          </span>
          <span className="text-xs text-muted-foreground">
            {t(report.window ? 'Last 24 hours' : 'Tracked data · last 30 days within selection')}
          </span>
        </>
      ) : (
        <Link
          to={siteRoute}
          params={{ siteId, environmentId, page: 'goals' }}
          search={{}}
          className="text-secondary-ink underline underline-offset-4"
        >
          {t('Choose a conversion goal')}
        </Link>
      )}
    </div>
  );
}

export function OverviewAnnotations({
  annotations,
  siteId,
  environmentId,
  from,
  to,
  onChange,
  onExpired,
}: {
  annotations: Annotation[];
  siteId: string;
  environmentId: string;
  from: string;
  to: string;
  onChange: () => void;
  onExpired: () => void;
}) {
  const { t, dateLabel, message } = useSitePreferences();
  const [day, setDay] = useState(to);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(body: object) {
    setBusy(true);
    setError('');

    try {
      await apiClient(
        `/sites/${siteId}/environments/${environmentId}/features/annotations`,
        write('POST', body),
      );
      setLabel('');
      onChange();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onExpired();
      else setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="group">
      <summary className={disclosureSummary}>
        <ChevronDown
          size={13}
          className="transition-transform duration-(--duration-fast) ease-smooth-out group-open:rotate-180"
        />
        {t('Chart notes')} · {annotations.length}
      </summary>
      <div className="mt-3 max-w-xl space-y-3">
        {annotations.map((note) => (
          <div key={note.id} className="flex items-center gap-3">
            <span className="shrink-0 tabular-nums">{dateLabel(note.day)}</span>
            <span className="min-w-0 flex-1 wrap-anywhere">{note.label}</span>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-label={t('Delete note: {label}', { label: note.label })}
              onClick={() => void save({ action: 'delete', id: note.id })}
            >
              {t('Delete')}
            </Button>
          </div>
        ))}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) void save({ action: 'create', day, label });
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <DatePicker
            label={t('Note date')}
            value={day}
            onValueChange={setDay}
            min={from}
            max={to}
          />
          <Input
            className="min-w-40 flex-1"
            aria-label={t('Note label')}
            placeholder={t('Deployment or campaign…')}
            value={label}
            maxLength={120}
            required
            onChange={(event) => setLabel(event.target.value)}
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            loading={busy}
            disabled={!label.trim() || day < from || day > to}
          >
            {t('Add note')}
          </Button>
        </form>
        {error && <Alert>{message(error)}</Alert>}
      </div>
    </details>
  );
}

import { CountryLabel } from './country-label';
import { useEffect, useRef, useState } from 'react';
import {
  User,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Check,
  Clock3,
  Download,
  ExternalLink,
  FileText,
  Monitor,
  MousePointer2,
  RefreshCw,
  Sparkles,
} from './ui/icons';
import { apiClient, errorText, number, type SiteEnvironment } from '../lib/client';
import {
  activeDuration,
  activityTitle,
  visitDate,
  visitorAlias,
  type Activity,
  type Visit,
  type VisitReport,
} from '../lib/visitor-journey';
import { Button } from './ui/button';

function VisitorAvatar({ large = false }: { large?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-xl bg-muted text-foreground ${large ? 'size-8' : 'size-6'}`}
    >
      <User size={large ? 18 : 15} />
    </span>
  );
}
export function VisitorJourneys({
  siteId,
  environment,
  onInstall,
}: {
  siteId: string;
  environment: SiteEnvironment;
  onInstall: () => void;
}) {
  const [days, setDays] = useState('7'),
    [reload, setReload] = useState(0),
    [visitor, setVisitor] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.parse(today) - (Number(days) - 1) * 86400000)
    .toISOString()
    .slice(0, 10);
  return (
    <div>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-5">
        <div>
          <h1 className="text-[22px] font-medium tracking-tight">Visitors</h1>
        </div>
        <div className="flex items-center gap-2">
          <select
            aria-label="Visitor date range"
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="h-10 sm:h-8 rounded-md border border-input bg-background px-2.5 text-sm focus-visible:outline-2 focus-visible:outline-ring"
          >
            <option value="1">Today</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
          </select>
          <Button
            aria-label="Refresh visits"
            variant="outline"
            size="icon"
            className="size-10 rounded-md sm:size-8"
            onClick={() => setReload((value) => value + 1)}
          >
            <RefreshCw size={16} />
          </Button>
        </div>
      </header>
      {visitor && (
        <div className="mb-5 flex items-center gap-2 rounded-lg bg-muted p-3 text-sm">
          <VisitorAvatar />
          <span className="flex-1">
            Visits by <strong className="font-medium">{visitorAlias(visitor).name}</strong>
            <span className="ml-2 text-xs text-secondary-ink">{visitor.slice(0, 8)}</span>
          </span>
          <Button variant="ghost" size="sm" onClick={() => setVisitor(null)}>
            All visitors
          </Button>
        </div>
      )}
      <VisitExplorer
        key={`${environment.id}:${from}:${reload}:${visitor}`}
        siteId={siteId}
        environment={environment}
        from={from}
        to={today}
        onInstall={onInstall}
        visitor={visitor}
        onVisitorChange={setVisitor}
      />
      <p className="mt-6 text-xs leading-relaxed text-secondary-ink">
        Anonymous visitors. Activity kept for 30 days. Times in UTC.
      </p>
    </div>
  );
}
function VisitExplorer({
  siteId,
  environment,
  from,
  to,
  onInstall,
  visitor,
  onVisitorChange,
}: {
  siteId: string;
  environment: SiteEnvironment;
  from: string;
  to: string;
  onInstall: () => void;
  visitor: string | null;
  onVisitorChange: (key: string) => void;
}) {
  const [report, setReport] = useState<VisitReport | null>(null),
    [selected, setSelected] = useState<Visit | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [retry, setRetry] = useState(0);
  const requests = useRef<AbortController | null>(null);
  const query = `environment=${environment.id}&from=${from}&to=${to}${visitor ? `&visitor=${visitor}` : ''}`;
  const previousVisit = useRef<string | null>(null);
  useEffect(() => {
    if (selected) previousVisit.current = selected.id;
    else if (previousVisit.current)
      document.getElementById(`visit-${previousVisit.current}`)?.focus({ preventScroll: true });
  }, [selected]);
  useEffect(() => {
    const controller = new AbortController();
    requests.current = controller;
    setError('');
    apiClient<VisitReport>(`/sites/${siteId}/sessions?${query}`, {
      signal: controller.signal,
    })
      .then(setReport)
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [siteId, query, retry]);
  async function more() {
    if (!report || busy) return;
    setBusy(true);
    setError('');
    const signal = requests.current?.signal;
    try {
      const next = await apiClient<VisitReport>(
        `/sites/${siteId}/sessions?${query}&${report.nextCursor ? `cursor=${encodeURIComponent(report.nextCursor)}` : `offset=${report.nextOffset}`}`,
        { signal },
      );
      if (!signal?.aborted)
        setReport((current) => ({
          ...next,
          sessions: [...(current?.sessions ?? []), ...next.sessions],
        }));
    } catch (e) {
      if (!signal?.aborted) setError(errorText(e));
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  }
  const recover = (
    <div
      role="alert"
      className="mb-5 flex items-center justify-between gap-3 rounded-md bg-danger-wash p-4 text-sm text-danger"
    >
      <span>{error}</span>
      <Button
        variant="outline"
        onClick={() => {
          if (report) void more();
          else setRetry((value) => value + 1);
        }}
      >
        Try again
      </Button>
    </div>
  );
  if (!report)
    return error ? (
      recover
    ) : (
      <div role="status" aria-label="Loading visits" className="space-y-3 py-5">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-14 rounded-md bg-muted" />
        ))}
      </div>
    );
  return (
    <>
      {!selected && (
        <dl className="mb-5 flex flex-wrap gap-x-8 gap-y-3">
          {[
            [
              environment.trackingMode === 'cookieless' ? 'Daily visits' : 'Visits',
              number(report.summary.sessions),
            ],
            ['Visitors', number(report.summary.visitors)],
            ['Clicks', number(report.summary.clicks)],
            ['Avg. active', activeDuration(report.summary.averageActiveSeconds)],
          ].map(([label, value]) => (
            <div key={label} className="flex items-baseline gap-2">
              <dt className="text-sm text-secondary-ink">{label}</dt>
              <dd className="text-sm font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {environment.trackingMode === 'cookieless' && (
        <p className="mb-4 text-sm text-secondary-ink">
          Anonymous page journeys grouped by UTC day. Identities reset daily and may group people
          sharing a network and browser. No cookies or local storage; history is kept for 30 days.
        </p>
      )}
      {error && recover}
      {!report.sessions.length ? (
        <div className="py-10">
          <span className="mb-4 inline-flex text-secondary-ink">
            <User size={28} />
          </span>
          <h2 className="text-xl font-medium">No visits yet</h2>
          <p className="mt-3 max-w-lg text-sm leading-relaxed text-secondary-ink">
            {environment.trackingMode !== 'cookieless'
              ? 'No visits in this period yet. Try a wider date range, or check your script and analytics consent.'
              : 'No visits in this period yet. Try a wider date range, or check your tracking script.'}
          </p>
          <Button className="mt-5" variant="outline" onClick={onInstall}>
            View tracking setup
            <ArrowRight size={15} />
          </Button>
        </div>
      ) : (
        <div>
          <section aria-label="Visitor history" className={selected ? 'hidden' : ''}>
            <div className="mb-2 hidden grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_44px_48px_120px_16px] gap-3 px-2 text-xs text-secondary-ink xl:grid">
              <span>Visitor</span>
              <span>First page</span>
              <span>Pages</span>
              <span>Active</span>
              <span>Visited · UTC</span>
              <span />
            </div>
            <div>
              {report.sessions.map((visit) => (
                <button
                  id={`visit-${visit.id}`}
                  key={visit.id}
                  aria-label={`Open session ${visit.id.slice(0, 8)}`}
                  onClick={() => setSelected(visit)}
                  className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-md px-2 py-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_44px_48px_120px_16px]"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <VisitorAvatar />
                    <span
                      className="truncate text-sm font-medium"
                      title={`Anonymous visitor ${visit.visitorKey.slice(0, 8)}`}
                    >
                      {visitorAlias(visit.visitorKey).name}
                    </span>
                  </span>
                  <span
                    className="hidden truncate text-sm text-secondary-ink xl:block"
                    title={visit.entryPath}
                  >
                    {visit.entryPath}
                  </span>
                  <span className="hidden text-sm text-secondary-ink tabular-nums xl:block">
                    {visit.pageviews}
                  </span>
                  <span className="hidden text-sm text-secondary-ink tabular-nums xl:block">
                    {activeDuration(visit.activeSeconds)}
                  </span>
                  <time className="text-xs text-secondary-ink">{visitDate(visit.startedAt)}</time>
                  <ArrowRight size={14} className="hidden text-secondary-ink xl:block" />
                  <span className="col-span-2 flex min-w-0 items-center justify-between gap-3 pl-8 text-xs text-secondary-ink xl:hidden">
                    <span className="truncate">{visit.entryPath}</span>
                    <span className="shrink-0">
                      {visit.pageviews} {visit.pageviews === 1 ? 'page' : 'pages'} ·{' '}
                      {activeDuration(visit.activeSeconds)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            {report.hasMore && (
              <Button className="mt-4" variant="outline" loading={busy} onClick={more}>
                Load more visits
              </Button>
            )}
          </section>
          {selected && (
            <JourneyTimeline
              key={selected.id}
              visit={selected}
              siteId={siteId}
              query={query}
              onClose={() => setSelected(null)}
              onVisitorHistory={visitor ? undefined : () => onVisitorChange(selected.visitorKey)}
            />
          )}
        </div>
      )}
    </>
  );
}
const eventIcons = {
  pageview: FileText,
  click: MousePointer2,
  outbound: ExternalLink,
  download: Download,
  form_submit: Check,
  scroll: ArrowDown,
  custom: Sparkles,
  engagement: Clock3,
};
function JourneyTimeline({
  visit,
  siteId,
  query,
  onClose,
  onVisitorHistory,
}: {
  visit: Visit;
  siteId: string;
  query: string;
  onClose: () => void;
  onVisitorHistory?: () => void;
}) {
  const [events, setEvents] = useState<Activity[]>([]),
    [hasMore, setHasMore] = useState(false),
    [offset, setOffset] = useState(0),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'nearest' });
  }, []);
  useEffect(() => {
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError('');
    apiClient<{
      events: Activity[];
      hasMore: boolean;
      nextOffset: number;
      nextCursor?: string | null;
    }>(`/sites/${siteId}/sessions?${query}&session=${visit.id}`, { signal: request.signal })
      .then((result) => {
        setEvents(result.events);
        setHasMore(result.hasMore);
        setOffset(result.nextOffset);
        setCursor(result.nextCursor ?? null);
      })
      .catch((e) => {
        if (!request.signal.aborted) setError(errorText(e));
      })
      .finally(() => {
        if (!request.signal.aborted) setBusy(false);
      });
    return () => request.abort();
  }, [siteId, query, visit.id, retry]);
  async function more() {
    setBusy(true);
    setError('');
    const signal = controller.current?.signal;
    try {
      const result = await apiClient<{
        events: Activity[];
        hasMore: boolean;
        nextOffset: number;
        nextCursor?: string | null;
      }>(
        `/sites/${siteId}/sessions?${query}&session=${visit.id}&${cursor ? `cursor=${encodeURIComponent(cursor)}` : `offset=${offset}`}`,
        { signal },
      );
      if (!signal?.aborted) {
        setEvents((current) => [...current, ...result.events]);
        setHasMore(result.hasMore);
        setOffset(result.nextOffset);
        setCursor(result.nextCursor ?? null);
      }
    } catch (e) {
      if (!signal?.aborted) setError(errorText(e));
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  }
  const first = events[0];
  return (
    <section aria-label="Session timeline" className="min-w-0 max-w-[800px]">
      <Button className="mb-5" variant="ghost" size="sm" onClick={onClose}>
        <ArrowLeft size={14} />
        All visits
      </Button>
      <div className="flex items-start gap-3">
        <VisitorAvatar large />
        <div className="min-w-0 flex-1">
          <h2 ref={heading} tabIndex={-1} className="text-xl font-medium outline-none">
            {visitorAlias(visit.visitorKey).name}
          </h2>
          <p className="mt-1 text-xs text-secondary-ink">
            Visitor {visit.visitorKey.slice(0, 8)} · {visitDate(visit.startedAt)}
          </p>
        </div>
      </div>
      {onVisitorHistory && (
        <Button className="mt-4" variant="ghost" size="sm" onClick={onVisitorHistory}>
          View visitor history
          <ArrowRight size={14} />
        </Button>
      )}
      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-secondary-ink">
        <span className="inline-flex items-center gap-1.5">
          <CountryLabel code={visit.country} />
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Monitor size={14} />
          {visit.device || 'Unknown device'}
        </span>
        {visit.activeSeconds > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <Clock3 size={14} />
            {activeDuration(visit.activeSeconds)} active
          </span>
        )}
      </div>
      {first && (
        <p className="mt-4 text-sm text-secondary-ink">
          Arrived{' '}
          {first.referrer ? (
            <>
              from <span className="font-medium text-foreground break-all">{first.referrer}</span>
            </>
          ) : (
            'directly or from an unknown source'
          )}
          .
        </p>
      )}
      <ol aria-label="Activity events" className="mt-6 border-t border-border pt-3">
        {events.map((event) => {
          const Icon = eventIcons[event.kind as keyof typeof eventIcons] ?? Sparkles;
          return (
            <li key={event.id} className="relative flex gap-3 py-2.5">
              <span className="relative mt-0.5 grid size-5 shrink-0 place-items-center text-secondary-ink">
                <Icon size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-1">
                  <h3 className="min-w-0 break-all text-sm">
                    {event.kind === 'pageview' ? event.path : activityTitle(event)}
                  </h3>
                  <time className="text-[11px] text-secondary-ink tabular-nums">
                    {new Date(event.occurredAt).toISOString().slice(11, 19)}
                  </time>
                </div>
                {event.kind !== 'pageview' && (
                  <p className="mt-0.5 break-all text-xs text-secondary-ink">{event.path}</p>
                )}
                {event.details.target && (
                  <p className="mt-1 break-all text-xs text-secondary-ink">
                    Element: {event.details.target}
                  </p>
                )}
                {event.details.destination && (
                  <p className="mt-1 break-all text-xs text-secondary-ink">
                    Destination: {event.details.destination}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {busy && (
        <p role="status" className="mt-5 text-sm text-secondary-ink">
          Loading activity…
        </p>
      )}
      {error && (
        <div role="alert" className="mt-5 text-sm text-danger">
          {error}
          <Button
            className="ml-3"
            variant="outline"
            size="sm"
            onClick={() => (events.length ? void more() : setRetry((value) => value + 1))}
          >
            Try again
          </Button>
        </div>
      )}
      {hasMore && (
        <Button className="mt-6" variant="outline" loading={busy} onClick={more}>
          Load more activity
        </Button>
      )}
      {first && (
        <details className="mt-6 border-t border-border pt-4 text-xs text-secondary-ink">
          <summary className="cursor-pointer py-1 focus-visible:outline-2 focus-visible:outline-ring">
            Visit details
          </summary>
          <dl className="mt-3 grid grid-cols-2 gap-3">
            {[
              ['Browser', first.browser || 'Unknown'],
              ['System', first.os || 'Unknown'],
              ['Language', first.details.language || 'Unknown'],
              [
                'Screen',
                first.details.screenWidth === undefined
                  ? 'Unknown'
                  : `${first.details.screenWidth} × ${first.details.screenHeight}`,
              ],
              [
                'Viewport',
                first.details.viewportWidth === undefined
                  ? 'Unknown'
                  : `${first.details.viewportWidth} × ${first.details.viewportHeight}`,
              ],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd className="mt-1 text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </section>
  );
}

import { useState } from 'react';
import { journeyStops } from '../lib/journey-flow';
import { activityTitle, type Activity } from '../lib/visitor-journey';
import { useSitePreferences } from './site-preferences';
import {
  ArrowDown,
  Check,
  Clock3,
  Download,
  ExternalLink,
  Globe2,
  MousePointer2,
  Sparkles,
} from './ui/icons';
import './journey-flow.css';

const icons = {
  pageview: Globe2,
  click: MousePointer2,
  outbound: ExternalLink,
  download: Download,
  form_submit: Check,
  scroll: ArrowDown,
  custom: Sparkles,
  engagement: Clock3,
};

export function JourneyFlow({ events, hasMore }: { events: Activity[]; hasMore: boolean }) {
  const { locale, number, t } = useSitePreferences();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const stops = journeyStops(events);
  const pages = events.filter((event) => event.kind === 'pageview').length;
  const selected = events.find((event) => event.id === selectedId);
  function node(event: Activity, first = false) {
    const Icon = icons[event.kind as keyof typeof icons] ?? Sparkles;
    const passive = event.kind === 'scroll' || event.kind === 'engagement';
    const tone =
      event.kind === 'pageview' ? (first ? 'entry' : 'page') : passive ? 'passive' : 'action';
    const label = event.kind === 'pageview' ? event.path : activityTitle(event, locale);
    return (
      <button
        type="button"
        className="journey-node"
        data-tone={tone}
        aria-expanded={selectedId === event.id}
        aria-controls={selectedId === event.id ? `journey-event-${event.id}` : undefined}
        title={`${label} · ${new Date(event.occurredAt).toISOString().slice(11, 19)} UTC`}
        onClick={() => setSelectedId(selectedId === event.id ? null : event.id)}
      >
        <Icon size={14} />
        <span>{label}</span>
      </button>
    );
  }
  function detail(event: Activity) {
    if (selected?.id !== event.id) return null;
    return (
      <div id={`journey-event-${event.id}`} className="journey-detail">
        <p className="font-medium text-foreground">{activityTitle(event, locale)}</p>
        <p className="mt-1 break-all">{event.path}</p>
        <time className="mt-1 block tabular-nums">
          {new Date(event.occurredAt).toISOString().slice(11, 19)} UTC
        </time>
        {event.details.target && (
          <p className="mt-2 break-all">
            {t('Element:')} {event.details.target}
          </p>
        )}
        {event.details.destination && (
          <p className="mt-2 break-all">
            {t('Destination:')} {event.details.destination}
          </p>
        )}
        {event.details.activeSeconds !== undefined && (
          <p className="mt-2">
            {t('{seconds} seconds active', { seconds: number(event.details.activeSeconds) })}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="journey-flow">
      <dl className="journey-summary">
        {[
          [t('Steps'), events.length],
          [t('Pages'), pages],
          [t('Actions'), events.length - pages],
        ].map(([label, value]) => (
          <div key={label}>
            <dd>{number(Number(value))}</dd>
            <dt>{label}</dt>
          </div>
        ))}
      </dl>
      <p className="mb-6 text-xs text-secondary-ink">
        {t('Follow the visit from top to bottom. Select a step for details.')}
        {hasMore && <> {t('Showing loaded activity. Load more to continue the journey.')}</>}
      </p>
      <ol aria-label={t('Journey steps')} className="journey-stops">
        {stops.map((stop, index) => (
          <li key={stop.id} className="journey-stop">
            <div className="journey-page-row">
              <span className="journey-order" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </span>
              <div className="min-w-0">
                {stop.page ? (
                  node(stop.page, index === 0)
                ) : (
                  <span className="journey-node journey-context" title={t('Page context')}>
                    <Globe2 size={14} />
                    <span>{stop.path}</span>
                  </span>
                )}
                {stop.page && detail(stop.page)}
              </div>
            </div>
            {stop.actions.length > 0 && (
              <ol
                className="journey-actions"
                aria-label={t('Actions on {path}', { path: stop.path })}
              >
                {stop.actions.map((event) => (
                  <li key={event.id} className="journey-action-row">
                    <div className="min-w-0">
                      {node(event)}
                      {detail(event)}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

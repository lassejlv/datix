import { useCallback, useEffect, useState } from 'react';
import { BillingActions } from './billing-actions';
import { Link } from '@tanstack/react-router';
import { apiClient, errorText, number, write } from '../lib/client';
import type { AccountUsage, UsagePauseReason } from '../billing/types';
import { Button } from './ui/button';
import { RefreshCw } from './ui/icons';
import { Spinner } from './ui/spinner';

export function useAccountUsage(refreshKey: string) {
  const [data, setData] = useState<AccountUsage | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const update = async () => {
      if (pending || controller.signal.aborted) return;
      pending = true;
      setLoading(true);
      try {
        const result = await apiClient<AccountUsage>('/usage', { signal: controller.signal });
        if (!controller.signal.aborted) {
          setData(result);
          setError('');
        }
      } catch (error) {
        if (!controller.signal.aborted) setError(errorText(error));
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void update();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void update();
    }, 15000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [refreshKey, revision]);
  return { data, error, loading, refresh };
}

const date = (value: string) =>
  new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value));
const reasonLabel = (reason: UsagePauseReason | null) =>
  reason === 'subscription_required'
    ? 'Pro required'
    : reason === 'event_limit'
      ? 'Event limit reached'
      : reason === 'website_budget'
        ? 'Website budget reached'
        : reason === 'website_limit'
          ? 'Website limit reached'
          : reason === 'disabled'
            ? 'Disabled'
            : 'Collecting';

export function Usage({ data, error, loading, refresh }: ReturnType<typeof useAccountUsage>) {
  return (
    <section aria-labelledby="usage-title" className="max-w-[760px]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 id="usage-title" className="text-2xl font-medium tracking-tight">
            Usage
          </h1>
          <p className="mt-2 text-sm text-secondary-ink">
            Across all your websites and environments.
          </p>
        </div>
        <Button
          variant="outline"
          size="icon"
          aria-label="Refresh usage"
          onClick={refresh}
          disabled={loading}
        >
          {loading ? <Spinner /> : <RefreshCw />}
        </Button>
      </div>
      {error && (
        <div role="alert" className="mt-5 text-sm text-danger">
          {error}{' '}
          <button className="underline" onClick={refresh}>
            Try again
          </button>
        </div>
      )}
      {!data ? (
        <p className="py-12 text-sm text-secondary-ink">
          {loading ? 'Loading usage…' : 'Usage is unavailable.'}
        </p>
      ) : (
        <>
          <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-medium">
                {data.plan ? `Pro${data.plan.trial ? ' · Trial' : ''}` : 'No active plan'}
              </h2>
              <p className="mt-1 text-sm text-secondary-ink">
                {data.period
                  ? `${date(data.period.start)} – ${date(data.period.end)} · UTC`
                  : 'Activate Pro to start collecting.'}
              </p>
            </div>
            <Link to="/pricing" className="text-sm underline underline-offset-4">
              View plans
            </Link>
          </div>
          <BillingActions active={Boolean(data.plan)} refresh={refresh} />
          {data.paused && (
            <div
              role="status"
              className="mt-5 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm"
            >
              <p className="font-medium">Tracking paused</p>
              <p className="mt-1 text-secondary-ink">
                {data.pauseReason === 'event_limit'
                  ? `Your event allowance is used up. Tracking resumes when your allowance renews on ${date(data.period!.end)} or you upgrade your plan.`
                  : 'An active Pro subscription or Pro trial is required to collect events. Your existing reports remain available.'}
              </p>
            </div>
          )}
          <div className="mt-8">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-medium">Event credits</h2>
              <p className="tabular-nums">
                <span className="text-2xl font-medium">{number(data.events.used)}</span>
                <span className="text-sm text-secondary-ink">
                  {data.plan ? ` / ${number(data.plan.eventLimit)}` : ' · No active allowance'}
                </span>
              </p>
            </div>
            {data.plan && (
              <div
                role="progressbar"
                aria-label="Event allowance used"
                aria-valuemin={0}
                aria-valuemax={data.plan.eventLimit}
                aria-valuenow={Math.min(data.events.used, data.plan.eventLimit)}
                aria-valuetext={`${number(data.events.used)} of ${number(data.plan.eventLimit)} credits`}
                className="mt-3 h-2 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full rounded-full bg-foreground"
                  style={{
                    width: `${Math.min(100, (data.events.used / data.plan.eventLimit) * 100)}%`,
                  }}
                />
              </div>
            )}
            <p className="mt-3 text-sm text-secondary-ink">
              Production pageviews use 1 credit; clicks and other events use 0.5. On localhost,
              these rates are 0.3 and 0.15 credits. Engagement time and duplicate deliveries are
              free.
            </p>
          </div>
          {data.protection && (
            <div className="mt-8 border-t border-border pt-6" aria-labelledby="protection-title">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 id="protection-title" className="font-medium">
                  Spam protection
                </h2>
                <span className="text-xs text-secondary-ink">Always on</span>
              </div>
              <p className="mt-4 text-sm">
                <strong className="text-2xl font-medium tabular-nums">
                  {number(data.protection.blocked)}
                </strong>{' '}
                blocked requests <span className="text-secondary-ink">· 0 credits charged</span>
              </p>
              <p className="mt-2 text-sm text-secondary-ink">
                Last 30 days. Repetitive activity and excessive source traffic are filtered before
                collection.
              </p>
              {data.protection.reasons.length > 0 && (
                <ul className="mt-3 space-y-1 text-sm text-secondary-ink">
                  {data.protection.reasons.map(({ reason, blocked }) => (
                    <li key={reason} className="flex justify-between gap-4">
                      <span>
                        {reason === 'source_limit'
                          ? 'Source limits'
                          : reason === 'repeated_activity'
                            ? 'Repetitive activity'
                            : 'Unusual activity'}
                      </span>
                      <span className="tabular-nums">{number(blocked)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-xs leading-relaxed text-secondary-ink">
                {data.protection.learned > 0
                  ? `${data.protection.learned} environment${data.protection.learned === 1 ? '' : 's'} also use${data.protection.learned === 1 ? 's' : ''} recent traffic history to detect unusual patterns. `
                  : ''}
                {data.protection.learning > 0
                  ? 'New environments learn after three complete days with enough traffic. Basic protection is active immediately. '
                  : ''}
                Traffic spikes alone do not trigger a block. Counts exclude requests rejected by the
                network rate limit or basic bot filter.
              </p>
            </div>
          )}
          <div className="mt-9 border-t border-border pt-6">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="font-medium">Websites</h2>
              <p className="text-sm tabular-nums text-secondary-ink">
                {data.websites.length}
                {data.plan ? ` / ${data.plan.websiteLimit}` : ''}
              </p>
            </div>
            {!data.websites.length ? (
              <p className="mt-5 text-sm text-secondary-ink">No websites added yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-border">
                {data.websites.map((site) => (
                  <li
                    key={site.id}
                    className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 py-4"
                  >
                    <div className="min-w-0 flex-1 basis-40">
                      <p className="truncate text-sm font-medium">{site.name}</p>
                      <p className="mt-1 truncate text-xs text-secondary-ink">{site.domain}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm tabular-nums">{number(site.events)} credits</p>
                      <p className="mt-1 text-xs text-secondary-ink">
                        {site.paused ? `Paused · ${reasonLabel(site.pauseReason)}` : 'Collecting'}
                      </p>
                    </div>
                    <WebsiteBudget site={site} refresh={refresh} />
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-4 text-xs leading-relaxed text-secondary-ink">
              Events from removed websites still count toward the current allowance. Paused events
              are not stored or replayed later.
            </p>
          </div>
        </>
      )}
    </section>
  );
}

function WebsiteBudget({
  site,
  refresh,
}: {
  site: AccountUsage['websites'][number];
  refresh: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="basis-full text-sm">
      {!editing ? (
        <button
          className="text-secondary-ink underline underline-offset-4"
          onClick={() => {
            setError('');
            setEditing(true);
          }}
        >
          {site.creditBudget === null
            ? 'Set a website budget'
            : `Budget: ${number(site.creditBudget)} credits · Edit`}
        </button>
      ) : (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={async (event) => {
            event.preventDefault();
            const value = String(new FormData(event.currentTarget).get('budget') ?? '').trim();
            setSaving(true);
            setError('');
            try {
              await apiClient(
                `/sites/${site.id}`,
                write('PATCH', { creditBudget: value ? Number(value) : null }),
              );
              setEditing(false);
              refresh();
            } catch (error) {
              setError(errorText(error));
            } finally {
              setSaving(false);
            }
          }}
        >
          <label className="flex flex-col gap-1.5" htmlFor={`budget-${site.id}`}>
            Credits per allowance period
            <input
              id={`budget-${site.id}`}
              name="budget"
              type="number"
              min="0.15"
              max="1000000000"
              step="0.01"
              defaultValue={site.creditBudget ?? ''}
              placeholder="No website budget"
              className="h-9 w-52 rounded-md border border-border bg-background px-3"
              disabled={saving}
            />
          </label>
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save budget'}
          </Button>
          <Button type="button" variant="ghost" disabled={saving} onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <p className="basis-full text-xs text-secondary-ink">
            This website pauses when its budget is used. Other websites keep collecting. Leave blank
            to remove the budget.
          </p>
          {error && (
            <p role="alert" className="basis-full text-danger">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}

import { Alert } from './ui/alert';
import { Input } from './ui/input';
import { toast } from './ui/toast';
import { useSitePreferences } from './site-preferences';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { apiClient, errorText, write } from '../lib/client';
import type { AccountUsage, UsagePauseReason } from '../billing/types';
import { Button } from './ui/button';
import { billingAmount } from '../lib/billing-plans';

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
          if (result.pauseReason === 'agreement_required')
            window.dispatchEvent(new Event('datix:agreement-required'));
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

    const focused = () => {
      if (document.visibilityState === 'visible') void update();
    };

    const accessRevoked = () => {
      setData(null);
      refresh();
    };

    window.addEventListener('focus', focused);
    document.addEventListener('visibilitychange', focused);
    window.addEventListener('datix:subscription-required', accessRevoked);

    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener('focus', focused);
      document.removeEventListener('visibilitychange', focused);
      window.removeEventListener('datix:subscription-required', accessRevoked);
    };
  }, [refreshKey, revision, refresh]);
  const syncedCheckout = useRef<string | null>(null);
  useEffect(() => {
    const checkoutId = new URLSearchParams(location.search).get('checkout_id');
    if (!checkoutId || syncedCheckout.current === checkoutId) return;
    syncedCheckout.current = checkoutId;
    void apiClient('/billing/sync', { method: 'POST', body: '{}' })
      .then(() => refresh())
      .catch(() => {
        /* Usage polling picks up the allowance when the sync lands late. */
      });
  }, [refreshKey, refresh]);

  return { data, error, loading, refresh };
}

const reasonLabel = (reason: UsagePauseReason | null) =>
  reason === 'agreement_required'
    ? 'Agreement required'
    : reason === 'subscription_required'
      ? 'Subscription required'
      : reason === 'event_limit'
        ? 'Event limit reached'
        : reason === 'website_budget'
          ? 'Website budget reached'
          : reason === 'website_limit'
            ? 'Website limit reached'
            : reason === 'disabled'
              ? 'Disabled'
              : 'Collecting';

export function PlanHeading({ data, action }: { data: AccountUsage; action?: ReactNode }) {
  const { dateTime, t } = useSitePreferences();

  const date = (value: string) =>
    dateTime(value, { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="font-medium">
          {data.plan
            ? data.plan.trial
              ? t('{plan} · Trial', { plan: data.plan.name })
              : data.plan.name
            : t('No active plan')}
        </h2>
        <p className="mt-1 text-sm text-secondary-ink">
          {data.period
            ? `${date(data.period.start)} – ${date(data.period.end)} · UTC`
            : t('Activate a plan to start collecting.')}
        </p>
      </div>
      {action}
    </div>
  );
}

export function EventCredits({ data }: { data: AccountUsage }) {
  const { dateTime, locale, number, t } = useSitePreferences();

  const date = (value: string) =>
    dateTime(value, { month: 'short', day: 'numeric', year: 'numeric' });

  // Overage plans have no cap; their bar measures the included credits instead.
  const overagePer1k = data.plan?.overageUnitAmount
    ? Number(data.plan.overageUnitAmount) * 10
    : null;

  const limit =
    data.plan?.eventLimit ?? (overagePer1k === null ? null : (data.plan?.includedEvents ?? null));

  const extra = limit === null || overagePer1k === null ? 0 : Math.max(0, data.events.used - limit);

  return (
    <>
      {data.paused && (
        <div
          role="status"
          className="mt-5 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm"
        >
          <p className="font-medium">{t('Tracking paused')}</p>
          <p className="mt-1 text-secondary-ink">
            {data.pauseReason === 'event_limit'
              ? t('Allowance renews on {date}. Upgrade to resume sooner.', {
                  date: date(data.period!.end),
                })
              : t('Choose a plan to resume tracking.')}
          </p>
        </div>
      )}
      <div className="mt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium">{t('Event credits')}</h3>
          <p className="tabular-nums">
            <span className="text-2xl font-medium">{number(data.events.used)}</span>
            <span className="text-sm text-secondary-ink">
              {data.plan
                ? ` / ${limit === null ? t('Unlimited') : number(limit)}${overagePer1k === null ? '' : ` ${t('included')}`}`
                : t(' · No active allowance')}
            </span>
          </p>
        </div>
        {data.plan && limit !== null && (
          <div
            role="progressbar"
            aria-label={t('Event allowance used')}
            aria-valuemin={0}
            aria-valuemax={limit}
            aria-valuenow={Math.min(data.events.used, limit)}
            aria-valuetext={t('{used} of {limit} credits', {
              used: number(data.events.used),
              limit: number(limit),
            })}
            className="mt-3 h-2 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-foreground"
              style={{
                width: `${Math.min(100, limit > 0 ? (data.events.used / limit) * 100 : 0)}%`,
              }}
            />
          </div>
        )}
        {overagePer1k !== null && (
          <p className="mt-2 text-sm text-secondary-ink">
            {extra > 0
              ? t('{count} extra credits · about {amount} billed at the end of the period', {
                  count: number(extra),
                  amount: billingAmount((extra / 1000) * overagePer1k, locale),
                })
              : t('Then {price} per 1,000 credits', {
                  price: billingAmount(overagePer1k, locale),
                })}
          </p>
        )}
        <details className="mt-3 text-sm text-secondary-ink">
          <summary className="w-fit cursor-pointer underline underline-offset-4">
            {t('How it works')}
          </summary>
          <p className="mt-2 leading-relaxed">
            {t(
              'Production pageviews use 1 credit; clicks and other events use 0.5. On localhost, these rates are 0.3 and 0.15 credits. Engagement time and duplicate deliveries are free.',
            )}
          </p>
        </details>
      </div>
    </>
  );
}

export function WebsitesUsage({ data, refresh }: { data: AccountUsage; refresh: () => void }) {
  const { number, t } = useSitePreferences();

  return (
    <section aria-labelledby="usage-websites-title">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="usage-websites-title" className="text-sm font-medium">
          {t('Websites')}
        </h3>
        <p className="text-sm tabular-nums text-secondary-ink">
          {data.websites.length}
          {data.plan
            ? ` / ${data.plan.websiteLimit === null ? t('Unlimited') : number(data.plan.websiteLimit)}`
            : ''}
        </p>
      </div>
      {!data.websites.length ? (
        <p className="mt-5 text-sm text-secondary-ink">{t('No websites added yet.')}</p>
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
                <p className="text-sm tabular-nums">
                  {t('{count} credits', { count: number(site.events) })}
                </p>
                <p className="mt-1 text-xs text-secondary-ink">
                  {site.paused
                    ? t('Paused · {reason}', { reason: t(reasonLabel(site.pauseReason)) })
                    : t('Collecting')}
                </p>
              </div>
              <WebsiteBudget site={site} refresh={refresh} />
            </li>
          ))}
        </ul>
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
  const { number, message: messageText, t } = useSitePreferences();
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
            ? t('Set a website budget')
            : t('Budget: {count} credits · Edit', { count: number(site.creditBudget) })}
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
              toast.success(t('Website budget saved.'));
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
            {t('Credits per allowance period')}
            <Input
              id={`budget-${site.id}`}
              name="budget"
              type="number"
              min="0.15"
              max="1000000000"
              step="0.01"
              defaultValue={site.creditBudget ?? ''}
              placeholder={t('No website budget')}
              className="w-52"
              disabled={saving}
            />
          </label>
          <Button type="submit" disabled={saving}>
            {saving ? t('Saving…') : t('Save budget')}
          </Button>
          <Button type="button" variant="ghost" disabled={saving} onClick={() => setEditing(false)}>
            {t('Cancel')}
          </Button>
          <p className="basis-full text-xs text-secondary-ink">
            {t(
              'This website pauses when its budget is used. Other websites keep collecting. Leave blank to remove the budget.',
            )}
          </p>
          {error && <Alert className="basis-full text-danger">{messageText(error)}</Alert>}
        </form>
      )}
    </div>
  );
}

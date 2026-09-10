import { Alert } from './ui/alert';
import { toast } from './ui/toast';
import { Select } from './ui/select';
import { useSitePreferences } from './site-preferences';
import { useEffect, useState } from 'react';
import { apiClient, errorText } from '../lib/client';
import { Button } from './ui/button';

import { billingPlans, billingPrice, billingAvailable } from '../lib/billing-plans';
export const billingVolumes = billingPlans;

export function BillingActions({ active, refresh }: { active: boolean; refresh: () => void }) {
  const { locale, number, message: messageText, t } = useSitePreferences();
  const [hasCustomer, setHasCustomer] = useState(false);
  const [events, setEvents] = useState<number>(billingPlans[0].events);
  const [interval, setInterval] = useState('month');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [returned, setReturned] = useState(false);
  const selectedPlan = billingVolumes.find((plan) => plan.events === events)!;
  useEffect(() => {
    void apiClient<{ hasCustomer: boolean }>('/billing')
      .then((r) => setHasCustomer(r.hasCustomer))
      .catch(() => {});
    try {
      const pending = Number(sessionStorage.getItem('ab-checkout-events'));
      // Browser storage is unavailable during SSR; apply the saved selection after hydration.
      // oxlint-disable-next-line react/set-state-in-effect
      if (billingVolumes.some((p) => p.events === pending)) setEvents(pending);
      if (
        sessionStorage.getItem('ab-checkout-interval') === 'year' &&
        billingVolumes.some((plan) => plan.events === pending && plan.yearlyAvailable)
      )
        setInterval('year');
      sessionStorage.removeItem('ab-checkout-events');
      sessionStorage.removeItem('ab-checkout-interval');
    } catch {
      /* Checkout selection is optional when storage is blocked. */
    }
    if (new URLSearchParams(location.search).has('checkout_id')) {
      // oxlint-disable-next-line react/set-state-in-effect -- browser URL is an external source
      setReturned(true);
      void apiClient('/billing/sync', { method: 'POST', body: '{}' })
        .then(refresh)
        .catch((e) => setError(errorText(e)));
    }
  }, [refresh]);
  const act = async (path: string) => {
    setBusy(true);
    setError('');
    try {
      const result = await apiClient<{ url?: string }>(path, {
        method: 'POST',
        body: JSON.stringify(path.endsWith('checkout') ? { events, interval, locale } : {}),
      });
      if (result.url) window.location.assign(result.url);
      else {
        toast.success(t('Subscription refreshed.'));
        refresh();
        setBusy(false);
      }
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <div className="mt-5 space-y-3">
      {returned && !active && (
        <p role="status" className="text-sm text-secondary-ink">
          {t(
            'Waiting for Polar to confirm your subscription. Your allowance will appear here once it is active.',
          )}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {!active && (
          <>
            <label className="sr-only" htmlFor="billing-volume">
              {t('Monthly plan')}
            </label>
            <Select
              id="billing-volume"
              className="h-9 max-w-full rounded-md border border-border bg-background px-3 text-sm"
              value={events}
              disabled={busy}
              onValueChange={(value) => setEvents(Number(value))}
            >
              {billingVolumes.map((p) => (
                <option key={p.events} value={p.events}>
                  {p.name} ·{' '}
                  {t(
                    interval === 'year'
                      ? '{events} events · {price}/year'
                      : '{events} events · {price}/month',
                    {
                      events: number(p.events),
                      price: billingPrice(p, locale, interval === 'year'),
                    },
                  )}
                </option>
              ))}
            </Select>
            <Select
              aria-label={t('Billing period')}
              value={interval}
              disabled={busy}
              onValueChange={(value) => setInterval(value)}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
            >
              <option value="month">{t('Monthly')}</option>
              <option value="year" disabled={!selectedPlan.yearlyAvailable}>
                {t('Yearly')}
                {!selectedPlan.yearlyAvailable ? ` · ${t('Coming soon')}` : ''}
              </option>
            </Select>
            <Button
              disabled={busy || !billingAvailable(selectedPlan, interval === 'year')}
              onClick={() => void act('/billing/checkout')}
            >
              {busy ? t('Opening…') : t('Choose plan')}
            </Button>
          </>
        )}
        {(hasCustomer || active) && (
          <Button variant="outline" disabled={busy} onClick={() => void act('/billing/portal')}>
            {t('Manage billing')}
          </Button>
        )}
        <button
          className="text-sm underline underline-offset-4 disabled:opacity-50"
          disabled={busy}
          onClick={() => void act('/billing/sync')}
        >
          {t('Refresh subscription')}
        </button>
      </div>
      {!active && (
        <p className="text-xs text-secondary-ink">
          {events === billingPlans[0].events
            ? t('Basic includes a 14-day trial. Confirm the price and payment details at checkout.')
            : t('Paid subscription from the start. This plan has no free trial.')}
        </p>
      )}
      {error && <Alert className="text-sm text-danger">{messageText(error)}</Alert>}
    </div>
  );
}

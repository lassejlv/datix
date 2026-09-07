import { useEffect, useState } from 'react';
import { apiClient, errorText } from '../lib/client';
import { Button } from './ui/button';

export const billingVolumes = [
  { events: 100_000, price: 9 },
  { events: 250_000, price: 19 },
  { events: 500_000, price: 29 },
  { events: 1_000_000, price: 49 },
  { events: 2_000_000, price: 79 },
  { events: 5_000_000, price: 149 },
] as const;

export function BillingActions({ active, refresh }: { active: boolean; refresh: () => void }) {
  const [hasCustomer, setHasCustomer] = useState(false);
  const [events, setEvents] = useState<number>(100000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [returned, setReturned] = useState(false);
  useEffect(() => {
    void apiClient<{ hasCustomer: boolean }>('/billing')
      .then((r) => setHasCustomer(r.hasCustomer))
      .catch(() => {});
    try {
      const pending = Number(sessionStorage.getItem('ab-checkout-events'));
      // Browser storage is unavailable during SSR; apply the saved selection after hydration.
      // oxlint-disable-next-line react/set-state-in-effect
      if (billingVolumes.some((p) => p.events === pending)) setEvents(pending);
      sessionStorage.removeItem('ab-checkout-events');
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
        body: JSON.stringify(path.endsWith('checkout') ? { events, interval: 'month' } : {}),
      });
      if (result.url) window.location.assign(result.url);
      else {
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
          Waiting for Polar to confirm your subscription. Your allowance will appear here once it is
          active.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {!active && (
          <>
            <label className="sr-only" htmlFor="billing-volume">
              Monthly plan
            </label>
            <select
              id="billing-volume"
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
              value={events}
              disabled={busy}
              onChange={(e) => setEvents(Number(e.target.value))}
            >
              {billingVolumes.map((p) => (
                <option key={p.events} value={p.events}>
                  {p.events.toLocaleString('en')} events · ${p.price}/month
                </option>
              ))}
            </select>
            <Button disabled={busy} onClick={() => void act('/billing/checkout')}>
              {busy ? 'Opening…' : 'Start Pro'}
            </Button>
          </>
        )}
        {(hasCustomer || active) && (
          <Button variant="outline" disabled={busy} onClick={() => void act('/billing/portal')}>
            Manage billing
          </Button>
        )}
        <button
          className="text-sm underline underline-offset-4 disabled:opacity-50"
          disabled={busy}
          onClick={() => void act('/billing/sync')}
        >
          Refresh subscription
        </button>
      </div>
      {!active && (
        <p className="text-xs text-secondary-ink">
          {events === 100000
            ? '14-day trial on Pro 100k, then $9/month. Confirm payment details in Polar.'
            : 'Paid subscription from the start. This plan has no free trial.'}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

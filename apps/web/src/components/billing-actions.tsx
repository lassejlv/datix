import { Alert } from './ui/alert';
import { toast } from './ui/toast';
import { useSitePreferences } from './site-preferences';
import { useEffect, useState } from 'react';
import { apiClient, errorText } from '../lib/client';
import { Button } from './ui/button';
import { Check } from './ui/icons';
import { cn } from '../lib/utils';

import {
  billingPlans,
  billingPlanDescriptions,
  billingPrice,
  billingAvailable,
} from '../lib/billing-plans';
export const billingVolumes = billingPlans;

type Plan = (typeof billingPlans)[number];

export function BillingActions({ active, refresh }: { active: boolean; refresh: () => void }) {
  const { locale, number, message: messageText, t } = useSitePreferences();
  const [hasCustomer, setHasCustomer] = useState(false);
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [returned, setReturned] = useState(false);
  const yearly = interval === 'year';
  useEffect(() => {
    void apiClient<{ hasCustomer: boolean }>('/billing')
      .then((r) => setHasCustomer(r.hasCustomer))
      .catch(() => {});
    try {
      const pending = Number(sessionStorage.getItem('ab-checkout-events'));
      if (
        sessionStorage.getItem('ab-checkout-interval') === 'year' &&
        billingVolumes.some((plan) => plan.events === pending && plan.yearlyAvailable)
      )
        // oxlint-disable-next-line react/set-state-in-effect
        setInterval('year');
      sessionStorage.removeItem('ab-checkout-events');
      sessionStorage.removeItem('ab-checkout-interval');
    } catch {
      /* Checkout selection is optional when storage is blocked. */
    }
    // The account usage hook syncs ?checkout_id= returns; this only keeps the waiting note.
    if (new URLSearchParams(location.search).has('checkout_id')) {
      // oxlint-disable-next-line react/set-state-in-effect -- browser URL is an external source
      setReturned(true);
    }
  }, []);
  const checkout = async (plan: Plan) => {
    setBusy(plan.id);
    setError('');
    try {
      const result = await apiClient<{ url?: string }>('/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ events: plan.events, interval, locale }),
      });
      if (result.url) window.location.assign(result.url);
      else {
        toast.success(t('Subscription refreshed.'));
        refresh();
        setBusy('');
      }
    } catch (e) {
      setError(errorText(e));
      setBusy('');
    }
  };
  const portal = async (path: string) => {
    setBusy(path);
    setError('');
    try {
      const result = await apiClient<{ url?: string }>(path, {
        method: 'POST',
        body: '{}',
      });
      if (result.url) window.location.assign(result.url);
      else {
        toast.success(t('Subscription refreshed.'));
        refresh();
        setBusy('');
      }
    } catch (e) {
      setError(errorText(e));
      setBusy('');
    }
  };
  return (
    <div className="mt-5 space-y-4">
      {returned && !active && (
        <p role="status" className="text-sm text-secondary-ink">
          {t(
            'Waiting for Polar to confirm your subscription. Your allowance will appear here once it is active.',
          )}
        </p>
      )}
      {!active && (
        <>
          <div
            className="inline-flex rounded-lg border border-border p-0.5"
            role="group"
            aria-label={t('Billing period')}
          >
            <button
              type="button"
              aria-pressed={!yearly}
              disabled={Boolean(busy)}
              className={cn(
                'h-8 rounded-md px-3 text-sm',
                !yearly ? 'bg-foreground text-primary-foreground' : 'text-secondary-ink',
              )}
              onClick={() => setInterval('month')}
            >
              {t('Monthly')}
            </button>
            <button
              type="button"
              aria-pressed={yearly}
              disabled={Boolean(busy)}
              className={cn(
                'h-8 rounded-md px-3 text-sm',
                yearly ? 'bg-foreground text-primary-foreground' : 'text-secondary-ink',
              )}
              onClick={() => setInterval('year')}
            >
              {t('Yearly')}
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {billingVolumes.map((plan) => {
              const available = billingAvailable(plan, yearly);
              const popular = plan.id === 'pro';
              const description = billingPlanDescriptions[plan.id];
              return (
                <article
                  key={plan.id}
                  aria-labelledby={`billing-plan-${plan.id}`}
                  className={cn(
                    'flex min-w-0 flex-col rounded-xl border bg-card p-4',
                    popular ? 'border-foreground' : 'border-border',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <h2 id={`billing-plan-${plan.id}`} className="text-base font-medium">
                      {plan.name}
                    </h2>
                    {popular && (
                      <span className="rounded-full bg-foreground px-2 py-0.5 text-[11px] font-medium text-primary-foreground">
                        {t('Most popular')}
                      </span>
                    )}
                  </div>
                  {description && (
                    <p className="mt-1 text-sm leading-relaxed text-secondary-ink">
                      {t(description)}
                    </p>
                  )}
                  <p className="mt-4">
                    <span className="text-[28px] font-medium tracking-tight">
                      {billingPrice(plan, locale, yearly)}
                    </span>
                    <span className="text-sm text-secondary-ink"> / {t(interval)}</span>
                  </p>
                  <ul className="mt-4 mb-5 flex flex-1 flex-col gap-1.5 text-sm">
                    {[
                      t('{count} credits per month', { count: number(plan.events) }),
                      t('{count} websites', { count: plan.websites }),
                      t('All dashboard reports'),
                      ...(plan.id === 'basic' ? [t('Includes a 14-day free trial')] : []),
                    ].map((feature) => (
                      <li key={feature} className="flex items-start gap-2">
                        <Check size={15} className="mt-0.5 shrink-0" />
                        {feature}
                      </li>
                    ))}
                  </ul>
                  <Button
                    className="w-full"
                    disabled={!available || Boolean(busy)}
                    loading={busy === plan.id}
                    onClick={() => void checkout(plan)}
                  >
                    {!available
                      ? t('Coming soon')
                      : plan.id === 'basic'
                        ? t('Start 14-day trial')
                        : t('Choose {plan}', { plan: plan.name })}
                  </Button>
                </article>
              );
            })}
          </div>
          {yearly && !billingPlans.some((plan) => billingAvailable(plan, true)) && (
            <p role="status" className="text-xs text-secondary-ink">
              {t('Yearly billing is not available yet. Choose a monthly plan.')}
            </p>
          )}
        </>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {(hasCustomer || active) && (
          <Button
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() => void portal('/billing/portal')}
          >
            {t('Manage billing')}
          </Button>
        )}
        <button
          className="text-sm underline underline-offset-4 disabled:opacity-50"
          disabled={Boolean(busy)}
          onClick={() => void portal('/billing/sync')}
        >
          {t('Refresh subscription')}
        </button>
      </div>
      {error && <Alert className="text-sm text-danger">{messageText(error)}</Alert>}
    </div>
  );
}

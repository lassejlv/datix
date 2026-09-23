import { Alert } from './ui/alert';
import { toast } from './ui/toast';
import { useSitePreferences } from './site-preferences';
import { useEffect, useState } from 'react';
import { apiClient, errorText } from '../lib/client';
import { Button } from './ui/button';
import { Check } from './ui/icons';
import { cn } from '../lib/utils';

import {
  billingAllowance,
  billingPlans,
  billingPlanDescriptions,
  billingPrice,
  freePlan,
  type BillingPlan,
} from '../lib/billing-plans';

/**
 * Without a plan, every plan is offered. Free accounts are offered the paid upgrade,
 * which the backend applies to the existing free subscription.
 */
export function BillingActions({
  active,
  current,
  refresh,
}: {
  active: boolean;
  current?: string | null;
  refresh: () => void;
}) {
  const { locale, number, message: messageText, t } = useSitePreferences();
  const [hasCustomer, setHasCustomer] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [returned, setReturned] = useState(false);
  const onFree = active && current === freePlan.name;
  const offered = !active ? billingPlans : onFree ? billingPlans.filter((plan) => !plan.free) : [];
  useEffect(() => {
    void apiClient<{ hasCustomer: boolean }>('/billing')
      .then((r) => setHasCustomer(r.hasCustomer))
      .catch(() => {});

    try {
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

  const checkout = async (plan: BillingPlan) => {
    setBusy(plan.id);
    setError('');

    try {
      const result = await apiClient<{ url?: string }>('/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ events: plan.events, interval: 'month', locale }),
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
      {offered.length > 0 && (
        <div className={cn('grid gap-3', offered.length > 1 && 'sm:grid-cols-2')}>
          {offered.map((plan) => {
            const popular = !plan.free;
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
                  {popular && !onFree && (
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
                    {billingPrice(plan, locale)}
                  </span>
                  <span className="text-sm text-secondary-ink"> / {t('month')}</span>
                </p>
                <ul className="mt-4 mb-5 flex flex-1 flex-col gap-1.5 text-sm">
                  {[...billingAllowance(plan, t, number, locale), t('All dashboard reports')].map(
                    (feature) => (
                      <li key={feature} className="flex items-start gap-2">
                        <Check size={15} className="mt-0.5 shrink-0" />
                        {feature}
                      </li>
                    ),
                  )}
                </ul>
                <Button
                  className="w-full"
                  disabled={Boolean(busy)}
                  loading={busy === plan.id}
                  onClick={() => void checkout(plan)}
                >
                  {plan.free
                    ? t('Start for free')
                    : onFree
                      ? t('Upgrade to {plan}', { plan: plan.name })
                      : t('Choose {plan}', { plan: plan.name })}
                </Button>
              </article>
            );
          })}
        </div>
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

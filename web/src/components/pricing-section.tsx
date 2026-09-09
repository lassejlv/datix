import { ApiError, apiClient, errorText } from '../lib/client';
import {
  billingPlans,
  billingPrice,
  billingCurrency,
  billingAvailable,
} from '../lib/billing-plans';
import { useSitePreferences } from './site-preferences';
import { useRef, useState } from 'react';
import { ArrowRight } from './ui/icons';
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from './ui/dialog';

export function PricingSection() {
  const { number, message: messageText, t, locale } = useSitePreferences();
  const [selected, setSelected] = useState<(typeof billingPlans)[number]>(billingPlans[0]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [yearly, setYearly] = useState(false);
  const returnFocus = useRef<HTMLButtonElement>(null);
  const interval = yearly ? 'year' : 'month';
  const amount = (plan: (typeof billingPlans)[number]) => billingPrice(plan, locale, yearly);
  const checkout = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await apiClient<{ url: string }>('/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ events: selected.events, interval, locale }),
      });
      window.location.assign(result.url);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        try {
          sessionStorage.setItem('ab-checkout-events', String(selected.events));
          sessionStorage.setItem('ab-checkout-interval', interval);
        } catch {
          /* Optional selection. */
        }
        window.location.assign('/signup');
        return;
      }
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <section id="pricing" className="landing-pricing" aria-labelledby="pricing-title">
      <header className="pricing-heading">
        <div>
          <h1 id="pricing-title">{t('Pricing')}</h1>
          <p className="landing-section-description">
            {t('Three plans. All your analytics. Start with 14 days free on Basic.')}
          </p>
        </div>
        <div className="pricing-billing-switch" role="group" aria-label={t('Billing period')}>
          <button type="button" aria-pressed={!yearly} onClick={() => setYearly(false)}>
            {t('Monthly')}
          </button>
          <button type="button" aria-pressed={yearly} onClick={() => setYearly(true)}>
            {t('Yearly')}
            <span className="pricing-coming-soon">{t('Save 2 months')}</span>
          </button>
        </div>
      </header>
      <div className="pricing-grid pricing-three-plans">
        {billingPlans.map((plan) => (
          <article
            key={plan.id}
            className={`pricing-card${plan.id === 'pro' ? ' pricing-card-pro' : ''}`}
            aria-labelledby={`plan-${plan.id}`}
          >
            <div className="pricing-configure">
              <h2 id={`plan-${plan.id}`}>{plan.name}</h2>
              <p className="pricing-amount">
                <span>{amount(plan)}</span>
                <span> / {t(interval)}</span>
              </p>
              <p className="pricing-billing-note">
                {plan.id === 'basic' ? t('14 days free, then') : ''}{' '}
                {t(yearly ? 'billed yearly' : 'billed monthly')}
              </p>
              <dl className="pricing-limits">
                <div>
                  <dt>{t('Monthly events')}</dt>
                  <dd>{number(plan.events)}</dd>
                </div>
                <div>
                  <dt>{t('Websites')}</dt>
                  <dd>{plan.websites}</dd>
                </div>
              </dl>
              <ul className="pricing-feature-list">
                <li>{t('All dashboard reports')}</li>
                <li>{t('Custom events')}</li>
                <li>{t('Separate environments')}</li>
              </ul>
              <div className="pricing-action">
                <button
                  className="pricing-select"
                  disabled={!billingAvailable(plan, yearly)}
                  type="button"
                  onClick={(event) => {
                    returnFocus.current = event.currentTarget;
                    setSelected(plan);
                    setError('');
                    setOpen(true);
                  }}
                >
                  {!billingAvailable(plan, yearly)
                    ? t('Coming soon')
                    : plan.id === 'basic'
                      ? t('Start 14-day trial')
                      : t('Choose {plan}', { plan: plan.name })}
                  <ArrowRight size={16} aria-hidden="true" />
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
      {yearly && !billingPlans.some((plan) => billingAvailable(plan, true)) && (
        <p role="status" className="pricing-currency-note">
          {t('Yearly billing is not available yet. Choose a monthly plan.')}
        </p>
      )}
      <p className="pricing-currency-note">
        {t('All prices in {currency}.', { currency: billingCurrency().toUpperCase() })}
      </p>
      <div className="pricing-event-note">
        <h4>{t('What counts as an event?')}</h4>
        <p>
          {t(
            'Events include pageviews and tracked activity. Your monthly allowance is shared across your websites.',
          )}
        </p>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup
          closeProps={{ 'aria-label': t('Close') }}
          className="pricing-dialog"
          finalFocus={returnFocus}
          bottomStickOnMobile={false}
        >
          <DialogHeader>
            <DialogTitle>{selected.name}</DialogTitle>
            <DialogDescription>
              {t('{price} per {interval}', {
                price: amount(selected),
                interval: t(interval),
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <dl className="pricing-dialog-limits">
              <div>
                <dt>{t('Monthly events')}</dt>
                <dd>{number(selected.events)}</dd>
              </div>
              <div>
                <dt>{t('Websites')}</dt>
                <dd>{selected.websites}</dd>
              </div>
            </dl>
            <p className="pricing-dialog-note">
              {selected.id === 'basic'
                ? t(
                    'Confirm your plan and payment details at checkout. Your trial starts only after checkout is completed.',
                  )
                : t(
                    'Confirm your plan and payment details at checkout. This plan starts with paid billing and has no free trial.',
                  )}
            </p>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {messageText(error)}
              </p>
            )}
            <div className="pricing-dialog-actions">
              <button type="button" onClick={() => setOpen(false)}>
                {t('Back to plans')}
              </button>
              <button
                className="pricing-checkout"
                type="button"
                disabled={busy || !billingAvailable(selected, yearly)}
                onClick={() => void checkout()}
              >
                {busy ? t('Opening checkout…') : t('Continue to checkout')}
                <ArrowRight size={16} aria-hidden="true" />
              </button>
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </section>
  );
}

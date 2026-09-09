import { ApiError, apiClient, errorText } from '../lib/client';
import {
  billingPlans,
  billingPrice,
  billingCurrency,
  billingAvailable,
} from '../lib/billing-plans';
import { useSitePreferences } from './site-preferences';
import { useRef, useState } from 'react';
import { ArrowRight, Check } from './ui/icons';
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from './ui/dialog';

const pricingQuestions = [
  [
    'Do I need Pro to get all the reports?',
    'No. Every plan includes the same reports and tracking features. Choose Basic, Pro, or Ultra based on how much traffic you expect.',
  ],
  [
    'Can I use one plan for several websites?',
    'Yes. Every plan includes up to 10 websites. Your monthly credits are shared across them, so estimate your total traffic when choosing a plan.',
  ],
  [
    'Which plan includes the free trial?',
    'Basic includes a 14-day free trial. You can explore the reports with your own website’s traffic before choosing a paid plan.',
  ],
  [
    'Does testing use my credits?',
    'Localhost traffic uses a reduced rate: 0.3 credits per pageview and 0.15 per other event. Separate environments keep test activity out of your production reports.',
  ],
] as const;

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
          <h1 id="pricing-title">
            {t('Three plans.')}
            <br />
            <span>{t('All your analytics.')}</span>
          </h1>
          <p className="landing-section-description">
            {t('Every plan includes every report. Start Basic with 14 days free.')}
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
      <div className="pricing-ledger">
        <div className="pricing-grid pricing-three-plans">
          {billingPlans.map((plan) => (
            <article
              key={plan.id}
              className={`pricing-card${plan.id === 'pro' ? ' pricing-card-pro' : ''}`}
              aria-labelledby={`plan-${plan.id}`}
            >
              <div className="pricing-configure">
                <div className="pricing-plan-head">
                  <h2 id={`plan-${plan.id}`}>{plan.name}</h2>
                  <span className="pricing-plan-tag">
                    {t(
                      plan.id === 'basic'
                        ? '14 days free'
                        : plan.id === 'pro'
                          ? 'Most popular'
                          : 'High volume',
                    )}
                  </span>
                </div>
                <p className="pricing-amount">
                  <span>{amount(plan)}</span>
                  <span> / {t(interval)}</span>
                </p>
                <dl className="pricing-limits">
                  <div>
                    <dt>{t('Monthly credits')}</dt>
                    <dd>{number(plan.events)}</dd>
                  </div>
                </dl>
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
        <div className="pricing-included">
          <h3>{t('Included in every plan')}</h3>
          <ul className="pricing-feature-list">
            {[
              t('All dashboard reports'),
              t('Cookieless by default'),
              t('One script to install'),
              t('Date ranges'),
              t('Referrers and countries'),
              t('{count} websites', { count: billingPlans[0].websites }),
              t('Custom events'),
              t('Separate environments'),
            ].map((feature) => (
              <li key={feature}>
                <Check size={15} aria-hidden="true" />
                {feature}
              </li>
            ))}
          </ul>
        </div>
      </div>
      {yearly && !billingPlans.some((plan) => billingAvailable(plan, true)) && (
        <p role="status" className="pricing-currency-note">
          {t('Yearly billing is not available yet. Choose a monthly plan.')}
        </p>
      )}
      <p className="pricing-currency-note">
        {t('All prices in {currency}.', { currency: billingCurrency().toUpperCase() })}
      </p>
      <section className="pricing-event-note" aria-labelledby="usage-guide-title">
        <h2 id="usage-guide-title">{t('Choose by traffic, not features.')}</h2>
        <p>{t('A production pageview uses 1 credit. Clicks and other events use 0.5 credits.')}</p>
        <p className="pricing-example">
          {t(
            'Basic covers 100,000 pageviews, or 80,000 pageviews + 40,000 other events per month.',
          )}
        </p>
        <p className="pricing-localhost-note">
          {t(
            'On localhost: 0.3 credits per pageview and 0.15 per other event. Engagement time is free.',
          )}
        </p>
      </section>
      <section className="pricing-questions" aria-labelledby="pricing-questions-title">
        <h2 id="pricing-questions-title">{t('Before you choose.')}</h2>
        <dl>
          {pricingQuestions.map(([question, answer]) => (
            <div key={question}>
              <dt>{t(question)}</dt>
              <dd>{t(answer)}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="landing-closing" aria-labelledby="pricing-closing-title">
        <h2 id="pricing-closing-title">{t('Start with your own traffic.')}</h2>
        <a className="landing-button" href="/signup">
          {t('Start 14-day trial')}
          <ArrowRight size={17} aria-hidden="true" />
        </a>
      </section>
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
                <dt>{t('Monthly credits')}</dt>
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

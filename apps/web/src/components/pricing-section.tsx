import { Accordion } from '@base-ui/react/accordion';
import { Alert } from './ui/alert';
import { ApiError, apiClient, errorText } from '../lib/client';
import {
  billingPlans,
  billingPlanDescriptions,
  billingPrice,
  billingCurrency,
  billingAvailable,
} from '../lib/billing-plans';
import { useSitePreferences } from './site-preferences';
import { useState } from 'react';
import { ArrowRight, Check, ChevronDown } from './ui/icons';

type Plan = (typeof billingPlans)[number];

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
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [yearly, setYearly] = useState(false);
  const interval = yearly ? 'year' : 'month';
  const amount = (plan: Plan) => billingPrice(plan, locale, yearly);

  const checkout = async (plan: Plan) => {
    setBusy(plan.id);
    setError('');

    try {
      const result = await apiClient<{ url: string }>('/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ events: plan.events, interval, locale }),
      });

      window.location.assign(result.url);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        try {
          sessionStorage.setItem('ab-checkout-events', String(plan.events));
          sessionStorage.setItem('ab-checkout-interval', interval);
        } catch {
          /* Optional selection. */
        }

        window.location.assign('/signup');

        return;
      }

      setError(errorText(e));
      setBusy('');
    }
  };

  return (
    <section id="pricing" className="landing-pricing" aria-labelledby="pricing-title">
      <header className="pricing-heading">
        <div>
          <h1 id="pricing-title">{t('Simple, transparent pricing')}</h1>
          <p className="landing-section-description">
            {t(
              'Every plan includes every report and every feature. Pick the one that matches your traffic.',
            )}
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
        {error && <Alert className="pricing-error text-sm text-danger">{messageText(error)}</Alert>}
        <div className="pricing-grid pricing-three-plans">
          {billingPlans.map((plan) => {
            const available = billingAvailable(plan, yearly);
            const popular = plan.id === 'pro';
            const description = billingPlanDescriptions[plan.id];

            return (
              <article
                key={plan.id}
                className={`pricing-card${popular ? ' pricing-card-pro' : ''}`}
                aria-labelledby={`plan-${plan.id}`}
              >
                <div className="pricing-plan-head">
                  <h2 id={`plan-${plan.id}`}>{plan.name}</h2>
                  {popular && <span className="pricing-plan-tag">{t('Most popular')}</span>}
                </div>
                <p className="pricing-card-description">{description ? t(description) : null}</p>
                <p className="pricing-amount">
                  <span>{amount(plan)}</span>
                  <span> / {t(interval)}</span>
                </p>
                <button
                  className="pricing-select"
                  disabled={!available || busy === plan.id}
                  type="button"
                  onClick={() => void checkout(plan)}
                >
                  {!available
                    ? t('Coming soon')
                    : busy === plan.id
                      ? t('Opening checkout…')
                      : plan.id === 'basic'
                        ? t('Start 14-day trial')
                        : t('Choose {plan}', { plan: plan.name })}
                  <ArrowRight size={16} aria-hidden="true" />
                </button>
                <ul className="pricing-card-features">
                  {[
                    t('{count} credits per month', { count: number(plan.events) }),
                    t('{count} websites', { count: plan.websites }),
                    t('All dashboard reports'),
                    t('Custom events'),
                    t('Separate environments'),
                    t('Cookieless by default'),
                    ...(plan.id === 'basic' ? [t('Includes a 14-day free trial')] : []),
                  ].map((feature) => (
                    <li key={feature}>
                      <Check size={15} aria-hidden="true" />
                      {feature}
                    </li>
                  ))}
                </ul>
              </article>
            );
          })}
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
          {t('Basic covers 15,000 pageviews, or 12,000 pageviews + 6,000 other events per month.')}
        </p>
        <p className="pricing-localhost-note">
          {t(
            'On localhost: 0.3 credits per pageview and 0.15 per other event. Engagement time is free.',
          )}
        </p>
      </section>
      <section className="pricing-questions" aria-labelledby="pricing-questions-title">
        <h2 id="pricing-questions-title">{t('Frequently asked questions')}</h2>
        <Accordion.Root className="pricing-faq">
          {pricingQuestions.map(([question, answer]) => (
            <Accordion.Item key={question} className="pricing-faq-item">
              <Accordion.Header className="pricing-faq-header">
                <Accordion.Trigger className="pricing-faq-trigger">
                  {t(question)}
                  <ChevronDown size={18} aria-hidden="true" />
                </Accordion.Trigger>
              </Accordion.Header>
              <Accordion.Panel className="pricing-faq-panel">
                <p className="pricing-faq-answer">{t(answer)}</p>
              </Accordion.Panel>
            </Accordion.Item>
          ))}
        </Accordion.Root>
      </section>
      <section className="landing-closing" aria-labelledby="pricing-closing-title">
        <h2 id="pricing-closing-title">{t('Start with your own traffic.')}</h2>
        <a className="landing-button" href="/signup">
          {t('Start 14-day trial')}
          <ArrowRight size={17} aria-hidden="true" />
        </a>
      </section>
    </section>
  );
}

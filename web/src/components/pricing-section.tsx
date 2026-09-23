import { Accordion } from '@base-ui/react/accordion';
import { Alert } from './ui/alert';
import { ApiError, apiClient, errorText } from '../lib/client';
import {
  billingAllowance,
  billingAmount,
  billingPlans,
  billingPlanDescriptions,
  billingPrice,
  billingCurrency,
  freePlan,
  overagePlan,
  type BillingPlan,
} from '../lib/billing-plans';
import { useSitePreferences } from './site-preferences';
import { useState } from 'react';
import { PricingCalculator } from './pricing-calculator';
import { ArrowRight, Check, ChevronDown } from './ui/icons';

const pricingQuestions = [
  [
    'Do I need Pro to get all the reports?',
    'No. Free and Pro include the same reports. Pro adds separate environments, more credits, more websites, and usage-based billing.',
  ],
  [
    'Can I use one plan for several websites?',
    'Free includes one website. Pro includes up to {websites} websites, and your monthly credits are shared across them.',
  ],
  [
    'What happens when I use all my credits?',
    'On Free, tracking pauses until your allowance renews. On Pro, tracking continues and extra usage is billed at {price} per 1,000 credits at the end of the month. Set a website budget to limit a single website.',
  ],
  [
    'Does testing use my credits?',
    'Localhost traffic uses a reduced rate: 0.3 credits per pageview and 0.15 per other event. On Pro, separate environments keep test activity out of your production reports.',
  ],
] as const;

export function PricingSection() {
  const { number, message: messageText, t, locale } = useSitePreferences();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const interval = 'month';

  const answerValues = {
    websites: overagePlan.websites,
    price: billingAmount(overagePlan.overagePer1k!, locale),
  };

  const checkout = async (plan: BillingPlan) => {
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
        <h1 id="pricing-title">{t('Simple, transparent pricing')}</h1>
        <p className="landing-section-description">
          {t(
            'Every plan includes every report. Pick the one that matches your traffic and websites.',
          )}
        </p>
      </header>
      <div className="pricing-ledger">
        {error && <Alert className="pricing-error text-sm text-danger">{messageText(error)}</Alert>}
        <div className="pricing-grid pricing-two-plans">
          {billingPlans.map((plan) => {
            const popular = !plan.free;
            const description = billingPlanDescriptions[plan.id];

            return (
              <article
                key={plan.id}
                className={`pricing-card${popular ? ' pricing-card-pro' : ''}`}
                aria-labelledby={`plan-${plan.id}`}
              >
                <p
                  className={`pricing-plan-kicker${popular ? '' : ' pricing-plan-kicker-spacer'}`}
                  aria-hidden={popular ? undefined : true}
                >
                  {popular ? t('Most popular') : null}
                </p>
                <div className="pricing-plan-head">
                  <h2 id={`plan-${plan.id}`}>{plan.name}</h2>
                </div>
                <p className="pricing-card-description">{description ? t(description) : null}</p>
                <p className="pricing-amount">
                  <span className="pricing-price">{billingPrice(plan, locale)}</span>
                  <span className="pricing-interval">/ {t(interval)}</span>
                </p>
                <ul className="pricing-card-features">
                  {[
                    ...billingAllowance(plan, t, number, locale),
                    t('All dashboard reports'),
                    t('Custom events'),
                    ...(plan.environments ? [t('Separate environments')] : []),
                    t('Cookieless by default'),
                  ].map((feature) => (
                    <li key={feature}>
                      <Check size={15} aria-hidden="true" />
                      {feature}
                    </li>
                  ))}
                </ul>
                <button
                  className="pricing-select"
                  disabled={busy === plan.id}
                  type="button"
                  onClick={() => void checkout(plan)}
                >
                  {busy === plan.id
                    ? t('Opening checkout…')
                    : plan.free
                      ? t('Start for free')
                      : t('Choose {plan}', { plan: plan.name })}
                  <ArrowRight size={16} aria-hidden="true" />
                </button>
              </article>
            );
          })}
        </div>
        <p className="pricing-currency-note">
          {t('All prices in {currency}.', { currency: billingCurrency().toUpperCase() })}
        </p>
        <PricingCalculator />
      </div>
      <section className="pricing-event-note" aria-labelledby="usage-guide-title">
        <h2 id="usage-guide-title">{t('How credits are counted')}</h2>
        <div className="pricing-rate-list">
          <p>
            {t('A production pageview uses 1 credit. Clicks and other events use 0.5 credits.')}
          </p>
          <p className="pricing-example">
            {t(
              'Free covers {count} pageviews, or {pageviews} pageviews + {events} other events per month.',
              {
                count: number(freePlan.events),
                pageviews: number(freePlan.events * 0.8),
                events: number(freePlan.events * 0.4),
              },
            )}
          </p>
          <p className="pricing-localhost-note">
            {t(
              'On localhost: 0.3 credits per pageview and 0.15 per other event. Engagement time is free.',
            )}
          </p>
        </div>
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
                <p className="pricing-faq-answer">{t(answer, answerValues)}</p>
              </Accordion.Panel>
            </Accordion.Item>
          ))}
        </Accordion.Root>
      </section>
      <section className="landing-closing" aria-labelledby="pricing-closing-title">
        <h2 id="pricing-closing-title">{t('Start with your own traffic.')}</h2>
        <a className="landing-button" href="/signup">
          {t('Start for free')}
          <ArrowRight size={17} aria-hidden="true" />
        </a>
      </section>
    </section>
  );
}

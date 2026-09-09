import { ApiError, apiClient, errorText } from '../lib/client';
import { useSitePreferences } from './site-preferences';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight } from './ui/icons';
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from './ui/dialog';

// Annual checkout remains unavailable until monthly credit cycling is enabled.
const proVolumes = [
  { events: 100_000, price: 9 },
  { events: 250_000, price: 19 },
  { events: 500_000, price: 29 },
  { events: 1_000_000, price: 49 },
  { events: 2_000_000, price: 79 },
  { events: 5_000_000, price: 149 },
] as const;
type Plan = { price: number; events: number; websites: number };
const initialPlan: Plan = { ...proVolumes[0], websites: 10 };

export function PricingSection() {
  const { number, message: messageText, t, locale } = useSitePreferences();
  const [selected, setSelected] = useState<Plan>(initialPlan);
  const [volume, setVolume] = useState(0);
  const enterprise = volume === proVolumes.length;
  const plan: Plan = { ...proVolumes[Math.min(volume, proVolumes.length - 1)]!, websites: 10 };
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [yearly, setYearly] = useState(false);
  const [mounted, setMounted] = useState(false);
  const returnFocus = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- controls become interactive after hydration
    setMounted(true);
  }, []);
  const amount = (plan: Plan) => (yearly ? plan.price * 10 : plan.price);
  const interval = yearly ? t('year') : t('month');

  const checkout = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await apiClient<{ url: string }>('/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ events: selected.events, interval: 'month', locale }),
      });
      window.location.assign(result.url);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        try {
          sessionStorage.setItem('ab-checkout-events', String(selected.events));
        } catch {
          /* Optional selection */
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
            {t('14 days free on Pro 100k. Pick your event volume.')}
          </p>
        </div>
        <div className="pricing-billing-switch" role="group" aria-label={t('Billing period')}>
          <button
            type="button"
            disabled={!mounted}
            aria-pressed={!yearly}
            onClick={() => setYearly(false)}
          >
            {t('Monthly')}
          </button>
          <button
            type="button"
            disabled={!mounted}
            aria-pressed={yearly}
            onClick={() => setYearly(true)}
          >
            {t('Yearly')}
            <span className="pricing-coming-soon">{t('Coming soon')}</span>
          </button>
        </div>
      </header>
      <div className="pricing-grid">
        <article className="pricing-card pricing-card-pro" aria-labelledby="plan-pro">
          <div className="pricing-configure">
            <h2 id="plan-pro">{enterprise ? t('Enterprise') : 'Pro'}</h2>
            <p className="pricing-amount" aria-live="polite" aria-atomic="true">
              <span>{enterprise ? t('Custom') : `$${amount(plan)}`}</span>
              {!enterprise && <span> / {interval}</span>}
            </p>
            <p className="pricing-billing-note">
              {enterprise
                ? t('For more than 5 million events per month.')
                : yearly
                  ? t('Yearly billing is coming soon. Save 2 months when it arrives.')
                  : plan.events === 100_000
                    ? t('14 days free on Pro 100k, then billed monthly.')
                    : t('Billed monthly. This volume does not include a trial.')}
            </p>
            <dl className="pricing-limits">
              <div>
                <dt>
                  <label htmlFor="pro-events">{t('Monthly events')}</label>
                </dt>
                <dd>
                  <output htmlFor="pro-events">
                    {enterprise ? `${number(5_000_000)}+` : number(plan.events)}
                  </output>
                </dd>
              </div>
              <div className="pricing-volume">
                <dt className="sr-only">{t('Adjust event volume')}</dt>
                <dd>
                  <input
                    id="pro-events"
                    type="range"
                    min={0}
                    max={proVolumes.length}
                    step={1}
                    value={volume}
                    disabled={!mounted}
                    aria-valuetext={
                      enterprise
                        ? t('Over 5 million monthly events — Enterprise')
                        : `${number(plan.events)} ${t('Monthly events')}`
                    }
                    onChange={(event) => setVolume(Number(event.target.value))}
                  />
                  <span className="pricing-volume-endpoints" aria-hidden="true">
                    <span>{number(proVolumes[0].events)}</span>
                    <span>{number(5_000_000)}+</span>
                  </span>
                </dd>
              </div>
              <div>
                <dt>{t('Websites')}</dt>
                <dd>{enterprise ? t('Custom') : plan.websites}</dd>
              </div>
            </dl>
            <div className="pricing-action">
              {enterprise ? (
                <a className="pricing-select" href="mailto:hello@analytics.beer">
                  {t('Contact sales')}
                  <ArrowRight size={16} aria-hidden="true" />
                </a>
              ) : (
                <button
                  className="pricing-select"
                  type="button"
                  disabled={!mounted}
                  onClick={(event) => {
                    returnFocus.current = event.currentTarget;
                    setSelected(plan);
                    setError('');
                    setOpen(true);
                  }}
                >
                  {t(
                    yearly
                      ? 'Preview yearly plan'
                      : plan.events === 100_000
                        ? 'Start 14-day trial'
                        : 'Choose Pro',
                  )}
                  <ArrowRight size={16} aria-hidden="true" />
                </button>
              )}
            </div>
            <p className="pricing-currency-note">{t('All prices in USD.')}</p>
          </div>
          <div className="pricing-included">
            <h3>{t('Included at every volume')}</h3>
            <ul className="pricing-feature-list">
              <li>
                <h4>{t('All dashboard reports')}</h4>
                <p>{t('Traffic, visitor journeys and engagement in one place.')}</p>
              </li>
              <li>
                <h4>{t('Custom events')}</h4>
                <p>{t('Measure the actions that matter to your website.')}</p>
              </li>
              <li>
                <h4>{t('Separate environments')}</h4>
                <p>{t('Keep development and production traffic apart.')}</p>
              </li>
            </ul>
            <div className="pricing-event-note">
              <h4>{t('What counts as an event?')}</h4>
              <p>
                {t(
                  'Events include pageviews and tracked activity. Your monthly allowance is shared across your websites.',
                )}
              </p>
            </div>
          </div>
        </article>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup
          closeProps={{ 'aria-label': t('Close') }}
          className="pricing-dialog"
          finalFocus={returnFocus}
          bottomStickOnMobile={false}
        >
          <DialogHeader>
            <DialogTitle>Pro{yearly ? ` · ${t('Coming soon')}` : ''}</DialogTitle>
            <DialogDescription>
              {`${!yearly && selected.events === 100000 ? `${t('14 days free, then')} ` : ''}$${amount(selected)} ${t('per')} ${interval}.`}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <dl className="pricing-dialog-limits">
              <div>
                <dt>{t('Billing')}</dt>
                <dd>
                  {`$${amount(selected)} ${yearly ? t('billed yearly') : t('billed monthly')}`}
                </dd>
              </div>
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
              {t(
                yearly
                  ? 'Yearly billing is not available yet. Choose monthly billing to start Pro.'
                  : selected.events === 100000
                    ? 'Confirm your plan and payment details in Polar. Your trial starts only after checkout is completed.'
                    : 'Confirm your plan and payment details in Polar. This plan starts with paid billing and has no free trial.',
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
              {!yearly && (
                <button
                  className="pricing-checkout"
                  type="button"
                  disabled={busy}
                  onClick={() => void checkout()}
                >
                  {busy ? t('Opening checkout…') : t('Continue to checkout')}
                  <ArrowRight size={16} aria-hidden="true" />
                </button>
              )}
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </section>
  );
}

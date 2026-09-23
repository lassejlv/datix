import { useEffect, useState, type CSSProperties } from 'react';
import { billingAmount, overagePlan } from '../lib/billing-plans';
import {
  calculatorLimits,
  clampTraffic,
  estimatePricing,
  formatEstimatePrice,
} from '../lib/pricing-estimate';
import { useSitePreferences } from './site-preferences';

const defaults = { pageviews: 20_000, events: 5_000 };

export function PricingCalculator() {
  const { number, t, locale } = useSitePreferences();
  const [pageviews, setPageviews] = useState(defaults.pageviews);
  const [events, setEvents] = useState(defaults.events);
  const estimate = estimatePricing(pageviews, events);
  const price = formatEstimatePrice(estimate.price, locale);

  const note =
    estimate.planId === 'free'
      ? t('Within the Free allowance. {count} credits left.', {
          count: number(estimate.remaining),
        })
      : estimate.extraCredits > 0
        ? t('{count} credits beyond Pro, at {price} per 1,000.', {
            count: number(estimate.extraCredits),
            price: billingAmount(overagePlan.overagePer1k!, locale),
          })
        : t('Included with Pro. {count} credits left.', {
            count: number(estimate.remaining),
          });

  const summary = `${estimate.planName}, ${price}, ${note}`;
  const [announced, setAnnounced] = useState(summary);

  useEffect(() => {
    const timer = setTimeout(() => setAnnounced(summary), 400);

    return () => clearTimeout(timer);
  }, [summary]);

  return (
    <section className="pricing-calculator" aria-labelledby="pricing-calculator-title">
      <h2 id="pricing-calculator-title">{t('Estimate a month')}</h2>
      <div className="pricing-calculator-panel">
        <div className="pricing-calculator-controls">
          <TrafficControl
            id="pricing-pageviews"
            label={t('Pageviews')}
            max={calculatorLimits.pageviews}
            value={pageviews}
            onChange={setPageviews}
          />
          <TrafficControl
            id="pricing-events"
            label={t('Other events')}
            max={calculatorLimits.events}
            value={events}
            onChange={setEvents}
          />
        </div>
        <div className="pricing-calculator-result">
          <p className="pricing-calculator-credits">
            {t('{count} credits', { count: number(estimate.credits) })}
          </p>
          <p className="pricing-calculator-plan" key={estimate.planId}>
            {estimate.planName}
          </p>
          <p className="pricing-calculator-total">
            <strong>{price}</strong>
            <span>/ {t('month')}</span>
          </p>
          <p className="pricing-calculator-note">{note}</p>
        </div>
      </div>
      <p className="pricing-calculator-live" aria-live="polite">
        {announced}
      </p>
    </section>
  );
}

function TrafficControl({
  id,
  label,
  max,
  value,
  onChange,
}: {
  id: string;
  label: string;
  max: number;
  value: number;
  onChange: (value: number) => void;
}) {
  const labelId = `${id}-label`;
  const fill = `${(value / max) * 100}%`;

  return (
    <div className="pricing-calculator-field">
      <div className="pricing-calculator-field-head">
        <label id={labelId} htmlFor={id}>
          {label}
        </label>
        <input
          id={id}
          className="pricing-calculator-value"
          inputMode="numeric"
          min={0}
          max={max}
          type="number"
          value={value}
          onChange={(event) => onChange(clampTraffic(Number(event.target.value), max))}
        />
      </div>
      <input
        className="pricing-slider"
        aria-labelledby={labelId}
        max={max}
        min={0}
        style={{ '--pricing-fill': fill } as CSSProperties}
        type="range"
        value={value}
        onChange={(event) => onChange(clampTraffic(Number(event.target.value), max))}
      />
    </div>
  );
}

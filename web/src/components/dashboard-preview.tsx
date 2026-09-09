import { useState } from 'react';
import { useSitePreferences } from './site-preferences';

const views = ['Overview', 'Pages', 'Referrers', 'Countries', 'Devices', 'Events'] as const;
type View = (typeof views)[number];

export function DashboardPreview() {
  const { t, darkMedia, number, locale } = useSitePreferences();
  const [view, setView] = useState<View>('Overview');
  const regions = new Intl.DisplayNames([locale], { type: 'region' });
  const reports: Record<Exclude<View, 'Overview'>, [string, number][]> = {
    Pages: [
      ['/', 171],
      ['/work', 165],
      ['/about', 159],
      ['/contact', 153],
    ],
    Referrers: [
      [t('Direct / none'), 171],
      ['google.com', 165],
      ['instagram.com', 159],
      ['linkedin.com', 153],
    ],
    Countries: [
      ['DK', 171],
      ['US', 165],
      ['GB', 159],
      ['DE', 153],
    ].map(([code, count]) => [regions.of(String(code)) ?? String(code), Number(count)]),
    Devices: [
      [t('Desktop'), 424],
      [t('Mobile'), 224],
    ],
    Events: [['contact', 147]],
  };
  return (
    <section className="landing-product" aria-label={t('Explore dashboard')}>
      <div className="landing-preview-tabs" role="group" aria-label={t('Dashboard reports')}>
        {views.map((item) => (
          <button
            type="button"
            key={item}
            aria-pressed={view === item}
            aria-controls="dashboard-preview"
            onClick={() => setView(item)}
          >
            {t(item)}
          </button>
        ))}
      </div>
      <div className="landing-preview-window" id="dashboard-preview">
        <div className="landing-preview-bar">
          <span className="landing-window-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>forest-studio.example · {t('Example traffic')}</span>
        </div>
        {view === 'Overview' ? (
          <picture>
            <source media={darkMedia} srcSet="/media/dashboard-dark.webp" />
            <img
              src="/media/dashboard-light.webp"
              width="1440"
              height="1128"
              fetchPriority="high"
              alt={t(
                'Datix dashboard with sample pageviews, daily visitors, a traffic chart, and page and referrer reports.',
              )}
            />
          </picture>
        ) : (
          <div className="landing-preview-report" aria-live="polite">
            <div className="landing-preview-report-title">
              <h2>{t(view)}</h2>
              <span>{t('Example traffic')}</span>
            </div>
            <div className="landing-preview-table-heading">
              <span>{t(view)}</span>
              <span>{t(view === 'Events' ? 'Events' : 'Pageviews')}</span>
            </div>
            <ul>
              {reports[view].map(([label, count]) => (
                <li key={label}>
                  <span>{label}</span>
                  <strong>{number(count)}</strong>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

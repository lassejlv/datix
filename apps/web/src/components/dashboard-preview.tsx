import { useSitePreferences } from './site-preferences';

export function DashboardPreview() {
  const { t } = useSitePreferences();
  return (
    <section className="landing-product" aria-label={t('Explore dashboard')}>
      <div className="landing-preview-window" id="dashboard-preview">
        <picture>
          <img
            src="/media/dashboard-dark.webp"
            width="1440"
            height="1128"
            fetchPriority="high"
            alt={t(
              'Datix dashboard with sample pageviews, daily visitors, a traffic chart, and page and referrer reports.',
            )}
          />
        </picture>
      </div>
    </section>
  );
}

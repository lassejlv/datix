import { useSitePreferences } from './site-preferences';

export function DashboardPreview() {
  const { t } = useSitePreferences();

  return (
    <section className="landing-product" aria-label={t('Explore dashboard')}>
      <div className="landing-preview-window" id="dashboard-preview">
        <video
          src="/media/datix-launch.mp4"
          poster="/media/datix-launch-poster.jpg"
          width="1920"
          height="1080"
          autoPlay
          muted
          loop
          playsInline
          aria-label={t(
            'Datix dashboard with sample pageviews, daily visitors, a traffic chart, and page and referrer reports.',
          )}
        />
      </div>
    </section>
  );
}

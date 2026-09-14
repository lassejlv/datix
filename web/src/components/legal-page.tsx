import { LandingLayout } from './landing-layout';
import { Button } from './ui/button';
import { useSitePreferences } from './site-preferences';

export function LegalPage({
  html,
  downloadable = false,
}: {
  html: string;
  downloadable?: boolean;
}) {
  const { t } = useSitePreferences();

  return (
    <LandingLayout>
      <main id="main-content" className="legal-page" tabIndex={-1}>
        {downloadable && (
          <div className="legal-actions mb-8 flex flex-wrap items-center gap-4 text-sm">
            <a className="underline" href="/api/dpa/download" download>
              {t('Download agreement')}
            </a>
            <Button variant="outline" onClick={() => window.print()}>
              {t('Print / save PDF')}
            </Button>
            <a className="underline" href="/account">
              {t('Your agreements')}
            </a>
          </div>
        )}
        {/* Static, repository-owned policy copy. Never render user-provided HTML here. */}
        <article lang="en" className="legal-document" dangerouslySetInnerHTML={{ __html: html }} />
      </main>
    </LandingLayout>
  );
}

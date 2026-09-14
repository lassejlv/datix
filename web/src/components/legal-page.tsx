import { LandingLayout } from './landing-layout';

export function LegalPage({ html }: { html: string }) {
  return (
    <LandingLayout>
      <main id="main-content" className="legal-page" tabIndex={-1}>
        {/* Static, repository-owned policy copy. Never render user-provided HTML here. */}
        <article lang="en" className="legal-document" dangerouslySetInnerHTML={{ __html: html }} />
      </main>
    </LandingLayout>
  );
}

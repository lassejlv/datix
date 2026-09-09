import { SitePreferences, useSitePreferences } from '../components/site-preferences';
import { getPreferences } from '../lib/i18n/get-preferences';
import { createRootRoute, HeadContent, Outlet, useLocation } from '@tanstack/react-router';
import { useEffect } from 'react';

export const Route = createRootRoute({
  loader: () => getPreferences(),
  staleTime: Infinity,
  head: () => ({
    meta: [
      { title: 'Analytics Beer | Website analytics' },
      {
        name: 'description',
        content:
          'Understand your visitors, spot what works, and get back to building. Simple website analytics with cookieless tracking by default.',
      },
    ],
  }),
  notFoundComponent: NotFound,
  component: RootDocument,
});

function RootDocument() {
  const preferences = Route.useLoaderData();
  useEffect(() => {
    // Static metadata covers the HTML shell; the router owns it once the app has mounted.
    document.querySelectorAll('[data-router-head]').forEach((element) => element.remove());
  }, []);
  return (
    <>
      <HeadContent />
      <SitePreferences initial={preferences}>
        <DocumentMetadata />
        <Outlet />
      </SitePreferences>
    </>
  );
}

function NotFound() {
  const { t } = useSitePreferences();
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-6 px-6 text-center">
      <p className="text-lg font-medium">Analytics Beer</p>
      <h1 className="text-4xl font-medium tracking-tight">{t('Nothing brewing here.')}</h1>
      <p className="text-secondary-ink">
        {t('This page could not be found. Head back to the homepage.')}
      </p>
      <a
        href="/"
        className="rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
      >
        {t('Back to home')}
      </a>
    </main>
  );
}

function DocumentMetadata() {
  const { t } = useSitePreferences();
  const { pathname } = useLocation();
  useEffect(() => {
    const page = pathname.split('/').filter(Boolean).at(-1);
    const titles = {
      signin: 'Sign in',
      signup: 'Create account',
      pricing: 'Pricing',
      usage: 'Usage',
      dashboard: 'Your workspace',
      overview: 'Overview',
      visitors: 'Visitors',
      installation: 'Install',
      imports: 'Imports',
      setup: 'Setup',
      settings: 'Settings',
    } as const;
    const key = titles[page as keyof typeof titles];
    document.title = key
      ? `${t(key)} | Analytics Beer`
      : `Analytics Beer | ${t('Website analytics')}`;
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (description)
      description.content = t(
        'Understand your visitors, spot what works, and get back to building. Simple website analytics with cookieless tracking by default.',
      );
  }, [pathname, t]);
  return null;
}

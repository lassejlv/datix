import { SitePreferences } from '../components/site-preferences';
import { getPreferences } from '../lib/i18n/get-preferences';
import { createRootRoute, HeadContent, Outlet } from '@tanstack/react-router';
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
  notFoundComponent: () => (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-6 px-6 text-center">
      <p className="text-lg font-medium">Analytics Beer</p>
      <h1 className="text-4xl font-medium tracking-tight">Nothing brewing here.</h1>
      <p className="text-secondary-ink">This page could not be found. Head back to the homepage.</p>
      <a
        href="/"
        className="rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
      >
        Back to home
      </a>
    </main>
  ),
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
        <Outlet />
      </SitePreferences>
    </>
  );
}

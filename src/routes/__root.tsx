import { SitePreferences } from '../components/site-preferences';
import { getPreferences } from '../lib/i18n/get-preferences';
import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import '../styles.css';

export const Route = createRootRoute({
  loader: () => getPreferences(),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Analytics Beer | Website analytics' },
      {
        name: 'description',
        content:
          'Understand your visitors, spot what works, and get back to building. Simple website analytics with cookieless tracking by default.',
      },
      { property: 'og:type', content: 'website' },
      { property: 'og:title', content: 'Analytics Beer | Good insights. Less head scratching.' },
      {
        property: 'og:description',
        content: 'Understand your visitors, spot what works, and get back to building.',
      },
      {
        property: 'og:image',
        content: 'https://analytics.beer/media/beer-stop-motion-poster-light.webp',
      },
      { property: 'og:image:width', content: '960' },
      { property: 'og:image:height', content: '600' },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
    links: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    scripts: [
      {
        src: 'https://analytics.beer/tracker.js',
        'data-site': '01a1b8f5-e833-42e6-a58f-ce78db51b128',
        defer: true,
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
  return (
    <html lang={preferences.locale} data-theme={preferences.theme} suppressHydrationWarning>
      <head>
        <HeadContent />
        <script
          dangerouslySetInnerHTML={{
            __html: `document.documentElement.classList.toggle("dark",document.documentElement.dataset.theme==="dark"||(document.documentElement.dataset.theme==="system"&&matchMedia("(prefers-color-scheme: dark)").matches));`,
          }}
        />
      </head>
      <body className="m-0 bg-background font-sans text-[15px] leading-normal text-foreground antialiased selection:bg-pressed **:motion-reduce:animate-none **:motion-reduce:transition-none **:motion-reduce:scroll-auto">
        <SitePreferences initial={preferences}>
          <Outlet />
        </SitePreferences>
        <Scripts />
      </body>
    </html>
  );
}

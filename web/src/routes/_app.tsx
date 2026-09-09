import { useSitePreferences } from '../components/site-preferences';
import { createFileRoute, Outlet } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
const AnalyticsApp = lazy(() =>
  import('../components/dashboard').then((module) => ({ default: module.AnalyticsApp })),
);
export const Route = createFileRoute('/_app')({
  component: AppLayout,
});

function AppLayout() {
  const { t } = useSitePreferences();
  return (
    <>
      <Suspense
        fallback={
          <main
            className="mx-auto min-h-dvh max-w-[440px] px-6 py-16"
            aria-label={t('Loading your account')}
          >
            <div className="h-8 w-48 rounded bg-muted" />
          </main>
        }
      >
        <AnalyticsApp />
      </Suspense>
      <Outlet />
    </>
  );
}

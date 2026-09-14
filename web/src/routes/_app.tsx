import { useSitePreferences } from '../components/site-preferences';
import { createFileRoute, Outlet } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { Skeleton } from '../components/ui/skeleton';

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
            role="status"
            aria-label={t('Loading your account')}
          >
            <Skeleton className="h-8 w-48" />
            <Skeleton className="mt-6 h-4 w-full" />
            <Skeleton className="mt-2 h-4 w-3/4" />
          </main>
        }
      >
        <AnalyticsApp />
      </Suspense>
      <Outlet />
    </>
  );
}

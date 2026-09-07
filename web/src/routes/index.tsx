import { createFileRoute, redirect } from '@tanstack/react-router';
import { LandingPage } from '../components/landing-page';
import { isDashboardPage, siteRoute } from '../lib/dashboard-route';
export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>) => ({
    auth: search.auth === 'signup' || search.auth === 'signin' ? search.auth : undefined,
    site: typeof search.site === 'string' ? search.site : undefined,
    environment: typeof search.environment === 'string' ? search.environment : undefined,
    view: typeof search.view === 'string' ? search.view : undefined,
  }),
  beforeLoad: ({ search }) => {
    if (search.site)
      throw redirect({
        to: siteRoute,
        params: {
          siteId: search.site,
          environmentId: search.environment ?? search.site,
          page: isDashboardPage(search.view) ? search.view : 'overview',
        },
        replace: true,
      });
    if (search.auth)
      throw redirect({ to: search.auth === 'signup' ? '/signup' : '/signin', replace: true });
    if (search.environment || search.view) throw redirect({ to: '/dashboard', replace: true });
  },
  component: LandingPage,
});

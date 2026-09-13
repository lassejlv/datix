import { createFileRoute, redirect } from '@tanstack/react-router';
import { LandingPage } from '../components/landing-page';
import { isDashboardPage, siteRoute } from '../lib/dashboard-route';
import { landingSearchSchema } from '../lib/search-params';
export const Route = createFileRoute('/')({
  validateSearch: landingSearchSchema,
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

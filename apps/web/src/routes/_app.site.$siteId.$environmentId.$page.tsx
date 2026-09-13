import { createFileRoute, notFound } from '@tanstack/react-router';
import { isDashboardPage, validRouteId } from '../lib/dashboard-route';
import { reportSearchSchema } from '../lib/search-params';

export const Route = createFileRoute('/_app/site/$siteId/$environmentId/$page')({
  validateSearch: reportSearchSchema,
  beforeLoad: ({ params }) => {
    if (
      !validRouteId(params.siteId) ||
      !validRouteId(params.environmentId) ||
      !isDashboardPage(params.page)
    )
      throw notFound({ routeId: '__root__' });
  },
  component: () => null,
});

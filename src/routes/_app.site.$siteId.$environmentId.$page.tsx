import { createFileRoute, notFound } from '@tanstack/react-router';
import { isDashboardPage, validRouteId } from '../lib/dashboard-route';
export const Route = createFileRoute('/_app/site/$siteId/$environmentId/$page')({
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

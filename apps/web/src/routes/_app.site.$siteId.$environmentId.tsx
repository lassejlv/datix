import { createFileRoute, notFound } from '@tanstack/react-router';
import { validRouteId } from '../lib/dashboard-route';
export const Route = createFileRoute('/_app/site/$siteId/$environmentId')({
  beforeLoad: ({ params }) => {
    if (!validRouteId(params.environmentId)) throw notFound({ routeId: '__root__' });
  },
});

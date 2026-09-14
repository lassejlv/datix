import { createFileRoute, notFound } from '@tanstack/react-router';
import { validRouteId } from '../lib/dashboard-route';

export const Route = createFileRoute('/_app/site/$siteId')({
  beforeLoad: ({ params }) => {
    if (!validRouteId(params.siteId)) throw notFound({ routeId: '__root__' });
  },
});

import { createFileRoute, notFound } from '@tanstack/react-router';
import { isDashboardPage, validRouteId } from '../lib/dashboard-route';
export const Route = createFileRoute('/_app/site/$siteId/$environmentId/$page')({
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    from?: string;
    to?: string;
    tab?: string;
  } => {
    const date = (value: unknown) =>
      typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
    const tab = typeof search.tab === 'string' ? search.tab : undefined;
    return { from: date(search.from), to: date(search.to), tab };
  },
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

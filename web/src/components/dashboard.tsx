import {
  LiveVisitors,
  OverviewAnnotations,
  OverviewGoal,
  disclosureSummary,
  type OverviewReport,
} from './overview-extras';
import { Alert } from './ui/alert';
import { Hint, HintText } from './ui/tooltip';
import { DatePicker } from './ui/date-picker';
import { Select } from './ui/select';
import { FeaturePageView } from './feature-pages';
import { isFeaturePage } from '../lib/features';
import { deviceName } from '../lib/i18n/display';
import { useSitePreferences } from './site-preferences';
import { AccountPage } from './account-settings';
import { AccountAccess } from './account-access';
import { AgreementGate } from './agreement';
import { useAccountUsage } from './usage';
import { CountryLabel, countryName } from './country-label';
import { Link, useLocation, useNavigate, useParams } from '@tanstack/react-router';
import { isDashboardPage, siteRoute, type DashboardPage } from '../lib/dashboard-route';
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, ChevronDown, Code2, ExternalLink, RefreshCw } from './ui/icons';
import { Button } from './ui/button';
import { WorkspaceSidebar } from './workspace-sidebar';
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from './ui/sidebar';
import { Spinner } from './ui/spinner';
import { Skeleton } from './ui/skeleton';
import { Brand } from './brand';
import { AuthScreen } from './auth-screen';
import { PageTransition } from './page-transition';
import { TrafficChart } from './traffic-chart';
import { metricColor } from '../lib/metric-colors';
import { WelcomeOnboarding, SetupOnboarding } from './onboarding';
import { VisitorJourneys } from './visitor-journeys';
import { AddSiteDialog, Installation, SiteSettings } from './site-panels';
import { AddEnvironmentDialog } from './environment-panels';
import { breakdownName, providerName } from '../lib/imports';
import {
  ApiError,
  apiClient,
  errorText,
  write,
  type Breakdown,
  type Metric,
  type Site,
  type SiteEnvironment,
  type User,
} from '../lib/client';

type Panel = DashboardPage;

// Only administrators ever load this surface, so it stays out of the workspace bundle.
const AdminPanel = lazy(() =>
  import('./admin-panel').then((module) => ({ default: module.AdminPanel })),
);

export function AnalyticsApp() {
  const { message: messageText, t } = useSitePreferences();
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const returnPath = useRef(pathname.startsWith('/site/') ? pathname : null);
  if (pathname.startsWith('/site/')) returnPath.current = pathname;

  const [user, setUser] = useState<User | null | undefined>(undefined),
    [error, setError] = useState(''),
    [reload, setReload] = useState(0);

  const [unverifiedEmail, setUnverifiedEmail] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    apiClient<{ user: User }>('/me', { signal: controller.signal })
      .then((data) => setUser(data.user))
      .catch(async (error) => {
        if (controller.signal.aborted) return;

        if (error instanceof ApiError && error.code === 'email_not_verified') {
          try {
            const session = await apiClient<{ user: { email: string } } | null>(
              '/auth/get-session',
              { signal: controller.signal },
            );

            if (controller.signal.aborted) return;
            setUnverifiedEmail(session?.user.email ?? '');
          } catch {
            if (controller.signal.aborted) return;
          }
        }

        if (
          error instanceof ApiError &&
          (error.status === 401 || error.code === 'email_not_verified')
        )
          setUser(null);
        else setError(errorText(error));
      });

    return () => controller.abort();
  }, [reload]);

  const signedOut = useCallback(() => {
    returnPath.current = null;
    setUser(null);
  }, []);

  if (error)
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-5 text-secondary-ink">
        <Brand />
        <Alert className="max-w-[420px] text-center">{messageText(error)}</Alert>
        <Button onClick={() => setReload((value) => value + 1)}>{t('Try again')}</Button>
      </main>
    );
  if (user === undefined)
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-5 text-secondary-ink">
        <Brand />
        <Spinner className="size-5" />
        <span>{t('Getting things ready…')}</span>
      </main>
    );
  // Administration is account-level operational tooling, so it stays reachable even when the
  // operator's own subscription has lapsed — AccountAccess would otherwise hold it behind a plan.
  if (user && pathname === '/admin')
    return (
      <Suspense
        fallback={
          <main className="flex min-h-dvh flex-col items-center justify-center gap-5 text-secondary-ink">
            <Brand />
            <Spinner className="size-5" />
          </main>
        }
      >
        <AdminPanel user={user} onExit={() => void navigate({ to: '/dashboard' })} />
      </Suspense>
    );

  return user ? (
    <AgreementGate
      key={user.id}
      user={user}
      onSignedOut={signedOut}
      account={<AccountPage user={user} onUpdated={setUser} onDeleted={signedOut} />}
    >
      <AccountAccess
        key={user.id}
        user={user}
        onSignedOut={signedOut}
        account={<AccountPage user={user} onUpdated={setUser} onDeleted={signedOut} />}
      >
        {(usage) => (
          <SidebarProvider className="dashboard-workspace">
            <Dashboard user={user} onSignedOut={signedOut} onUserUpdated={setUser} usage={usage} />
          </SidebarProvider>
        )}
      </AccountAccess>
    </AgreementGate>
  ) : (
    <AuthScreen
      unverifiedEmail={unverifiedEmail}
      initialSignup={pathname === '/signup'}
      onModeChange={(signup) => {
        void navigate({ to: signup ? '/signup' : '/signin' });
      }}
      onSignedIn={(user) => {
        setUser(user);

        try {
          if (sessionStorage.getItem('ab-checkout-events')) {
            void navigate({ to: '/dashboard', replace: true });

            return;
          }
        } catch {
          /* Optional checkout selection. */
        }

        if (returnPath.current && !pathname.startsWith('/site/'))
          void navigate({ to: returnPath.current, replace: true });
      }}
    />
  );
}

function Dashboard({
  user,
  onSignedOut,
  onUserUpdated,
  usage,
}: {
  user: User;
  onSignedOut: () => void;
  onUserUpdated: (user: User) => void;
  usage: ReturnType<typeof useAccountUsage>;
}) {
  const { message: messageText, t } = useSitePreferences();
  const navigate = useNavigate();
  const params = useParams({ strict: false });

  const reportRange = useLocation({
    select: (location) => location.search as { from?: string; to?: string },
  });

  const settingsTab = useLocation({
    select: (location) => (location.search as { tab?: string }).tab,
  });

  const isAccount = useLocation({ select: (location) => location.pathname === '/account' });
  const { setOpenMobile } = useSidebar();

  const [sites, setSites] = useState<Site[]>([]),
    [rememberedSite, setRememberedSite] = useState(''),
    [environmentIds, setEnvironmentIds] = useState<Record<string, string>>({});

  const selected = params.siteId ?? rememberedSite;
  const panel: Panel = isDashboardPage(params.page) ? params.page : 'overview';
  // Legacy /imports URLs carry no ?tab= but must open the imports tab.
  const settingsTabOrLegacy = panel === 'imports' ? 'imports' : settingsTab;

  const [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [addOpen, setAddOpen] = useState(false),
    [addEnvironmentOpen, setAddEnvironmentOpen] = useState(false),
    [signingOut, setSigningOut] = useState(false);

  const site = sites.find((value) => value.id === selected);
  const websiteUsage = usage.data?.websites.find((value) => value.id === selected);

  const environment = site?.environments.find(
    (value) => value.id === (params.environmentId ?? environmentIds[site.id] ?? site.id),
  );

  const [setupStatus, setSetupStatus] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!site || !environment) return;
    const controller = new AbortController();
    const environmentId = environment.id;
    void apiClient<{ receiving: boolean }>(
      `/sites/${site.id}/installation?environment=${environmentId}`,
      { signal: controller.signal },
    )
      .then(({ receiving }) => {
        if (!controller.signal.aborted)
          setSetupStatus((current) => ({
            ...current,
            [environmentId]: current[environmentId] === true || receiving,
          }));
      })
      .catch(() => {
        /* Keep the last known setup status if the check fails. */
      });

    return () => controller.abort();
  }, [site?.id, environment?.id, panel]);

  function go(siteId: string, environmentId: string, page: DashboardPage, replace = false) {
    setOpenMobile(false);
    void navigate({ to: siteRoute, params: { siteId, environmentId, page }, replace });
  }

  function environmentUpdated(updated: SiteEnvironment) {
    setSites((items) =>
      items.map((value) =>
        value.id === updated.siteId
          ? {
              ...value,
              ...(updated.id === value.id
                ? {
                    enabled: updated.enabled,
                    allowLocalhost: updated.allowLocalhost,
                  }
                : {}),
              environments: value.environments.map((environment) =>
                environment.id === updated.id ? updated : environment,
              ),
            }
          : value,
      ),
    );
  }

  const loadSites = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const result = await apiClient<{ sites: Site[] }>('/sites');
      setSites(result.sites);
      let remembered: string | null = null;

      try {
        remembered =
          localStorage.getItem(`analytics-beer:site:${user.id}`) ??
          localStorage.getItem(`folks:site:${user.id}`);
      } catch {
        /* Optional preference. */
      }

      setRememberedSite(
        result.sites.find((site) => site.id === remembered)?.id ?? result.sites[0]?.id ?? '',
      );
      setEnvironmentIds(
        Object.fromEntries(
          result.sites.map((site) => {
            let id: string | null = null;

            try {
              id = localStorage.getItem(`analytics-beer:environment:${user.id}:${site.id}`);
            } catch {
              /* Optional preference. */
            }

            return [
              site.id,
              site.environments.some((environment) => environment.id === id) ? id! : site.id,
            ];
          }),
        ),
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onSignedOut();
      else setError(errorText(error));
    } finally {
      setLoading(false);
    }
  }, [onSignedOut, user.id]);

  useEffect(() => {
    void loadSites();
  }, [loadSites]);
  useEffect(() => {
    if (!selected || !environment) return;

    try {
      localStorage.setItem(`analytics-beer:site:${user.id}`, selected);
      localStorage.setItem(`analytics-beer:environment:${user.id}:${selected}`, environment.id);
    } catch {
      /* Storage may be unavailable in private browsing. */
    }

    setEnvironmentIds((current) =>
      current[selected] === environment.id ? current : { ...current, [selected]: environment.id },
    );

    if (!isAccount && (!params.siteId || !params.environmentId || !params.page)) {
      void navigate({
        to: siteRoute,
        params: {
          siteId: selected,
          environmentId: environment.id,
          page: (() => {
            try {
              return localStorage.getItem(`analytics-beer:setup:${user.id}`) === selected
                ? 'setup'
                : panel;
            } catch {
              return panel;
            }
          })(),
        },
        replace: true,
      });
    }
  }, [
    selected,
    panel,
    environment?.id,
    user.id,
    params.siteId,
    params.environmentId,
    params.page,
    navigate,
    isAccount,
  ]);
  useEffect(() => {
    if (site && environment && panel === 'imports') {
      void navigate({
        to: siteRoute,
        params: { siteId: site.id, environmentId: environment.id, page: 'settings' },
        search: { tab: 'imports' },
        replace: true,
      });
    }
  }, [site, environment, panel, navigate]);

  function show(next: DashboardPage) {
    if (site && environment) go(site.id, environment.id, next);
  }

  const completeSetup = useCallback(() => {
    if (environment)
      setSetupStatus((current) =>
        current[environment.id] === true ? current : { ...current, [environment.id]: true },
      );

    try {
      if (localStorage.getItem(`analytics-beer:setup:${user.id}`) === selected)
        localStorage.removeItem(`analytics-beer:setup:${user.id}`);
    } catch {
      /* Optional resume preference. */
    }

    if (!usage.data?.onboardingCompleted)
      void apiClient('/onboarding/complete', write('POST', {}))
        .then(usage.refresh)
        .catch((error) => setError(errorText(error)));
  }, [user.id, usage.data?.onboardingCompleted, usage.refresh, selected, environment?.id]);

  function accountDeleted() {
    try {
      const exact = [
        `analytics-beer:site:${user.id}`,
        `folks:site:${user.id}`,
        `analytics-beer:setup:${user.id}`,
      ];

      for (const key of Object.keys(localStorage))
        if (exact.includes(key) || key.startsWith(`analytics-beer:environment:${user.id}:`))
          localStorage.removeItem(key);
    } catch {
      /* Browser preferences are optional. */
    }

    void navigate({ to: '/signin', replace: true });
    onSignedOut();
  }

  async function signout() {
    setSigningOut(true);

    try {
      await apiClient('/auth/sign-out', write('POST', {}));
      void navigate({ to: '/signin', replace: true });
      onSignedOut();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <>
      <a
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-4 focus:z-60 focus:rounded-md focus:border focus:border-border focus:bg-background focus:p-3 focus:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        href="#main-content"
      >
        {t('Skip to content')}
      </a>
      <WorkspaceSidebar
        sites={sites}
        site={site}
        environment={environment}
        panel={panel === 'imports' ? 'settings' : panel}
        isAccount={isAccount}
        user={user}
        signingOut={signingOut}
        showSetup={!!environment && setupStatus[environment.id] === false}
        onSelect={(nextSite, nextEnvironment) =>
          go(nextSite, nextEnvironment, nextSite === site?.id ? panel : 'overview')
        }
        onAddSite={() => setAddOpen(true)}
        onAddEnvironment={() => setAddEnvironmentOpen(true)}
        onSignOut={signout}
        onAccountSettings={() => void navigate({ to: '/account' })}
        onAdministration={() => void navigate({ to: '/admin' })}
      />
      <SidebarInset className="min-h-dvh min-w-0 md:min-h-[calc(100dvh-1rem)]">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4 md:px-6">
          <SidebarTrigger
            className="size-8 rounded-md sm:size-8 [&_svg]:size-4"
            aria-label={t('Toggle navigation')}
            data-testid="navigation-toggle"
          />
        </header>
        <div
          id="main-content"
          className="mx-auto w-full max-w-[960px] flex-1 px-4 pt-5 pb-4 md:px-6 md:pt-6 md:pb-5 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          tabIndex={-1}
        >
          {error && (
            <Alert className="mb-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                {messageText(error)}
                <Button variant="outline" size="sm" onClick={loadSites}>
                  {t('Try again')}
                </Button>
              </div>
            </Alert>
          )}
          {(usage.data?.paused || websiteUsage?.pauseReason === 'website_budget') && (
            <div
              className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-4 py-3 text-sm"
              role="status"
            >
              <span>
                {t('Tracking paused ·')}{' '}
                {websiteUsage?.pauseReason === 'website_budget'
                  ? t('Website budget reached')
                  : usage.data?.pauseReason === 'event_limit'
                    ? t('Event limit reached')
                    : t('An active plan is required')}
              </span>
              {site && environment && (
                <Link
                  to={siteRoute}
                  params={{ siteId: site.id, environmentId: environment.id, page: 'settings' }}
                  search={{ tab: 'usage' }}
                  className="underline underline-offset-4"
                >
                  {t('View usage')}
                </Link>
              )}
            </div>
          )}
          <PageTransition
            view={
              loading
                ? 'loading'
                : `${environment?.id || selected || 'empty'}:${panel}${isAccount ? ':account' : ''}`
            }
          >
            {loading ? (
              <WorkspaceSkeleton />
            ) : isAccount ? (
              <AccountPage user={user} onUpdated={onUserUpdated} onDeleted={accountDeleted} />
            ) : params.siteId && (!site || !environment) ? (
              <div className="max-w-[440px] py-10">
                <h1 className="text-2xl font-medium">{t('Website or environment unavailable')}</h1>
                <p className="mt-3 text-secondary-ink">
                  {t('It may have been removed, or you may not have access to it.')}
                </p>
                <Link to="/dashboard" replace className="mt-5 inline-block underline">
                  {t('Back to your websites')}
                </Link>
              </div>
            ) : !site || !environment ? (
              <WelcomeOnboarding name={user.name} onAdd={() => setAddOpen(true)} />
            ) : panel === 'setup' ? (
              <SetupOnboarding
                key={environment.id}
                site={site}
                environment={environment}
                onUpdated={environmentUpdated}
                onDashboard={() => show('overview')}
                onInstallation={() => show('installation')}
                onComplete={completeSetup}
              />
            ) : isFeaturePage(panel) ? (
              <FeaturePageView
                key={`${environment.id}:${panel}`}
                page={panel}
                siteId={site.id}
                environment={environment}
                onSettings={() => show('settings')}
              />
            ) : panel === 'visitors' ? (
              <VisitorJourneys
                key={environment.id}
                siteId={site.id}
                environment={environment}
                onInstall={() => show('installation')}
              />
            ) : panel === 'installation' ? (
              <Installation
                key={environment.id}
                site={site}
                environment={environment}
                onDashboard={() => show('overview')}
                onUpdated={environmentUpdated}
                onConnected={completeSetup}
              />
            ) : panel === 'settings' || panel === 'imports' ? (
              <SiteSettings
                key={`${environment.id}:${settingsTabOrLegacy ?? ''}`}
                site={site}
                environment={environment}
                usage={usage}
                initialTab={settingsTabOrLegacy}
                onViewReport={(from, to) => {
                  void navigate({
                    to: siteRoute,
                    params: {
                      siteId: site.id,
                      environmentId: environment.id,
                      page: 'overview',
                    },
                    search: { from, to },
                  });
                }}
                onEnvironmentUpdated={environmentUpdated}
                onEnvironmentDeleted={() => {
                  setSites((items) =>
                    items.map((value) =>
                      value.id === site.id
                        ? {
                            ...value,
                            environments: value.environments.filter(
                              (value) => value.id !== environment.id,
                            ),
                          }
                        : value,
                    ),
                  );
                  go(site.id, site.id, panel, true);
                }}
                onUpdated={(updated) =>
                  setSites((items) =>
                    items.map((value) => (value.id === updated.id ? updated : value)),
                  )
                }
                onDeleted={() => {
                  setSites((items) => items.filter((value) => value.id !== site.id));
                  const remaining = sites.find((value) => value.id !== site.id);

                  if (remaining)
                    go(
                      remaining.id,
                      environmentIds[remaining.id] ?? remaining.id,
                      'overview',
                      true,
                    );
                  else {
                    setRememberedSite('');
                    void navigate({ to: '/dashboard', replace: true });
                  }
                }}
              />
            ) : (
              <Overview
                key={`${environment.id}:${reportRange.from ?? ''}:${reportRange.to ?? ''}`}
                site={site}
                environment={environment}
                initialRange={reportRange}
                onInstall={() => show('installation')}
                onExpired={onSignedOut}
              />
            )}
          </PageTransition>
        </div>
      </SidebarInset>
      <AddSiteDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={(site) => {
          setSites((items) => [...items, site]);
          if (sites.length === 0) {
            try {
              localStorage.setItem(`analytics-beer:setup:${user.id}`, site.id);
            } catch {
              /* Setup remains accessible from navigation. */
            }

            go(site.id, site.id, 'setup');
          } else go(site.id, site.id, 'installation');
        }}
      />
      {site && (
        <AddEnvironmentDialog
          key={site.id}
          site={site}
          open={addEnvironmentOpen}
          onOpenChange={setAddEnvironmentOpen}
          onCreated={(environment) => {
            setSites((items) =>
              items.map((value) =>
                value.id === site.id
                  ? {
                      ...value,
                      environments: [...value.environments, environment],
                    }
                  : value,
              ),
            );
            go(site.id, environment.id, 'installation');
          }}
        />
      )}
    </>
  );
}

function Overview({
  site,
  environment,
  onInstall,
  onExpired,
  initialRange,
}: {
  site: Site;
  environment: SiteEnvironment;
  onInstall: () => void;
  onExpired: () => void;
  initialRange?: { from?: string; to?: string };
}) {
  const { message: messageText, number, dateLabel, dateTime, t, dark } = useSitePreferences();

  const [days, setDays] = useState(initialRange?.from && initialRange?.to ? 'custom' : '30'),
    [metric, setMetric] = useState<Metric>('pageviews'),
    [reports, setReports] = useState<OverviewReport | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [reload, setReload] = useState(0);

  const [filters, setFilters] = useState<Record<string, string>>({});
  const [compare, setCompare] = useState(true);
  const filterQuery = new URLSearchParams(filters).toString();
  const today = new Date().toISOString().slice(0, 10);

  const [customFrom, setCustomFrom] = useState(initialRange?.from ?? today),
    [customTo, setCustomTo] = useState(initialRange?.to ?? today);

  const from =
    days === 'custom'
      ? customFrom
      : new Date(Date.parse(today) - (days === '24h' ? 1 : Number(days) - 1) * 86400000)
          .toISOString()
          .slice(0, 10);

  const to = days === 'custom' ? customTo : today;

  const rangeValid =
    !!from &&
    !!to &&
    from <= to &&
    to <= today &&
    (Date.parse(to) - Date.parse(from)) / 86400000 < 366;

  useEffect(() => {
    if (!rangeValid) {
      setReports(null);
      setError('Choose a range of up to 366 days, ending no later than today.');
      setLoading(false);

      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError('');
    setReports(null);
    const query = `${days === '24h' ? 'window=24h' : `from=${from}&to=${to}`}&${filterQuery}`;
    apiClient<OverviewReport>(
      `/sites/${site.id}/environments/${environment.id}/features/overview?${query}`,
      { signal: controller.signal },
    )
      .then((result) => setReports(result))
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) onExpired();
        else setError(errorText(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [site.id, environment.id, from, to, reload, rangeValid, onExpired, filterQuery, days]);

  const metrics = [
    { key: 'pageviews', name: 'Pageviews', caption: 'Every page opened' },
    {
      key: 'dailyUniqueVisitors',
      name: 'Daily visitors',
      caption: 'Sum of daily estimates',
    },
    {
      key: 'customEvents',
      name: 'Events',
      caption: 'Clicks and actions',
    },
  ] as const;

  return (
    <div>
      <div className="mb-6 flex flex-col items-stretch gap-4 md:flex-row md:items-start md:justify-between md:gap-6">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h1 className="text-[23px] leading-[1.25] font-medium tracking-[-0.025em] wrap-anywhere md:text-[26px]">
              {environment.domain}
            </h1>
            <a
              className="shrink-0 p-2 text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
              href={`https://${environment.domain}`}
              target="_blank"
              rel="noreferrer"
              aria-label={t('Visit {domain}', { domain: environment.domain })}
            >
              <ExternalLink size={15} />
            </a>
            <LiveVisitors
              key={environment.id}
              siteId={site.id}
              environmentId={environment.id}
              onExpired={onExpired}
            />
          </div>
          <p className="mt-1.5 text-sm text-secondary-ink">
            {site.name} · {environment.name}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 max-md:self-stretch md:pt-1">
          <div className="flex min-w-0 max-md:flex-1">
            <Select
              className="kit-date-range max-md:flex-1"
              popupClassName="kit-date-menu"
              aria-label={t('Date range')}
              value={days}
              onValueChange={(value) => setDays(value)}
            >
              <option className="bg-background" value="24h">
                {t('Last 24 hours')}
              </option>
              <option className="bg-background" value="7">
                {t('Last 7 days')}
              </option>
              <option className="bg-background" value="30">
                {t('Last 30 days')}
              </option>
              <option className="bg-background" value="90">
                {t('Last 90 days')}
              </option>
              <option className="bg-background" value="365">
                {t('Last 365 days')}
              </option>
              <option className="bg-background" value="custom">
                {t('Custom dates')}
              </option>
            </Select>
          </div>
          <Button
            className="size-8 rounded-md sm:size-8"
            variant="outline"
            size="icon"
            aria-label={t('Refresh analytics')}
            loading={loading}
            onClick={() => setReload((value) => value + 1)}
          >
            <RefreshCw size={16} />
          </Button>
        </div>
      </div>
      {days === 'custom' && (
        <div className="mb-6 flex items-end justify-start gap-2 md:justify-end md:gap-3">
          <label className="flex flex-col gap-1.5 text-[13px] text-secondary-ink max-md:min-w-0 max-md:flex-1">
            {t('From')}
            <DatePicker
              label={t('From date')}

              value={customFrom}
              onValueChange={setCustomFrom}
              max={customTo || today}
            />
          </label>
          <span className="pb-2 text-[13px] text-muted-foreground">{t('to')}</span>
          <label className="flex flex-col gap-1.5 text-[13px] text-secondary-ink max-md:min-w-0 max-md:flex-1">
            {t('To')}
            <DatePicker
              label={t('To date')}

              value={customTo}
              onValueChange={setCustomTo}
              min={customFrom}
              max={today}
            />
          </label>
        </div>
      )}
      {!environment.enabled && (
        <div className="mb-6 flex items-center gap-3 rounded-md bg-muted px-4 py-3.5 text-sm max-md:flex-wrap">
          <span className="size-1.5 shrink-0 rounded-full bg-secondary-ink" />
          <span className="flex-1 max-md:basis-[calc(100%-36px)]">
            {t('Collection is paused. Your existing analytics are still here.')}
          </span>
        </div>
      )}
      {!loading &&
        reports &&
        !filterQuery &&
        reports.overview.pageviews === 0 &&
        reports.overview.customEvents === 0 && (
          <div className="mb-6 flex items-center gap-3 rounded-md bg-muted px-4 py-3.5 text-sm max-md:flex-wrap">
            <Code2 size={18} />
            <span className="flex-1 max-md:basis-[calc(100%-36px)]">
              {t('Install your script to start collecting pageviews.')}
            </span>
            <Button variant="ghost" size="sm" onClick={onInstall}>
              {t('Get your script')}
              <ArrowRight size={14} />
            </Button>
          </div>
        )}
      {error && (
        <Alert className="mb-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {messageText(error)}
            {rangeValid && (
              <Button variant="outline" size="sm" onClick={() => setReload((value) => value + 1)}>
                {t('Try again')}
              </Button>
            )}
          </div>
        </Alert>
      )}
      {Object.keys(filters).length > 0 && (
        <div className="mb-5 flex flex-wrap gap-2" aria-label={t('Active filters')}>
          {Object.entries(filters).map(([key, value]) => (
            <Button
              key={key}
              variant="outline"
              size="sm"
              onClick={() =>
                setFilters((current) => {
                  const next = { ...current };
                  delete next[key];

                  return next;
                })
              }
            >
              {t(
                key === 'path'
                  ? 'Page'
                  : key === 'referrer'
                    ? 'Source'
                    : key === 'country'
                      ? 'Country'
                      : 'Device',
              )}
              : {value || t('Direct / none')} ×
            </Button>
          ))}
          <Button variant="ghost" size="sm" onClick={() => setFilters({})}>
            {t('Clear filters')}
          </Button>
        </div>
      )}
      {reports?.filtered && (
        <p className="mb-4 text-xs text-secondary-ink">
          {t('Filters use tracked events from {date}; imported history is excluded.', {
            date: dateLabel(reports.retainedFrom),
          })}
        </p>
      )}
      <section aria-label={t('Traffic overview')}>
        <div className="grid grid-cols-3 gap-2 md:gap-3">
          {metrics.map((item) => {
            const selected = metric === item.key;

            return (
              <Hint key={item.key} content={t(item.caption)}>
                <button
                  className={`relative min-w-0 cursor-pointer rounded-lg px-3 py-3 text-left transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:px-4 ${selected ? 'bg-muted' : ''}`}
                  onClick={() => setMetric(item.key)}
                  aria-pressed={selected}
                >
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-3 bottom-0 h-0.5 rounded-full md:inset-x-4"
                    style={selected ? { background: metricColor(item.key, dark) } : undefined}
                  />
                  <span className="text-xs text-secondary-ink md:text-sm">{t(item.name)}</span>
                  {loading ? (
                    <Skeleton className="my-1 h-[38px] w-[72px]" />
                  ) : (
                    <strong className="my-1 block text-[22px] leading-[1.2] font-medium tracking-[-0.025em] tabular-nums md:text-[28px]">
                      {reports ? number(reports.overview[item.key]) : '-'}
                    </strong>
                  )}
                  {compare && reports?.previous && (
                    <MetricDelta
                      current={reports.overview[item.key]}
                      previous={reports.previous.overview[item.key]}
                    />
                  )}
                </button>
              </Hint>
            );
          })}
        </div>
        <div className="pt-1">
          {loading ? (
            <ChartSkeleton />
          ) : reports ? (
            <TrafficChart
              data={reports.timeseries.data}
              metric={metric}
              previous={compare ? reports.previous?.timeseries.data : undefined}
              annotations={reports.annotations}
            />
          ) : (
            <div className="flex h-[204px] flex-col items-center justify-center gap-3 text-[13px] text-secondary-ink">
              {t('No report to display.')}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-t border-line pt-2.5 text-xs text-secondary-ink">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={compare}
              onChange={(event) => setCompare(event.target.checked)}
            />
            {t('Previous period')}
          </label>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {compare && reports && (
              <span className="text-muted-foreground">
                {reports.previous
                  ? t('Dashed line: {from} – {to}', {
                      from: reports.window
                        ? dateTime(reports.previousRange.from)
                        : dateLabel(reports.previousRange.from),
                      to: reports.window
                        ? dateTime(reports.previousRange.to)
                        : dateLabel(reports.previousRange.to),
                    })
                  : t('Previous period is outside retained history.')}
              </span>
            )}
            <span>
              {days === '24h'
                ? t('Last 24 hours')
                : from && to
                  ? `${dateLabel(from)} - ${dateLabel(to)}`
                  : ''}
              <span className="ml-2 text-muted-foreground">
                {reports?.overview.imports?.calendarDayWarning ? t('Source dates') : 'UTC'}
              </span>
            </span>
          </span>
        </div>
      </section>
      {reports && (
        <>
          <OverviewGoal
            key={environment.id}
            report={reports}
            siteId={site.id}
            environmentId={environment.id}
          />
          <div className="mt-4 space-y-2 text-xs leading-relaxed text-secondary-ink">
            <OverviewAnnotations
              key={`${environment.id}:${from}:${to}`}
              annotations={reports.annotations}
              siteId={site.id}
              environmentId={environment.id}
              from={from}
              to={to}
              onChange={() => setReload((value) => value + 1)}
              onExpired={onExpired}
            />
            {!!reports.overview.imports?.importedDays && (
              <details className="group">
                <summary className={disclosureSummary}>
                  <ChevronDown
                    size={13}
                    className="transition-transform duration-(--duration-fast) ease-smooth-out group-open:rotate-180"
                  />
                  {t(
                    reports.overview.imports.importedDays === 1
                      ? 'Includes {count} day of imported history'
                      : 'Includes {count} days of imported history',
                    { count: number(reports.overview.imports.importedDays) },
                  )}
                </summary>
                <ul className="mt-2 space-y-1">
                  {reports.overview.imports.sources.map((source) => (
                    <li key={source.id}>
                      {providerName(source.provider)} · {source.timeZone} ·{' '}
                      {source.breakdowns.length
                        ? source.breakdowns.map((value) => breakdownName(value, t)).join(', ')
                        : t('Daily totals only')}
                    </li>
                  ))}
                </ul>
                <p className="mt-2">
                  {t(
                    'Daily visitors follow each provider’s definition and are added across days. Events and breakdowns include only what was tracked here or included in the export; GA4 imports contain daily pageviews and total users. Visitor journeys contain only visits tracked by Datix.',
                  )}
                </p>
                {reports.overview.imports.calendarDayWarning && (
                  <p className="mt-2">
                    {t(
                      'Imported totals retain their provider’s calendar dates and timezone. Datix tracking uses UTC.',
                    )}
                  </p>
                )}
                <Link
                  to={siteRoute}
                  params={{ siteId: site.id, environmentId: environment.id, page: 'settings' }}
                  search={{ tab: 'imports' }}
                  className="mt-2 inline-block underline underline-offset-4"
                >
                  {t('Manage imports')}
                </Link>
              </details>
            )}
          </div>
        </>
      )}
      {(!reports || reports.overview.pageviews > 0 || !!filterQuery) && (
        <div className="mt-8 grid grid-cols-1 items-start gap-x-10 gap-y-8 md:grid-cols-2">
          <BreakdownCard
            title={t('Top pages')}
            label={t('Page')}
            onSelect={(value) => setFilters((current) => ({ ...current, path: value }))}
            report={reports?.path}
            loading={loading}
          />
          <BreakdownCard
            title={t('Referrers')}
            label={t('Source')}
            onSelect={(value) => setFilters((current) => ({ ...current, referrer: value }))}
            report={reports?.referrer}
            loading={loading}
          />
          <BreakdownCard
            title={t('Countries')}
            label={t('Country')}
            onSelect={(value) => setFilters((current) => ({ ...current, country: value }))}
            report={reports?.country}
            loading={loading}
            countries
          />
          <BreakdownCard
            title={t('Devices')}
            label={t('Device')}
            devices
            onSelect={(value) => setFilters((current) => ({ ...current, device: value }))}
            report={reports?.device}
            loading={loading}
          />
        </div>
      )}
      <section className={`mt-8 ${cardClass}`}>
        <h2 className={cardTitleClass}>{t('Tracked actions')}</h2>
        <div className="mt-3 border-b border-line" />
        {reports?.event.data.length ? (
          <ol className="m-0 mt-1 grid list-none grid-cols-1 gap-x-10 p-0 sm:grid-cols-2">
            {reports.event.data.map((item) => (
              <MeterRow
                key={item.value}
                share={share(item.count, reports.event.data)}
                value={number(item.count)}
              >
                <span className="block truncate">{item.value}</span>
              </MeterRow>
            ))}
          </ol>
        ) : (
          <div className="mt-3">
            <Button variant="outline" onClick={onInstall}>
              {t('Set up an event')}
              <ArrowRight size={15} />
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

// Fixed heights keep the server and client render identical.
const chartBars = [38, 52, 44, 61, 55, 72, 64, 58, 79, 68, 85, 74, 66, 91, 82];

/** A bar silhouette in place of the traffic chart while its report loads. */
function ChartSkeleton() {
  const { t } = useSitePreferences();

  return (
    <div
      className="flex h-[204px] items-end gap-1"
      role="status"
      aria-label={t('Loading analytics…')}
    >
      {chartBars.map((height, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: index is the stable bar position
        <Skeleton className="min-w-0 flex-1" key={index} style={{ height: `${height}%` }} />
      ))}
    </div>
  );
}

/** The overview's own shape, so switching websites keeps the layout in place. */
function WorkspaceSkeleton() {
  const { t } = useSitePreferences();

  return (
    <div role="status" aria-label={t('Loading your workspace…')}>
      <section>
        <div className="grid grid-cols-3 gap-2 md:gap-3">
          {[1, 2, 3].map((value) => (
            <div className="min-w-0 px-3 py-3 md:px-4" key={value}>
              <Skeleton className="h-4 w-16" />
              <Skeleton className="my-1 h-[38px] w-[72px]" />
            </div>
          ))}
        </div>
        <div className="pt-1">
          <ChartSkeleton />
        </div>
      </section>
      <div className="mt-8 grid grid-cols-1 items-start gap-x-10 gap-y-8 md:grid-cols-2">
        {[1, 2, 3, 4].map((value) => (
          <section className={cardClass} key={value}>
            <Skeleton className="h-5 w-32" />
            <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
              {[1, 2, 3].map((row) => (
                <Skeleton className="h-8" key={row} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

const cardClass = 'min-w-0';
const cardTitleClass = 'text-[15px] leading-[1.4] font-medium tracking-[-0.02em]';

/** Row width as a share of the largest count, so every list is read at a glance. */
function share(count: number, rows: { count: number }[]) {
  const max = Math.max(...rows.map((row) => row.count), 0);

  return max > 0 ? Math.max((count / max) * 100, 2) : 0;
}

function MeterRow({
  share,
  value,
  children,
}: {
  share: number;
  value: string;
  children: ReactNode;
}) {
  return (
    <li className="relative flex min-h-9 items-center justify-between gap-4 px-2 py-1.5 text-sm">
      <span
        aria-hidden="true"
        className="absolute inset-y-0.5 left-0 rounded-sm bg-muted"
        style={{ width: `${share}%` }}
      />
      <span className="relative min-w-0 flex-1">{children}</span>
      <strong className="relative shrink-0 text-[13px] font-normal tabular-nums">{value}</strong>
    </li>
  );
}

function MetricDelta({ current, previous }: { current: number; previous: number }) {
  const { number, t } = useSitePreferences();
  if (previous === 0)
    return (
      <span className="block text-[11px] text-secondary-ink md:text-xs">
        {current === 0 ? t('No change') : t('No previous traffic')}
      </span>
    );
  const change = Math.round((current / previous - 1) * 1000) / 10;

  return (
    <span
      className={`block text-[11px] tabular-nums md:text-xs ${change > 0 ? 'text-success' : change < 0 ? 'text-danger' : 'text-secondary-ink'}`}
    >
      {change > 0 ? '↑ ' : change < 0 ? '↓ ' : ''}
      {number(Math.abs(change))}%
    </span>
  );
}

function BreakdownCard({
  title,
  label,
  report,
  loading,
  countries = false,
  devices = false,
  onSelect,
}: {
  title: string;
  label: string;
  report?: Breakdown;
  loading: boolean;
  countries?: boolean;
  devices?: boolean;
  onSelect?: (value: string) => void;
}) {
  const { locale, number, t } = useSitePreferences();

  return (
    <section className={cardClass}>
      <h2 className={cardTitleClass}>{title}</h2>
      <div className="mt-3 flex justify-between border-b border-line px-2 pb-2 text-xs text-muted-foreground">
        <span>{label}</span>
        <span>{t('Pageviews')}</span>
      </div>
      {loading ? (
        <div
          className="mt-2 flex flex-col gap-2"
          role="status"
          aria-label={t('Loading {title}', { title })}
        >
          {[1, 2, 3].map((value) => (
            <Skeleton className="h-8" key={value} />
          ))}
        </div>
      ) : !report?.data.length ? (
        <div className="min-h-[100px] px-2 py-6 text-[13px] text-muted-foreground">
          {t('No data in this period.')}
        </div>
      ) : (
        <ol className="m-0 mt-1 flex list-none flex-col p-0">
          {report.data.map((item) => {
            const text = item.value
              ? countries
                ? (countryName(item.value, locale) ?? t('Unknown location'))
                : devices
                  ? deviceName(item.value, t)
                  : item.value
              : countries
                ? t('Unknown')
                : t('Direct / none');

            return (
              <MeterRow
                key={item.value}
                share={share(item.count, report.data)}
                value={number(item.count)}
              >
                <button
                  className="w-full cursor-pointer rounded-sm text-left hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  aria-label={t('Filter by {value}', { value: text })}
                  onClick={() => onSelect?.(item.value)}
                >
                  <HintText content={text} className={`truncate ${devices ? 'capitalize' : ''}`}>
                    {countries ? <CountryLabel code={item.value} /> : text}
                  </HintText>
                </button>
              </MeterRow>
            );
          })}
        </ol>
      )}
    </section>
  );
}

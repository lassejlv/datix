import { AccountSettings } from './account-settings';
import { Usage, useAccountUsage } from './usage';
import { CountryLabel, countryName } from './country-label';
import { Link, useLocation, useNavigate, useParams } from '@tanstack/react-router';
import { isDashboardPage, siteRoute, type DashboardPage } from '../lib/dashboard-route';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, CalendarDays, ChevronDown, Code2, ExternalLink, RefreshCw } from './ui/icons';
import { Button } from './ui/button';
import { WorkspaceSidebar } from './workspace-sidebar';
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from './ui/sidebar';
import { Spinner } from './ui/spinner';
import { Brand } from './brand';
import { AuthScreen } from './auth-screen';
import { PageTransition } from './page-transition';
import { TrafficChart } from './traffic-chart';
import { WelcomeOnboarding, SetupOnboarding } from './onboarding';
import { VisitorJourneys } from './visitor-journeys';
import { AddSiteDialog, Installation, SiteSettings } from './site-panels';
import { AddEnvironmentDialog } from './environment-panels';
import {
  ApiError,
  apiClient,
  dateLabel,
  errorText,
  number,
  write,
  type Breakdown,
  type Metric,
  type Reports,
  type Site,
  type SiteEnvironment,
  type User,
} from '../lib/client';

type Panel = DashboardPage | 'usage';
export function AnalyticsApp() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const returnPath = useRef(
    pathname.startsWith('/site/') || pathname === '/usage' ? pathname : null,
  );
  if (pathname.startsWith('/site/')) returnPath.current = pathname;
  const [user, setUser] = useState<User | null | undefined>(undefined),
    [error, setError] = useState(''),
    [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    apiClient<{ user: User }>('/me', { signal: controller.signal })
      .then((data) => setUser(data.user))
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) setUser(null);
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
        <p className="max-w-[420px] text-center" role="alert">
          {error}
        </p>
        <Button onClick={() => setReload((value) => value + 1)}>Try again</Button>
      </main>
    );
  if (user === undefined)
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-5 text-secondary-ink">
        <Brand />
        <Spinner className="size-5" />
        <span>Getting things ready…</span>
      </main>
    );
  return user ? (
    <SidebarProvider className="dashboard-workspace">
      <Dashboard key={user.id} user={user} onSignedOut={signedOut} onUserUpdated={setUser} />
    </SidebarProvider>
  ) : (
    <AuthScreen
      initialSignup={pathname === '/signup'}
      onModeChange={(signup) => {
        void navigate({ to: signup ? '/signup' : '/signin' });
      }}
      onSignedIn={(user) => {
        setUser(user);
        try {
          if (sessionStorage.getItem('ab-checkout-events')) {
            void navigate({ to: '/usage', replace: true });
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
}: {
  user: User;
  onSignedOut: () => void;
  onUserUpdated: (user: User) => void;
}) {
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const isUsage = useLocation({ select: (location) => location.pathname === '/usage' });
  const { setOpenMobile } = useSidebar();
  const [sites, setSites] = useState<Site[]>([]),
    [rememberedSite, setRememberedSite] = useState(''),
    [environmentIds, setEnvironmentIds] = useState<Record<string, string>>({});
  const selected = params.siteId ?? rememberedSite;
  const panel: Panel = isUsage ? 'usage' : isDashboardPage(params.page) ? params.page : 'overview';
  const usage = useAccountUsage(`${panel}:${sites.length}`);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [addOpen, setAddOpen] = useState(false),
    [accountOpen, setAccountOpen] = useState(false),
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
    if (!isUsage && (!params.siteId || !params.environmentId || !params.page)) {
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
    isUsage,
  ]);
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
  }, [user.id, selected, environment?.id]);
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
    setAccountOpen(false);
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
        Skip to content
      </a>
      <AccountSettings
        open={accountOpen}
        onOpenChange={setAccountOpen}
        user={user}
        onUpdated={onUserUpdated}
        onDeleted={accountDeleted}
      />
      <WorkspaceSidebar
        sites={sites}
        site={site}
        environment={environment}
        panel={panel}
        user={user}
        signingOut={signingOut}
        showSetup={!!environment && setupStatus[environment.id] === false}
        onSiteChange={(id) => go(id, environmentIds[id] ?? id, 'overview')}
        onEnvironmentChange={(id) => {
          if (site) go(site.id, id, panel === 'usage' ? 'overview' : panel);
        }}
        onAddSite={() => setAddOpen(true)}
        onAddEnvironment={() => setAddEnvironmentOpen(true)}
        onSignOut={signout}
        onAccountSettings={() => setAccountOpen(true)}
      />
      <SidebarInset className="min-h-dvh min-w-0 md:min-h-[calc(100dvh-1rem)]">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4 md:px-6">
          <SidebarTrigger
            className="size-8 rounded-md sm:size-8 [&_svg]:size-4"
            aria-label="Toggle navigation"
          />
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className="truncate text-secondary-ink">
              {isUsage ? 'Account' : (site?.name ?? 'Your workspace')}
            </span>
            <span aria-hidden="true" className="text-muted-foreground">
              /
            </span>
            <span className="shrink-0 font-medium">
              {isUsage
                ? 'Usage'
                : !site || panel === 'setup'
                  ? 'Setup'
                  : panel === 'settings'
                    ? 'Settings'
                    : panel === 'installation'
                      ? 'Install'
                      : panel === 'visitors'
                        ? 'Visitors'
                        : 'Overview'}
            </span>
          </div>
        </header>
        <div
          id="main-content"
          className="mx-auto w-full max-w-[960px] flex-1 px-4 pt-5 pb-4 md:px-6 md:pt-6 md:pb-5 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          tabIndex={-1}
        >
          {error && (
            <div
              className="mb-6 flex items-center justify-between gap-3 rounded-md bg-danger-wash px-4 py-3.5 text-sm text-danger max-md:flex-wrap"
              role="alert"
            >
              {error}
              <Button variant="outline" size="sm" onClick={loadSites}>
                Try again
              </Button>
            </div>
          )}
          {!isUsage && (usage.data?.paused || websiteUsage?.pauseReason === 'website_budget') && (
            <div
              className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-4 py-3 text-sm"
              role="status"
            >
              <span>
                Tracking paused ·{' '}
                {websiteUsage?.pauseReason === 'website_budget'
                  ? 'Website budget reached'
                  : usage.data?.pauseReason === 'event_limit'
                    ? 'Event limit reached'
                    : 'An active Pro plan is required'}
              </span>
              <Link to="/usage" className="underline underline-offset-4">
                View usage
              </Link>
            </div>
          )}
          <PageTransition
            view={loading ? 'loading' : `${environment?.id || selected || 'empty'}:${panel}`}
          >
            {loading ? (
              <div className="flex items-center gap-3 py-20 text-secondary-ink">
                <Spinner className="size-5" />
                <span>Loading your workspace…</span>
              </div>
            ) : isUsage ? (
              <Usage {...usage} />
            ) : params.siteId && (!site || !environment) ? (
              <div className="max-w-[440px] py-10">
                <h1 className="text-2xl font-medium">Website or environment unavailable</h1>
                <p className="mt-3 text-secondary-ink">
                  It may have been removed, or you may not have access to it.
                </p>
                <Link to="/dashboard" replace className="mt-5 inline-block underline">
                  Back to your websites
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
            ) : panel === 'settings' ? (
              <SiteSettings
                key={environment.id}
                site={site}
                environment={environment}
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
                key={environment.id}
                site={site}
                environment={environment}
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
}: {
  site: Site;
  environment: SiteEnvironment;
  onInstall: () => void;
  onExpired: () => void;
}) {
  const [days, setDays] = useState('30'),
    [metric, setMetric] = useState<Metric>('pageviews'),
    [reports, setReports] = useState<Reports | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [reload, setReload] = useState(0);
  const today = new Date().toISOString().slice(0, 10);
  const [customFrom, setCustomFrom] = useState(today),
    [customTo, setCustomTo] = useState(today);
  const from =
    days === 'custom'
      ? customFrom
      : new Date(Date.parse(today) - (Number(days) - 1) * 86400000).toISOString().slice(0, 10);
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
    const query = `from=${from}&to=${to}&environment=${environment.id}`;
    const endpoints = [
      'overview',
      'timeseries',
      'path',
      'referrer',
      'country',
      'device',
      'event',
    ] as const;
    Promise.all(
      endpoints.map(
        async (key) =>
          [
            key,
            await apiClient(
              `/sites/${site.id}/${key === 'overview' || key === 'timeseries' ? key : 'breakdown'}?${query}${key === 'overview' || key === 'timeseries' ? '' : `&dimension=${key}`}`,
              { signal: controller.signal },
            ),
          ] as const,
      ),
    )
      .then((results) => setReports(Object.fromEntries(results) as Reports))
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) onExpired();
        else setError(errorText(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [site.id, environment.id, from, to, reload, rangeValid, onExpired]);
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
      <div className="mb-7 flex flex-col items-stretch gap-5 md:flex-row md:items-center md:justify-between md:gap-6">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2.5">
            <h1 className="text-[23px] leading-[1.25] font-medium tracking-[-0.025em] wrap-anywhere md:text-[26px]">
              {environment.domain}
            </h1>
            <a
              className="shrink-0 p-2 text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
              href={`https://${environment.domain}`}
              target="_blank"
              rel="noreferrer"
              aria-label={`Visit ${environment.domain}`}
            >
              <ExternalLink size={15} />
            </a>
          </div>
          <p className="mt-1 text-sm text-secondary-ink">
            {site.name} · {environment.name}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 max-md:self-stretch">
          <div className="relative flex h-8 items-center gap-2 rounded-md border border-input px-3 text-secondary-ink max-md:flex-1">
            <CalendarDays size={16} />
            <select
              className="cursor-pointer appearance-none bg-transparent pr-2 text-[13px] text-foreground max-md:flex-1 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
              aria-label="Date range"
              value={days}
              onChange={(event) => setDays(event.target.value)}
            >
              <option className="bg-background" value="7">
                Last 7 days
              </option>
              <option className="bg-background" value="30">
                Last 30 days
              </option>
              <option className="bg-background" value="90">
                Last 90 days
              </option>
              <option className="bg-background" value="365">
                Last 365 days
              </option>
              <option className="bg-background" value="custom">
                Custom dates
              </option>
            </select>
            <ChevronDown size={13} />
          </div>
          <Button
            className="size-8 rounded-md sm:size-8"
            variant="outline"
            size="icon"
            aria-label="Refresh analytics"
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
            From
            <input
              className="min-w-0 rounded-md border border-input bg-background px-2.5 py-1 max-md:w-full max-md:text-[13px] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
              aria-label="From date"
              type="date"
              value={customFrom}
              onChange={(event) => setCustomFrom(event.target.value)}
              max={customTo || today}
            />
          </label>
          <span className="pb-2 text-[13px] text-muted-foreground">to</span>
          <label className="flex flex-col gap-1.5 text-[13px] text-secondary-ink max-md:min-w-0 max-md:flex-1">
            To
            <input
              className="min-w-0 rounded-md border border-input bg-background px-2.5 py-1 max-md:w-full max-md:text-[13px] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
              aria-label="To date"
              type="date"
              value={customTo}
              onChange={(event) => setCustomTo(event.target.value)}
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
            Collection is paused. Your existing analytics are still here.
          </span>
        </div>
      )}
      {!loading &&
        reports &&
        reports.overview.pageviews === 0 &&
        reports.overview.customEvents === 0 && (
          <div className="mb-6 flex items-center gap-3 rounded-md bg-muted px-4 py-3.5 text-sm max-md:flex-wrap">
            <Code2 size={18} />
            <span className="flex-1 max-md:basis-[calc(100%-36px)]">
              Install your script to start collecting pageviews.
            </span>
            <Button variant="ghost" size="sm" onClick={onInstall}>
              Get your script
              <ArrowRight size={14} />
            </Button>
          </div>
        )}
      {error && (
        <div
          className="mb-6 flex items-center justify-between gap-3 rounded-md bg-danger-wash px-4 py-3.5 text-sm text-danger max-md:flex-wrap"
          role="alert"
        >
          {error}
          {rangeValid && (
            <Button variant="outline" size="sm" onClick={() => setReload((value) => value + 1)}>
              Try again
            </Button>
          )}
        </div>
      )}
      <section className="w-full" aria-label="Traffic overview">
        <div className="grid grid-cols-3 gap-1 md:gap-4">
          {metrics.map((item) => (
            <button
              key={item.key}
              className="relative cursor-pointer border-b-2 border-transparent px-2.5 py-2 text-left hover:bg-muted aria-pressed:border-foreground md:px-3 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
              title={item.caption}
              onClick={() => setMetric(item.key)}
              aria-pressed={metric === item.key}
            >
              <span className="text-xs text-secondary-ink md:text-sm">{item.name}</span>
              <strong className="my-1 block text-[22px] leading-[1.2] font-medium tracking-[-0.025em] tabular-nums md:text-[24px]">
                {loading ? (
                  <span className="block h-[38px] w-[72px] rounded-sm bg-pressed" />
                ) : reports ? (
                  number(reports.overview[item.key])
                ) : (
                  '-'
                )}
              </strong>
            </button>
          ))}
        </div>
        <div className="flex justify-between gap-4 pt-4 text-xs text-secondary-ink md:pt-4">
          <span>{metrics.find((item) => item.key === metric)?.name}</span>
          <span>
            {from && to ? `${dateLabel(from)} - ${dateLabel(to)}` : ''}
            <span className="ml-2 text-muted-foreground">UTC</span>
          </span>
        </div>
        {loading ? (
          <div
            className="flex h-[204px] flex-col items-center justify-center gap-3 text-[13px] text-secondary-ink"
            role="status"
          >
            <Spinner className="size-5" />
            <span>Loading analytics…</span>
          </div>
        ) : reports ? (
          <TrafficChart data={reports.timeseries.data} metric={metric} />
        ) : (
          <div className="flex h-[204px] flex-col items-center justify-center gap-3 text-[13px] text-secondary-ink">
            No report to display.
          </div>
        )}
      </section>

      {(!reports || reports.overview.pageviews > 0) && (
        <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2 md:gap-x-8 md:gap-y-6">
          <BreakdownCard title="Top pages" label="Page" report={reports?.path} loading={loading} />
          <BreakdownCard
            title="Referrers"
            label="Source"
            report={reports?.referrer}
            loading={loading}
          />
          <BreakdownCard
            title="Countries"
            label="Country"
            report={reports?.country}
            loading={loading}
            countries
          />
          <BreakdownCard
            title="Devices"
            label="Device"
            report={reports?.device}
            loading={loading}
          />
        </div>
      )}
      <section className="mt-9 flex flex-col items-start gap-3">
        <div>
          <h2 className="text-[17px] leading-[1.4] font-medium tracking-[-0.025em]">
            Tracked actions
          </h2>
        </div>
        {reports?.event.data.length ? (
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            {reports.event.data.map((item) => (
              <span className="flex gap-6 py-2 text-sm" key={item.value}>
                {item.value}
                <strong className="font-medium tabular-nums">{number(item.count)}</strong>
              </span>
            ))}
          </div>
        ) : (
          <Button variant="outline" onClick={onInstall}>
            Set up an event
            <ArrowRight size={15} />
          </Button>
        )}
      </section>
    </div>
  );
}

function BreakdownCard({
  title,
  label,
  report,
  loading,
  countries = false,
}: {
  title: string;
  label: string;
  report?: Breakdown;
  loading: boolean;
  countries?: boolean;
}) {
  const max = Math.max(1, ...(report?.data.map((item) => item.count) ?? []));
  return (
    <section className="min-w-0">
      <div>
        <h2 className="text-[17px] leading-[1.4] font-medium tracking-[-0.025em]">{title}</h2>
      </div>
      <div className="mt-3.5 mb-2 flex justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span>Pageviews</span>
      </div>
      {loading ? (
        <div className="flex flex-col gap-2 pt-1" role="status" aria-label={`Loading ${title}`}>
          {[1, 2, 3].map((value) => (
            <i className="h-8 rounded-sm bg-muted" key={value} />
          ))}
        </div>
      ) : !report?.data.length ? (
        <div className="min-h-[100px] py-6 text-[13px] text-muted-foreground">
          No {label.toLowerCase()} data in this period.
        </div>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-1 p-0">
          {report.data.map((item) => {
            const text = item.value
              ? countries
                ? (countryName(item.value) ?? 'Unknown location')
                : item.value
              : countries
                ? 'Unknown'
                : 'Direct / none';
            return (
              <li
                className="relative flex min-h-10 items-center justify-between gap-4 px-2.5 py-[7px] text-sm md:min-h-9"
                key={item.value}
              >
                <span
                  className="absolute inset-y-0 left-0 rounded-sm bg-muted"
                  style={{ width: `${(item.count / max) * 78}%` }}
                />
                <span
                  title={text}
                  className={`relative truncate ${label === 'Device' ? 'capitalize' : ''}`}
                >
                  {countries ? <CountryLabel code={item.value} /> : text}
                </span>
                <strong className="relative text-[13px] font-normal tabular-nums">
                  {number(item.count)}
                </strong>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

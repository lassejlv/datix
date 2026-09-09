import { featureDefinitions, featureSettings } from '../lib/features';
import type { Locale } from '../lib/i18n/preferences';
import { useSitePreferences } from './site-preferences';
import { AccountMenu } from './account-menu';
import { Link } from '@tanstack/react-router';
import {
  Globe2,
  CircleCheck,
  Sparkles,
  BarChart3,
  Footprints,
  Code2,
  FileText,
  Settings2,
  Activity,
  X,
} from './ui/icons';
import { WorkspaceSwitcher } from './workspace-switcher';
import { Brand } from './brand';
import { Button } from './ui/button';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from './ui/sidebar';
import { siteRoute, type DashboardPage } from '../lib/dashboard-route';
import type { Site, SiteEnvironment, User } from '../lib/client';

export function WorkspaceSidebar({
  sites,
  site,
  environment,
  panel,
  user,
  signingOut,
  showSetup,
  onSiteChange,
  onEnvironmentChange,
  onAddSite,
  onAddEnvironment,
  onSignOut,
  onAccountSettings,
}: {
  sites: Site[];
  site?: Site;
  environment?: SiteEnvironment;
  panel: DashboardPage | 'usage';
  user: User;
  signingOut: boolean;
  showSetup: boolean;
  onSiteChange: (id: string) => void;
  onEnvironmentChange: (id: string) => void;
  onAddSite: () => void;
  onAddEnvironment: () => void;
  onSignOut: () => void;
  onAccountSettings: () => void;
}) {
  const { t, locale, setLocale } = useSitePreferences();
  const { setOpenMobile } = useSidebar();
  const action = (callback: () => void) => {
    setOpenMobile(false);
    callback();
  };
  return (
    <Sidebar variant="inset" aria-label={t('Main navigation')} className="border-sidebar-border">
      <SidebarHeader className="gap-0 px-5 pt-4 pb-3">
        <div className="flex min-h-8 items-center justify-between gap-2">
          <Brand />
          <Button
            className="md:hidden"
            aria-label={t('Close navigation')}
            variant="ghost"
            size="icon"
            onClick={() => setOpenMobile(false)}
          >
            <X size={18} />
          </Button>
        </div>
      </SidebarHeader>
      <SidebarContent className="gap-5 px-3 pt-3">
        <div className="flex flex-col">
          <WorkspaceSwitcher
            kind="website"
            items={sites.map((item) => ({
              id: item.id,
              name: item.name,
              description: item.domain,
            }))}
            selectedId={site?.id}
            onChange={onSiteChange}
            onAdd={() => action(onAddSite)}
          />
          {site && environment && (
            <WorkspaceSwitcher
              key={site.id}
              kind="environment"
              items={site.environments.map((item) => ({ id: item.id, name: item.name }))}
              selectedId={environment.id}
              onChange={onEnvironmentChange}
              onAdd={() => action(onAddEnvironment)}
            />
          )}
        </div>
        <nav aria-label={t('Workspace pages')}>
          <SidebarMenu>
            {(
              [
                { page: 'setup', label: 'Setup', icon: Sparkles },
                { page: 'overview', label: 'Overview', icon: BarChart3 },
                { page: 'visitors', label: 'Visitors', icon: Footprints },
                ...featureDefinitions
                  .filter((feature) => featureSettings(environment?.featureSettings)[feature.key])
                  .map((feature) => ({
                    page: feature.page,
                    label: feature.label,
                    icon:
                      feature.key === 'geography'
                        ? Globe2
                        : feature.key === 'goals'
                          ? CircleCheck
                          : Activity,
                  })),
                { page: 'installation', label: 'Install', icon: Code2 },
                { page: 'imports', label: 'Imports', icon: FileText },
                { page: 'settings', label: 'Settings', icon: Settings2 },
              ] as const
            )
              .filter((item) => item.page !== 'setup' || showSetup)
              .map((item) => (
                <SidebarMenuItem key={item.page}>
                  <SidebarMenuButton
                    className="h-11 gap-3 px-3 text-secondary-ink md:h-8"
                    isActive={panel === item.page && !!site && !!environment}
                    aria-current={panel === item.page && site && environment ? 'page' : undefined}
                    disabled={!site || !environment}
                    render={
                      site && environment ? (
                        <Link
                          to={siteRoute}
                          params={{
                            siteId: site.id,
                            environmentId: environment.id,
                            page: item.page,
                          }}
                          disabled={!site || !environment}
                          onClick={() => setOpenMobile(false)}
                        />
                      ) : undefined
                    }
                  >
                    <item.icon />
                    <span>{t(item.label)}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            <SidebarMenuItem>
              <SidebarMenuButton
                className="h-11 gap-3 px-3 text-secondary-ink md:h-8"
                isActive={panel === 'usage'}
                aria-current={panel === 'usage' ? 'page' : undefined}
                render={<Link to="/usage" onClick={() => setOpenMobile(false)} />}
              >
                <Activity />
                <span>{t('Usage')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </nav>
      </SidebarContent>
      <SidebarFooter className="px-2 py-2">
        <label className="mx-1 flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm text-secondary-ink hover:bg-accent focus-within:ring-2 focus-within:ring-ring">
          <Globe2 size={16} aria-hidden="true" />
          <span className="sr-only">{t('Language')}</span>
          <select
            data-testid="dashboard-language"
            className="min-w-0 flex-1 cursor-pointer bg-transparent py-2 text-inherit outline-none"
            value={locale}
            onChange={(event) => setLocale(event.target.value as Locale)}
          >
            <option value="en">English</option>
            <option value="da">Dansk</option>
            <option value="de">Deutsch</option>
          </select>
        </label>
        <AccountMenu
          user={user}
          signingOut={signingOut}
          onSettings={() => action(onAccountSettings)}
          onSignOut={onSignOut}
        />
      </SidebarFooter>
    </Sidebar>
  );
}

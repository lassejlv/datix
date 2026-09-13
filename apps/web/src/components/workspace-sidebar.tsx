import { useId } from 'react';
import { SelectionIndicator } from './ui/selection-indicator';
import { featureDefinitions, featureSettings } from '../lib/features';
import { useSitePreferences } from './site-preferences';
import { AccountMenu } from './account-menu';
import { Link } from '@tanstack/react-router';
import {
  CircleCheck,
  Sparkles,
  BarChart3,
  Footprints,
  Code2,
  Settings2,
  Warning,
  Gauge,
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
  isAccount,
  user,
  signingOut,
  showSetup,
  onSelect,
  onAddSite,
  onAddEnvironment,
  onSignOut,
  onAccountSettings,
  onAdministration,
}: {
  sites: Site[];
  site?: Site;
  environment?: SiteEnvironment;
  panel: DashboardPage;
  isAccount: boolean;
  user: User;
  signingOut: boolean;
  showSetup: boolean;
  onSelect: (siteId: string, environmentId: string) => void;
  onAddSite: () => void;
  onAddEnvironment: () => void;
  onSignOut: () => void;
  onAccountSettings: () => void;
  onAdministration: () => void;
}) {
  const { t } = useSitePreferences();
  const indicatorId = useId();
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
            sites={sites}
            siteId={site?.id}
            environmentId={environment?.id}
            onSelect={onSelect}
            onAddSite={() => action(onAddSite)}
            onAddEnvironment={() => action(onAddEnvironment)}
          />
        </div>
        <nav className="isolate" aria-label={t('Workspace pages')}>
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
                      feature.key === 'goals'
                        ? CircleCheck
                        : feature.key === 'errors'
                          ? Warning
                          : Gauge,
                  })),
                { page: 'installation', label: 'Install', icon: Code2 },
                { page: 'settings', label: 'Settings', icon: Settings2 },
              ] as const
            )
              .filter((item) => item.page !== 'setup' || showSetup)
              .map((item) => (
                <SidebarMenuItem key={item.page}>
                  <SidebarMenuButton
                    className="relative h-11 overflow-visible gap-3 px-3 text-secondary-ink data-[active=true]:bg-transparent md:h-8"
                    isActive={!isAccount && panel === item.page && !!site && !!environment}
                    aria-current={
                      !isAccount && panel === item.page && site && environment ? 'page' : undefined
                    }
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
                    {!isAccount && panel === item.page && site && environment && (
                      <SelectionIndicator id={indicatorId} className="kit-navigation-indicator" />
                    )}
                    <item.icon />
                    <span>{t(item.label)}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
          </SidebarMenu>
        </nav>
      </SidebarContent>
      <SidebarFooter className="px-2 py-2">
        <AccountMenu
          user={user}
          signingOut={signingOut}
          onSettings={() => action(onAccountSettings)}
          onAdmin={() => action(onAdministration)}
          onSignOut={onSignOut}
        />
      </SidebarFooter>
    </Sidebar>
  );
}

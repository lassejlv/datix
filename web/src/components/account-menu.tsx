import { useSitePreferences } from './site-preferences';
import { useRef } from 'react';
import { Menu } from '@base-ui/react/menu';
import { ChevronDown, LogOut, Settings2 } from './ui/icons';
import type { User } from '../lib/client';

export function AccountMenu({
  user,
  signingOut,
  onSettings,
  onSignOut,
}: {
  user: User;
  signingOut: boolean;
  onSettings: () => void;
  onSignOut: () => void;
}) {
  const { t } = useSitePreferences();
  const openingSettings = useRef(false);
  const itemClass =
    'flex h-10 cursor-pointer items-center gap-2 rounded-sm px-2 text-sm outline-none data-highlighted:bg-muted data-disabled:opacity-50 sm:h-8';
  return (
    <Menu.Root
      onOpenChange={(open) => {
        if (open) openingSettings.current = false;
      }}
    >
      <Menu.Trigger
        aria-label={t('Account menu')}
        data-testid="account-menu"
        disabled={signingOut}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md p-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{user.name}</span>
          <span className="mt-0.5 block break-all text-xs leading-4 text-secondary-ink">
            {user.email}
          </span>
        </span>
        <ChevronDown className="size-3 shrink-0 text-secondary-ink" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start" sideOffset={6} className="z-50">
          <Menu.Popup
            aria-label={t('Account')}
            finalFocus={() => !openingSettings.current}
            className="w-(--anchor-width) min-w-44 rounded-md border border-border bg-popover p-1 text-foreground shadow-lg/5 outline-none"
          >
            <Menu.Item
              className={itemClass}
              onClick={() => {
                openingSettings.current = true;
                onSettings();
              }}
            >
              <Settings2 className="size-4" />
              {t('Account settings')}
            </Menu.Item>
            <Menu.Item className={itemClass} disabled={signingOut} onClick={onSignOut}>
              <LogOut className="size-4" />
              {t('Sign out')}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

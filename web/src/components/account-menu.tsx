import { useSitePreferences } from './site-preferences';
import { useRef } from 'react';
import { Menu } from '@base-ui/react/menu';
import { ChevronDown, LogOut, Settings2, Monitor, Sun, Moon } from './ui/icons';
import type { Theme } from '../lib/i18n/preferences';
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
  const { t, theme, setTheme } = useSitePreferences();
  const openingSettings = useRef(false);
  const itemClass =
    'flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm outline-none data-highlighted:bg-pressed data-disabled:opacity-40';
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
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg p-2 text-left outline-none transition-colors duration-200 ease-[cubic-bezier(0.19,1,0.22,1)] hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ring disabled:opacity-36"
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
            className="w-60 max-w-[calc(100vw-24px)] origin-(--transform-origin) rounded-xl bg-popover p-2.5 text-foreground shadow-[var(--menu-shadow)] outline-none transition-[scale,opacity] duration-150 ease-[cubic-bezier(0.19,1,0.22,1)] data-starting-style:scale-98 data-starting-style:opacity-0 data-ending-style:scale-98 data-ending-style:opacity-0 motion-reduce:transition-none"
          >
            <div className="px-1.5 pb-3">
              <p className="truncate text-sm font-medium">{user.name}</p>
              <p className="mt-0.5 truncate text-xs text-secondary-ink">{user.email}</p>
            </div>
            <Menu.RadioGroup
              value={theme}
              onValueChange={(value) => setTheme(value as Theme)}
              aria-label={t('Theme')}
              className="kit-theme-picker"
            >
              {(
                [
                  { value: 'system', label: 'System', icon: Monitor },
                  { value: 'light', label: 'Light', icon: Sun },
                  { value: 'dark', label: 'Dark', icon: Moon },
                ] as const
              ).map((item) => (
                <Menu.RadioItem
                  key={item.value}
                  value={item.value}
                  closeOnClick={false}
                  aria-label={t(item.label)}
                  className="kit-theme-option"
                >
                  <item.icon className="size-4" />
                  <span>{t(item.label)}</span>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
            <Menu.Separator className="my-2 h-px bg-line" />
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

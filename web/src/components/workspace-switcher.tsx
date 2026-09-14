import { Hint, HintText } from './ui/tooltip';
import { useSitePreferences } from './site-preferences';
import { useState } from 'react';
import { ChevronDown, Search, Plus } from './ui/icons';
import {
  Combobox,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from './ui/combobox';
import type { Site } from '../lib/client';

/** One row of the switcher: an environment, carrying the website it belongs to. */
type Choice = {
  id: string;
  siteId: string;
  siteName: string;
  domain: string;
  environmentId: string;
  environmentName: string;
};

type Group = { siteId: string; name: string; domain: string; items: Choice[] };

export function WorkspaceSwitcher({
  sites,
  siteId,
  environmentId,
  onSelect,
  onAddSite,
  onAddEnvironment,
}: {
  sites: Site[];
  siteId?: string;
  environmentId?: string;
  onSelect: (siteId: string, environmentId: string) => void;
  onAddSite: () => void;
  onAddEnvironment: () => void;
}) {
  const { t } = useSitePreferences();
  const [open, setOpen] = useState(false);

  const groups: Group[] = sites.map((site) => ({
    siteId: site.id,
    name: site.name,
    domain: site.domain,
    items: site.environments.map((environment) => ({
      id: `${site.id}:${environment.id}`,
      siteId: site.id,
      siteName: site.name,
      domain: site.domain,
      environmentId: environment.id,
      environmentName: environment.name,
    })),
  }));

  const selected =
    groups
      .flatMap((group) => group.items)
      .find((item) => item.siteId === siteId && item.environmentId === environmentId) ?? null;

  const close = (add: () => void) => {
    setOpen(false);
    add();
  };

  return (
    <Combobox
      items={groups}
      value={selected}
      open={open}
      onOpenChange={setOpen}
      autoHighlight
      itemToStringLabel={(item: Choice) =>
        `${item.siteName} ${item.environmentName} ${item.domain}`
      }
      isItemEqualToValue={(a: Choice, b: Choice) => a.id === b.id}
      onValueChange={(item: Choice | null) => {
        if (item && item.id !== selected?.id) onSelect(item.siteId, item.environmentId);
      }}
    >
      <Hint
        content={
          selected
            ? `${selected.siteName} · ${selected.environmentName} · ${selected.domain}`
            : t('Choose a website')
        }
      >
        <ComboboxTrigger
          aria-label={t('Selected website')}
          data-value={siteId ?? ''}
          data-environment={environmentId ?? ''}
          className="group flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">
              {selected?.siteName ?? t('Choose a website')}
            </span>
            {selected && (
              <span className="block truncate text-xs text-secondary-ink">
                {selected.environmentName}
              </span>
            )}
          </span>
          <ChevronDown
            size={12}
            className="shrink-0 text-secondary-ink transition-transform duration-(--duration-fast) ease-smooth-out group-data-popup-open:rotate-180 motion-reduce:transition-none"
          />
        </ComboboxTrigger>
      </Hint>
      <ComboboxPopup className="w-(--anchor-width) overflow-hidden" sideOffset={6}>
        <div className="border-b border-line px-1.5 pt-0.5 pb-1.5">
          <ComboboxInput
            aria-label={t('Search websites')}
            placeholder={t('Find a website…')}
            showTrigger={false}
            startAddon={<Search size={16} />}
            className="w-full rounded-none border-0 bg-transparent has-focus-visible:border-transparent has-focus-visible:shadow-none"
          />
        </div>
        <ComboboxEmpty className="empty:hidden px-4 py-5 text-left text-sm text-secondary-ink">
          {t('No websites found.')}
        </ComboboxEmpty>
        <ComboboxList aria-label={t('Websites')}>
          {(group: Group) => (
            <ComboboxGroup key={group.siteId} items={group.items}>
              <ComboboxGroupLabel className="pt-2.5 pb-1">
                <HintText
                  tabIndex={-1}
                  content={group.domain}
                  className="block truncate text-xs font-medium text-foreground"
                >
                  {group.name}
                </HintText>
              </ComboboxGroupLabel>
              <ComboboxCollection>
                {(item: Choice) => (
                  <ComboboxItem
                    key={item.id}
                    value={item}
                    data-value={item.environmentId}
                    className="min-h-10 cursor-pointer sm:min-h-8 data-selected:bg-muted"
                  >
                    <HintText
                      tabIndex={-1}
                      content={item.environmentName}
                      className="block truncate text-sm"
                    >
                      {item.environmentName}
                    </HintText>
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
        <div className="flex flex-col gap-0.5 border-t border-border p-1">
          {[
            { label: t('Add a website'), run: onAddSite },
            ...(siteId ? [{ label: t('Add environment'), run: onAddEnvironment }] : []),
          ].map((action) => (
            <button
              key={action.label}
              type="button"
              className="flex h-10 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-sm text-secondary-ink hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring sm:h-8"
              onClick={() => close(action.run)}
            >
              <Plus size={14} />
              {action.label}
            </button>
          ))}
        </div>
      </ComboboxPopup>
    </Combobox>
  );
}

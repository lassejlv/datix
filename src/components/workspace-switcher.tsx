import { useState } from 'react';
import { ChevronDown, Search, Plus } from './ui/icons';
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from './ui/combobox';

type Option = { id: string; name: string; description?: string };

export function WorkspaceSwitcher({
  kind,
  items,
  selectedId,
  onChange,
  onAdd,
}: {
  kind: 'website' | 'environment';
  items: Option[];
  selectedId?: string;
  onChange: (id: string) => void;
  onAdd: () => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const website = kind === 'website';
  return (
    <Combobox
      items={items}
      value={selected}
      open={open}
      onOpenChange={setOpen}
      autoHighlight
      itemToStringLabel={(item) => `${item.name} ${item.description ?? ''}`}
      isItemEqualToValue={(a, b) => a.id === b.id}
      onValueChange={(item) => {
        if (item && item.id !== selectedId) onChange(item.id);
      }}
    >
      <ComboboxTrigger
        aria-label={`Selected ${kind}`}
        data-value={selectedId ?? ''}
        title={website ? selected?.description : undefined}
        className={`group flex h-10 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-3 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default sm:h-8 ${website ? 'text-sm font-medium' : 'text-xs text-secondary-ink'}`}
      >
        <span className="min-w-0 flex-1 truncate">
          {selected?.name ?? (website ? 'Choose a website' : 'Choose an environment')}
        </span>
        <ChevronDown
          size={12}
          className="shrink-0 text-secondary-ink transition-transform duration-150 group-data-popup-open:rotate-180 motion-reduce:transition-none"
        />
      </ComboboxTrigger>
      <ComboboxPopup
        className="w-(--anchor-width) overflow-hidden border-border shadow-lg/5"
        sideOffset={6}
      >
        <div className="p-2">
          <ComboboxInput
            aria-label={`Search ${website ? 'websites' : 'environments'}`}
            placeholder={`Find ${website ? 'a website' : 'an environment'}…`}
            showTrigger={false}
            startAddon={<Search size={16} />}
            className="w-full rounded-md has-focus-visible:ring-0 has-focus-visible:border-ring"
          />
        </div>
        <ComboboxEmpty className="empty:hidden px-4 py-5 text-left text-sm text-secondary-ink">
          No {website ? 'websites' : 'environments'} found.
        </ComboboxEmpty>
        <ComboboxList aria-label={website ? 'Websites' : 'Environments'}>
          {(item: Option) => (
            <ComboboxItem
              key={item.id}
              value={item}
              data-value={item.id}
              className="min-h-10 cursor-pointer px-2 py-1 sm:min-h-8 data-selected:bg-muted"
            >
              <span title={item.name} className="block truncate text-sm">
                {item.name}
              </span>
              {item.description && (
                <span
                  title={item.description}
                  className="mt-0.5 block truncate text-xs text-secondary-ink"
                >
                  {item.description}
                </span>
              )}
            </ComboboxItem>
          )}
        </ComboboxList>
        <div className="border-t border-border p-1">
          <button
            type="button"
            className="flex h-10 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-sm text-secondary-ink hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring sm:h-8"
            onClick={() => {
              setOpen(false);
              onAdd();
            }}
          >
            <Plus size={14} />
            {website ? 'Add a website' : 'Add environment'}
          </button>
        </div>
      </ComboboxPopup>
    </Combobox>
  );
}

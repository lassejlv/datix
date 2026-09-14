import { useId, useRef } from 'react';
import { SelectionIndicator } from './selection-indicator';

export function Tabs<Value extends string>({
  id,
  label,
  value,
  items,
  onValueChange,
}: {
  id: string;
  label: string;
  value: Value;
  items: readonly { value: Value; label: string }[];
  onValueChange: (value: Value) => void;
}) {
  const indicatorId = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  return (
    <div role="tablist" aria-label={label} className="kit-tabs">
      {items.map((item, index) => (
        <button
          key={item.value}
          ref={(node) => {
            buttons.current[index] = node;
          }}
          type="button"
          role="tab"
          id={`${id}-tab-${item.value}`}
          aria-selected={value === item.value}
          aria-controls={`${id}-panel`}
          tabIndex={value === item.value ? 0 : -1}
          onClick={() => onValueChange(item.value)}
          onKeyDown={(event) => {
            const next =
              event.key === 'ArrowRight'
                ? (index + 1) % items.length
                : event.key === 'ArrowLeft'
                  ? (index + items.length - 1) % items.length
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? items.length - 1
                      : -1;

            if (next < 0) return;
            event.preventDefault();
            onValueChange(items[next].value);
            buttons.current[next]?.focus();
            buttons.current[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          }}
        >
          {item.label}
          {value === item.value && (
            <SelectionIndicator id={indicatorId} className="kit-tab-indicator" />
          )}
        </button>
      ))}
    </div>
  );
}

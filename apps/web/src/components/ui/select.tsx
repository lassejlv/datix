import { Select as Primitive } from '@base-ui/react/select';
import { Children, isValidElement, type ReactNode, type ComponentProps } from 'react';
import { Check, ChevronDown } from './icons';
import { cn } from '@/lib/utils';

type Option = { value: string; label: ReactNode; disabled?: boolean };
type Props = Omit<
  ComponentProps<'select'>,
  'onChange' | 'value' | 'defaultValue' | 'multiple' | 'size' | 'ref'
> & {
  value?: string | number;
  defaultValue?: string | number;
  onValueChange?: (value: string) => void;
  popupClassName?: string;
  'data-testid'?: string;
};

// Option children keep translated labels and form values together at the call site.
export function Select({
  children,
  value,
  defaultValue,
  onValueChange,
  name,
  disabled,
  required,
  className,
  popupClassName,
  id,
  ...props
}: Props) {
  const items: Option[] = [];
  Children.forEach(children, (child) => {
    if (
      isValidElement<{ value: string | number; children: ReactNode; disabled?: boolean }>(child)
    ) {
      items.push({
        value: String(child.props.value),
        label: child.props.children,
        disabled: child.props.disabled,
      });
    }
  });
  return (
    <Primitive.Root
      items={items}
      value={value === undefined ? undefined : String(value)}
      defaultValue={defaultValue === undefined ? undefined : String(defaultValue)}
      onValueChange={(next) => {
        if (next !== null) onValueChange?.(next);
      }}
      name={name}
      disabled={disabled}
      required={required}
    >
      <Primitive.Trigger
        id={id}
        data-slot="select-trigger"
        data-testid={props['data-testid']}
        className={cn('kit-select-trigger', className)}
        aria-label={props['aria-label']}
        aria-labelledby={props['aria-labelledby']}
        aria-describedby={props['aria-describedby']}
      >
        <Primitive.Value className="min-w-0 truncate" />
        <Primitive.Icon className="ml-auto shrink-0 text-secondary-ink">
          <ChevronDown className="size-3.5" />
        </Primitive.Icon>
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Positioner
          sideOffset={4}
          align="start"
          alignItemWithTrigger={false}
          className="z-[70] max-w-[calc(100vw-24px)] outline-none"
        >
          <Primitive.Popup className={cn('kit-select-popup', popupClassName)}>
            <Primitive.List
              data-slot="select-list"
              className="max-h-[min(320px,var(--available-height))] overflow-y-auto p-1.5"
            >
              {items.map((item) => (
                <Primitive.Item
                  key={item.value}
                  value={item.value}
                  disabled={item.disabled}
                  className="kit-select-option"
                >
                  <span
                    data-slot="select-item-indicator"
                    className="flex w-4 shrink-0 items-center"
                  >
                    <Primitive.ItemIndicator>
                      <Check className="size-4" />
                    </Primitive.ItemIndicator>
                  </span>
                  <Primitive.ItemText className="min-w-0">{item.label}</Primitive.ItemText>
                </Primitive.Item>
              ))}
            </Primitive.List>
          </Primitive.Popup>
        </Primitive.Positioner>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

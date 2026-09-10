import { Popover } from '@base-ui/react/popover';
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CalendarDays, ArrowLeft, ArrowRight } from './icons';
import { Button } from './button';
import { useSitePreferences } from '../site-preferences';

const dayMs = 86_400_000;
const iso = (date: Date) => date.toISOString().slice(0, 10);
const parse = (value: string) => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) ? date : new Date();
};

// Paper board 08: 12 px calendar type, 34 px day columns, 12 px popup radius.
export function DatePicker({
  value,
  onValueChange,
  min,
  max,
  label,
}: {
  value: string;
  onValueChange: (value: string) => void;
  min?: string;
  max?: string;
  label: string;
}) {
  const { t, locale, dateLabel } = useSitePreferences();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => iso(parse(value)).slice(0, 7));
  const [focused, setFocused] = useState(() => iso(parse(value)));
  const days = useRef(new Map<string, HTMLButtonElement>());
  const moveFocus = useRef(false);
  const first = parse(`${month}-01`);
  const start = first.getTime() - first.getUTCDay() * dayMs;
  const heading = first.toLocaleDateString(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const enabled = (date: string) => (!min || date >= min) && (!max || date <= max);
  const clamp = (date: string) => (min && date < min ? min : max && date > max ? max : date);
  useLayoutEffect(() => {
    if (moveFocus.current) {
      days.current.get(focused)?.focus();
      moveFocus.current = false;
    }
  }, [focused, month]);
  function monthDate(delta: number) {
    return iso(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + delta, 1)));
  }
  function navigateMonth(delta: number) {
    const next = monthDate(delta);
    setMonth(next.slice(0, 7));
    setFocused(clamp(next));
  }
  function keyboard(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    const current = parse(date);
    const delta =
      event.key === 'ArrowLeft'
        ? -1
        : event.key === 'ArrowRight'
          ? 1
          : event.key === 'ArrowUp'
            ? -7
            : event.key === 'ArrowDown'
              ? 7
              : event.key === 'Home'
                ? -current.getUTCDay()
                : event.key === 'End'
                  ? 6 - current.getUTCDay()
                  : null;
    let next: string;
    if (delta !== null) next = iso(new Date(current.getTime() + delta * dayMs));
    else if (event.key === 'PageUp' || event.key === 'PageDown') {
      const offset = event.key === 'PageUp' ? -1 : 1;
      const lastDay = new Date(
        Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + offset + 1, 0),
      ).getUTCDate();
      next = iso(
        new Date(
          Date.UTC(
            current.getUTCFullYear(),
            current.getUTCMonth() + offset,
            Math.min(current.getUTCDate(), lastDay),
          ),
        ),
      );
    } else return;
    event.preventDefault();
    next = clamp(next);
    moveFocus.current = true;
    setFocused(next);
    setMonth(next.slice(0, 7));
  }
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next) {
          const date = clamp(iso(parse(value)));
          setMonth(date.slice(0, 7));
          setFocused(date);
        }
        setOpen(next);
      }}
    >
      <Popover.Trigger
        aria-label={label}
        data-value={value}
        render={<Button variant="outline" className="w-full justify-between font-normal" />}
      >
        <span className="truncate">
          {dateLabel(iso(parse(value)), { day: 'numeric', month: 'short', year: 'numeric' })}
        </span>
        <CalendarDays className="size-4 text-secondary-ink" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="end" className="z-[70]">
          <Popover.Popup
            className="kit-calendar"
            aria-label={label}
            initialFocus={() => days.current.get(focused) ?? true}
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('Previous month')}
                disabled={!!min && monthDate(0).slice(0, 7) <= min.slice(0, 7)}
                onClick={() => navigateMonth(-1)}
              >
                <ArrowLeft />
              </Button>
              <Popover.Title className="text-sm font-medium capitalize" aria-live="polite">
                {heading}
              </Popover.Title>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('Next month')}
                disabled={!!max && monthDate(1).slice(0, 7) > max.slice(0, 7)}
                onClick={() => navigateMonth(1)}
              >
                <ArrowRight />
              </Button>
            </div>
            <table
              role="grid"
              aria-label={heading}
              className="w-full table-fixed border-collapse text-center"
            >
              <thead>
                <tr>
                  {Array.from({ length: 7 }, (_, i) => (
                    <th key={i} scope="col" className="pb-2 text-xs font-normal text-secondary-ink">
                      {new Date(Date.UTC(2026, 0, 4 + i)).toLocaleDateString(locale, {
                        weekday: 'short',
                        timeZone: 'UTC',
                      })}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 6 }, (_, week) => (
                  <tr key={week}>
                    {Array.from({ length: 7 }, (_, weekday) => {
                      const date = new Date(start + (week * 7 + weekday) * dayMs);
                      const key = iso(date);
                      const outside = key.slice(0, 7) !== month;
                      return (
                        <td key={key} aria-selected={key === value} className="p-0">
                          <button
                            type="button"
                            ref={(node) => {
                              if (node) days.current.set(key, node);
                              else days.current.delete(key);
                            }}
                            aria-label={dateLabel(key, {
                              weekday: 'long',
                              day: 'numeric',
                              month: 'long',
                              year: 'numeric',
                            })}
                            aria-current={key === iso(new Date()) ? 'date' : undefined}
                            data-selected={key === value || undefined}
                            data-outside={outside || undefined}
                            disabled={!enabled(key)}
                            tabIndex={key === focused ? 0 : -1}
                            className="kit-calendar-day"
                            onKeyDown={(event) => keyboard(event, key)}
                            onFocus={() => setFocused(key)}
                            onClick={() => {
                              onValueChange(key);
                              setOpen(false);
                            }}
                          >
                            {date.getUTCDate()}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

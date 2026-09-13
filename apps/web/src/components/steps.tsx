import type { ReactNode } from 'react';
import { Check } from './ui/icons';

/**
 * A numbered guide. Steps share one rail so the install and onboarding pages read
 * as a sequence rather than as separate blocks.
 */
export function StepList({ children }: { children: ReactNode }) {
  return <ol className="m-0 list-none p-0">{children}</ol>;
}

export function Step({
  index,
  title,
  description,
  done = false,
  children,
}: {
  index: number;
  title: string;
  description?: ReactNode;
  done?: boolean;
  children?: ReactNode;
}) {
  return (
    <li className="group/step relative grid grid-cols-[28px_minmax(0,1fr)] gap-x-3.5 pb-7 last:pb-0 md:gap-x-4">
      <span
        aria-hidden="true"
        className="absolute top-8 bottom-1 left-[13.5px] w-px bg-line group-last/step:hidden"
      />
      <span
        aria-hidden="true"
        className={`z-1 grid size-7 place-items-center rounded-full border text-[13px] tabular-nums ${
          done
            ? 'border-success/40 bg-background text-success'
            : 'border-line bg-background text-secondary-ink'
        }`}
      >
        {done ? <Check size={15} /> : index}
      </span>
      <div className="min-w-0 pt-0.5">
        <h2 className="text-[15px] leading-[1.4] font-medium tracking-[-0.02em]">{title}</h2>
        {description && (
          <p className="mt-1 text-sm leading-[1.6] text-secondary-ink wrap-anywhere">
            {description}
          </p>
        )}
        {children && <div className="mt-3.5">{children}</div>}
      </div>
    </li>
  );
}

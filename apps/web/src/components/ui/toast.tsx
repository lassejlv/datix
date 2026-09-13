import { Toaster, toast as sonnerToast } from 'sonner';
import type { CSSProperties, ReactNode } from 'react';
import { Check, X } from './icons';
import { useSitePreferences } from '../site-preferences';

export const toast = {
  success: (title: string) => sonnerToast.success(title),
  error: (title: string) => {
    // Sonner has no priority API: visibility is purely positional
    // (index + 1 <= visibleToasts), so a later burst of toasts could bury
    // this 8s error behind data-visible="false". Clear the stack first so
    // the error always lands front/visible (restores old priority-high
    // behavior). Fresh auto id: a fixed id would merge into / race the
    // just-dismissed entry instead of prepending.
    sonnerToast.dismiss();
    return sonnerToast.error(title, { duration: 8000 });
  },
  info: (title: string) => sonnerToast.info(title),
};

function ToastBadge({ children }: { children: ReactNode }) {
  return (
    <span
      className="grid size-4 place-items-center rounded-full border text-[11px]"
      aria-hidden="true"
    >
      {children}
    </span>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t, theme } = useSitePreferences();
  return (
    <>
      {children}
      <Toaster
        position="bottom-right"
        theme={theme}
        duration={5000}
        visibleToasts={3}
        gap={8}
        offset={{
          bottom: 'max(24px, env(safe-area-inset-bottom))',
          right: 'max(24px, env(safe-area-inset-right))',
        }}
        mobileOffset={{
          bottom: 'max(16px, env(safe-area-inset-bottom))',
          right: '16px',
        }}
        closeButton
        icons={{
          success: <Check className="size-4 text-success" />,
          error: <ToastBadge>!</ToastBadge>,
          info: <ToastBadge>i</ToastBadge>,
          close: <X className="size-3.5" />,
        }}
        toastOptions={{
          unstyled: true,
          className: 'kit-toast',
          classNames: { closeButton: 'kit-toast-close' },
          closeButtonAriaLabel: t('Dismiss notification'),
        }}
        style={{ '--width': 'min(360px, calc(100vw - 32px))' } as CSSProperties}
      />
    </>
  );
}

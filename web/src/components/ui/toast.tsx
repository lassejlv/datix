import { Toast } from '@base-ui/react/toast';
import type { ReactNode } from 'react';
import { Check, X } from './icons';
import { useSitePreferences } from '../site-preferences';

const manager = Toast.createToastManager();
export const toast = {
  success: (title: string) => manager.add({ title, type: 'success' }),
  error: (title: string) => manager.add({ title, type: 'error', priority: 'high', timeout: 8000 }),
  info: (title: string) => manager.add({ title, type: 'info' }),
};

export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider toastManager={manager} timeout={5000} limit={3}>
      {children}
      <Toasts />
    </Toast.Provider>
  );
}

function Toasts() {
  const { toasts } = Toast.useToastManager();
  const { t } = useSitePreferences();
  return (
    <Toast.Portal>
      <Toast.Viewport className="kit-toasts">
        {toasts.map((item) => (
          <Toast.Root key={item.id} toast={item} className="kit-toast" data-kind={item.type}>
            <Toast.Content className="flex items-start gap-2.5">
              {item.type === 'success' ? (
                <Check className="mt-0.5 size-4 shrink-0 text-success" />
              ) : (
                <span
                  className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border text-[11px]"
                  aria-hidden="true"
                >
                  {item.type === 'error' ? '!' : 'i'}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <Toast.Title className="text-sm leading-5 font-normal" />
                <Toast.Description className="mt-1 text-xs text-secondary-ink" />
              </div>
              <Toast.Close
                aria-hidden={false}
                aria-label={t('Dismiss notification')}
                className="kit-toast-close"
              >
                <X className="size-3.5" />
              </Toast.Close>
            </Toast.Content>
          </Toast.Root>
        ))}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

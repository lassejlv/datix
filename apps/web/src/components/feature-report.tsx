import { Spinner } from './ui/spinner';
import { Alert } from './ui/alert';
import { Select } from './ui/select';
import { useEffect, useState, type ReactNode } from 'react';
import { apiClient, errorText } from '../lib/client';
import { useSitePreferences } from './site-preferences';
import { Button } from './ui/button';
export function useFeatureReport<T>(path: string, refresh = 0, interval = 0) {
  const key = `${path}:${refresh}`;
  const [result, setResult] = useState<{ key: string; data?: T; error: string }>({
    key: '',
    error: '',
  });
  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    async function load() {
      if (loading || controller.signal.aborted) return;
      loading = true;
      try {
        const result = await apiClient<T>(path, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setResult({ key, data: result, error: '' });
        }
      } catch (error) {
        if (!controller.signal.aborted) setResult({ key, error: errorText(error) });
      } finally {
        loading = false;
      }
    }
    void load();
    const timer = interval
      ? setInterval(() => {
          if (document.visibilityState === 'visible') void load();
        }, interval)
      : undefined;
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [path, key, interval]);
  return result.key === key ? result : { data: undefined, error: '' };
}
export function ReportStatus({
  error,
  loading,
  children,
}: {
  error: string;
  loading: boolean;
  children: ReactNode;
}) {
  const { t, message } = useSitePreferences();
  if (error) return <Alert className="py-8 text-sm text-danger">{message(error)}</Alert>;
  if (loading)
    return (
      <p role="status" className="flex items-center gap-2 py-8 text-sm text-secondary-ink">
        <Spinner />
        {t('Loading…')}
      </p>
    );
  return children;
}
export function EmptyFeature({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line px-6 py-12 text-center text-sm text-secondary-ink">
      {children}
    </div>
  );
}
export function FeatureToolbar({
  days,
  setDays,
  onRefresh,
}: {
  days: string;
  setDays: (days: string) => void;
  onRefresh: () => void;
}) {
  const { t } = useSitePreferences();
  return (
    <div className="mb-5 flex items-center justify-end gap-2">
      <Select
        aria-label={t('Date range')}
        value={days}
        onValueChange={(value) => setDays(value)}
        className="rounded-md border border-border bg-background px-3 py-2 text-sm"
      >
        <option value="1">{t('Today')}</option>
        <option value="7">{t('Last 7 days')}</option>
        <option value="30">{t('Last 30 days')}</option>
      </Select>
      <Button variant="outline" size="sm" onClick={onRefresh}>
        {t('Refresh')}
      </Button>
    </div>
  );
}
export function rangeQuery(days: string) {
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.parse(today) - (Number(days) - 1) * 86400000)
    .toISOString()
    .slice(0, 10);
  return `?from=${from}&to=${today}`;
}

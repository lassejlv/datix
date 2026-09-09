import { translate } from '../lib/i18n/translations';
import { Translated } from './translated';
import { useSitePreferences } from './site-preferences';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { apiClient, errorText, type Site, type SiteEnvironment } from '../lib/client';
import {
  breakdownName,
  providerName,
  type ImportProvider,
  type ImportSummary,
} from '../lib/imports';
import { ArrowRight, FileText, Trash2 } from './ui/icons';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Spinner } from './ui/spinner';
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from './ui/dialog';

const MAX_UPLOAD = 10 * 1024 * 1024;

export function AnalyticsImports({
  site,
  environment,
  onViewReport,
}: {
  site: Site;
  environment: SiteEnvironment;
  onViewReport: (from: string, to: string) => void;
}) {
  const { number, message: messageText, t, locale, dateLabel } = useSitePreferences();
  const fullDate = (day: string) =>
    dateLabel(day, { day: 'numeric', month: 'short', year: 'numeric' });
  const endpoint = `/sites/${site.id}/environments/${environment.id}/imports`;
  const [provider, setProvider] = useState<ImportProvider>('plausible');
  const [timeZone, setTimeZone] = useState('UTC');
  const [webOnly, setWebOnly] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportSummary | null>(null);
  const [history, setHistory] = useState<ImportSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState<'preview' | 'import' | 'remove' | null>(null);
  const [error, setError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [message, setMessage] = useState('');
  const [removing, setRemoving] = useState<ImportSummary | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiClient<{ imports: ImportSummary[] }>(endpoint, { signal: controller.signal })
      .then((data) => {
        setHistory(data.imports);
        setHistoryError('');
      })
      .catch((error) => {
        if (!controller.signal.aborted) setHistoryError(errorText(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [endpoint, revision]);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (preview) reviewHeading.current?.focus();
  }, [preview]);

  function resetPreview() {
    setPreview(null);
    setError('');
    setMessage('');
  }
  function selectFile(selected: File | undefined) {
    resetPreview();
    setFile(null);
    if (!selected) return;
    if (!selected.size || selected.size > MAX_UPLOAD) {
      setError(
        'Choose a non-empty export up to 10 MB. Export a shorter date range for larger files.',
      );
      return;
    }
    if (!(provider === 'plausible' ? /\.(csv|zip)$/i : /\.csv$/i).test(selected.name)) {
      setError(
        provider === 'plausible'
          ? 'Choose a Plausible full-export ZIP or visitors CSV.'
          : 'Choose a Google Analytics CSV export.',
      );
      return;
    }
    setFile(selected);
  }
  function reloadHistory() {
    setLoading(true);
    setRevision((value) => value + 1);
  }
  async function readExport(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy('preview');
    setError('');
    setMessage('');
    const controller = new AbortController();
    request.current = controller;
    try {
      const query = new URLSearchParams({
        provider,
        timeZone: timeZone.trim(),
        filename: file.name,
        webOnly: String(webOnly),
      });
      const result = await apiClient<ImportSummary>(`${endpoint}/preview?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
        signal: controller.signal,
      });
      setPreview(result);
    } catch (error) {
      if (!controller.signal.aborted) setError(errorText(error));
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }
  async function commit() {
    if (!file || !preview) return;
    setBusy('import');
    setError('');
    const controller = new AbortController();
    request.current = controller;
    try {
      const query = new URLSearchParams({
        provider,
        timeZone: timeZone.trim(),
        filename: file.name,
        webOnly: String(webOnly),
        fingerprint: preview.fingerprint,
      });
      const result = await apiClient<{ import: ImportSummary; duplicate: boolean }>(
        `${endpoint}?${query}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file,
          signal: controller.signal,
        },
      );
      setMessage(
        result.duplicate
          ? 'This export is already imported. Your totals have not changed.'
          : translate(
              'en',
              result.import.days === 1
                ? '{count} day imported from {provider}. Your history is ready in Overview.'
                : '{count} days imported from {provider}. Your history is ready in Overview.',
              { count: result.import.days, provider: providerName(result.import.provider) },
            ),
      );
      setPreview(null);
      setFile(null);
      if (picker.current) picker.current.value = '';
      reloadHistory();
    } catch (error) {
      if (!controller.signal.aborted) setError(errorText(error));
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }
  async function remove() {
    if (!removing?.id) return;
    setBusy('remove');
    setError('');
    try {
      await apiClient(`${endpoint}/${removing.id}`, { method: 'DELETE' });
      setRemoving(null);
      setMessage('Import removed. Your tracked analytics are unchanged.');
      reloadHistory();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="max-w-[760px]">
      <header className="mb-7">
        <h1 className="text-[24px] font-medium tracking-tight">{t('Import analytics')}</h1>
        <p className="mt-2 text-sm leading-relaxed text-secondary-ink">
          {t('Bring your existing history to {environment} for {domain}.', {
            environment: environment.name,
            domain: environment.domain,
          })}
        </p>
        <p className="mt-2 text-sm leading-relaxed text-secondary-ink">
          {t(
            'Import completed days from the last two years, before tracking began here. Imported history does not use your monthly event allowance.',
          )}
        </p>
      </header>
      <form onSubmit={readExport}>
        <fieldset disabled={busy !== null}>
          <legend className="mb-3 text-sm font-medium">
            {t('Where is your data coming from?')}
          </legend>
          <div
            className="grid grid-cols-1 gap-3 sm:grid-cols-2"
            role="group"
            aria-label={t('Analytics provider')}
          >
            {(['plausible', 'ga4'] as const).map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={provider === value}
                onClick={() => {
                  setProvider(value);
                  setFile(null);
                  resetPreview();
                  if (picker.current) picker.current.value = '';
                }}
                className="min-h-20 rounded-lg border border-border px-4 py-3 text-left hover:bg-accent aria-pressed:border-foreground aria-pressed:bg-accent focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
              >
                <span className="block text-sm font-medium">{providerName(value)}</span>
                <span className="mt-1 block text-xs leading-relaxed text-secondary-ink">
                  {value === 'plausible'
                    ? t('Full-export ZIP or daily visitors CSV')
                    : t('Daily traffic report as CSV')}
                </span>
              </button>
            ))}
          </div>
          <details
            key={provider}
            className="mt-5 rounded-lg border border-border px-4 py-3 text-sm"
            open={!preview}
          >
            <summary className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
              {t('Prepare your {provider} export', { provider: providerName(provider) })}
            </summary>
            {provider === 'plausible' ? (
              <div className="mt-3 text-secondary-ink">
                <ol className="list-decimal space-y-1.5 pl-5 leading-relaxed">
                  <li>
                    <Translated
                      text="Open your site settings, then {section}."
                      values={{
                        section: (
                          <strong className="font-medium text-foreground">
                            Imports &amp; Exports
                          </strong>
                        ),
                      }}
                    />
                  </li>
                  <li>
                    <Translated
                      text="Choose {action} and download the full CSV export."
                      values={{
                        action: (
                          <strong className="font-medium text-foreground">Export Data</strong>
                        ),
                      }}
                    />
                  </li>
                  <li>
                    <Translated
                      text="Upload the ZIP, or its {file} CSV for daily totals only."
                      values={{ file: <code className="text-xs">imported_visitors</code> }}
                    />
                  </li>
                </ol>
                <p className="mt-3 leading-relaxed">
                  {t(
                    'The dashboard’s “Export stats” files do not contain the full history needed here. Plausible full exports also exclude data previously imported into Plausible.',
                  )}
                </p>
                <a
                  href="https://plausible.io/docs/export-stats"
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-block underline underline-offset-4"
                >
                  {t('Plausible export guide')}
                </a>
              </div>
            ) : (
              <div className="mt-3 text-secondary-ink">
                <ol className="list-decimal space-y-1.5 pl-5 leading-relaxed">
                  <li>
                    <Translated
                      text="In your GA4 property, open {section} and choose your dates."
                      values={{
                        section: (
                          <strong className="font-medium text-foreground">
                            Explore → Free form
                          </strong>
                        ),
                      }}
                    />
                  </li>
                  <li>
                    <Translated
                      text="Use {date} as the only row dimension, and {views} and {users} as the metrics."
                      values={{
                        date: <strong className="font-medium text-foreground">Date</strong>,
                        views: <strong className="font-medium text-foreground">Views</strong>,
                        users: <strong className="font-medium text-foreground">Total users</strong>,
                      }}
                    />
                  </li>
                  <li>
                    {t(
                      'Remove segments, comparisons, and other dimensions. Filter to your website’s web stream if the property includes apps.',
                    )}
                  </li>
                  <li>
                    {t(
                      'Export as CSV with English column names. Available history depends on your GA4 retention settings.',
                    )}
                  </li>
                </ol>
                <a
                  href={`https://support.google.com/analytics/answer/9327972?hl=${locale}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-block underline underline-offset-4"
                >
                  {t('Google Analytics exploration guide')}
                </a>
              </div>
            )}
          </details>
          <label className="mt-5 block max-w-sm text-sm font-medium" htmlFor="import-timezone">
            {t('Reporting timezone')}
            <Input
              id="import-timezone"
              className="mt-2"
              value={timeZone}
              required
              maxLength={80}
              list="import-timezones"
              onChange={(event) => {
                setTimeZone(event.target.value);
                resetPreview();
              }}
              aria-describedby="import-timezone-help"
            />
          </label>
          <datalist id="import-timezones">
            <option value="UTC" />
            <option value="Europe/Copenhagen" />
            <option value="Europe/Berlin" />
            <option value="Europe/London" />
            <option value="America/New_York" />
            <option value="America/Los_Angeles" />
          </datalist>
          <p id="import-timezone-help" className="mt-2 text-xs leading-relaxed text-secondary-ink">
            {t(
              'Use the timezone set in your provider, such as UTC or Europe/Copenhagen. Imported dates keep that timezone.',
            )}
          </p>
          {provider === 'ga4' && (
            <label className="mt-5 flex items-start gap-3 text-sm leading-relaxed">
              <input
                type="checkbox"
                required
                checked={webOnly}
                onChange={(event) => {
                  setWebOnly(event.target.checked);
                  resetPreview();
                }}
                className="mt-1 size-4 shrink-0 accent-foreground"
              />
              {t('This export contains only my website’s web traffic, with no app screens.')}
            </label>
          )}
          <div
            className="mt-5 flex flex-col items-start gap-3 rounded-lg border border-dashed border-border p-5"
            onDragOver={(event) => {
              event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (busy) return;
              if (event.dataTransfer.files.length !== 1) {
                setError('Upload one export at a time.');
                return;
              }
              selectFile(event.dataTransfer.files[0]);
            }}
          >
            <div className="flex min-w-0 items-start gap-3">
              <FileText
                size={20}
                className="mt-0.5 shrink-0 text-secondary-ink"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="break-all text-sm font-medium">
                  {file ? file.name : t('Drop your export here')}
                </p>
                <p className="mt-1 text-xs text-secondary-ink">
                  {file
                    ? t('{size} KB · ready to review', {
                        size: number(Math.ceil(file.size / 1024)),
                      })
                    : provider === 'plausible'
                      ? t('ZIP or CSV · up to 10 MB')
                      : t('CSV · up to 10 MB')}
                </p>
              </div>
            </div>
            <input
              ref={picker}
              type="file"
              accept={provider === 'plausible' ? '.zip,.csv' : '.csv'}
              className="sr-only"
              tabIndex={-1}
              aria-label={t('Analytics export file')}
              onChange={(event) => selectFile(event.target.files?.[0])}
            />
            <Button variant="outline" onClick={() => picker.current?.click()}>
              {file ? t('Change export') : t('Select export')}
            </Button>
          </div>
          {!preview && (
            <Button className="mt-4" type="submit" disabled={!file} loading={busy === 'preview'}>
              {t('Review import')} <ArrowRight size={15} aria-hidden="true" />
            </Button>
          )}
        </fieldset>
      </form>
      {error && !removing && (
        <p className="mt-4 text-sm leading-relaxed text-danger" role="alert">
          {messageText(error)}
        </p>
      )}
      {message && (
        <p
          className="mt-5 rounded-lg border border-border p-4 text-sm leading-relaxed"
          role="status"
        >
          {messageText(message)}
        </p>
      )}
      {preview && (
        <section className="mt-7 border-t border-border pt-6" aria-labelledby="import-review-title">
          <h2
            id="import-review-title"
            ref={reviewHeading}
            tabIndex={-1}
            className="text-lg font-medium focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          >
            {t('Review your import')}
          </h2>
          <p className="mt-2 text-sm text-secondary-ink">
            {fullDate(preview.from)} – {fullDate(preview.to)} · {preview.timeZone}
          </p>
          <dl className="mt-5 grid grid-cols-3 gap-4">
            {[
              [t('Days'), preview.days],
              [t('Pageviews'), preview.pageviews],
              [t('Daily visitors'), preview.dailyVisitors],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-secondary-ink">{label}</dt>
                <dd className="mt-1 text-xl font-medium tabular-nums">{number(value as number)}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-sm leading-relaxed text-secondary-ink">
            {preview.breakdowns.length
              ? t('Also includes: {breakdowns}.', {
                  breakdowns: preview.breakdowns.map((value) => breakdownName(value, t)).join(', '),
                })
              : t(
                  'Daily totals only. This export does not include page, source, country, device, or custom-event breakdowns.',
                )}{' '}
            {t('Visitor journeys cannot be reconstructed from aggregate exports.')}
          </p>
          {preview.warnings.length > 0 && (
            <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-relaxed text-secondary-ink">
              {preview.warnings.map((warning) => (
                <li key={messageText(warning)}>{messageText(warning)}</li>
              ))}
            </ul>
          )}
          {preview.duplicate ? (
            <p className="mt-4 text-sm" role="status">
              {t('This history is already imported. Your reports will not be counted twice.')}
            </p>
          ) : (
            <Button
              className="mt-5"
              onClick={() => void commit()}
              loading={busy === 'import'}
              disabled={busy !== null}
            >
              {t(preview.days === 1 ? 'Import {count} day' : 'Import {count} days', {
                count: number(preview.days),
              })}{' '}
              <ArrowRight size={15} aria-hidden="true" />
            </Button>
          )}
        </section>
      )}
      <section className="mt-9 border-t border-border pt-6" aria-labelledby="import-history-title">
        <h2 id="import-history-title" className="text-lg font-medium">
          {t('Import history')}
        </h2>
        {loading ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-secondary-ink" role="status">
            <Spinner className="size-4" /> {t('Loading imports…')}
          </div>
        ) : historyError ? (
          <div className="mt-4">
            <p role="alert" className="mb-3 text-sm text-danger">
              {messageText(historyError)}
            </p>
            <Button variant="outline" onClick={reloadHistory}>
              {t('Try again')}
            </Button>
          </div>
        ) : !history.length ? (
          <p className="mt-3 text-sm text-secondary-ink">
            {t('No history imported into this environment yet.')}
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {history.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-4 py-4">
                <div className="min-w-0 flex-1 basis-64">
                  <h3 className="text-sm font-medium">{providerName(item.provider)}</h3>
                  <p className="mt-1 break-all text-xs text-secondary-ink">{item.sourceName}</p>
                  <p className="mt-1 text-xs leading-relaxed text-secondary-ink">
                    {fullDate(item.from)} – {fullDate(item.to)} ·{' '}
                    {t('{count} pageviews', { count: number(item.pageviews) })} · {item.timeZone}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const earliest = new Date(Date.parse(item.to) - 365 * 86400000)
                        .toISOString()
                        .slice(0, 10);
                      onViewReport(item.from < earliest ? earliest : item.from, item.to);
                    }}
                  >
                    {Date.parse(item.to) - Date.parse(item.from) >= 366 * 86400000
                      ? t('View latest year')
                      : t('View report')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('Remove {provider} import from {date}', {
                      provider: providerName(item.provider),
                      date: fullDate(item.from),
                    })}
                    disabled={busy !== null}
                    onClick={() => {
                      setRemoving(item);
                      setError('');
                    }}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && busy !== 'remove') {
            setRemoving(null);
            setError('');
          }
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{t('Remove this import?')}</DialogTitle>
            <DialogDescription>
              {t(
                'This removes the imported totals and breakdowns from your reports. Your Analytics Beer tracking data stays unchanged. You can upload the export again later.',
              )}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p className="px-6 pb-4 text-sm text-danger" role="alert">
              {messageText(error)}
            </p>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy === 'remove'} />}>
              {t('Keep import')}
            </DialogClose>
            <Button variant="destructive" loading={busy === 'remove'} onClick={() => void remove()}>
              {t('Remove import')}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

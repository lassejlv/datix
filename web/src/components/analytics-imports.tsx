import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  apiClient,
  dateLabel,
  errorText,
  number,
  type Site,
  type SiteEnvironment,
} from '../lib/client';
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
const fullDate = (day: string) =>
  dateLabel(day, { day: 'numeric', month: 'short', year: 'numeric' });

export function AnalyticsImports({
  site,
  environment,
  onViewReport,
}: {
  site: Site;
  environment: SiteEnvironment;
  onViewReport: (from: string, to: string) => void;
}) {
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
          : `${number(result.import.days)} ${result.import.days === 1 ? 'day' : 'days'} imported from ${providerName(result.import.provider)}. Your history is ready in Overview.`,
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
        <h1 className="text-[24px] font-medium tracking-tight">Import analytics</h1>
        <p className="mt-2 text-sm leading-relaxed text-secondary-ink">
          Bring your existing history to {environment.name} for {environment.domain}.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-secondary-ink">
          Import completed days from the last two years, before tracking began here. Imported
          history does not use your monthly event allowance.
        </p>
      </header>
      <form onSubmit={readExport}>
        <fieldset disabled={busy !== null}>
          <legend className="mb-3 text-sm font-medium">Where is your data coming from?</legend>
          <div
            className="grid grid-cols-1 gap-3 sm:grid-cols-2"
            role="group"
            aria-label="Analytics provider"
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
                    ? 'Full-export ZIP or daily visitors CSV'
                    : 'Daily traffic report as CSV'}
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
              Prepare your {providerName(provider)} export
            </summary>
            {provider === 'plausible' ? (
              <div className="mt-3 text-secondary-ink">
                <ol className="list-decimal space-y-1.5 pl-5 leading-relaxed">
                  <li>
                    Open your site settings, then{' '}
                    <strong className="font-medium text-foreground">Imports &amp; Exports</strong>.
                  </li>
                  <li>
                    Choose <strong className="font-medium text-foreground">Export Data</strong> and
                    download the full CSV export.
                  </li>
                  <li>
                    Upload the ZIP, or its <code className="text-xs">imported_visitors</code> CSV
                    for daily totals only.
                  </li>
                </ol>
                <p className="mt-3 leading-relaxed">
                  The dashboard’s “Export stats” files do not contain the full history needed here.
                  Plausible full exports also exclude data previously imported into Plausible.
                </p>
                <a
                  href="https://plausible.io/docs/export-stats"
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-block underline underline-offset-4"
                >
                  Plausible export guide
                </a>
              </div>
            ) : (
              <div className="mt-3 text-secondary-ink">
                <ol className="list-decimal space-y-1.5 pl-5 leading-relaxed">
                  <li>
                    In your GA4 property, open{' '}
                    <strong className="font-medium text-foreground">Explore → Free form</strong> and
                    choose your dates.
                  </li>
                  <li>
                    Use a table with <strong className="font-medium text-foreground">Date</strong>{' '}
                    as the only row dimension, and{' '}
                    <strong className="font-medium text-foreground">Views</strong> and{' '}
                    <strong className="font-medium text-foreground">Total users</strong> as the
                    metrics.
                  </li>
                  <li>
                    Remove segments, comparisons, and other dimensions. Filter to your website’s web
                    stream if the property includes apps.
                  </li>
                  <li>
                    Export as CSV with English column names. Available history depends on your GA4
                    retention settings.
                  </li>
                </ol>
                <a
                  href="https://support.google.com/analytics/answer/9327972?hl=en"
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-block underline underline-offset-4"
                >
                  Google Analytics exploration guide
                </a>
              </div>
            )}
          </details>
          <label className="mt-5 block max-w-sm text-sm font-medium" htmlFor="import-timezone">
            Reporting timezone
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
            Use the timezone set in your provider, such as UTC or Europe/Copenhagen. Imported dates
            keep that timezone.
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
              This export contains only my website’s web traffic, with no app screens.
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
                  {file ? file.name : 'Drop your export here'}
                </p>
                <p className="mt-1 text-xs text-secondary-ink">
                  {file
                    ? `${number(Math.ceil(file.size / 1024))} KB · ready to review`
                    : `${provider === 'plausible' ? 'ZIP or CSV' : 'CSV'} · up to 10 MB`}
                </p>
              </div>
            </div>
            <input
              ref={picker}
              type="file"
              accept={provider === 'plausible' ? '.zip,.csv' : '.csv'}
              className="sr-only"
              tabIndex={-1}
              aria-label="Analytics export file"
              onChange={(event) => selectFile(event.target.files?.[0])}
            />
            <Button variant="outline" onClick={() => picker.current?.click()}>
              {file ? 'Change export' : 'Select export'}
            </Button>
          </div>
          {!preview && (
            <Button className="mt-4" type="submit" disabled={!file} loading={busy === 'preview'}>
              Review import <ArrowRight size={15} aria-hidden="true" />
            </Button>
          )}
        </fieldset>
      </form>
      {error && !removing && (
        <p className="mt-4 text-sm leading-relaxed text-danger" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p
          className="mt-5 rounded-lg border border-border p-4 text-sm leading-relaxed"
          role="status"
        >
          {message}
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
            Review your import
          </h2>
          <p className="mt-2 text-sm text-secondary-ink">
            {fullDate(preview.from)} – {fullDate(preview.to)} · {preview.timeZone}
          </p>
          <dl className="mt-5 grid grid-cols-3 gap-4">
            {[
              ['Days', preview.days],
              ['Pageviews', preview.pageviews],
              ['Daily visitors', preview.dailyVisitors],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-secondary-ink">{label}</dt>
                <dd className="mt-1 text-xl font-medium tabular-nums">{number(value as number)}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-sm leading-relaxed text-secondary-ink">
            {preview.breakdowns.length
              ? `Also includes: ${preview.breakdowns.map(breakdownName).join(', ')}.`
              : 'Daily totals only. This export does not include page, source, country, device, or custom-event breakdowns.'}{' '}
            Visitor journeys cannot be reconstructed from aggregate exports.
          </p>
          {preview.warnings.length > 0 && (
            <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-relaxed text-secondary-ink">
              {preview.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          {preview.duplicate ? (
            <p className="mt-4 text-sm" role="status">
              This history is already imported. Your reports will not be counted twice.
            </p>
          ) : (
            <Button
              className="mt-5"
              onClick={() => void commit()}
              loading={busy === 'import'}
              disabled={busy !== null}
            >
              Import {number(preview.days)} {preview.days === 1 ? 'day' : 'days'}{' '}
              <ArrowRight size={15} aria-hidden="true" />
            </Button>
          )}
        </section>
      )}
      <section className="mt-9 border-t border-border pt-6" aria-labelledby="import-history-title">
        <h2 id="import-history-title" className="text-lg font-medium">
          Import history
        </h2>
        {loading ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-secondary-ink" role="status">
            <Spinner className="size-4" /> Loading imports…
          </div>
        ) : historyError ? (
          <div className="mt-4">
            <p role="alert" className="mb-3 text-sm text-danger">
              {historyError}
            </p>
            <Button variant="outline" onClick={reloadHistory}>
              Try again
            </Button>
          </div>
        ) : !history.length ? (
          <p className="mt-3 text-sm text-secondary-ink">
            No history imported into this environment yet.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {history.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-4 py-4">
                <div className="min-w-0 flex-1 basis-64">
                  <h3 className="text-sm font-medium">{providerName(item.provider)}</h3>
                  <p className="mt-1 break-all text-xs text-secondary-ink">{item.sourceName}</p>
                  <p className="mt-1 text-xs leading-relaxed text-secondary-ink">
                    {fullDate(item.from)} – {fullDate(item.to)} · {number(item.pageviews)} pageviews
                    · {item.timeZone}
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
                      ? 'View latest year'
                      : 'View report'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${providerName(item.provider)} import from ${item.from}`}
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
            <DialogTitle>Remove this import?</DialogTitle>
            <DialogDescription>
              This removes the imported totals and breakdowns from your reports. Your Analytics Beer
              tracking data stays unchanged. You can upload the export again later.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p className="px-6 pb-4 text-sm text-danger" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy === 'remove'} />}>
              Keep import
            </DialogClose>
            <Button variant="destructive" loading={busy === 'remove'} onClick={() => void remove()}>
              Remove import
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

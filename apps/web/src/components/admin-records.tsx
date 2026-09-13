import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { apiClient, errorText, write } from '../lib/client';
import {
  adminListPath,
  suspensionSource,
  type AdminSite,
  type AdminSiteDetail,
  type AdminStatusFilter,
  type AdminUser,
  type AdminUserDetail,
  adminStatusFilters,
} from '../lib/admin';
import { useSitePreferences } from './site-preferences';
import { AdminEmpty, AdminState, Badge, DetailField, LoadMore, useAdminResource } from './admin-ui';
import { Alert } from './ui/alert';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { toast } from './ui/toast';
import { ArrowLeft, Search } from './ui/icons';
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from './ui/dialog';

const PAGE_SIZE = 25;

/**
 * Accumulates cursor pages for one resource. Changing the search or status starts a new
 * list; 'Load more' appends without refetching what is already shown.
 */
function useDirectory<Row>(
  resource: 'users' | 'sites',
  key: 'users' | 'sites',
  search: string,
  status: AdminStatusFilter,
) {
  const path = adminListPath(resource, { search, status, limit: PAGE_SIZE });
  const page = useAdminResource<Record<string, Row[]> & { nextCursor: string | null }>(path);

  const [appended, setAppended] = useState<{
    key: string;
    rows: Row[];
    cursor: string | null;
  } | null>(null);

  const [loadingMore, setLoadingMore] = useState(false);
  // Appended pages belong to one request; a new filter or reload discards them by key.
  const active = appended?.key === page.key ? appended : null;
  const rows = [...((page.data?.[key] as Row[] | undefined) ?? []), ...(active?.rows ?? [])];
  const cursor = active ? active.cursor : (page.data?.nextCursor ?? null);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);

    try {
      const next = await apiClient<Record<string, Row[]> & { nextCursor: string | null }>(
        adminListPath(resource, { search, status, cursor, limit: PAGE_SIZE }),
      );

      setAppended({
        key: page.key,
        rows: [...(active?.rows ?? []), ...((next[key] as Row[] | undefined) ?? [])],
        cursor: next.nextCursor,
      });
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  return { ...page, rows, cursor, loadingMore, loadMore };
}

function DirectoryToolbar({
  label,
  placeholder,
  search,
  status,
  onSearch,
  onStatus,
}: {
  label: string;
  placeholder: string;
  search: string;
  status: AdminStatusFilter;
  onSearch: (value: string) => void;
  onStatus: (value: AdminStatusFilter) => void;
}) {
  const { t } = useSitePreferences();
  const names = { all: t('All'), active: t('Active'), suspended: t('Suspended') } as const;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <div className="relative min-w-[220px] flex-1">
        <Search
          size={15}
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2.5 z-10 -translate-y-1/2 text-secondary-ink"
        />
        <Input
          type="search"
          aria-label={label}
          placeholder={placeholder}
          value={search}
          maxLength={100}
          className="[&_input]:pl-8"
          onChange={(event) => onSearch(event.target.value)}
        />
      </div>
      <div
        className="inline-flex gap-1 rounded-md border border-border p-1"
        role="group"
        aria-label={t('Status filter')}
      >
        {adminStatusFilters.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={status === value}
            onClick={() => onStatus(value)}
            className={`rounded px-3 py-1.5 text-xs focus-visible:outline-2 focus-visible:outline-ring ${
              status === value
                ? 'bg-muted font-medium text-foreground'
                : 'text-secondary-ink hover:text-foreground'
            }`}
          >
            {names[value]}
          </button>
        ))}
      </div>
    </div>
  );
}

function RecordRow({
  title,
  subtitle,
  badges,
  metric,
  metricLabel,
  onOpen,
  openLabel,
}: {
  title: string;
  subtitle: string;
  badges: ReactNode;
  metric: string;
  metricLabel: string;
  onOpen: () => void;
  openLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={openLabel}
      className="flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left transition-colors duration-150 hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          {badges}
        </span>
        <span className="mt-0.5 block truncate text-xs text-secondary-ink">{subtitle}</span>
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-sm tabular-nums">{metric}</span>
        <span className="block text-xs text-secondary-ink">{metricLabel}</span>
      </span>
    </button>
  );
}

function DetailHeader({
  title,
  subtitle,
  onBack,
  backLabel,
  action,
}: {
  title: string;
  subtitle: string;
  onBack: () => void;
  backLabel: string;
  action: ReactNode;
}) {
  return (
    <div className="mb-5">
      <Button variant="ghost" size="sm" className="-ml-2 mb-3" onClick={onBack}>
        <ArrowLeft size={15} />
        {backLabel}
      </Button>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-medium break-words">{title}</h2>
          <p className="mt-0.5 text-sm break-all text-secondary-ink">{subtitle}</p>
        </div>
        {action}
      </div>
    </div>
  );
}

function SuspensionNotice({
  reason,
  at,
  by,
}: {
  reason: string | null;
  at: string | null;
  by: string | null;
}) {
  const { dateTime, t } = useSitePreferences();
  if (!reason) return null;

  return (
    <Alert variant="warning" className="mb-5 text-sm">
      <p className="font-medium">{t('Suspended')}</p>
      <p className="mt-1 break-words">{reason}</p>
      <p className="mt-1 text-xs text-secondary-ink">
        {at && by
          ? t('{date} · by {actor}', { date: dateTime(at), actor: by })
          : at
            ? dateTime(at)
            : ''}
      </p>
    </Alert>
  );
}

/** Suspending always records a reason; restoring never needs one. */
function SuspensionDialog({
  open,
  suspended,
  name,
  busy,
  error,
  reason,
  onReasonChange,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  suspended: boolean;
  name: string;
  busy: boolean;
  error: string;
  reason: string;
  onReasonChange: (reason: string) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: (reason: string) => void;
}) {
  const { message: messageText, t } = useSitePreferences();

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {suspended ? t('Restore {name}?', { name }) : t('Suspend {name}?', { name })}
          </DialogTitle>
          <DialogDescription>
            {suspended
              ? t('Collection resumes immediately and the suspension reason is cleared.')
              : t(
                  'Collection stops immediately and every active session is signed out. This is recorded in the audit log.',
                )}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (!busy) onSubmit(reason.trim());
          }}
        >
          <div className="flex flex-col gap-4 px-6 pb-6">
            {!suspended && (
              <label className="flex flex-col gap-2 text-sm font-medium" htmlFor="suspend-reason">
                {t('Reason')}
                <Input
                  id="suspend-reason"
                  required
                  maxLength={500}
                  autoComplete="off"
                  value={reason}
                  disabled={busy}
                  onChange={(event) => onReasonChange(event.target.value)}
                />
                <span className="text-[13px] leading-normal font-normal text-muted-foreground">
                  {t('Recorded in the audit log. 1–500 characters.')}
                </span>
              </label>
            )}
            {error && <Alert className="text-sm text-danger">{messageText(error)}</Alert>}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>
              {t('Cancel')}
            </DialogClose>
            <Button
              type="submit"
              variant={suspended ? 'default' : 'destructive'}
              loading={busy}
              disabled={busy || (!suspended && !reason.trim())}
            >
              {suspended ? t('Restore access') : t('Suspend access')}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** Shared suspend/restore wiring: the PATCH response is the refreshed detail payload. */
function useSuspension<Detail>(path: string, onUpdated: (detail: Detail) => void) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');

  // Opening clears the previous attempt here rather than from an effect on `open`.
  function start() {
    setReason('');
    setError('');
    setOpen(true);
  }

  async function submit(suspended: boolean, reason: string) {
    setBusy(true);
    setError('');

    try {
      const detail = await apiClient<Detail>(
        path,
        write('PATCH', suspended ? { suspended: true, reason } : { suspended: false }),
      );

      onUpdated(detail);
      setOpen(false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return { open, setOpen, start, busy, error, reason, setReason, submit };
}

export function AdminUsers() {
  const { dateTime, number, t } = useSitePreferences();
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<AdminStatusFilter>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    timer.current = setTimeout(() => setSearch(input), 300);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [input]);
  const directory = useDirectory<AdminUser>('users', 'users', search, status);
  if (selected)
    return (
      <AdminUserDetailView
        id={selected}
        onBack={() => {
          setSelected(null);
          directory.reload();
        }}
      />
    );

  return (
    <>
      <DirectoryToolbar
        label={t('Search accounts')}
        placeholder={t('Name, email or account ID')}
        search={input}
        status={status}
        onSearch={setInput}
        onStatus={setStatus}
      />
      <AdminState
        error={directory.error}
        loading={directory.loading && directory.rows.length === 0}
        onRetry={directory.reload}
      >
        {directory.rows.length === 0 ? (
          <AdminEmpty>{t('No accounts match this filter.')}</AdminEmpty>
        ) : (
          <div
            aria-busy={directory.loading}
            className="divide-y divide-border rounded-lg border border-border transition-opacity duration-150 aria-busy:opacity-60"
          >
            {directory.rows.map((row) => (
              <RecordRow
                key={row.id}
                title={row.name}
                subtitle={`${row.email} · ${t('Joined {date}', { date: dateTime(row.createdAt, { day: 'numeric', month: 'short', year: 'numeric' }) })}`}
                badges={
                  <>
                    {row.suspended && <Badge tone="danger">{t('Suspended')}</Badge>}
                    {!row.emailVerified && <Badge tone="muted">{t('Unverified')}</Badge>}
                  </>
                }
                metric={number(row.siteCount)}
                metricLabel={row.siteCount === 1 ? t('website') : t('websites')}
                openLabel={t('Open {name}', { name: row.name })}
                onOpen={() => setSelected(row.id)}
              />
            ))}
          </div>
        )}
        <LoadMore
          cursor={directory.cursor}
          busy={directory.loadingMore}
          onLoad={directory.loadMore}
        />
      </AdminState>
    </>
  );
}

function AdminUserDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const { dateTime, number, t } = useSitePreferences();
  const detail = useAdminResource<AdminUserDetail>(`/admin/users/${id}`);

  const suspension = useSuspension<AdminUserDetail>(`/admin/users/${id}`, (updated) => {
    detail.setData(updated);
    toast.success(updated.user.suspended ? t('Account suspended.') : t('Account restored.'));
  });

  const user = detail.data?.user;

  return (
    <>
      <DetailHeader
        title={user?.name ?? t('Account')}
        subtitle={user?.email ?? id}
        backLabel={t('All accounts')}
        onBack={onBack}
        action={
          user && (
            <Button
              variant={user.suspended ? 'outline' : 'destructive-outline'}
              onClick={suspension.start}
            >
              {user.suspended ? t('Restore access') : t('Suspend access')}
            </Button>
          )
        }
      />
      <AdminState error={detail.error} loading={detail.loading} onRetry={detail.reload}>
        {user && detail.data && (
          <>
            <SuspensionNotice
              reason={user.suspensionReason}
              at={user.suspendedAt}
              by={user.suspendedBy}
            />
            <dl className="mb-6 grid grid-cols-2 gap-4 rounded-lg border border-border px-4 py-4 sm:grid-cols-4">
              <DetailField label={t('Websites')}>{number(user.siteCount)}</DetailField>
              <DetailField label={t('Active sessions')}>
                {number(user.activeSessionCount)}
              </DetailField>
              <DetailField label={t('Email')}>
                {user.emailVerified ? t('Verified') : t('Unverified')}
              </DetailField>
              <DetailField label={t('Joined')}>
                {dateTime(user.createdAt, { day: 'numeric', month: 'short', year: 'numeric' })}
              </DetailField>
              <DetailField label={t('Account ID')}>
                <code className="text-xs break-all">{user.id}</code>
              </DetailField>
            </dl>
            <h3 className="mb-2 text-sm font-medium">{t('Websites')}</h3>
            {detail.data.sites.length === 0 ? (
              <AdminEmpty>{t('This account has no websites.')}</AdminEmpty>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {detail.data.sites.map((site) => (
                  <li
                    key={site.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {site.name}
                        {site.suspended && <Badge tone="danger">{t('Suspended')}</Badge>}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-secondary-ink">{site.domain}</p>
                    </div>
                    <span className="text-xs text-secondary-ink">
                      {t('{count} environments', { count: number(site.environmentCount) })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <SuspensionDialog
              open={suspension.open}
              suspended={user.suspended}
              name={user.name}
              busy={suspension.busy}
              error={suspension.error}
              reason={suspension.reason}
              onReasonChange={suspension.setReason}
              onOpenChange={suspension.setOpen}
              onSubmit={(reason) => void suspension.submit(!user.suspended, reason)}
            />
          </>
        )}
      </AdminState>
    </>
  );
}

export function AdminSites() {
  const { number, t } = useSitePreferences();
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<AdminStatusFilter>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    timer.current = setTimeout(() => setSearch(input), 300);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [input]);
  const directory = useDirectory<AdminSite>('sites', 'sites', search, status);
  if (selected)
    return (
      <AdminSiteDetailView
        id={selected}
        onBack={() => {
          setSelected(null);
          directory.reload();
        }}
      />
    );

  return (
    <>
      <DirectoryToolbar
        label={t('Search websites')}
        placeholder={t('Name, domain or owner email')}
        search={input}
        status={status}
        onSearch={setInput}
        onStatus={setStatus}
      />
      <AdminState
        error={directory.error}
        loading={directory.loading && directory.rows.length === 0}
        onRetry={directory.reload}
      >
        {directory.rows.length === 0 ? (
          <AdminEmpty>{t('No websites match this filter.')}</AdminEmpty>
        ) : (
          <div
            aria-busy={directory.loading}
            className="divide-y divide-border rounded-lg border border-border transition-opacity duration-150 aria-busy:opacity-60"
          >
            {directory.rows.map((row) => {
              const source = suspensionSource(row);

              return (
                <RecordRow
                  key={row.id}
                  title={row.name}
                  subtitle={`${row.domain} · ${row.ownerEmail}`}
                  badges={
                    source === 'site' ? (
                      <Badge tone="danger">{t('Suspended')}</Badge>
                    ) : source === 'owner' ? (
                      <Badge tone="danger">{t('Owner suspended')}</Badge>
                    ) : null
                  }
                  metric={number(row.environmentCount)}
                  metricLabel={row.environmentCount === 1 ? t('environment') : t('environments')}
                  openLabel={t('Open {name}', { name: row.name })}
                  onOpen={() => setSelected(row.id)}
                />
              );
            })}
          </div>
        )}
        <LoadMore
          cursor={directory.cursor}
          busy={directory.loadingMore}
          onLoad={directory.loadMore}
        />
      </AdminState>
    </>
  );
}

function AdminSiteDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const { dateTime, number, t } = useSitePreferences();
  const detail = useAdminResource<AdminSiteDetail>(`/admin/sites/${id}`);

  const suspension = useSuspension<AdminSiteDetail>(`/admin/sites/${id}`, (updated) => {
    detail.setData(updated);
    toast.success(updated.site.suspended ? t('Website suspended.') : t('Website restored.'));
  });

  const site = detail.data?.site;

  return (
    <>
      <DetailHeader
        title={site?.name ?? t('Website')}
        subtitle={site?.domain ?? id}
        backLabel={t('All websites')}
        onBack={onBack}
        action={
          site && (
            <Button
              variant={site.suspended ? 'outline' : 'destructive-outline'}
              onClick={suspension.start}
            >
              {site.suspended ? t('Restore access') : t('Suspend access')}
            </Button>
          )
        }
      />
      <AdminState error={detail.error} loading={detail.loading} onRetry={detail.reload}>
        {site && detail.data && (
          <>
            <SuspensionNotice
              reason={site.suspensionReason}
              at={site.suspendedAt}
              by={site.suspendedBy}
            />
            {site.ownerSuspended && !site.suspended && (
              <Alert variant="warning" className="mb-5 text-sm">
                {t('Collection is stopped because the owner account is suspended.')}
              </Alert>
            )}
            <dl className="mb-6 grid grid-cols-2 gap-4 rounded-lg border border-border px-4 py-4 sm:grid-cols-4">
              <DetailField label={t('Owner')}>
                <span className="break-all">{site.ownerEmail}</span>
              </DetailField>
              <DetailField label={t('Collecting')}>
                {site.trackingSuspended ? t('Stopped') : site.enabled ? t('Yes') : t('Disabled')}
              </DetailField>
              <DetailField label={t('Event credits')}>
                {site.creditBudget === null ? t('Account allowance') : number(site.creditBudget)}
              </DetailField>
              <DetailField label={t('Created')}>
                {dateTime(site.createdAt, { day: 'numeric', month: 'short', year: 'numeric' })}
              </DetailField>
              <DetailField label={t('Website ID')}>
                <code className="text-xs break-all">{site.id}</code>
              </DetailField>
            </dl>
            <h3 className="mb-2 text-sm font-medium">{t('Environments')}</h3>
            {detail.data.environments.length === 0 ? (
              <AdminEmpty>{t('This website has no environments.')}</AdminEmpty>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {detail.data.environments.map((environment) => (
                  <li
                    key={environment.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {environment.name}
                        {!environment.enabled && <Badge tone="muted">{t('Disabled')}</Badge>}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-secondary-ink">
                        {environment.domain}
                      </p>
                    </div>
                    <Badge>{environment.trackingMode}</Badge>
                  </li>
                ))}
              </ul>
            )}
            <SuspensionDialog
              open={suspension.open}
              suspended={site.suspended}
              name={site.name}
              busy={suspension.busy}
              error={suspension.error}
              reason={suspension.reason}
              onReasonChange={suspension.setReason}
              onOpenChange={suspension.setOpen}
              onSubmit={(reason) => void suspension.submit(!site.suspended, reason)}
            />
          </>
        )}
      </AdminState>
    </>
  );
}

import { useId, useState } from 'react';
import {
  adminAuditPath,
  auditActionCopy,
  revokedSessions,
  type AdminAuditEntry,
  type AdminStatus,
} from '../lib/admin';
import { apiClient, errorText, type User } from '../lib/client';
import { AdminSites, AdminUsers } from './admin-records';
import {
  AdminEmpty,
  AdminSection,
  AdminState,
  Badge,
  LoadMore,
  StatCard,
  useAdminResource,
} from './admin-ui';
import { Brand } from './brand';
import { PageTransition } from './page-transition';
import { useSitePreferences } from './site-preferences';
import { Button } from './ui/button';
import { ArrowLeft, RefreshCw } from './ui/icons';
import { Tabs } from './ui/tabs';
import { toast } from './ui/toast';

const PAGE_SIZE = 25;
type AdminTab = 'overview' | 'users' | 'sites' | 'audit';

export function AdminPanel({ user, onExit }: { user: User; onExit: () => void }) {
  const { t } = useSitePreferences();
  const tabsId = useId();
  const [tab, setTab] = useState<AdminTab>('overview');
  // The server decides access; this only avoids rendering a panel whose every request would fail.
  if (!user.admin)
    return (
      <main className="mx-auto flex min-h-dvh max-w-[440px] flex-col items-center justify-center gap-5 px-6 text-center">
        <Brand />
        <p className="text-secondary-ink">
          {t('Administration is not available for this account.')}
        </p>
        <Button variant="outline" onClick={onExit}>
          {t('Back to dashboard')}
        </Button>
      </main>
    );

  const items = [
    { value: 'overview', label: t('Overview') },
    { value: 'users', label: t('Accounts') },
    { value: 'sites', label: t('Websites') },
    { value: 'audit', label: t('Audit log') },
  ] as const;

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 w-full max-w-[960px] items-center justify-between gap-3 px-4 md:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <Brand />
            <Badge tone="muted">{t('Admin')}</Badge>
          </div>
          <Button variant="ghost" size="sm" onClick={onExit}>
            <ArrowLeft size={15} />
            {t('Back to dashboard')}
          </Button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[960px] px-4 pt-6 pb-10 md:px-6">
        <h1 className="text-2xl font-medium">{t('Administration')}</h1>
        <p className="mt-2 text-sm text-secondary-ink">
          {t('Signed in as {email}. Every action here is recorded in the audit log.', {
            email: user.email,
          })}
        </p>
        <div className="mt-5">
          <Tabs
            id={tabsId}
            label={t('Administration sections')}
            value={tab}
            items={items}
            onValueChange={setTab}
          />
        </div>
        <div
          id={`${tabsId}-panel`}
          role="tabpanel"
          aria-labelledby={`${tabsId}-tab-${tab}`}
          className="mt-6"
        >
          <PageTransition view={tab}>
            {tab === 'overview' ? (
              <AdminOverview />
            ) : tab === 'users' ? (
              <AdminUsers />
            ) : tab === 'sites' ? (
              <AdminSites />
            ) : (
              <AdminAudit />
            )}
          </PageTransition>
        </div>
      </main>
    </div>
  );
}

function HealthPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-secondary-ink">
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${ok ? 'bg-success' : 'bg-danger'}`}
      />
      {label}
    </span>
  );
}

function AdminOverview() {
  const { number, t } = useSitePreferences();
  const status = useAdminResource<AdminStatus>('/admin/status');
  const data = status.data;

  return (
    <AdminState error={status.error} loading={status.loading && !data} onRetry={status.reload}>
      {data && (
        <>
          <AdminSection
            title={t('Platform')}
            description={t('Live counts across every account.')}
            action={
              <Button variant="outline" size="sm" onClick={status.reload} loading={status.loading}>
                <RefreshCw size={14} />
                {t('Refresh')}
              </Button>
            }
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard
                label={t('Accounts')}
                value={number(data.counts.users.total)}
                detail={
                  data.counts.users.suspended
                    ? t('{count} suspended', { count: number(data.counts.users.suspended) })
                    : t('None suspended')
                }
              />
              <StatCard
                label={t('Websites')}
                value={number(data.counts.sites.total)}
                detail={
                  data.counts.sites.suspended
                    ? t('{count} not collecting', { count: number(data.counts.sites.suspended) })
                    : t('All collecting')
                }
              />
              <StatCard label={t('Environments')} value={number(data.counts.environments)} />
              <StatCard label={t('Active sessions')} value={number(data.counts.activeSessions)} />
            </div>
          </AdminSection>
          <AdminSection
            title={t('Event queue')}
            description={t('Events waiting in Redis before they reach Postgres.')}
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard
                label={t('Pending')}
                value={data.queue.pending === null ? '—' : number(data.queue.pending)}
              />
              <StatCard
                label={t('Failed')}
                value={data.queue.failed === null ? '—' : number(data.queue.failed)}
                tone={data.queue.failed ? 'danger' : 'default'}
              />
            </div>
          </AdminSection>
          <AdminSection title={t('Service')}>
            <dl className="grid grid-cols-2 gap-4 rounded-lg border border-border px-4 py-4 sm:grid-cols-4">
              <div>
                <dt className="text-xs text-secondary-ink">{t('Status')}</dt>
                <dd className="mt-1">
                  <HealthPill
                    ok={data.status === 'ok'}
                    label={data.status === 'ok' ? t('Healthy') : t('Degraded')}
                  />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-secondary-ink">{t('Redis')}</dt>
                <dd className="mt-1">
                  <HealthPill
                    ok={data.dependencies.redis.status === 'ok'}
                    label={data.dependencies.redis.status === 'ok' ? t('Connected') : t('Offline')}
                  />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-secondary-ink">{t('Schema version')}</dt>
                <dd className="mt-1 text-sm tabular-nums">
                  {data.dependencies.database.schemaVersion ?? '—'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-secondary-ink">{t('Build')}</dt>
                <dd className="mt-1 text-sm">
                  {data.service.version} · {data.service.role}
                </dd>
              </div>
            </dl>
          </AdminSection>
          <SentryTest />
        </>
      )}
    </AdminState>
  );
}

function SentryTest() {
  const { t } = useSitePreferences();
  const [busy, setBusy] = useState(false);
  const [eventId, setEventId] = useState<string | null>(null);

  async function sendTest() {
    if (busy) return;
    setBusy(true);
    setEventId(null);

    try {
      const result = await apiClient<{ status: 'queued'; eventId: string }>('/admin/sentry-test', {
        method: 'POST',
      });

      setEventId(result.eventId);
      toast.success(t('Sentry test queued.'));
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdminSection
      title={t('Backend error monitoring')}
      description={t(
        'Queue a harmless backend test issue in Sentry. Limited to once every 30 seconds.',
      )}
      action={
        <Button variant="outline" size="sm" loading={busy} onClick={sendTest}>
          {t('Send Sentry test')}
        </Button>
      }
    >
      <p role="status" className="text-sm break-words text-secondary-ink">
        {eventId
          ? t('Test queued. Search Sentry for event ID {id} to confirm delivery.', { id: eventId })
          : t(
              'Requires Sentry and external effects to be enabled on the backend. No frontend errors are collected.',
            )}
      </p>
    </AdminSection>
  );
}

function AdminAudit() {
  const { dateTime, number, t } = useSitePreferences();

  const first = useAdminResource<{ entries: AdminAuditEntry[]; nextCursor: number | null }>(
    adminAuditPath({ limit: PAGE_SIZE }),
  );

  const [appended, setAppended] = useState<{
    key: string;
    entries: AdminAuditEntry[];
    cursor: number | null;
  } | null>(null);

  const [loadingMore, setLoadingMore] = useState(false);
  // A reload restarts the log, so previously appended pages are dropped with it.
  const active = appended?.key === first.key ? appended : null;
  const entries = [...(first.data?.entries ?? []), ...(active?.entries ?? [])];
  const cursor = active ? active.cursor : (first.data?.nextCursor ?? null);

  async function loadMore() {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);

    try {
      const next = await apiClient<{ entries: AdminAuditEntry[]; nextCursor: number | null }>(
        adminAuditPath({ cursor: String(cursor), limit: PAGE_SIZE }),
      );

      setAppended({
        key: first.key,
        entries: [...(active?.entries ?? []), ...next.entries],
        cursor: next.nextCursor,
      });
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <AdminState error={first.error} loading={first.loading} onRetry={first.reload}>
      {entries.length === 0 ? (
        <AdminEmpty>{t('No administrative actions have been recorded yet.')}</AdminEmpty>
      ) : (
        <ol className="divide-y divide-border rounded-lg border border-border">
          {entries.map((entry) => {
            const copy = auditActionCopy(entry.action);
            const revoked = revokedSessions(entry);

            return (
              <li key={entry.id} className="px-4 py-3.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {copy ? t(copy) : entry.action}
                    <Badge tone="muted">
                      {entry.targetType === 'user' ? t('Account') : t('Website')}
                    </Badge>
                  </p>
                  <time className="text-xs text-secondary-ink" dateTime={entry.createdAt}>
                    {dateTime(entry.createdAt, {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                </div>
                {entry.reason && <p className="mt-1 text-sm break-words">{entry.reason}</p>}
                <p className="mt-1 text-xs break-all text-secondary-ink">
                  {t('Target {id}', { id: entry.targetId })} ·{' '}
                  {t('by {actor}', {
                    actor: entry.actorUserId,
                  })}
                  {revoked > 0 &&
                    ` · ${t('{count} sessions signed out', { count: number(revoked) })}`}
                </p>
              </li>
            );
          })}
        </ol>
      )}
      <LoadMore
        cursor={cursor === null ? null : String(cursor)}
        busy={loadingMore}
        onLoad={loadMore}
      />
    </AdminState>
  );
}

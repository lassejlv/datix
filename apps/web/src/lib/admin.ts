import type { Copy } from './i18n/translations';

/** Mirrors the status filter accepted by /api/admin/users and /api/admin/sites. */
export type AdminStatusFilter = 'all' | 'active' | 'suspended';
export const adminStatusFilters: readonly AdminStatusFilter[] = ['all', 'active', 'suspended'];

export type AdminUser = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: string;
  updatedAt: string;
  suspended: boolean;
  suspensionReason: string | null;
  suspendedAt: string | null;
  suspendedBy: string | null;
  siteCount: number;
  activeSessionCount: number;
};

export type AdminSite = {
  id: string;
  ownerId: string;
  name: string;
  domain: string;
  enabled: boolean;
  allowLocalhost: boolean;
  creditBudget: number | null;
  createdAt: string;
  ownerName: string;
  ownerEmail: string;
  suspended: boolean;
  suspensionReason: string | null;
  suspendedAt: string | null;
  suspendedBy: string | null;
  ownerSuspended: boolean;
  trackingSuspended: boolean;
  environmentCount: number;
};

export type AdminEnvironment = {
  id: string;
  name: string;
  domain: string;
  enabled: boolean;
  allowLocalhost: boolean;
  trackingMode: string;
  createdAt: string;
};

export type AdminAuditEntry = {
  id: number;
  actorUserId: string;
  action: string;
  targetType: 'user' | 'site';
  targetId: string;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type AdminStatus = {
  status: 'ok' | 'degraded';
  service: { name: string; version: string; role: string };
  dependencies: {
    database: { status: string; schemaVersion: number | null };
    redis: { status: string };
  };
  counts: {
    users: { total: number; suspended: number };
    sites: { total: number; suspended: number };
    environments: number;
    activeSessions: number;
  };
  queue: { pending: number | null; failed: number | null };
};

export type AdminUserDetail = { user: AdminUser; sites: AdminSite[]; subscriptions: unknown[] };
export type AdminSiteDetail = { site: AdminSite; environments: AdminEnvironment[] };
export type AdminList<Key extends string, Row> = Record<Key, Row[]> & { nextCursor: string | null };

export type AdminListQuery = {
  search?: string;
  status?: AdminStatusFilter;
  cursor?: string | null;
  limit?: number;
};

/**
 * The API rejects unknown and empty parameters, so only meaningful values are sent.
 * A blank search would fail name validation; the default 'all' status is implied.
 */
export function adminListPath(resource: 'users' | 'sites', query: AdminListQuery = {}): string {
  const params = new URLSearchParams();
  const search = query.search?.trim();
  if (search) params.set('search', search);
  if (query.status && query.status !== 'all') params.set('status', query.status);
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.limit) params.set('limit', String(query.limit));
  const suffix = params.toString();
  return suffix ? `/admin/${resource}?${suffix}` : `/admin/${resource}`;
}

export type AdminAuditQuery = {
  targetType?: 'user' | 'site';
  targetId?: string;
  cursor?: string | null;
  limit?: number;
};

export function adminAuditPath(query: AdminAuditQuery = {}): string {
  const params = new URLSearchParams();
  if (query.targetType) params.set('targetType', query.targetType);
  if (query.targetId) params.set('targetId', query.targetId);
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.limit) params.set('limit', String(query.limit));
  const suffix = params.toString();
  return suffix ? `/admin/audit?${suffix}` : '/admin/audit';
}

const auditActions: Record<string, Copy> = {
  'user.suspended': 'Account suspended',
  'user.restored': 'Account restored',
  'user.suspension_updated': 'Suspension reason updated',
  'site.suspended': 'Website suspended',
  'site.restored': 'Website restored',
  'site.suspension_updated': 'Suspension reason updated',
};

/** Unknown actions are recorded data, so they are shown verbatim rather than translated. */
export function auditActionCopy(action: string): Copy | null {
  return auditActions[action] ?? null;
}

/** Sessions are only revoked when an account is suspended, so zero is not worth reporting. */
export function revokedSessions(entry: AdminAuditEntry): number {
  const value = entry.metadata?.sessionsRevoked;
  return typeof value === 'number' && value > 0 ? value : 0;
}

/** A website stops collecting when either the website itself or its owner is suspended. */
export function suspensionSource(site: AdminSite): 'site' | 'owner' | null {
  if (site.suspended) return 'site';
  return site.ownerSuspended ? 'owner' : null;
}

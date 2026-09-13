import { describe, expect, test } from 'bun:test';
import {
  adminAuditPath,
  adminListPath,
  auditActionCopy,
  revokedSessions,
  suspensionSource,
  type AdminAuditEntry,
  type AdminSite,
} from '../../src/lib/admin';
import { en } from '../../src/lib/i18n/en';

const site = (overrides: Partial<AdminSite>): AdminSite =>
  ({ suspended: false, ownerSuspended: false, ...overrides }) as AdminSite;

const entry = (metadata: AdminAuditEntry['metadata']): AdminAuditEntry =>
  ({ metadata }) as AdminAuditEntry;

describe('administrative list requests', () => {
  test('omits parameters the API rejects and keeps the ones it validates', () => {
    expect(adminListPath('users')).toBe('/admin/users');
    // A blank or whitespace search would fail server-side name validation.
    expect(adminListPath('users', { search: '   ', status: 'all' })).toBe('/admin/users');
    expect(adminListPath('sites', { search: 'acme', status: 'suspended', limit: 25 })).toBe(
      '/admin/sites?search=acme&status=suspended&limit=25',
    );
    expect(adminListPath('users', { cursor: 'user-1', limit: 25 })).toBe(
      '/admin/users?cursor=user-1&limit=25',
    );
  });
  test('escapes values rather than letting them alter the query', () => {
    expect(adminListPath('sites', { search: 'a&b=c d' })).toBe('/admin/sites?search=a%26b%3Dc+d');
  });
  test('audit requests carry only the filters that were asked for', () => {
    expect(adminAuditPath()).toBe('/admin/audit');
    expect(adminAuditPath({ limit: 25 })).toBe('/admin/audit?limit=25');
    expect(adminAuditPath({ targetType: 'site', targetId: 'abc', cursor: '40' })).toBe(
      '/admin/audit?targetType=site&targetId=abc&cursor=40',
    );
  });
});

describe('audit entries', () => {
  test('every known action maps to a translatable sentence', () => {
    for (const action of [
      'user.suspended',
      'user.restored',
      'user.suspension_updated',
      'site.suspended',
      'site.restored',
      'site.suspension_updated',
    ]) {
      const copy = auditActionCopy(action);
      expect(copy, action).not.toBeNull();
      expect(Object.hasOwn(en, copy!), action).toBe(true);
    }
  });
  test('unrecognized actions stay verbatim instead of being mistranslated', () => {
    expect(auditActionCopy('user.exported')).toBeNull();
  });
  test('only a positive revocation count is worth reporting', () => {
    expect(revokedSessions(entry({ sessionsRevoked: 3 }))).toBe(3);
    expect(revokedSessions(entry({ sessionsRevoked: 0 }))).toBe(0);
    expect(revokedSessions(entry({}))).toBe(0);
    expect(revokedSessions(entry(null))).toBe(0);
  });
});

describe('why a website stopped collecting', () => {
  test('its own suspension is reported ahead of the owner’s', () => {
    expect(suspensionSource(site({ suspended: true, ownerSuspended: true }))).toBe('site');
    expect(suspensionSource(site({ suspended: false, ownerSuspended: true }))).toBe('owner');
    expect(suspensionSource(site({}))).toBeNull();
  });
});

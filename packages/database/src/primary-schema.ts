import type { TrackingSettings } from './json-types';
import {
  pgTable,
  text,
  uuid,
  timestamp,
  date,
  boolean,
  bigint,
  integer,
  numeric,
  primaryKey,
  index,
  uniqueIndex,
  check,
  jsonb,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { BillingSubscription } from './json-types';
import type { Baseline, SourceActivity, TrafficWindow, AbuseReason } from './json-types';
import { user } from './auth-schema';
export * from './auth-schema';

export const billingCheckouts = pgTable('billing_checkouts', {
  ownerId: text('owner_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  checkoutId: text('checkout_id').notNull(),
  provider: text('provider').notNull().default('polar'),
  organizationId: uuid('organization_id'),
  planId: text('plan_id'),
  checkoutUrl: text('checkout_url'),
  checkoutOptions: jsonb('checkout_options').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Primary outbox: provider delivery begins only after analytics persistence succeeds.
export const billingOutbox = pgTable(
  'billing_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    eventType: text('event_type').$type<'pageview' | 'event'>().notNull(),
    eventCount: numeric('event_count', { precision: 20, scale: 2, mode: 'number' }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: bigint('attempts', { mode: 'number' }).notNull().default(0),
    leaseId: uuid('lease_id'),
    provider: text('provider').notNull().default('polar'),
    organizationId: uuid('organization_id'),
    deliveryStartedAt: timestamp('delivery_started_at', { withTimezone: true }),
  },
  (t) => [
    index('billing_outbox_available_idx').on(t.availableAt),
    check('billing_outbox_count_check', sql`${t.eventCount} > 0`),
  ],
);

// Keep counters after a website/environment is deleted so deletion cannot reset an allowance.
export const billingUsage = pgTable(
  'billing_usage',
  {
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .default('00000000-0000-0000-0000-000000000000'),
    siteId: uuid('site_id').notNull(),
    periodStart: timestamp('period_start', { withTimezone: true, mode: 'string' }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true, mode: 'string' }).notNull(),
    events: numeric('events', { precision: 20, scale: 2, mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.periodStart, t.siteId] })],
);

// Retired Free ledger retained for migration compatibility. No plan reads or writes it.
export const freeUsage = pgTable(
  'free_usage',
  {
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id').notNull(),
    periodStart: timestamp('period_start', { withTimezone: true, mode: 'string' }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true, mode: 'string' }).notNull(),
    events: numeric('events', { precision: 20, scale: 2, mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.periodStart, t.siteId] })],
);

export const billingCustomers = pgTable(
  'billing_customers',
  {
    customerId: text('customer_id').primaryKey(),
    provider: text('provider').notNull().default('polar'),
    organizationId: uuid('organization_id'),
    syncAttemptedAt: timestamp('sync_attempted_at', { withTimezone: true }).notNull().defaultNow(),
    ownerId: text('owner_id').references(() => user.id, { onDelete: 'set null' }),
    subscriptions: jsonb('subscriptions').$type<BillingSubscription[]>().notNull(),
    deleted: boolean('deleted').notNull().default(false),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('billing_customers_owner_idx').on(t.ownerId)],
);

export const billingWebhookEvents = pgTable('billing_webhook_events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sites = pgTable(
  'sites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    domain: text('domain').notNull(),
    creditBudget: numeric('credit_budget', { precision: 20, scale: 2, mode: 'number' }),
    enabled: boolean('enabled').notNull().default(true),
    allowLocalhost: boolean('allow_localhost').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('sites_owner_idx').on(t.ownerId),
    uniqueIndex('sites_owner_domain_idx').on(t.ownerId, t.domain),
  ],
);

export const environments = pgTable(
  'environments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    trackingSettings: jsonb('tracking_settings')
      .$type<Partial<TrackingSettings>>()
      .notNull()
      .default({}),
    importRevision: bigint('import_revision', { mode: 'number' }).notNull().default(0),
    featureSettings: jsonb('feature_settings')
      .$type<Record<string, boolean>>()
      .notNull()
      .default({}),
    trackingMode: text('tracking_mode')
      .$type<'cookieless' | 'sessions' | 'local'>()
      .notNull()
      .default('cookieless'),
    domain: text('domain').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    allowLocalhost: boolean('allow_localhost').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('environments_site_name_idx').on(t.siteId, sql`lower(${t.name})`)],
);

// Short-lived, server-derived source counters; no IP addresses or event payloads are stored.
export const abuseSources = pgTable(
  'abuse_sources',
  {
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    activity: jsonb('activity').$type<SourceActivity>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.environmentId, t.source] }),
    index('abuse_sources_retention_idx').on(t.updatedAt),
  ],
);

export const abuseEnvironment = pgTable('abuse_environment', {
  environmentId: uuid('environment_id')
    .primaryKey()
    .references(() => environments.id, { onDelete: 'cascade' }),
  baseline: jsonb('baseline').$type<Baseline>().notNull(),
  learnedAt: timestamp('learned_at', { withTimezone: true }).notNull(),
  traffic: jsonb('traffic').$type<TrafficWindow>().notNull(),
});

export const abuseDaily = pgTable(
  'abuse_daily',
  {
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    reason: text('reason').$type<AbuseReason>().notNull(),
    blocked: bigint('blocked', { mode: 'number' }).notNull().default(0),
    lastBlockedAt: timestamp('last_blocked_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.environmentId, t.day, t.reason] }),
    index('abuse_daily_retention_idx').on(t.day),
  ],
);

export const billingOrganizationUsage = pgTable(
  'billing_organization_usage',
  {
    organizationId: uuid('organization_id').notNull(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id').notNull(),
    periodStart: timestamp('period_start', { withTimezone: true, mode: 'string' }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true, mode: 'string' }).notNull(),
    events: numeric('events', { precision: 20, scale: 2, mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.ownerId, t.periodStart, t.siteId] })],
);

export const accountOnboarding = pgTable('account_onboarding', {
  ownerId: text('owner_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
});
export const userSuspensions = pgTable('user_suspensions', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  reason: text('reason').notNull(),
  suspendedAt: timestamp('suspended_at', { withTimezone: true }).notNull().defaultNow(),
  suspendedBy: text('suspended_by').notNull(),
});
export const siteSuspensions = pgTable('site_suspensions', {
  siteId: uuid('site_id')
    .primaryKey()
    .references(() => sites.id, { onDelete: 'cascade' }),
  reason: text('reason').notNull(),
  suspendedAt: timestamp('suspended_at', { withTimezone: true }).notNull().defaultNow(),
  suspendedBy: text('suspended_by').notNull(),
});
export const adminAuditLog = pgTable(
  'admin_audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    actorUserId: text('actor_user_id').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    reason: text('reason'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('admin_audit_target_idx').on(t.targetType, t.targetId, t.id)],
);
export const conversionGoals = pgTable(
  'conversion_goals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    matchType: text('match_type').$type<'event' | 'page'>().notNull(),
    matchValue: text('match_value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('conversion_goals_match_idx').on(t.environmentId, t.matchType, t.matchValue)],
);
export const overviewAnnotations = pgTable(
  'overview_annotations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    label: text('label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('overview_annotations_environment_day_idx').on(t.environmentId, t.day)],
);
export const errorResolutions = pgTable(
  'error_resolutions',
  {
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.environmentId, t.fingerprint] })],
);

// Durable bridge between the two databases. Payloads are cleared after delivery.
export const ingestionReceipts = pgTable(
  'ingestion_receipts',
  {
    environmentId: uuid('environment_id').notNull(),
    eventId: uuid('event_id').notNull(),
    ownerId: text('owner_id').notNull(),
    siteId: uuid('site_id').notNull(),
    periodStart: timestamp('period_start', { withTimezone: true, mode: 'string' }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true, mode: 'string' }).notNull(),
    units: integer('units').notNull(),
    payload: jsonb('payload'),
    state: text('state')
      .$type<'pending' | 'delivered' | 'cancelled'>()
      .notNull()
      .default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.environmentId, t.eventId] }),
    index('ingestion_receipts_pending_idx').on(t.state, t.createdAt),
  ],
);

// Environment removals persist cleanup before deleting their primary rows.
export const analyticsDeletions = pgTable('analytics_deletions', {
  environmentId: uuid('environment_id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

import type { TrackingSettings } from '../lib/tracking-settings';
import {
  pgTable,
  text,
  uuid,
  timestamp,
  date,
  boolean,
  bigint,
  numeric,
  primaryKey,
  index,
  uniqueIndex,
  check,
  jsonb,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { ActivityDetails } from '../lib/session-tracking';
import type { BillingSubscription } from '../billing/types';
import type { Baseline, SourceActivity, TrafficWindow, AbuseReason } from '../abuse/detection';
import { user } from './auth-schema';
export * from './auth-schema';

export const billingCheckouts = pgTable('billing_checkouts', {
  ownerId: text('owner_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  checkoutId: text('checkout_id').notNull(),
});

// Written in the analytics transaction; stable IDs make ambiguous delivery retries safe.
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

// Retain the existing storage keys and column names: site_id now identifies an
// environment. A site's default environment keeps the site's original ID, so
// old snippets, raw events, visitor deduplication and summaries stay unchanged.
export const events = pgTable(
  'events',
  {
    siteId: uuid('site_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    id: uuid('id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    day: date('day').notNull(),
    type: text('type').$type<'pageview' | 'event'>().notNull(),
    name: text('name').notNull(),
    path: text('path').notNull(),
    referrer: text('referrer').notNull(),
    country: text('country').notNull(),
    device: text('device').notNull(),
    visitor: text('visitor').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.id] }),
    index('events_retention_idx').on(t.receivedAt),
    index('events_site_received_idx').on(t.siteId, t.receivedAt),
    check('events_type_check', sql`${t.type} in ('pageview', 'event')`),
  ],
);

export const dailyVisitors = pgTable(
  'daily_visitors',
  {
    siteId: uuid('site_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    visitor: text('visitor').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.day, t.visitor] }),
    index('visitors_retention_idx').on(t.day),
  ],
);

export const dailyStats = pgTable(
  'daily_stats',
  {
    siteId: uuid('site_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    dimension: text('dimension').notNull(),
    value: text('value').notNull(),
    pageviews: bigint('pageviews', { mode: 'number' }).notNull().default(0),
    customEvents: bigint('custom_events', { mode: 'number' }).notNull().default(0),
    visitors: bigint('visitors', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.day, t.dimension, t.value] }),
    index('stats_retention_idx').on(t.day),
  ],
);

export const activityEvents = pgTable(
  'activity_events',
  {
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    id: uuid('id').notNull(),
    sessionKey: text('session_key').notNull(),
    visitorKey: text('visitor_key').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    path: text('path').notNull(),
    referrer: text('referrer').notNull(),
    country: text('country').notNull(),
    device: text('device').notNull(),
    browser: text('browser').notNull(),
    os: text('os').notNull(),
    details: jsonb('details').$type<ActivityDetails>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.environmentId, t.id] }),
    index('activity_environment_received_idx').on(t.environmentId, t.receivedAt),
    index('activity_session_idx').on(t.environmentId, t.sessionKey, t.receivedAt),
    index('activity_retention_idx').on(t.receivedAt),
  ],
);

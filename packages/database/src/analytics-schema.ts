import {
  pgTable,
  text,
  uuid,
  timestamp,
  date,
  bigint,
  primaryKey,
  index,
  uniqueIndex,
  foreignKey,
  check,
  jsonb,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { ActivityDetails } from './json-types';
// Retain the existing storage keys and column names: site_id now identifies an
// environment. A site's default environment keeps the site's original ID, so
// old snippets, raw events, visitor deduplication and summaries stay unchanged.
export const events = pgTable(
  'events',
  {
    siteId: uuid('site_id').notNull(),
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
    primaryKey({ columns: [t.siteId, t.id, t.day] }),
    index('events_retention_idx').on(t.receivedAt),
    index('events_site_received_idx').on(t.siteId, t.receivedAt),
    check('events_type_check', sql`${t.type} in ('pageview', 'event')`),
  ],
);

export const dailyVisitors = pgTable(
  'daily_visitors',
  {
    siteId: uuid('site_id').notNull(),
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
    siteId: uuid('site_id').notNull(),
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
    environmentId: uuid('environment_id').notNull(),
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
    primaryKey({ columns: [t.environmentId, t.id, t.receivedAt] }),
    index('activity_environment_received_idx').on(t.environmentId, t.receivedAt),
    index('activity_session_idx').on(t.environmentId, t.sessionKey, t.receivedAt),
    index('activity_retention_idx').on(t.receivedAt),
  ],
);

export const goalConversions = pgTable(
  'goal_conversions',
  {
    goalId: uuid('goal_id').notNull(),
    environmentId: uuid('environment_id').notNull(),
    eventId: uuid('event_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    day: date('day').notNull(),
    visitor: text('visitor').notNull(),
    path: text('path').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.goalId, t.eventId, t.day] }),
    index('goal_conversions_report_idx').on(t.environmentId, t.receivedAt),
  ],
);
export const diagnosticEvents = pgTable(
  'diagnostic_events',
  {
    environmentId: uuid('environment_id').notNull(),
    id: uuid('id').notNull(),
    pageId: uuid('page_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    kind: text('kind').$type<'error' | 'vital'>().notNull(),
    path: text('path').notNull(),
    device: text('device').notNull(),
    visitor: text('visitor').notNull(),
    fingerprint: text('fingerprint').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.environmentId, t.id, t.receivedAt] }),
    index('diagnostic_events_report_idx').on(t.environmentId, t.kind, t.receivedAt),
  ],
);
export const analyticsImports = pgTable(
  'analytics_imports',
  {
    id: uuid('id').primaryKey(),
    environmentId: uuid('environment_id').notNull(),
    provider: text('provider').$type<'plausible' | 'ga4'>().notNull(),
    sourceTimezone: text('source_timezone').notNull(),
    fingerprint: text('fingerprint').notNull(),
    summary: jsonb('summary').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('analytics_imports_environment_idx').on(t.environmentId, t.createdAt),
    uniqueIndex('analytics_imports_fingerprint_idx').on(t.environmentId, t.fingerprint),
  ],
);
export const importedDailyStats = pgTable(
  'imported_daily_stats',
  {
    environmentId: uuid('environment_id').notNull(),
    day: date('day').notNull(),
    importId: uuid('import_id')
      .notNull()
      .references(() => analyticsImports.id, { onDelete: 'cascade' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    pageviews: bigint('pageviews', { mode: 'number' }).notNull(),
    visitors: bigint('visitors', { mode: 'number' }).notNull(),
    customEvents: bigint('custom_events', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.environmentId, t.day] })],
);
export const importedBreakdowns = pgTable(
  'imported_breakdowns',
  {
    environmentId: uuid('environment_id').notNull(),
    day: date('day').notNull(),
    dimension: text('dimension').notNull(),
    value: text('value').notNull(),
    count: bigint('count', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.environmentId, t.day, t.dimension, t.value] }),
    foreignKey({
      columns: [t.environmentId, t.day],
      foreignColumns: [importedDailyStats.environmentId, importedDailyStats.day],
    }).onDelete('cascade'),
  ],
);

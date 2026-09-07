import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.server';
import { billingCustomers, billingUsage, sites } from '../db/schema';
import { activeAllowance } from './allowance';
import type { AccountUsage, UsagePauseReason } from './types';

type Reader = Pick<Database, 'select'>;
export async function accountAllowance(db: Reader, ownerId: string, now = new Date()) {
  const [customers, websites] = await Promise.all([
    db
      .select({ subscriptions: billingCustomers.subscriptions })
      .from(billingCustomers)
      .where(and(eq(billingCustomers.ownerId, ownerId), eq(billingCustomers.deleted, false))),
    db
      .select({
        id: sites.id,
        name: sites.name,
        domain: sites.domain,
        creditBudget: sites.creditBudget,
        enabled: sql<boolean>`exists (select 1 from environments where site_id = ${sites.id} and enabled = true)`,
      })
      .from(sites)
      .where(eq(sites.ownerId, ownerId))
      .orderBy(sites.createdAt, sites.id),
  ]);
  const allowance = activeAllowance(
    customers.flatMap((customer) => customer.subscriptions),
    now,
  );
  return { allowance, websites };
}

export async function periodUsage(db: Reader, ownerId: string, start: string) {
  return db
    .select({ siteId: billingUsage.siteId, events: billingUsage.events })
    .from(billingUsage)
    .where(and(eq(billingUsage.ownerId, ownerId), eq(billingUsage.periodStart, start)));
}

export async function accountUsage(
  db: Reader,
  ownerId: string,
  now = new Date(),
): Promise<AccountUsage> {
  const { allowance, websites } = await accountAllowance(db, ownerId, now);
  const rows = allowance ? await periodUsage(db, ownerId, allowance.period.start) : [];
  const used = rows.reduce((total, row) => total + Math.round(row.events * 100), 0) / 100;
  const pauseReason: UsagePauseReason | null = !allowance
    ? 'subscription_required'
    : Math.round((allowance.eventLimit - used) * 100) < 15
      ? 'event_limit'
      : null;
  const counts = new Map(rows.map((row) => [row.siteId, row.events]));
  return {
    plan: allowance
      ? {
          name: allowance.name,
          trial: allowance.trial,
          eventLimit: allowance.eventLimit,
          websiteLimit: allowance.websiteLimit,
        }
      : null,
    period: allowance?.period ?? null,
    events: {
      used,
      remaining: Math.max(0, Math.round(((allowance?.eventLimit ?? 0) - used) * 100) / 100),
    },
    paused: pauseReason !== null,
    pauseReason,
    websites: websites.map((site, index) => {
      const reason: UsagePauseReason | null = !site.enabled
        ? 'disabled'
        : (pauseReason ??
          (allowance && index >= allowance.websiteLimit
            ? 'website_limit'
            : site.creditBudget !== null &&
                Math.round((site.creditBudget - (counts.get(site.id) ?? 0)) * 100) < 15
              ? 'website_budget'
              : null));
      return {
        id: site.id,
        name: site.name,
        domain: site.domain,
        events: counts.get(site.id) ?? 0,
        creditBudget: site.creditBudget,
        paused: reason !== null,
        pauseReason: reason,
      };
    }),
  };
}

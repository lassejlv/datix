export type BillingSubscription = {
  entitlements?: {
    name: string;
    eventLimit: number | null;
    websiteLimit: number | null;
    used: number;
    remaining: number | null;
    localBaseline: number;
    pending: number;
    periodStart: string;
    periodEnd: string;
  };
  id: string;
  productId: string;
  status: string;
  currentPeriodStart?: string;
  currentPeriodEnd: string;
  trialEnd: string | null;
  cancelAtPeriodEnd: boolean;
  endsAt: string | null;
};

export type UsagePauseReason =
  | 'agreement_required'
  | 'subscription_required'
  | 'event_limit'
  | 'website_limit'
  | 'website_budget'
  | 'disabled';

export type AccountUsage = {
  onboardingCompleted: boolean;
  protection?: {
    since: string;
    blocked: number;
    reasons: { reason: string; blocked: number }[];
    lastBlockedAt: string | null;
    learning: number;
    learned: number;
  };
  plan: {
    name: string;
    trial: boolean;
    eventLimit: number | null;
    /** Credits included per period; usage beyond them is billed when overage is set. */
    includedEvents: number | null;
    /** Metered price per credit in cents, or null when the plan stops at its limit. */
    overageUnitAmount: string | null;
    websiteLimit: number | null;
  } | null;
  period: { start: string; end: string } | null;
  events: { used: number; remaining: number | null };
  paused: boolean;
  pauseReason: UsagePauseReason | null;
  websites: {
    id: string;
    name: string;
    domain: string;
    events: number;
    creditBudget: number | null;
    paused: boolean;
    pauseReason: UsagePauseReason | null;
  }[];
};

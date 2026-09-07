export type BillingSubscription = {
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
  | 'subscription_required'
  | 'event_limit'
  | 'website_limit'
  | 'website_budget'
  | 'disabled';
export type AccountUsage = {
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
    eventLimit: number;
    websiteLimit: number;
  } | null;
  period: { start: string; end: string } | null;
  events: { used: number; remaining: number };
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

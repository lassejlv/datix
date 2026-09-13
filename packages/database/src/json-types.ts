// JSON columns retained from the Rust API contract. Runtime validation stays in Rust.
export type TrackingSettings = Record<
  | 'pageview'
  | 'custom'
  | 'click'
  | 'outbound'
  | 'download'
  | 'form_submit'
  | 'scroll'
  | 'engagement'
  | 'referrer'
  | 'country'
  | 'device'
  | 'dimensions'
  | 'language'
  | 'coordinates',
  boolean
>;
export type ActivityDetails = {
  clientTime?: number;
  sequence?: number;
  target?: string;
  destination?: string;
  scrollDepth?: number;
  activeSeconds?: number;
  x?: number;
  y?: number;
  viewportWidth: number;
  viewportHeight: number;
  screenWidth: number;
  screenHeight: number;
  language: string;
};
export type Entitlements = {
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
export type BillingSubscription = {
  entitlements?: Entitlements;
  id: string;
  productId: string;
  status: string;
  currentPeriodStart?: string;
  currentPeriodEnd: string;
  trialEnd: string | null;
  cancelAtPeriodEnd: boolean;
  endsAt: string | null;
};

export type Baseline = {
  days: number;
  dailyEvents: number;
  eventsPerVisitor: number;
  customShare: number;
};
export type SourceActivity = {
  minute: number;
  minuteEvents: number;
  minutePageviews: number;
  hour: number;
  hourEvents: number;
  day: number;
  dayEvents: number;
  signature: string;
  repeats: number;
};
export type TrafficWindow = { start: number; events: number; custom: number };
export type AbuseReason = 'source_limit' | 'repeated_activity' | 'unusual_activity';

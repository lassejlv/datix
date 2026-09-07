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
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length
    ? (sorted[middle]! + sorted[Math.max(0, middle - (sorted.length % 2 ? 0 : 1))]!) / 2
    : 0;
};

/** Complete accepted days only. Median resists one-off campaigns and isolated poisoned days. */
export function learnBaseline(
  days: { pageviews: number; customEvents: number; visitors: number; blocked: number }[],
): Baseline {
  const clean = days.filter(
    (day) => day.visitors > 0 && day.pageviews + day.customEvents >= 20 && day.blocked < 50,
  );
  return {
    days: clean.length,
    dailyEvents: median(clean.map((day) => day.pageviews + day.customEvents)),
    eventsPerVisitor: median(clean.map((day) => (day.pageviews + day.customEvents) / day.visitors)),
    customShare: median(clean.map((day) => day.customEvents / (day.pageviews + day.customEvents))),
  };
}

export function detectActivity(input: {
  now: number;
  pageview: boolean;
  signature: string;
  previous?: SourceActivity;
  traffic?: TrafficWindow;
  baseline: Baseline;
}) {
  const { now, previous, baseline, signature, pageview } = input;
  const minute = Math.max(Math.floor(now / 60000), previous?.minute ?? -1);
  const hour = Math.max(Math.floor(now / 3600000), previous?.hour ?? -1);
  const day = Math.max(Math.floor(now / 86400000), previous?.day ?? -1);
  const sameMinute = previous?.minute === minute;
  const source: SourceActivity = {
    minute,
    minuteEvents: (sameMinute ? previous!.minuteEvents : 0) + 1,
    minutePageviews: (sameMinute ? previous!.minutePageviews : 0) + Number(pageview),
    hour,
    hourEvents: (previous?.hour === hour ? previous.hourEvents : 0) + 1,
    day,
    dayEvents: (previous?.day === day ? previous.dayEvents : 0) + 1,
    signature,
    repeats: (sameMinute && previous?.signature === signature ? previous.repeats : 0) + 1,
  };
  const start = Math.floor(now / 300000);
  const traffic = {
    start,
    events: (input.traffic?.start === start ? input.traffic.events : 0) + 1,
    custom: (input.traffic?.start === start ? input.traffic.custom : 0) + Number(!pageview),
  };
  const learned = baseline.days >= 3;
  const typical = learned ? baseline.eventsPerVisitor : 0;
  const hourLimit = Math.min(6000, Math.max(1200, Math.ceil(typical * 40)));
  const dayLimit = Math.min(30000, Math.max(6000, Math.ceil(typical * 200)));
  let reason: AbuseReason | null = null;
  if (
    source.minuteEvents > 180 ||
    source.minutePageviews > 90 ||
    source.hourEvents > hourLimit ||
    source.dayEvents > dayLimit
  )
    reason = 'source_limit';
  else if (source.repeats > (pageview ? 20 : 60)) reason = 'repeated_activity';
  else if (learned && traffic.events > Math.max(300, (baseline.dailyEvents / 288) * 12)) {
    // A traffic spike alone never blocks a source. Require a local automation signal too.
    const reloadLoop = pageview && source.repeats > 10;
    const changedMix =
      !pageview &&
      baseline.customShare < 0.5 &&
      traffic.custom / traffic.events > 0.95 &&
      source.minuteEvents > 30;
    if (reloadLoop || changedMix) reason = 'unusual_activity';
  }
  return { source, traffic, reason };
}

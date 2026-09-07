/** Integer hundredths keep admission and bucket sums exact. Heartbeats are free. */
export function creditUnits(event: {
  type: 'pageview' | 'event';
  localhost?: boolean;
  version: number;
  activity?: { kind: string };
}) {
  if (event.version === 3 && event.activity?.kind === 'engagement') return 0;
  return event.type === 'pageview' ? (event.localhost ? 30 : 100) : event.localhost ? 15 : 50;
}

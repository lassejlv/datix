import type { Activity } from './visitor-journey';

export type JourneyStop = {
  id: string;
  path: string;
  page: Activity | null;
  actions: Activity[];
};

/** Preserve arrival order and repeat visits; a changed action path is context, not a pageview. */
export function journeyStops(events: Activity[]): JourneyStop[] {
  const stops: JourneyStop[] = [];

  for (const event of events) {
    let stop = stops.at(-1);

    if (event.kind === 'pageview' || !stop || stop.path !== event.path) {
      stop = {
        id: event.id,
        path: event.path,
        page: event.kind === 'pageview' ? event : null,
        actions: [],
      };
      stops.push(stop);
    }

    if (event.kind !== 'pageview') stop.actions.push(event);
  }

  return stops;
}

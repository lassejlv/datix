import { onCLS, onINP, onLCP, type Metric } from 'web-vitals';

// Only aggregate metric values leave the page. DOM attribution is deliberately omitted.
export function observe(report: (id: string, name: string, value: number) => void) {
  const receive = (metric: Metric) => report(metric.id, metric.name, metric.value);
  onCLS(receive, { reportAllChanges: false });
  onINP(receive, { reportAllChanges: false });
  onLCP(receive, { reportAllChanges: false });
}

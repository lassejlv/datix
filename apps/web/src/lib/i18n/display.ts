import type { Translate } from './translations';
export function deviceName(value: string, t: Translate): string {
  const labels = {
    desktop: 'Desktop',
    mobile: 'Mobile',
    tablet: 'Tablet',
    unknown: 'Unknown device',
  } as const;
  return t(labels[value.toLowerCase() as keyof typeof labels] ?? 'Unknown device');
}

import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { resolvePreferences } from './preferences';
export const getPreferences = createServerFn().handler(() => {
  const request = getRequest();
  const country =
    request.headers.get('x-analytics-country') ??
    (request as Request & { cf?: { country?: unknown } }).cf?.country;
  return resolvePreferences(
    request.headers.get('cookie') ?? '',
    typeof country === 'string' ? country : undefined,
  );
});

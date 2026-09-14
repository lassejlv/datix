import * as v from 'valibot';

const optionalString = v.optional(
  v.pipe(
    v.unknown(),
    v.transform((value) => (typeof value === 'string' ? value : undefined)),
  ),
);

const optionalAuthMode = v.optional(
  v.pipe(
    v.unknown(),
    v.transform((value) => (value === 'signup' || value === 'signin' ? value : undefined)),
  ),
);

const optionalDate = v.optional(
  v.pipe(
    v.unknown(),
    v.transform((value) =>
      typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined,
    ),
  ),
);

export const landingSearchSchema = v.pipe(
  v.object({
    auth: optionalAuthMode,
    site: optionalString,
    environment: optionalString,
    view: optionalString,
  }),
  v.transform((search) => ({
    auth: search.auth,
    site: search.site,
    environment: search.environment,
    view: search.view,
  })),
);

export const reportSearchSchema = v.pipe(
  v.object({
    from: optionalDate,
    to: optionalDate,
    tab: optionalString,
  }),
  v.transform((search) => ({
    from: search.from,
    to: search.to,
    tab: search.tab,
  })),
);

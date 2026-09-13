import { Schema } from 'effect';
import { invalid } from './errors';
export const Id = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
);
export const Name = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  Schema.isPattern(/\S/),
);
export const Domain = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(253));
export function decode<S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  input: unknown,
): S['Type'] {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(input);
  } catch {
    throw invalid();
  }
}
export const id = (input: unknown) => decode(Id, input);
export function domain(input: string) {
  const host = input.trim().toLowerCase().replace(/\.$/, '');
  if (
    !host ||
    host.includes('/') ||
    host.includes(':') ||
    !/^[a-z0-9.-]+$/.test(host) ||
    host.includes('..')
  )
    throw invalid('Use a hostname without a protocol or path.');
  return host;
}
export const CreateSite = Schema.Struct({ name: Name, domain: Domain });
export const UpdateSite = Schema.Struct({
  name: Schema.optional(Name),
  enabled: Schema.optional(Schema.Boolean),
  allowLocalhost: Schema.optional(Schema.Boolean),
  creditBudget: Schema.optional(
    Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0.15, maximum: 1e9 }))),
  ),
});
const Tracking = Schema.Struct(
  Object.fromEntries(
    [
      'pageview',
      'custom',
      'click',
      'outbound',
      'download',
      'form_submit',
      'scroll',
      'engagement',
      'referrer',
      'country',
      'device',
      'dimensions',
      'language',
      'coordinates',
    ].map((key) => [key, Schema.optional(Schema.Boolean)]),
  ),
);
export const EnvironmentInput = Schema.Struct({
  name: Schema.optional(Name),
  domain: Schema.optional(Domain),
  enabled: Schema.optional(Schema.Boolean),
  allowLocalhost: Schema.optional(Schema.Boolean),
  trackingMode: Schema.optional(Schema.Literals(['cookieless', 'sessions', 'local'])),
  trackingSettings: Schema.optional(Tracking),
  featureSettings: Schema.optional(
    Schema.Struct({
      goals: Schema.optional(Schema.Boolean),
      errors: Schema.optional(Schema.Boolean),
      webVitals: Schema.optional(Schema.Boolean),
    }),
  ),
});

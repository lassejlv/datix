import { Schema } from 'effect';
import original from '../../../../config/polar-catalog.json';
import { Id } from '../shared/validation';
// Sandbox IDs may differ; prices, limits and plan names stay aligned with the unchanged frontend.
const Mapping = Schema.Struct({
  organizationId: Id,
  meterId: Id,
  analyticsBenefitId: Id,
  websitesBenefitId: Id,
  plans: Schema.Record(Schema.String, Schema.Struct({ productId: Id, eventsBenefitId: Id })),
});
function load() {
  if (!process.env.POLAR_SANDBOX_IDS) return original;
  if (process.env.BILLING_STATE_MODE === 'snapshot')
    throw new Error('Sandbox IDs cannot reinterpret copied subscriptions');
  const ids = Schema.decodeUnknownSync(Mapping)(JSON.parse(process.env.POLAR_SANDBOX_IDS));
  if (ids.organizationId === original.organizationId)
    throw new Error('Sandbox must use a separate organization');
  return {
    ...original,
    organizationId: ids.organizationId,
    meter: { ...original.meter, id: ids.meterId },
    analyticsBenefitId: ids.analyticsBenefitId,
    websitesBenefitId: ids.websitesBenefitId,
    plans: original.plans.map((plan) => {
      const mapped = ids.plans[plan.id];
      if (!mapped) throw new Error(`Missing sandbox plan: ${plan.id}`);
      return { ...plan, ...mapped };
    }),
  };
}
export default load();

-- Keep legacy workers' ON CONFLICT(owner_id,period_start,site_id) valid during
-- rollout. The Datix ledger has its own organization-scoped key, so even equal
-- subscription anniversaries cannot merge old and new providers' consumption.
CREATE TABLE billing_organization_usage (
    organization_id uuid NOT NULL,
    owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    site_id uuid NOT NULL,
    period_start timestamptz NOT NULL,
    period_end timestamptz NOT NULL,
    events numeric(20,2) NOT NULL DEFAULT 0,
    PRIMARY KEY(organization_id,owner_id,period_start,site_id)
);
INSERT INTO billing_organization_usage(organization_id,owner_id,site_id,period_start,period_end,events)
    SELECT organization_id,owner_id,site_id,period_start,period_end,events
    FROM billing_usage WHERE organization_id<>'00000000-0000-0000-0000-000000000000';
DELETE FROM billing_usage WHERE organization_id<>'00000000-0000-0000-0000-000000000000';
ALTER TABLE billing_usage DROP CONSTRAINT billing_usage_owner_period_site_organization_pk;
ALTER TABLE billing_usage ADD CONSTRAINT billing_usage_owner_id_period_start_site_id_pk
    PRIMARY KEY(owner_id,period_start,site_id);

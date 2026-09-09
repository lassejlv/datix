-- Scope this integration to the Datix organization. Legacy Polar and Autumn
-- state, checkouts and undelivered usage must never be reused or replayed here.
-- Old binaries still omit organization_id and remain isolated during cutover.
ALTER TABLE billing_customers ADD COLUMN organization_id uuid;
ALTER TABLE billing_outbox ADD COLUMN organization_id uuid;
ALTER TABLE billing_checkouts ADD COLUMN organization_id uuid;
CREATE INDEX billing_customers_polar_sync_idx
    ON billing_customers(organization_id,sync_attempted_at)
    WHERE provider='polar' AND owner_id IS NOT NULL;
CREATE INDEX billing_outbox_polar_available_idx
    ON billing_outbox(organization_id,available_at)
    WHERE provider='polar';

-- Historical usage has no unambiguous organization; retain it under the nil UUID.
ALTER TABLE billing_usage ADD COLUMN organization_id uuid NOT NULL
    DEFAULT '00000000-0000-0000-0000-000000000000';
ALTER TABLE billing_usage DROP CONSTRAINT billing_usage_owner_id_period_start_site_id_pk;
ALTER TABLE billing_usage ADD CONSTRAINT billing_usage_owner_period_site_organization_pk
    PRIMARY KEY(owner_id,period_start,site_id,organization_id);

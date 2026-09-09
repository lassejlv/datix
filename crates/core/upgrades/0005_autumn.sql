-- Retain Polar history; never send its undelivered usage to a different provider.
ALTER TABLE billing_customers ADD COLUMN provider text NOT NULL DEFAULT 'polar';
ALTER TABLE billing_customers ALTER COLUMN provider SET DEFAULT 'autumn';
ALTER TABLE billing_customers ADD COLUMN sync_attempted_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX billing_customers_sync_idx ON billing_customers(sync_attempted_at) WHERE provider='autumn' AND owner_id IS NOT NULL;
ALTER TABLE billing_outbox ADD COLUMN provider text NOT NULL DEFAULT 'polar';
ALTER TABLE billing_outbox ALTER COLUMN provider SET DEFAULT 'autumn';
ALTER TABLE billing_outbox ADD COLUMN delivery_started_at timestamptz;
ALTER TABLE billing_checkouts ADD COLUMN provider text NOT NULL DEFAULT 'polar';
ALTER TABLE billing_checkouts ALTER COLUMN provider SET DEFAULT 'autumn';
ALTER TABLE billing_checkouts ADD COLUMN plan_id text;
ALTER TABLE billing_checkouts ADD COLUMN checkout_url text;
ALTER TABLE billing_checkouts ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

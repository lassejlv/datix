-- Do not reuse a checkout created for another locale or payment configuration.
ALTER TABLE billing_checkouts ADD COLUMN checkout_options jsonb NOT NULL DEFAULT '{}'::jsonb;

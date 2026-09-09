-- Old binaries omit provider. Keep their writes isolated during a rolling cutover.
ALTER TABLE billing_customers ALTER COLUMN provider SET DEFAULT 'polar';
ALTER TABLE billing_outbox ALTER COLUMN provider SET DEFAULT 'polar';
ALTER TABLE billing_checkouts ALTER COLUMN provider SET DEFAULT 'polar';

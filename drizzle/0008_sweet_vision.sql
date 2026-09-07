ALTER TABLE "billing_outbox" ALTER COLUMN "event_count" SET DATA TYPE numeric(20, 2);--> statement-breakpoint
ALTER TABLE "billing_usage" ALTER COLUMN "events" SET DATA TYPE numeric(20, 2);--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "tracking_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;
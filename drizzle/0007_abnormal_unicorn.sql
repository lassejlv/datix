CREATE TABLE "billing_checkouts" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"checkout_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"event_type" text NOT NULL,
	"event_count" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"lease_id" uuid,
	CONSTRAINT "billing_outbox_count_check" CHECK ("billing_outbox"."event_count" > 0)
);
--> statement-breakpoint
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_outbox" ADD CONSTRAINT "billing_outbox_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_outbox_available_idx" ON "billing_outbox" USING btree ("available_at");
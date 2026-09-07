SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "activity_events" (
	"environment_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"session_key" text NOT NULL,
	"visitor_key" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"referrer" text NOT NULL,
	"country" text NOT NULL,
	"device" text NOT NULL,
	"browser" text NOT NULL,
	"os" text NOT NULL,
	"details" jsonb NOT NULL,
	CONSTRAINT "activity_events_environment_id_id_pk" PRIMARY KEY("environment_id","id")
);
--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "tracking_mode" text DEFAULT 'cookieless' NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_environment_received_idx" ON "activity_events" USING btree ("environment_id","received_at");--> statement-breakpoint
CREATE INDEX "activity_session_idx" ON "activity_events" USING btree ("environment_id","session_key","received_at");--> statement-breakpoint
CREATE INDEX "activity_retention_idx" ON "activity_events" USING btree ("received_at");
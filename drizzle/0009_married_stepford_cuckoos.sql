CREATE TABLE "abuse_daily" (
	"environment_id" uuid NOT NULL,
	"day" date NOT NULL,
	"reason" text NOT NULL,
	"blocked" bigint DEFAULT 0 NOT NULL,
	"last_blocked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "abuse_daily_environment_id_day_reason_pk" PRIMARY KEY("environment_id","day","reason")
);
--> statement-breakpoint
CREATE TABLE "abuse_environment" (
	"environment_id" uuid PRIMARY KEY NOT NULL,
	"baseline" jsonb NOT NULL,
	"learned_at" timestamp with time zone NOT NULL,
	"traffic" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "abuse_sources" (
	"environment_id" uuid NOT NULL,
	"source" text NOT NULL,
	"activity" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "abuse_sources_environment_id_source_pk" PRIMARY KEY("environment_id","source")
);
--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "credit_budget" numeric(20, 2);--> statement-breakpoint
ALTER TABLE "abuse_daily" ADD CONSTRAINT "abuse_daily_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abuse_environment" ADD CONSTRAINT "abuse_environment_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abuse_sources" ADD CONSTRAINT "abuse_sources_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "abuse_daily_retention_idx" ON "abuse_daily" USING btree ("day");--> statement-breakpoint
CREATE INDEX "abuse_sources_retention_idx" ON "abuse_sources" USING btree ("updated_at");
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
CREATE TABLE "account_onboarding" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "admin_audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_user_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_deletions" (
	"environment_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_checkouts" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"checkout_id" text NOT NULL,
	"provider" text DEFAULT 'polar' NOT NULL,
	"organization_id" uuid,
	"plan_id" text,
	"checkout_url" text,
	"checkout_options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_customers" (
	"customer_id" text PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'polar' NOT NULL,
	"organization_id" uuid,
	"sync_attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"owner_id" text,
	"subscriptions" jsonb NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_organization_usage" (
	"organization_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"site_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"events" numeric(20, 2) DEFAULT 0 NOT NULL,
	CONSTRAINT "billing_organization_usage_organization_id_owner_id_period_start_site_id_pk" PRIMARY KEY("organization_id","owner_id","period_start","site_id")
);
--> statement-breakpoint
CREATE TABLE "billing_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"event_type" text NOT NULL,
	"event_count" numeric(20, 2) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"lease_id" uuid,
	"provider" text DEFAULT 'polar' NOT NULL,
	"organization_id" uuid,
	"delivery_started_at" timestamp with time zone,
	CONSTRAINT "billing_outbox_count_check" CHECK ("billing_outbox"."event_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "billing_usage" (
	"owner_id" text NOT NULL,
	"organization_id" uuid DEFAULT '00000000-0000-0000-0000-000000000000' NOT NULL,
	"site_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"events" numeric(20, 2) DEFAULT 0 NOT NULL,
	CONSTRAINT "billing_usage_owner_id_period_start_site_id_pk" PRIMARY KEY("owner_id","period_start","site_id")
);
--> statement-breakpoint
CREATE TABLE "billing_webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversion_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"name" text NOT NULL,
	"match_type" text NOT NULL,
	"match_value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"name" text NOT NULL,
	"tracking_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"import_revision" bigint DEFAULT 0 NOT NULL,
	"feature_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tracking_mode" text DEFAULT 'cookieless' NOT NULL,
	"domain" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"allow_localhost" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "error_resolutions" (
	"environment_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "error_resolutions_environment_id_fingerprint_pk" PRIMARY KEY("environment_id","fingerprint")
);
--> statement-breakpoint
CREATE TABLE "free_usage" (
	"owner_id" text NOT NULL,
	"site_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"events" numeric(20, 2) DEFAULT 0 NOT NULL,
	CONSTRAINT "free_usage_owner_id_period_start_site_id_pk" PRIMARY KEY("owner_id","period_start","site_id")
);
--> statement-breakpoint
CREATE TABLE "ingestion_receipts" (
	"environment_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"site_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"units" integer NOT NULL,
	"payload" jsonb,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingestion_receipts_environment_id_event_id_pk" PRIMARY KEY("environment_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "overview_annotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"day" date NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_suspensions" (
	"site_id" uuid PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"suspended_at" timestamp with time zone DEFAULT now() NOT NULL,
	"suspended_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"credit_budget" numeric(20, 2),
	"enabled" boolean DEFAULT true NOT NULL,
	"allow_localhost" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_suspensions" (
	"user_id" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"suspended_at" timestamp with time zone DEFAULT now() NOT NULL,
	"suspended_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
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
	CONSTRAINT "activity_events_environment_id_id_received_at_pk" PRIMARY KEY("environment_id","id","received_at")
);
--> statement-breakpoint
CREATE TABLE "analytics_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"environment_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"source_timezone" text NOT NULL,
	"fingerprint" text NOT NULL,
	"summary" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_stats" (
	"site_id" uuid NOT NULL,
	"day" date NOT NULL,
	"dimension" text NOT NULL,
	"value" text NOT NULL,
	"pageviews" bigint DEFAULT 0 NOT NULL,
	"custom_events" bigint DEFAULT 0 NOT NULL,
	"visitors" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "daily_stats_site_id_day_dimension_value_pk" PRIMARY KEY("site_id","day","dimension","value")
);
--> statement-breakpoint
CREATE TABLE "daily_visitors" (
	"site_id" uuid NOT NULL,
	"day" date NOT NULL,
	"visitor" text NOT NULL,
	CONSTRAINT "daily_visitors_site_id_day_visitor_pk" PRIMARY KEY("site_id","day","visitor")
);
--> statement-breakpoint
CREATE TABLE "diagnostic_events" (
	"environment_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"path" text NOT NULL,
	"device" text NOT NULL,
	"visitor" text NOT NULL,
	"fingerprint" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "diagnostic_events_environment_id_id_received_at_pk" PRIMARY KEY("environment_id","id","received_at")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"site_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"day" date NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"referrer" text NOT NULL,
	"country" text NOT NULL,
	"device" text NOT NULL,
	"visitor" text NOT NULL,
	CONSTRAINT "events_site_id_id_day_pk" PRIMARY KEY("site_id","id","day"),
	CONSTRAINT "events_type_check" CHECK ("events"."type" in ('pageview', 'event'))
);
--> statement-breakpoint
CREATE TABLE "goal_conversions" (
	"goal_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"day" date NOT NULL,
	"visitor" text NOT NULL,
	"path" text NOT NULL,
	CONSTRAINT "goal_conversions_goal_id_event_id_day_pk" PRIMARY KEY("goal_id","event_id","day")
);
--> statement-breakpoint
CREATE TABLE "imported_breakdowns" (
	"environment_id" uuid NOT NULL,
	"day" date NOT NULL,
	"dimension" text NOT NULL,
	"value" text NOT NULL,
	"count" bigint NOT NULL,
	CONSTRAINT "imported_breakdowns_environment_id_day_dimension_value_pk" PRIMARY KEY("environment_id","day","dimension","value")
);
--> statement-breakpoint
CREATE TABLE "imported_daily_stats" (
	"environment_id" uuid NOT NULL,
	"day" date NOT NULL,
	"import_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"pageviews" bigint NOT NULL,
	"visitors" bigint NOT NULL,
	"custom_events" bigint NOT NULL,
	CONSTRAINT "imported_daily_stats_environment_id_day_pk" PRIMARY KEY("environment_id","day")
);
--> statement-breakpoint
ALTER TABLE "abuse_daily" ADD CONSTRAINT "abuse_daily_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abuse_environment" ADD CONSTRAINT "abuse_environment_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abuse_sources" ADD CONSTRAINT "abuse_sources_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_onboarding" ADD CONSTRAINT "account_onboarding_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customers_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_organization_usage" ADD CONSTRAINT "billing_organization_usage_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_outbox" ADD CONSTRAINT "billing_outbox_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_usage" ADD CONSTRAINT "billing_usage_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_goals" ADD CONSTRAINT "conversion_goals_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_resolutions" ADD CONSTRAINT "error_resolutions_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "free_usage" ADD CONSTRAINT "free_usage_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overview_annotations" ADD CONSTRAINT "overview_annotations_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_suspensions" ADD CONSTRAINT "site_suspensions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_suspensions" ADD CONSTRAINT "user_suspensions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_breakdowns" ADD CONSTRAINT "imported_breakdowns_environment_id_day_imported_daily_stats_environment_id_day_fk" FOREIGN KEY ("environment_id","day") REFERENCES "public"."imported_daily_stats"("environment_id","day") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imported_daily_stats" ADD CONSTRAINT "imported_daily_stats_import_id_analytics_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."analytics_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "abuse_daily_retention_idx" ON "abuse_daily" USING btree ("day");--> statement-breakpoint
CREATE INDEX "abuse_sources_retention_idx" ON "abuse_sources" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "admin_audit_target_idx" ON "admin_audit_log" USING btree ("target_type","target_id","id");--> statement-breakpoint
CREATE INDEX "billing_customers_owner_idx" ON "billing_customers" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "billing_outbox_available_idx" ON "billing_outbox" USING btree ("available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversion_goals_match_idx" ON "conversion_goals" USING btree ("environment_id","match_type","match_value");--> statement-breakpoint
CREATE UNIQUE INDEX "environments_site_name_idx" ON "environments" USING btree ("site_id",lower("name"));--> statement-breakpoint
CREATE INDEX "ingestion_receipts_pending_idx" ON "ingestion_receipts" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "overview_annotations_environment_day_idx" ON "overview_annotations" USING btree ("environment_id","day");--> statement-breakpoint
CREATE INDEX "sites_owner_idx" ON "sites" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sites_owner_domain_idx" ON "sites" USING btree ("owner_id","domain");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "activity_environment_received_idx" ON "activity_events" USING btree ("environment_id","received_at");--> statement-breakpoint
CREATE INDEX "activity_session_idx" ON "activity_events" USING btree ("environment_id","session_key","received_at");--> statement-breakpoint
CREATE INDEX "activity_retention_idx" ON "activity_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "analytics_imports_environment_idx" ON "analytics_imports" USING btree ("environment_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_imports_fingerprint_idx" ON "analytics_imports" USING btree ("environment_id","fingerprint");--> statement-breakpoint
CREATE INDEX "stats_retention_idx" ON "daily_stats" USING btree ("day");--> statement-breakpoint
CREATE INDEX "visitors_retention_idx" ON "daily_visitors" USING btree ("day");--> statement-breakpoint
CREATE INDEX "diagnostic_events_report_idx" ON "diagnostic_events" USING btree ("environment_id","kind","received_at");--> statement-breakpoint
CREATE INDEX "events_retention_idx" ON "events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "events_site_received_idx" ON "events" USING btree ("site_id","received_at");--> statement-breakpoint
CREATE INDEX "goal_conversions_report_idx" ON "goal_conversions" USING btree ("environment_id","received_at");
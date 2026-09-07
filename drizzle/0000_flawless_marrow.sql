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
	CONSTRAINT "events_site_id_id_pk" PRIMARY KEY("site_id","id"),
	CONSTRAINT "events_type_check" CHECK ("events"."type" in ('pageview', 'event'))
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
ALTER TABLE "daily_stats" ADD CONSTRAINT "daily_stats_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_visitors" ADD CONSTRAINT "daily_visitors_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stats_retention_idx" ON "daily_stats" USING btree ("day");--> statement-breakpoint
CREATE INDEX "visitors_retention_idx" ON "daily_visitors" USING btree ("day");--> statement-breakpoint
CREATE INDEX "events_retention_idx" ON "events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "sites_owner_idx" ON "sites" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sites_owner_domain_idx" ON "sites" USING btree ("owner_id","domain");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");
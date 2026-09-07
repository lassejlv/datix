-- Keep existing IDs, summaries and old writers valid throughout this migration.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
LOCK TABLE "sites" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"allow_localhost" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "daily_stats" DROP CONSTRAINT "daily_stats_site_id_sites_id_fk";
--> statement-breakpoint
ALTER TABLE "daily_visitors" DROP CONSTRAINT "daily_visitors_site_id_sites_id_fk";
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_site_id_sites_id_fk";
--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "environments_site_name_idx" ON "environments" USING btree ("site_id",lower("name"));--> statement-breakpoint
INSERT INTO "environments" ("id", "site_id", "name", "domain", "enabled", "allow_localhost", "created_at")
SELECT "id", "id", 'Production', "domain", "enabled", "allow_localhost", "created_at" FROM "sites";
--> statement-breakpoint
-- Old deployed workers and legacy API clients still write the default settings
-- on sites. Preserve that path, including sites created during a rolling deploy.
CREATE FUNCTION public.sync_default_environment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.environments (id, site_id, name, domain, enabled, allow_localhost, created_at)
  VALUES (NEW.id, NEW.id, 'Production', NEW.domain, NEW.enabled, NEW.allow_localhost, NEW.created_at)
  ON CONFLICT (id) DO UPDATE SET
    domain = EXCLUDED.domain, enabled = EXCLUDED.enabled, allow_localhost = EXCLUDED.allow_localhost;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sites_default_environment
AFTER INSERT OR UPDATE OF domain, enabled, allow_localhost ON public.sites
FOR EACH ROW EXECUTE FUNCTION public.sync_default_environment();
--> statement-breakpoint
ALTER TABLE "daily_stats" ADD CONSTRAINT "daily_stats_site_id_environments_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_visitors" ADD CONSTRAINT "daily_visitors_site_id_environments_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_site_id_environments_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;
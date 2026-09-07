CREATE TABLE "free_usage" (
	"owner_id" text NOT NULL,
	"site_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"events" numeric(20, 2) DEFAULT 0 NOT NULL,
	CONSTRAINT "free_usage_owner_id_period_start_site_id_pk" PRIMARY KEY("owner_id","period_start","site_id")
);
--> statement-breakpoint
ALTER TABLE "free_usage" ADD CONSTRAINT "free_usage_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
CREATE EXTENSION IF NOT EXISTS timescaledb;
--> statement-breakpoint
SELECT create_hypertable('public.events', 'day', chunk_time_interval => INTERVAL '7 days');
--> statement-breakpoint
SELECT create_hypertable('public.activity_events', 'received_at', chunk_time_interval => INTERVAL '1 days');
--> statement-breakpoint
SELECT create_hypertable('public.diagnostic_events', 'received_at', chunk_time_interval => INTERVAL '1 days');
--> statement-breakpoint
SELECT create_hypertable('public.goal_conversions', 'day', chunk_time_interval => INTERVAL '7 days');
--> statement-breakpoint
SELECT create_hypertable('public.daily_stats', 'day', chunk_time_interval => INTERVAL '30 days');
--> statement-breakpoint
SELECT create_hypertable('public.daily_visitors', 'day', chunk_time_interval => INTERVAL '30 days');
--> statement-breakpoint
-- Keep default-environment compatibility and durable cleanup inside the primary transaction.
CREATE FUNCTION datix_default_environment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO environments (id,site_id,name,domain,enabled,allow_localhost,created_at)
  VALUES (NEW.id,NEW.id,'Production',NEW.domain,NEW.enabled,NEW.allow_localhost,NEW.created_at)
  ON CONFLICT(id) DO UPDATE SET domain=excluded.domain,enabled=excluded.enabled,allow_localhost=excluded.allow_localhost;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sites_default_environment AFTER INSERT OR UPDATE OF domain,enabled,allow_localhost ON sites
  FOR EACH ROW EXECUTE FUNCTION datix_default_environment();
--> statement-breakpoint
CREATE FUNCTION datix_delete_environment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO analytics_deletions(environment_id) VALUES(OLD.id) ON CONFLICT DO NOTHING;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER environments_analytics_cleanup AFTER DELETE ON environments
  FOR EACH ROW EXECUTE FUNCTION datix_delete_environment();

--> statement-breakpoint
-- Serialize login with administrator suspension, including sessions created by OAuth.
CREATE FUNCTION datix_session_access_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM public."user" WHERE id=NEW.user_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.user_suspensions WHERE user_id=NEW.user_id) THEN
    RAISE EXCEPTION 'Account suspended' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER datix_session_access BEFORE INSERT ON public.session
FOR EACH ROW EXECUTE FUNCTION datix_session_access_guard();

--> statement-breakpoint
-- Only fixed retention operations are exposed to the runtime role.
CREATE FUNCTION public.datix_retention() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.drop_chunks('public.events', older_than => (current_date-730));
  PERFORM public.drop_chunks('public.activity_events', older_than => now()-interval '30 days');
  PERFORM public.drop_chunks('public.diagnostic_events', older_than => now()-interval '30 days');
  PERFORM public.drop_chunks('public.goal_conversions', older_than => (current_date-730));
  PERFORM public.drop_chunks('public.daily_stats', older_than => (current_date-730));
  PERFORM public.drop_chunks('public.daily_visitors', older_than => (current_date-730));
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.datix_retention() FROM PUBLIC;

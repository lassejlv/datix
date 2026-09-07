-- Atomic conversion. The original tables remain available for rollback and retain their deletion FKs.
CREATE TABLE analytics_partitions (
    parent_name text NOT NULL CHECK(parent_name IN ('events','activity_events')),
    partition_name text PRIMARY KEY,
    lower_bound timestamptz NOT NULL,
    upper_bound timestamptz NOT NULL,
    CHECK(upper_bound>lower_bound)
);
CREATE TABLE events_v3 (LIKE events INCLUDING DEFAULTS INCLUDING CONSTRAINTS) PARTITION BY RANGE(received_at);
ALTER TABLE events_v3 ADD PRIMARY KEY(site_id,id,received_at);
ALTER TABLE events_v3 ADD FOREIGN KEY(site_id) REFERENCES environments(id) ON DELETE CASCADE;
CREATE TABLE activity_events_v3 (LIKE activity_events INCLUDING DEFAULTS INCLUDING CONSTRAINTS) PARTITION BY RANGE(received_at);
ALTER TABLE activity_events_v3 ADD PRIMARY KEY(environment_id,id,received_at);
ALTER TABLE activity_events_v3 ADD FOREIGN KEY(environment_id) REFERENCES environments(id) ON DELETE CASCADE;

DO $$
DECLARE parent text; part text; lower_at timestamptz; upper_at timestamptz; day date;
BEGIN
    FOREACH parent IN ARRAY ARRAY['events','activity_events'] LOOP
        FOR offset_day IN -30..7 LOOP
            day:=(now() AT TIME ZONE 'UTC')::date+offset_day;
            lower_at:=day::timestamp AT TIME ZONE 'UTC'; upper_at:=(day+1)::timestamp AT TIME ZONE 'UTC';
            part:=parent||'_p'||to_char(day,'YYYYMMDD');
            EXECUTE format('CREATE TABLE public.%I PARTITION OF public.%I FOR VALUES FROM (%L) TO (%L)',part,parent||'_v3',lower_at,upper_at);
            INSERT INTO public.analytics_partitions VALUES(parent,part,lower_at,upper_at);
        END LOOP;
        EXECUTE format('CREATE TABLE public.%I PARTITION OF public.%I DEFAULT',parent||'_default',parent||'_v3');
    END LOOP;
END $$;

INSERT INTO events_v3 SELECT * FROM events;
INSERT INTO activity_events_v3 SELECT * FROM activity_events;
DO $$ BEGIN
    IF EXISTS(SELECT * FROM events EXCEPT ALL SELECT * FROM events_v3)
      OR EXISTS(SELECT * FROM events_v3 EXCEPT ALL SELECT * FROM events)
      OR EXISTS(SELECT * FROM activity_events EXCEPT ALL SELECT * FROM activity_events_v3)
      OR EXISTS(SELECT * FROM activity_events_v3 EXCEPT ALL SELECT * FROM activity_events)
    THEN RAISE EXCEPTION 'Partition copy verification failed'; END IF;
END $$;

DROP TRIGGER analytics_record_session ON events;
DROP TRIGGER analytics_claim_event ON events;
DROP TRIGGER analytics_claim_activity ON activity_events;
ALTER TABLE events RENAME TO events_unpartitioned_backup;
ALTER TABLE activity_events RENAME TO activity_events_unpartitioned_backup;
ALTER TABLE events_v3 RENAME TO events;
ALTER TABLE activity_events_v3 RENAME TO activity_events;

CREATE INDEX events_time_idx ON events(received_at);
CREATE INDEX events_site_time_idx ON events(site_id,received_at);
CREATE INDEX events_site_visitor_time_idx ON events(site_id,visitor,received_at,id);
CREATE INDEX activity_time_idx ON activity_events(received_at);
CREATE INDEX activity_environment_time_idx ON activity_events(environment_id,received_at);
CREATE INDEX activity_session_time_idx ON activity_events(environment_id,session_key,received_at,id);
CREATE INDEX activity_visitor_time_idx ON activity_events(environment_id,visitor_key,received_at,id);
CREATE TRIGGER analytics_claim_event BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION analytics_claim_event('events');
CREATE TRIGGER analytics_claim_activity BEFORE INSERT ON activity_events FOR EACH ROW EXECUTE FUNCTION analytics_claim_event('activity');
CREATE CONSTRAINT TRIGGER analytics_record_session AFTER INSERT ON events
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION analytics_record_session();

-- Hard-coded parents, verified inheritance and UTC boundaries constrain this owner's maintenance capability.
CREATE FUNCTION analytics_partition_maintenance() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' SET lock_timeout='2s' AS $$
DECLARE parent text; part text; day date; lower_at timestamptz; upper_at timestamptz; old record;
    created integer:=0; dropped integer:=0;
BEGIN
    IF NOT pg_try_advisory_xact_lock(732806231) THEN RETURN jsonb_build_object('busy',true); END IF;
    FOREACH parent IN ARRAY ARRAY['events','activity_events'] LOOP
        FOR offset_day IN -30..7 LOOP
            day:=(now() AT TIME ZONE 'UTC')::date+offset_day;
            lower_at:=day::timestamp AT TIME ZONE 'UTC'; upper_at:=(day+1)::timestamp AT TIME ZONE 'UTC';
            part:=parent||'_p'||to_char(day,'YYYYMMDD');
            IF NOT EXISTS(SELECT 1 FROM public.analytics_partitions WHERE partition_name=part) THEN
                -- A worker outage can leave valid rows in DEFAULT. Move them before attaching a new day.
                EXECUTE format('LOCK TABLE public.%I IN SHARE ROW EXCLUSIVE MODE',parent);
                EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE',parent||'_default');
                EXECUTE format('CREATE TABLE public.%I (LIKE public.%I INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)',part,parent);
                EXECUTE format('ALTER TABLE public.%I ADD CHECK(received_at >= %L::timestamptz AND received_at < %L::timestamptz)',part,lower_at,upper_at);
                EXECUTE format('WITH moved AS (DELETE FROM ONLY public.%I WHERE received_at >= %L::timestamptz AND received_at < %L::timestamptz RETURNING *) INSERT INTO public.%I SELECT * FROM moved',parent||'_default',lower_at,upper_at,part);
                EXECUTE format('ALTER TABLE public.%I ATTACH PARTITION public.%I FOR VALUES FROM (%L) TO (%L)',parent,part,lower_at,upper_at);
                INSERT INTO public.analytics_partitions VALUES(parent,part,lower_at,upper_at);
                created:=created+1;
            END IF;
        END LOOP;
    END LOOP;
    FOR old IN SELECT * FROM public.analytics_partitions WHERE upper_bound<=now()-interval '30 days' ORDER BY upper_bound LOOP
        IF old.partition_name<>old.parent_name||'_p'||to_char(old.lower_bound AT TIME ZONE 'UTC','YYYYMMDD')
          OR NOT EXISTS(SELECT 1 FROM pg_inherits WHERE inhparent=to_regclass('public.'||old.parent_name) AND inhrelid=to_regclass('public.'||old.partition_name))
        THEN RAISE EXCEPTION 'Invalid analytics partition registration'; END IF;
        EXECUTE format('DROP TABLE public.%I',old.partition_name);
        DELETE FROM public.analytics_partitions WHERE partition_name=old.partition_name;
        dropped:=dropped+1;
    END LOOP;
    RETURN jsonb_build_object('created',created,'dropped',dropped);
END $$;
REVOKE ALL ON FUNCTION analytics_partition_maintenance() FROM PUBLIC;
DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='analytics_runtime') THEN
        GRANT SELECT,INSERT,UPDATE,DELETE ON events,activity_events TO analytics_runtime;
        GRANT SELECT ON analytics_partitions TO analytics_runtime;
        GRANT EXECUTE ON FUNCTION analytics_partition_maintenance() TO analytics_runtime;
    END IF;
END $$;

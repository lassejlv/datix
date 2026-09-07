-- Additive changes remain compatible with the preceding Rust writer during rollout.
CREATE TABLE event_receipts (
    environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    id uuid NOT NULL,
    kind smallint NOT NULL CHECK (kind IN (0,1)),
    received_at timestamptz NOT NULL,
    PRIMARY KEY (environment_id,id,kind)
);
CREATE INDEX event_receipts_retention_idx ON event_receipts(received_at);
INSERT INTO event_receipts SELECT site_id,id,0,received_at FROM events;
INSERT INTO event_receipts SELECT environment_id,id,1,received_at FROM activity_events;

CREATE FUNCTION analytics_claim_event() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE environment uuid; event_kind smallint;
BEGIN
    IF TG_ARGV[0]='events' THEN environment:=NEW.site_id; event_kind:=0;
    ELSE environment:=NEW.environment_id; event_kind:=1; END IF;
    INSERT INTO public.event_receipts(environment_id,id,kind,received_at)
      VALUES(environment,NEW.id,event_kind,NEW.received_at) ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN RETURN NULL; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER analytics_claim_event BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION analytics_claim_event('events');
CREATE TRIGGER analytics_claim_activity BEFORE INSERT ON activity_events FOR EACH ROW EXECUTE FUNCTION analytics_claim_event('activity');

CREATE TABLE session_days (
    environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    day date NOT NULL,
    session_key text NOT NULL,
    visitor_key text NOT NULL,
    daily boolean NOT NULL,
    started_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL,
    pageviews bigint NOT NULL,
    clicks bigint NOT NULL,
    events bigint NOT NULL,
    active_seconds bigint NOT NULL,
    entry_path text NOT NULL,
    entry_at timestamptz NOT NULL,
    entry_sequence integer NOT NULL,
    entry_event uuid NOT NULL,
    country text NOT NULL,
    device text NOT NULL,
    first_received_at timestamptz NOT NULL,
    first_event uuid NOT NULL,
    PRIMARY KEY(environment_id,day,session_key,visitor_key)
);
CREATE INDEX session_days_visitor_idx ON session_days(environment_id,visitor_key,day);
CREATE INDEX session_days_retention_idx ON session_days(day);

CREATE FUNCTION analytics_record_session() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE a record; moment timestamptz; sequence integer; session_id text; visitor_id text;
    event_kind text; seconds bigint; event_path text; event_country text; event_device text;
    received timestamptz;
BEGIN
    -- A row can be deleted again in its insertion transaction (for example account deletion).
    IF NOT EXISTS(SELECT 1 FROM public.events WHERE site_id=NEW.site_id AND id=NEW.id) THEN RETURN NULL; END IF;
    SELECT * INTO a FROM public.activity_events WHERE environment_id=NEW.site_id AND id=NEW.id LIMIT 1;
    IF FOUND THEN
        session_id:=a.session_key; visitor_id:=a.visitor_key; event_kind:=a.kind;
        received:=a.received_at;
        moment:=to_timestamp(coalesce((a.details->>'clientTime')::bigint,(extract(epoch FROM received)*1000)::bigint)/1000.0);
        sequence:=coalesce((a.details->>'sequence')::integer,0);
        seconds:=coalesce((a.details->>'activeSeconds')::bigint,0);
        event_path:=a.path; event_country:=a.country; event_device:=a.device;
    ELSE
        session_id:=NEW.visitor; visitor_id:=NEW.visitor;
        event_kind:=CASE WHEN NEW.type='pageview' THEN 'pageview' ELSE 'custom' END;
        received:=NEW.received_at; moment:=to_timestamp((extract(epoch FROM received)*1000)::bigint/1000.0); sequence:=0; seconds:=0;
        event_path:=NEW.path; event_country:=NEW.country; event_device:=NEW.device;
    END IF;
    INSERT INTO public.session_days AS s(environment_id,day,session_key,visitor_key,daily,started_at,last_seen_at,
      pageviews,clicks,events,active_seconds,entry_path,entry_at,entry_sequence,entry_event,country,device,first_received_at,first_event)
    VALUES(NEW.site_id,(received AT TIME ZONE 'UTC')::date,session_id,visitor_id,session_id=visitor_id,moment,received,
      (event_kind='pageview')::integer,(event_kind='click')::integer,(event_kind<>'engagement')::integer,seconds,
      event_path,moment,sequence,NEW.id,event_country,event_device,received,NEW.id)
    ON CONFLICT(environment_id,day,session_key,visitor_key) DO UPDATE SET
      daily=s.daily AND excluded.daily,started_at=least(s.started_at,excluded.started_at),last_seen_at=greatest(s.last_seen_at,excluded.last_seen_at),
      pageviews=s.pageviews+excluded.pageviews,clicks=s.clicks+excluded.clicks,events=s.events+excluded.events,active_seconds=s.active_seconds+excluded.active_seconds,
      entry_path=CASE WHEN (excluded.entry_at,excluded.entry_sequence,excluded.entry_event)<(s.entry_at,s.entry_sequence,s.entry_event) THEN excluded.entry_path ELSE s.entry_path END,
      entry_at=least(s.entry_at,excluded.entry_at),
      entry_sequence=CASE WHEN (excluded.entry_at,excluded.entry_sequence,excluded.entry_event)<(s.entry_at,s.entry_sequence,s.entry_event) THEN excluded.entry_sequence ELSE s.entry_sequence END,
      entry_event=CASE WHEN (excluded.entry_at,excluded.entry_sequence,excluded.entry_event)<(s.entry_at,s.entry_sequence,s.entry_event) THEN excluded.entry_event ELSE s.entry_event END,
      country=CASE WHEN (excluded.first_received_at,excluded.first_event)<(s.first_received_at,s.first_event) THEN excluded.country ELSE s.country END,
      device=CASE WHEN (excluded.first_received_at,excluded.first_event)<(s.first_received_at,s.first_event) THEN excluded.device ELSE s.device END,
      first_received_at=least(s.first_received_at,excluded.first_received_at),
      first_event=CASE WHEN (excluded.first_received_at,excluded.first_event)<(s.first_received_at,s.first_event) THEN excluded.first_event ELSE s.first_event END;
    RETURN NULL;
END $$;
-- Deferred until the event and its optional rich activity row have both been written.
CREATE CONSTRAINT TRIGGER analytics_record_session AFTER INSERT ON events
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION analytics_record_session();

WITH source AS (
  SELECT environment_id,id,received_at,session_key,visitor_key,kind,path,country,device,details FROM activity_events
  UNION ALL
  SELECT e.site_id,e.id,e.received_at,e.visitor,e.visitor,CASE WHEN e.type='pageview' THEN 'pageview' ELSE 'custom' END,
    e.path,e.country,e.device,'{}'::jsonb FROM events e
    WHERE NOT EXISTS(SELECT 1 FROM activity_events a WHERE a.environment_id=e.site_id AND a.id=e.id)
), activity AS (
  SELECT *,to_timestamp(coalesce((details->>'clientTime')::bigint,(extract(epoch FROM received_at)*1000)::bigint)/1000.0) AS occurred_at,
    coalesce((details->>'sequence')::integer,0) AS sequence FROM source
)
INSERT INTO session_days
SELECT environment_id,(received_at AT TIME ZONE 'UTC')::date,session_key,visitor_key,bool_and(session_key=visitor_key),
  min(occurred_at),max(received_at),count(*) FILTER(WHERE kind='pageview'),count(*) FILTER(WHERE kind='click'),
  count(*) FILTER(WHERE kind<>'engagement'),coalesce(sum((details->>'activeSeconds')::bigint),0),
  (array_agg(path ORDER BY occurred_at,sequence,id))[1],min(occurred_at),
  (array_agg(sequence ORDER BY occurred_at,sequence,id))[1],(array_agg(id ORDER BY occurred_at,sequence,id))[1],
  (array_agg(country ORDER BY received_at,id))[1],(array_agg(device ORDER BY received_at,id))[1],min(received_at),
  (array_agg(id ORDER BY received_at,id))[1]
FROM activity GROUP BY environment_id,(received_at AT TIME ZONE 'UTC')::date,session_key,visitor_key;

-- Keep the existing abuse policy, but perform counters, detection and persistence in one round trip.
CREATE FUNCTION analytics_guard(p_environment uuid,p_source text,p_signature text,p_pageview boolean,p_now timestamptz)
RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
#variable_conflict use_column
<<guard>>
DECLARE previous jsonb; source jsonb; baseline jsonb; traffic jsonb; learned_at timestamptz;
    minute bigint; hour bigint; day bigint; bucket bigint; minute_events bigint; minute_pageviews bigint;
    hour_events bigint; day_events bigint; repeats bigint; traffic_events bigint; traffic_custom bigint;
    typical double precision; reason text; same_minute boolean;
BEGIN
    INSERT INTO public.abuse_environment(environment_id,baseline,learned_at,traffic)
      VALUES(p_environment,'{}',to_timestamp(0),'{"start":0,"events":0,"custom":0}') ON CONFLICT DO NOTHING;
    -- Preserve the preceding writer's source-before-environment lock order during rolling deployment.
    INSERT INTO public.abuse_sources(environment_id,source,activity,updated_at)
      VALUES(p_environment,p_source,'{"minute":-1,"minuteEvents":0,"minutePageviews":0,"hour":-1,"hourEvents":0,"day":-1,"dayEvents":0,"signature":"","repeats":0}',p_now)
      ON CONFLICT(environment_id,source) DO UPDATE SET updated_at=abuse_sources.updated_at RETURNING activity INTO previous;
    SELECT e.baseline,e.learned_at,e.traffic INTO baseline,learned_at,traffic FROM public.abuse_environment e WHERE environment_id=p_environment FOR UPDATE;
    IF p_now-learned_at>=interval '1 hour' THEN
        WITH clean AS (
          SELECT (s.pageviews+s.custom_events)::double precision AS total,
            (s.pageviews+s.custom_events)::double precision/s.visitors AS per_visitor,
            s.custom_events::double precision/(s.pageviews+s.custom_events) AS custom_share
          FROM public.daily_stats s WHERE s.site_id=p_environment AND s.dimension='total' AND s.value=''
            AND s.day>=(p_now-interval '14 days')::date AND s.day<p_now::date
            AND s.visitors>0 AND s.pageviews+s.custom_events>=20
            AND coalesce((SELECT sum(a.blocked) FROM public.abuse_daily a WHERE a.environment_id=p_environment AND a.day=s.day),0)<50
        )
        SELECT jsonb_build_object('days',count(*),'dailyEvents',coalesce(percentile_cont(0.5) WITHIN GROUP(ORDER BY total),0),
          'eventsPerVisitor',coalesce(percentile_cont(0.5) WITHIN GROUP(ORDER BY per_visitor),0),
          'customShare',coalesce(percentile_cont(0.5) WITHIN GROUP(ORDER BY custom_share),0)) INTO baseline FROM clean;
        UPDATE public.abuse_environment SET baseline=guard.baseline,learned_at=p_now WHERE environment_id=p_environment;
    END IF;
    minute:=greatest(floor(extract(epoch FROM p_now)/60)::bigint,(previous->>'minute')::bigint);
    hour:=greatest(floor(extract(epoch FROM p_now)/3600)::bigint,(previous->>'hour')::bigint);
    day:=greatest(floor(extract(epoch FROM p_now)/86400)::bigint,(previous->>'day')::bigint);
    same_minute:=(previous->>'minute')::bigint=minute;
    minute_events:=CASE WHEN same_minute THEN (previous->>'minuteEvents')::bigint+1 ELSE 1 END;
    minute_pageviews:=CASE WHEN same_minute THEN (previous->>'minutePageviews')::bigint+p_pageview::integer ELSE p_pageview::integer END;
    hour_events:=CASE WHEN (previous->>'hour')::bigint=hour THEN (previous->>'hourEvents')::bigint+1 ELSE 1 END;
    day_events:=CASE WHEN (previous->>'day')::bigint=day THEN (previous->>'dayEvents')::bigint+1 ELSE 1 END;
    repeats:=CASE WHEN same_minute AND previous->>'signature'=p_signature THEN (previous->>'repeats')::bigint+1 ELSE 1 END;
    source:=jsonb_build_object('minute',minute,'minuteEvents',minute_events,'minutePageviews',minute_pageviews,
      'hour',hour,'hourEvents',hour_events,'day',day,'dayEvents',day_events,'signature',p_signature,'repeats',repeats);
    bucket:=floor(extract(epoch FROM p_now)/300)::bigint;
    traffic_events:=CASE WHEN (traffic->>'start')::bigint=bucket THEN (traffic->>'events')::bigint+1 ELSE 1 END;
    traffic_custom:=CASE WHEN (traffic->>'start')::bigint=bucket THEN (traffic->>'custom')::bigint+(NOT p_pageview)::integer ELSE (NOT p_pageview)::integer END;
    typical:=CASE WHEN (baseline->>'days')::bigint>=3 THEN (baseline->>'eventsPerVisitor')::double precision ELSE 0 END;
    IF minute_events>180 OR minute_pageviews>90 OR hour_events>least(greatest(ceil(typical*40),1200),6000)
        OR day_events>least(greatest(ceil(typical*200),6000),30000) THEN reason:='source_limit';
    ELSIF repeats>(CASE WHEN p_pageview THEN 20 ELSE 60 END) THEN reason:='repeated_activity';
    ELSIF (baseline->>'days')::bigint>=3 AND traffic_events>greatest((baseline->>'dailyEvents')::double precision/288*12,300)
        AND ((p_pageview AND repeats>10) OR (NOT p_pageview AND (baseline->>'customShare')::double precision<0.5
          AND traffic_custom::double precision/traffic_events>0.95 AND minute_events>30)) THEN reason:='unusual_activity'; END IF;
    UPDATE public.abuse_sources SET activity=guard.source,updated_at=p_now WHERE environment_id=p_environment AND abuse_sources.source=p_source;
    IF reason IS NOT NULL THEN
        INSERT INTO public.abuse_daily(environment_id,day,reason,blocked,last_blocked_at)
          VALUES(p_environment,p_now::date,reason,1,p_now) ON CONFLICT(environment_id,day,reason)
          DO UPDATE SET blocked=abuse_daily.blocked+1,last_blocked_at=excluded.last_blocked_at;
    END IF;
    UPDATE public.abuse_environment SET traffic=jsonb_build_object('start',greatest((traffic->>'start')::bigint,bucket),
      'events',CASE WHEN (traffic->>'start')::bigint=bucket THEN traffic_events WHEN (traffic->>'start')::bigint>bucket THEN (traffic->>'events')::bigint ELSE 1 END,
      'custom',CASE WHEN (traffic->>'start')::bigint=bucket THEN traffic_custom WHEN (traffic->>'start')::bigint>bucket THEN (traffic->>'custom')::bigint ELSE (NOT p_pageview)::integer END)
      WHERE environment_id=p_environment;
    RETURN reason;
END $$;

DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='analytics_runtime') THEN
        GRANT SELECT,INSERT,UPDATE,DELETE ON event_receipts,session_days TO analytics_runtime;
        GRANT SELECT ON analytics_schema_migrations TO analytics_runtime;
        GRANT EXECUTE ON FUNCTION analytics_guard(uuid,text,text,boolean,timestamptz) TO analytics_runtime;
    END IF;
END $$;

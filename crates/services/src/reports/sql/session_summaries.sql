WITH bounds AS (
  SELECT greatest($2::date::timestamptz,now()-interval '30 days') AS starts,($3::date+1)::timestamptz AS ends
), partial_source AS (
  -- Only the partially retained oldest day needs raw rows. Complete days use maintained summaries.
  SELECT a.environment_id,a.id,a.received_at,a.session_key,a.visitor_key,a.kind,a.path,a.country,a.device,a.details
  FROM activity_events a CROSS JOIN bounds b
  WHERE a.environment_id=$1 AND a.received_at>=b.starts AND a.received_at<least(b.ends,date_trunc('day',b.starts)+interval '1 day')
    AND b.starts<>date_trunc('day',b.starts) AND ($4::text IS NULL OR a.visitor_key=$4)
  UNION ALL
  SELECT e.site_id,e.id,e.received_at,e.visitor,e.visitor,CASE WHEN e.type='pageview' THEN 'pageview' ELSE 'custom' END,
    e.path,e.country,e.device,'{}'::jsonb
  FROM events e CROSS JOIN bounds b
  WHERE e.site_id=$1 AND e.received_at>=b.starts AND e.received_at<least(b.ends,date_trunc('day',b.starts)+interval '1 day')
    AND b.starts<>date_trunc('day',b.starts) AND ($4::text IS NULL OR e.visitor=$4)
    AND NOT EXISTS(SELECT 1 FROM activity_events a WHERE a.environment_id=e.site_id AND a.id=e.id)
), partial_activity AS (
  SELECT *,to_timestamp(coalesce((details->>'clientTime')::bigint,(extract(epoch FROM received_at)*1000)::bigint)/1000.0) AS occurred_at,
    coalesce((details->>'sequence')::integer,0) AS sequence FROM partial_source
), days AS (
  SELECT s.session_key,s.visitor_key,s.daily,s.started_at,s.last_seen_at,s.pageviews,s.clicks,s.events,s.active_seconds,
    s.entry_path,s.entry_at,s.entry_sequence,s.entry_event,s.country,s.device,s.first_received_at,s.first_event
  FROM session_days s CROSS JOIN bounds b
  WHERE s.environment_id=$1
    AND s.day>=b.starts::date+(b.starts<>date_trunc('day',b.starts))::integer AND s.day<b.ends::date
    AND ($4::text IS NULL OR s.visitor_key=$4)
  UNION ALL
  SELECT session_key,visitor_key,bool_and(session_key=visitor_key),min(occurred_at),max(received_at),
    count(*) FILTER(WHERE kind='pageview'),count(*) FILTER(WHERE kind='click'),count(*) FILTER(WHERE kind<>'engagement'),
    coalesce(sum((details->>'activeSeconds')::bigint),0),
    (array_agg(path ORDER BY occurred_at,sequence,id))[1],min(occurred_at),
    (array_agg(sequence ORDER BY occurred_at,sequence,id))[1],(array_agg(id ORDER BY occurred_at,sequence,id))[1],
    (array_agg(country ORDER BY received_at,id))[1],(array_agg(device ORDER BY received_at,id))[1],
    min(received_at),(array_agg(id ORDER BY received_at,id))[1]
  FROM partial_activity GROUP BY session_key,visitor_key
), grouped AS MATERIALIZED (
  SELECT session_key AS id,visitor_key AS "visitorKey",bool_and(daily) AS daily,
    min(started_at) AS "startedAt",max(last_seen_at) AS "lastSeenAt",
    sum(pageviews)::bigint AS pageviews,sum(clicks)::bigint AS clicks,sum(events)::bigint AS events,sum(active_seconds)::bigint AS "activeSeconds",
    (array_agg(entry_path ORDER BY entry_at,entry_sequence,entry_event))[1] AS "entryPath",
    (array_agg(country ORDER BY first_received_at,first_event))[1] AS country,
    (array_agg(device ORDER BY first_received_at,first_event))[1] AS device
  FROM days GROUP BY session_key,visitor_key
)
SELECT jsonb_build_object(
  'summary',(SELECT jsonb_build_object('sessions',count(*),'visitors',count(DISTINCT "visitorKey"),
    'averageActiveSeconds',coalesce(round(avg("activeSeconds")),0),'clicks',coalesce(sum(clicks),0)) FROM grouped),
  'sessions',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY "lastSeenAt" DESC,id,"visitorKey"),'[]'::jsonb) FROM (
    SELECT * FROM grouped WHERE $5::timestamptz IS NULL OR "lastSeenAt"<$5
      OR ("lastSeenAt"=$5 AND (id,"visitorKey")>($6::text,$7::text))
    ORDER BY "lastSeenAt" DESC,id,"visitorKey" LIMIT 51 OFFSET $8
  ) p)
)

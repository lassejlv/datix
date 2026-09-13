WITH source AS (
  SELECT environment_id,id,received_at,session_key,visitor_key,kind,name,path,referrer,country,device,browser,os,details,(session_key=visitor_key) AS daily
  FROM activity_events
  WHERE environment_id=$1 AND received_at >= greatest($2::date,now()-interval '30 days')
    AND received_at < $3::date+interval '1 day' AND ($4::text IS NULL OR visitor_key=$4)
  UNION ALL
  SELECT e.site_id,e.id,e.received_at,e.visitor,e.visitor,
    CASE WHEN e.type='pageview' THEN 'pageview' ELSE 'custom' END,
    e.name,e.path,e.referrer,e.country,e.device,'','','{}'::jsonb,true
  FROM events e
  WHERE e.site_id=$1 AND e.day BETWEEN $2::date AND $3::date AND e.received_at >= greatest($2::date,now()-interval '30 days')
    AND e.received_at < $3::date+interval '1 day' AND ($4::text IS NULL OR e.visitor=$4)
    AND NOT EXISTS(SELECT 1 FROM activity_events a WHERE a.environment_id=e.site_id AND a.id=e.id)
), activity AS (
  SELECT *, to_timestamp(coalesce((details->>'clientTime')::bigint,(extract(epoch FROM received_at)*1000)::bigint)/1000.0) AS occurred_at
  FROM source
)

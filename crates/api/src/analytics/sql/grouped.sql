SELECT session_key AS id,visitor_key AS "visitorKey",bool_and(daily) AS daily,
  min(occurred_at) AS "startedAt",max(received_at) AS "lastSeenAt",
  count(*) FILTER(WHERE kind='pageview')::int AS pageviews,
  count(*) FILTER(WHERE kind='click')::int AS clicks,
  count(*) FILTER(WHERE kind<>'engagement')::int AS events,
  coalesce(sum((details->>'activeSeconds')::int),0)::int AS "activeSeconds",
  (array_agg(path ORDER BY occurred_at,coalesce((details->>'sequence')::int,0),id))[1] AS "entryPath",
  (array_agg(country ORDER BY received_at,id))[1] AS country,
  (array_agg(device ORDER BY received_at,id))[1] AS device
FROM activity GROUP BY session_key,visitor_key

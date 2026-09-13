SELECT jsonb_build_object(
  'summary',(SELECT jsonb_build_object('sessions',count(*),'visitors',count(DISTINCT "visitorKey"),
    'averageActiveSeconds',coalesce(round(avg("activeSeconds")),0),'clicks',coalesce(sum(clicks),0)) FROM grouped),
  'sessions',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY "lastSeenAt" DESC,id,"visitorKey"),'[]'::jsonb) FROM (
    SELECT * FROM grouped WHERE $5::timestamptz IS NULL OR "lastSeenAt"<$5
      OR ("lastSeenAt"=$5 AND (id,"visitorKey")>($6::text,$7::text))
    ORDER BY "lastSeenAt" DESC,id,"visitorKey" LIMIT 51 OFFSET $8
  ) p)
)::text

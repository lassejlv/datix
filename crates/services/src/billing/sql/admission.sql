SELECT e.tracking_mode,e.tracking_settings,e.domain,e.allow_localhost,s.credit_budget::text,
  (SELECT count(*) FROM sites older WHERE older.owner_id=s.owner_id
    AND (older.created_at,older.id)<(s.created_at,s.id)) AS site_position,
  (SELECT coalesce(jsonb_agg(subscription),'[]'::jsonb)
    FROM billing_customers c CROSS JOIN LATERAL jsonb_array_elements(c.subscriptions) subscription
    WHERE c.owner_id=s.owner_id AND c.deleted=false) AS subscriptions,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('site',u.site_id,'start',u.period_start,'units',(u.events*100)::bigint)),'[]'::jsonb)
    FROM billing_usage u WHERE u.owner_id=s.owner_id AND u.period_start>=now()-interval '32 days') AS usage
FROM environments e JOIN sites s ON s.id=e.site_id
WHERE e.id=$2 AND e.site_id=$1 AND e.enabled=true

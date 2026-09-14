SELECT s.id,s.owner_id,s.name,s.domain,s.enabled,s.allow_localhost,
       s.credit_budget::float8 AS credit_budget,s.created_at,
       u.name AS owner_name,u.email AS owner_email,
       ss.site_id IS NOT NULL AS suspended,ss.reason AS suspension_reason,
       ss.suspended_at,ss.suspended_by,
       us.user_id IS NOT NULL AS owner_suspended,
       (ss.site_id IS NOT NULL OR us.user_id IS NOT NULL) AS tracking_suspended,
       (SELECT count(*) FROM environments e WHERE e.site_id=s.id) AS environment_count
FROM sites s
JOIN "user" u ON u.id=s.owner_id
LEFT JOIN site_suspensions ss ON ss.site_id=s.id
LEFT JOIN user_suspensions us ON us.user_id=s.owner_id

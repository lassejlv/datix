SELECT u.id,u.name,u.email,u.email_verified,
       u.created_at AT TIME ZONE 'UTC' AS created_at,
       u.updated_at AT TIME ZONE 'UTC' AS updated_at,
       us.user_id IS NOT NULL AS suspended,us.reason AS suspension_reason,
       us.suspended_at,us.suspended_by,
       (SELECT count(*) FROM sites s WHERE s.owner_id=u.id) AS site_count,
       (SELECT count(*) FROM session se WHERE se.user_id=u.id AND se.expires_at>now() AT TIME ZONE 'UTC') AS active_session_count
FROM "user" u LEFT JOIN user_suspensions us ON us.user_id=u.id

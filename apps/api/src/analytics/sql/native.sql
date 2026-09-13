WITH raw AS (
    SELECT * FROM events e WHERE site_id=$1 AND day BETWEEN $2 AND $3
    AND NOT EXISTS (SELECT 1 FROM daily_stats d WHERE d.site_id=e.site_id AND d.day=e.day AND d.dimension='total')
), native AS (
    SELECT day,count(*) FILTER(WHERE type='pageview')::bigint AS pageviews,
        count(*) FILTER(WHERE type='event')::bigint AS custom_events,
        count(DISTINCT visitor) FILTER(WHERE type='pageview')::bigint AS visitors
    FROM raw GROUP BY day
    UNION ALL
    SELECT day,pageviews,custom_events,visitors FROM daily_stats
    WHERE site_id=$1 AND dimension='total' AND day BETWEEN $2 AND $3
), live_start AS (
    SELECT min(day)::timestamp AT TIME ZONE 'UTC' AS starts_at FROM (
        SELECT min(day) AS day FROM events WHERE site_id=$1
        UNION ALL SELECT min(day) FROM daily_stats WHERE site_id=$1 AND dimension='total'
    ) days
), imported AS (
    SELECT d.*,i.provider,i.source_timezone,i.summary FROM imported_daily_stats d
    JOIN analytics_imports i ON i.id=d.import_id AND i.environment_id=d.environment_id
    CROSS JOIN live_start l WHERE d.environment_id=$1 AND d.day BETWEEN $2 AND $3
      AND (l.starts_at IS NULL OR d.ends_at<=l.starts_at)
)

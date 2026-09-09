use super::*;
use analytics_core::validation::DateRange;
use analytics_services::reports;
use std::collections::HashSet;

fn rich(mut event: Event, session: u64, visitor: u64, kind: &str, sequence: i32) -> Event {
    event.version = 3;
    event.environment_id = Some(event.site_id);
    event.event_type = if kind == "pageview" {
        "pageview"
    } else {
        "event"
    }
    .into();
    event.name = if kind == "pageview" { "" } else { kind }.into();
    event.activity = Some(serde_json::from_value(json!({
        "sessionKey":format!("{session:064x}"),"visitorKey":format!("{visitor:064x}"),"kind":kind,
        "browser":"Chrome","os":"macOS","details":{"clientTime":event.received_at.timestamp_millis(),"sequence":sequence,
        "viewportWidth":1280,"viewportHeight":800,"screenWidth":1280,"screenHeight":800,"language":"en","activeSeconds":if kind=="engagement"{15}else{0}}
    })).unwrap());
    event
}

#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn owner_batches_preserve_credit_boundaries_and_cross_partition_deduplication() {
    fixture!(f, {
        f.pro().await;
        let site = f.site().await;
        sqlx::query("UPDATE sites SET credit_budget=0.5 WHERE id=$1")
            .bind(site)
            .execute(&f.state.db)
            .await
            .unwrap();
        let expensive = f.event(site);
        let mut affordable = expensive.clone();
        affordable.event_type = "event".into();
        affordable.name = "custom".into();
        let result = ingest::ingest_batch(
            &f.state,
            &[expensive, affordable.clone(), affordable.clone()],
            Utc::now(),
        )
        .await;
        assert_eq!(
            result.into_iter().map(Result::unwrap).collect::<Vec<_>>(),
            [false, true, false]
        );
        assert_eq!(
            billing::account_usage(&f.state, &f.user).await.unwrap()["events"]["used"],
            0.5
        );
        sqlx::query("UPDATE sites SET credit_budget=NULL WHERE id=$1")
            .bind(site)
            .execute(&f.state.db)
            .await
            .unwrap();
        let mut moved = affordable;
        moved.received_at -= Duration::days(1);
        moved.day = moved.received_at.date_naive();
        assert!(!ingest::ingest(&f.state, &moved, Utc::now()).await.unwrap());
        let events: i64 = sqlx::query_scalar("SELECT count(*) FROM events WHERE site_id=$1")
            .bind(site)
            .fetch_one(&f.state.db)
            .await
            .unwrap();
        assert_eq!(events, 1);
        let mut batch = vec![];
        for i in 0..80 {
            let mut e = f.event(site);
            e.visitor = format!("{i:064x}");
            batch.push(e);
        }
        let results = ingest::ingest_batch(&f.state, &batch, Utc::now()).await;
        assert!(results.into_iter().all(|r| r.unwrap()));
        let (outbox, units): (i64, i64) = sqlx::query_as(
            "SELECT count(*),(sum(event_count)*100)::bigint FROM billing_outbox WHERE owner_id=$1",
        )
        .bind(&f.user)
        .fetch_one(&f.state.db)
        .await
        .unwrap();
        assert_eq!(outbox, 2, "one delivery per event type/day in a batch");
        assert_eq!(units, 8050);
        let summary = reports::overview(&f.state, site, DateRange::parse(&HashMap::new()).unwrap())
            .await
            .unwrap();
        assert_eq!(summary["pageviews"], 80);
        assert_eq!(summary["dailyUniqueVisitors"], 80);
    });
}

#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn session_rollups_match_raw_reports_and_cursors_cover_ties_and_date_boundaries() {
    fixture!(f, {
        f.pro().await;
        let site = f.site().await;
        sqlx::query("UPDATE billing_customers SET subscriptions=jsonb_set(jsonb_set(subscriptions,'{0,currentPeriodStart}',$1),'{0,entitlements,periodStart}',$1) WHERE owner_id=$2")
            .bind(json!(Utc::now()-Duration::days(60))).bind(&f.user).execute(&f.state.db).await.unwrap();
        let now = Utc::now();
        let mut events = vec![];
        for i in 0..72 {
            let mut event = f.event(site);
            event.received_at = now - Duration::days(i % 3);
            event.day = event.received_at.date_naive();
            events.push(rich(
                event,
                i as u64,
                (i % 20 + 1000) as u64,
                if i % 5 == 0 { "engagement" } else { "pageview" },
                (i % 4) as i32,
            ));
        }
        let mut edge = f.event(site);
        edge.received_at = now - Duration::days(30) + Duration::minutes(2);
        edge.day = edge.received_at.date_naive();
        events.push(rich(edge, 9000, 9001, "click", 1));
        assert!(
            ingest::ingest_batch(&f.state, &events, now)
                .await
                .into_iter()
                .all(|r| r.unwrap())
        );
        for days in [1, 2, 3, 31] {
            let params = HashMap::from([
                (
                    "from".into(),
                    (now.date_naive() - Duration::days(days - 1)).to_string(),
                ),
                ("to".into(), now.date_naive().to_string()),
            ]);
            let range = DateRange::parse(&params).unwrap();
            let source = include_str!("../../../services/src/reports/sql/activity.sql");
            let grouped = include_str!("../../../services/src/reports/sql/grouped.sql");
            let statement = format!(
                "{source}, grouped AS ({grouped}) SELECT to_jsonb(g) FROM grouped g ORDER BY \"lastSeenAt\" DESC,id,\"visitorKey\""
            );
            let expected: Vec<Value> = sqlx::query_scalar(&statement)
                .bind(site)
                .bind(range.from)
                .bind(range.to)
                .bind(None::<String>)
                .fetch_all(&f.state.db)
                .await
                .unwrap();
            let mut page_params = params.clone();
            let mut actual = vec![];
            loop {
                let page = reports::sessions(&f.state, site, range.clone(), &page_params)
                    .await
                    .unwrap();
                assert_eq!(page["summary"]["sessions"], expected.len() as u64);
                actual.extend(page["sessions"].as_array().unwrap().iter().cloned());
                if page["hasMore"] == false {
                    break;
                }
                let cursor = page["nextCursor"].as_str().unwrap().to_owned();
                page_params.insert("cursor".into(), cursor.clone());
                let mut invalid = page_params.clone();
                invalid.insert("visitor".into(), "a".repeat(64));
                assert!(
                    reports::sessions(&f.state, site, range.clone(), &invalid)
                        .await
                        .is_err()
                );
                invalid = page_params.clone();
                invalid.insert("cursor".into(), format!("{cursor}x"));
                assert!(
                    reports::sessions(&f.state, site, range.clone(), &invalid)
                        .await
                        .is_err()
                );
            }
            assert_eq!(actual, expected, "rollup parity for {days} days");
        }
        let mut timeline = vec![];
        for i in 0..251 {
            let mut event = f.event(site);
            event.received_at = now;
            event.day = now.date_naive();
            timeline.push(rich(event, 9900, 9901, "click", i % 3));
        }
        for batch in timeline.chunks(128) {
            assert!(
                ingest::ingest_batch(&f.state, batch, now)
                    .await
                    .into_iter()
                    .all(|r| r.unwrap())
            );
        }
        let mut params = HashMap::from([("session".into(), format!("{:064x}", 9900))]);
        let range = DateRange::parse(&params).unwrap();
        let first = reports::sessions(&f.state, site, range.clone(), &params)
            .await
            .unwrap();
        assert_eq!(first["events"].as_array().unwrap().len(), 200);
        params.insert(
            "cursor".into(),
            first["nextCursor"].as_str().unwrap().into(),
        );
        let second = reports::sessions(&f.state, site, range, &params)
            .await
            .unwrap();
        assert_eq!(second["events"].as_array().unwrap().len(), 51);
        assert_eq!(second["hasMore"], false);
        let actual: HashSet<_> = first["events"]
            .as_array()
            .unwrap()
            .iter()
            .chain(second["events"].as_array().unwrap())
            .map(|r| r["id"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(actual, timeline.iter().map(|e| e.id.to_string()).collect());
    });
}

#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn sql_abuse_guard_matches_reference_policy_at_decision_boundaries() {
    fixture!(f, {
        let site = f.site().await;
        let now = Utc::now();
        let baseline = abuse::Baseline {
            days: 5,
            daily_events: 2000.,
            events_per_visitor: 20.,
            custom_share: 0.1,
        };
        for (
            index,
            (
                pageview,
                minute_events,
                minute_pageviews,
                hour_events,
                day_events,
                repeats,
                traffic_events,
                traffic_custom,
            ),
        ) in [
            (true, 0, 0, 0, 0, 0, 0, 0),
            (true, 180, 20, 500, 500, 0, 500, 0),
            (true, 90, 90, 100, 100, 0, 100, 0),
            (true, 10, 10, 1200, 1300, 0, 50, 0),
            (false, 10, 0, 50, 6000, 0, 50, 40),
            (true, 20, 20, 20, 20, 20, 20, 0),
            (false, 60, 0, 60, 60, 60, 60, 60),
            (true, 15, 15, 100, 100, 10, 900, 100),
            (false, 30, 0, 100, 100, 0, 900, 899),
        ]
        .into_iter()
        .enumerate()
        {
            let previous = abuse::Source {
                minute: now.timestamp_millis() / 60000,
                minute_events,
                minute_pageviews,
                hour: now.timestamp_millis() / 3600000,
                hour_events,
                day: now.timestamp_millis() / 86400000,
                day_events,
                signature: "pattern".into(),
                repeats,
            };
            let traffic = abuse::Traffic {
                start: now.timestamp_millis() / 300000,
                events: traffic_events,
                custom: traffic_custom,
            };
            let (expected_source, expected_traffic, expected_reason) = abuse::detect(
                now.timestamp_millis(),
                pageview,
                "pattern",
                &previous,
                &traffic,
                &baseline,
            );
            sqlx::query("INSERT INTO abuse_environment(environment_id,baseline,learned_at,traffic) VALUES($1,$2,$3,$4) ON CONFLICT(environment_id) DO UPDATE SET baseline=excluded.baseline,learned_at=excluded.learned_at,traffic=excluded.traffic")
                .bind(site).bind(json!(baseline)).bind(now).bind(json!(traffic)).execute(&f.state.db).await.unwrap();
            let source = format!("boundary-{index}");
            sqlx::query("INSERT INTO abuse_sources(environment_id,source,activity,updated_at) VALUES($1,$2,$3,$4)")
                .bind(site).bind(&source).bind(json!(previous)).bind(now).execute(&f.state.db).await.unwrap();
            let actual = abuse::guard(&f.state, site, &source, "pattern", pageview, now)
                .await
                .unwrap();
            assert_eq!(actual, expected_reason, "policy boundary {index}");
            let stored: Value = sqlx::query_scalar(
                "SELECT activity FROM abuse_sources WHERE environment_id=$1 AND source=$2",
            )
            .bind(site)
            .bind(&source)
            .fetch_one(&f.state.db)
            .await
            .unwrap();
            assert_eq!(stored, json!(expected_source));
            let stored: Value =
                sqlx::query_scalar("SELECT traffic FROM abuse_environment WHERE environment_id=$1")
                    .bind(site)
                    .fetch_one(&f.state.db)
                    .await
                    .unwrap();
            assert_eq!(stored, json!(expected_traffic));
        }
    });
}

#[tokio::test]
#[ignore = "requires isolated Neon; partition maintenance is rehearsed in a rolled-back transaction"]
async fn partition_maintenance_moves_default_rows_without_losing_or_double_counting_them() {
    fixture!(f, {
        let site = f.site().await;
        let day = Utc::now().date_naive() + Duration::days(7);
        let part = format!("events_p{}", day.format("%Y%m%d"));
        let detached = format!("scaling_detached_{}", Uuid::new_v4().simple());
        let id = Uuid::new_v4();
        let mut tx = f.state.db.begin().await.unwrap();
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {part}"))
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_eq!(
            count, 0,
            "future partition must be empty for this rehearsal"
        );
        sqlx::raw_sql(&format!(
            "ALTER TABLE events DETACH PARTITION {part}; ALTER TABLE {part} RENAME TO {detached}"
        ))
        .execute(&mut *tx)
        .await
        .unwrap();
        sqlx::query("DELETE FROM analytics_partitions WHERE partition_name=$1")
            .bind(&part)
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO events(site_id,id,received_at,day,type,name,path,referrer,country,device,visitor) VALUES($1,$2,$3::date::timestamptz,$3,'pageview','','/default','','DK','desktop',$4)")
            .bind(site).bind(id).bind(day).bind("e".repeat(64)).execute(&mut *tx).await.unwrap();
        sqlx::raw_sql("SET CONSTRAINTS ALL IMMEDIATE")
            .execute(&mut *tx)
            .await
            .unwrap();
        let result: Value = sqlx::query_scalar("SELECT analytics_partition_maintenance()")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_eq!(result["created"], 1);
        let actual: String = sqlx::query_scalar(
            "SELECT tableoid::regclass::text FROM events WHERE site_id=$1 AND id=$2",
        )
        .bind(site)
        .bind(id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!(actual, part);
        let count: i64 = sqlx::query_scalar(
            "SELECT sum(pageviews)::bigint FROM session_days WHERE environment_id=$1",
        )
        .bind(site)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!(count, 1);
        tx.rollback().await.unwrap();
    });
}

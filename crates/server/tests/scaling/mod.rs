//! Explicit load tests use the same isolated branch and disposable fixtures as integration tests.
use super::*;
use std::time::{Duration as StdDuration, Instant};
mod correctness;
mod load;
mod operations;

#[tokio::test]
#[ignore = "requires isolated Neon branch; rehearses the owner migration"]
async fn partition_upgrade_preserves_prepared_readers_writers_and_deduplication() {
    fixture!(f, {
        let site = f.site().await;
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let mut held = f.state.acquire().await.unwrap();
        let insert = "INSERT INTO events(site_id,id,received_at,day,type,name,path,referrer,country,device,visitor) VALUES($1,$2,now(),current_date,'pageview','','/migration','','DK','desktop',$3) ON CONFLICT DO NOTHING";
        let read = "SELECT tableoid::regclass::text FROM events WHERE site_id=$1 AND id=$2";
        assert_eq!(
            sqlx::query(insert)
                .bind(site)
                .bind(first)
                .bind("d".repeat(64))
                .execute(&mut *held)
                .await
                .unwrap()
                .rows_affected(),
            1
        );
        let before: String = sqlx::query_scalar(read)
            .bind(site)
            .bind(first)
            .fetch_one(&mut *held)
            .await
            .unwrap();
        analytics_core::database::upgrade(&f.state.db)
            .await
            .unwrap();
        let report = analytics_core::database::check(&f.state.db).await.unwrap();
        assert_eq!(report["partitionedEventTables"], 2);
        assert_eq!(
            sqlx::query(insert)
                .bind(site)
                .bind(second)
                .bind("d".repeat(64))
                .execute(&mut *held)
                .await
                .unwrap()
                .rows_affected(),
            1
        );
        let after: String = sqlx::query_scalar(read)
            .bind(site)
            .bind(second)
            .fetch_one(&mut *held)
            .await
            .unwrap();
        assert!(
            after.starts_with("events_p"),
            "prepared writer used the wrong relation: {after}"
        );
        assert_eq!(
            sqlx::query(insert)
                .bind(site)
                .bind(first)
                .bind("d".repeat(64))
                .execute(&mut *held)
                .await
                .unwrap()
                .rows_affected(),
            0
        );
        let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM events WHERE site_id=$1")
            .bind(site)
            .fetch_one(&mut *held)
            .await
            .unwrap();
        assert_eq!(rows, 2);
        println!(
            "MIGRATION_RESULT {}",
            json!({"before":before,"after":after,"schema":report,"preparedWriterPreserved":true,"duplicateRejected":true})
        );
        drop(held);
    });
}

#[tokio::test]
#[ignore = "requires isolated Neon and Redis; run explicitly with --nocapture"]
async fn queue_load_baseline() {
    fixture!(f, {
        f.pro().await;
        let site = f.site().await;
        let count = std::env::var("LOAD_EVENTS")
            .unwrap_or_else(|_| "80".into())
            .parse::<usize>()
            .unwrap();
        assert!((20..=10000).contains(&count));
        queue::initialize(&f.state).await.unwrap();
        for _ in 0..count {
            queue::enqueue(&f.state, &f.event(site)).await.unwrap();
        }
        let started = Instant::now();
        let jobs = analytics_server::jobs::Jobs::start_events(f.state.clone())
            .await
            .unwrap();
        let result = AssertUnwindSafe(async {
            let mut redis = f.state.redis.clone();
            loop {
                let remaining: i64 = redis::cmd("XLEN").arg(queue::stream(&f.state))
                    .query_async(&mut redis).await.unwrap();
                if remaining == 0 { break; }
                assert!(started.elapsed() < StdDuration::from_secs(180), "queue did not drain");
                tokio::time::sleep(StdDuration::from_millis(50)).await;
            }
            let elapsed = started.elapsed().as_secs_f64();
            let committed: i64 = sqlx::query_scalar("SELECT count(*) FROM events WHERE site_id=$1")
                .bind(site).fetch_one(&f.state.db).await.unwrap();
            assert_eq!(committed, count as i64);
            assert_eq!(billing::account_usage(&f.state, &f.user).await.unwrap()["events"]["used"], count as f64);
            println!("SCALING_RESULT {}", json!({"scenario":"single_owner_queue","events":count,"seconds":elapsed,"committedPerSecond":count as f64/elapsed}));
        }).catch_unwind().await;
        jobs.close().await;
        if let Err(error) = result {
            std::panic::resume_unwind(error);
        }
    });
}

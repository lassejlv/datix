use super::*;
use crate::polar::MockProvider;
use analytics_core::config::Role;

#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn billing_drains_more_than_five_batches_with_exact_quantities() {
    fixture!(f, {
        sqlx::query("INSERT INTO billing_outbox(owner_id,event_type,event_count,occurred_at,provider,organization_id) SELECT $1,'pageview',0.15,now(),'polar',$2 FROM generate_series(1,601)")
            .bind(&f.user).bind(billing::catalog::CATALOG.organization_id).execute(&f.state.db).await.unwrap();
        let provider = MockProvider::start().await;
        let state = provider.state(&f);
        let deadline = Instant::now() + StdDuration::from_secs(120);
        let mut delivered = 0;
        while delivered < 601 {
            delivered += billing::delivery::flush(&state).await.unwrap();
            assert!(Instant::now() < deadline, "billing backlog did not drain");
        }
        assert_eq!(delivered, 601);
        let remaining: i64 =
            sqlx::query_scalar("SELECT count(*) FROM billing_outbox WHERE owner_id=$1")
                .bind(&f.user)
                .fetch_one(&f.state.db)
                .await
                .unwrap();
        assert_eq!(remaining, 0);
        let data = provider.data.lock().await;
        let events: Vec<_> = data
            .ingested
            .iter()
            .flat_map(|event| event["events"].as_array().unwrap())
            .collect();
        assert_eq!(events.len(), 601);
        assert_eq!(
            events
                .iter()
                .map(|e| (e["metadata"]["quantity"].as_f64().unwrap() * 100.).round() as i64)
                .sum::<i64>(),
            9015
        );
        let ids: std::collections::HashSet<_> = events
            .iter()
            .map(|e| e["external_id"].as_str().unwrap())
            .collect();
        assert_eq!(ids.len(), 601);
    });
}

#[tokio::test]
#[ignore = "requires isolated Neon and Redis; seeds and removes 100500 disposable rate-limit rows"]
async fn retention_continues_backlogs_instead_of_marking_the_day_complete() {
    fixture!(f, {
        let prefix = format!("{}-retention-", f.user);
        let outcome=AssertUnwindSafe(async {
            sqlx::query("INSERT INTO rate_limit(id,key,count,last_request) SELECT $1||n,$1||n,1,0 FROM generate_series(1,100500) n")
                .bind(&prefix).execute(&f.state.db).await.unwrap();
            let mut small=f.state.clone();let mut config=(*small.config).clone();
            config.runtime.retention_batch_size=10000;config.runtime.retention_max_rows=100;small.config=Arc::new(config);
            analytics_server::jobs::retention_pass(&small).await.unwrap();
            let key=format!("{}:retention:{}",queue::stream(&f.state),Utc::now().date_naive());
            let mut redis=f.state.redis.clone();
            let complete: bool=redis::cmd("EXISTS").arg(&key).query_async(&mut redis).await.unwrap();
            assert!(!complete,"a bounded pass must leave the day pending while backlog remains");
            let deadline=Instant::now()+StdDuration::from_secs(90);
            loop {
                analytics_server::jobs::retention_pass(&f.state).await.unwrap();
                let complete: bool=redis::cmd("EXISTS").arg(&key).query_async(&mut redis).await.unwrap();
                if complete {break;}
                assert!(Instant::now()<deadline,"retention failed to catch up");
            }
            let remaining: i64=sqlx::query_scalar("SELECT count(*) FROM rate_limit WHERE id LIKE $1")
                .bind(format!("{prefix}%")).fetch_one(&f.state.db).await.unwrap();
            assert_eq!(remaining,0);
            let _: i64=redis::cmd("DEL").arg(&key).arg(format!("{}:retention-cursor",queue::stream(&f.state))).query_async(&mut redis).await.unwrap();
        }).catch_unwind().await;
        sqlx::query("DELETE FROM rate_limit WHERE id LIKE $1")
            .bind(format!("{prefix}%"))
            .execute(&f.state.db)
            .await
            .unwrap();
        if let Err(error) = outcome {
            std::panic::resume_unwind(error);
        }
    });
}

#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn api_worker_roles_metrics_cache_and_queue_backpressure_remain_isolated() {
    fixture!(f, {
        f.pro().await;
        let site = f.site().await;
        let mut state = f.state.clone();
        let mut config = (*state.config).clone();
        config.runtime.role = Role::Api;
        config.runtime.queue_max_pending = 2;
        config.runtime.report_cache_seconds = 5;
        state.config = Arc::new(config);
        let api_jobs = analytics_server::jobs::Jobs::start(state.clone())
            .await
            .unwrap();
        queue::enqueue(&state, &f.event(site)).await.unwrap();
        queue::enqueue(&state, &f.event(site)).await.unwrap();
        assert!(queue::enqueue(&state, &f.event(site)).await.is_err());
        assert_eq!(
            queue::inspect(&state).await.unwrap()["stream"],
            2,
            "API role must not consume worker messages"
        );
        api_jobs.close().await;
        analytics_server::jobs::observe(&state).await.unwrap();
        let app = http::router(state.clone(), Arc::new(AtomicBool::new(true)));
        for (token, code) in [
            (None, 404),
            (Some("wrong"), 404),
            (Some("test-metrics-token"), 200),
        ] {
            let mut request = Request::builder().uri("/internal/metrics");
            if let Some(token) = token {
                request = request.header("authorization", format!("Bearer {token}"));
            }
            let response = app
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), code);
            if code == 200 {
                let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
                let text = String::from_utf8(bytes.to_vec()).unwrap();
                assert!(text.contains("analytics_queue_depth 2"));
                assert!(!text.contains(&f.user));
                assert!(!text.contains(&f.email));
            }
        }
        let route = format!("/api/sites/{site}/overview");
        for _ in 0..2 {
            let request = Request::builder()
                .uri(&route)
                .header("cookie", &f.cookie)
                .body(Body::empty())
                .unwrap();
            assert_eq!(
                app.clone().oneshot(request).await.unwrap().status(),
                StatusCode::OK
            );
        }
        assert_eq!(
            state
                .metrics
                .report_cache_hits
                .load(std::sync::atomic::Ordering::Relaxed),
            1
        );
        let outsider = Fixture::new().await;
        let request = Request::builder()
            .uri(&route)
            .header("cookie", &outsider.cookie)
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.clone().oneshot(request).await.unwrap().status(),
            StatusCode::NOT_FOUND
        );
        outsider.cleanup().await;
        let mut config = (*state.config).clone();
        config.runtime.role = Role::Worker;
        state.config = Arc::new(config);
        let worker = http::router(state.clone(), Arc::new(AtomicBool::new(true)));
        assert_eq!(
            worker
                .clone()
                .oneshot(
                    Request::builder()
                        .uri("/api/me")
                        .body(Body::empty())
                        .unwrap()
                )
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            worker
                .oneshot(
                    Request::builder()
                        .uri("/health/ready")
                        .body(Body::empty())
                        .unwrap()
                )
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    });
}

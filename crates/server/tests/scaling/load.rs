//! Bounded closed-loop HTTP traffic through separate API and worker pools on the isolated branch.
use super::*;
use analytics_core::config::Role;
use futures_util::{StreamExt, stream};
use std::sync::atomic::Ordering;

fn percentiles(mut values: Vec<f64>) -> Value {
    values.sort_by(f64::total_cmp);
    let at = |p: f64| {
        values[((values.len() as f64 * p).ceil() as usize)
            .saturating_sub(1)
            .min(values.len() - 1)]
    };
    json!({"samples":values.len(),"p50":at(0.5),"p95":at(0.95),"p99":at(0.99),"max":at(1.)})
}

#[tokio::test]
#[ignore = "real HTTP load against isolated Neon api-tests and loopback Redis only"]
async fn multi_tenant_and_hot_tenant_http_with_dashboard_reads() {
    let mut fixtures = vec![];
    let mut sites = vec![];
    for _ in 0..8 {
        let fixture = Fixture::new().await;
        fixture.pro().await;
        sites.push(fixture.site().await);
        fixtures.push(fixture);
    }
    let base = &fixtures[0];
    let mut config = (*base.state.config).clone();
    config.railway = true; // Exercise Railway's proxy normalization with distinct simulated visitor IPs.
    config.runtime.role = Role::Api;
    config.runtime.db_connections = 6;
    config.runtime.report_cache_seconds = 5;
    let database = std::env::var("TEST_DATABASE_URL").unwrap();
    let redis =
        std::env::var("RUST_TEST_REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6394".into());
    let api = State::connect(config.clone(), &database, &redis)
        .await
        .unwrap();
    config.runtime.role = Role::Worker;
    config.runtime.db_connections = 8;
    let worker = State::connect(config, &database, &redis).await.unwrap();
    let jobs = analytics_server::jobs::Jobs::start_events(worker.clone())
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = http::router(api.clone(), Arc::new(AtomicBool::new(true)));
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let result = AssertUnwindSafe(async {
        let count = std::env::var("HTTP_LOAD_EVENTS").unwrap_or_else(|_|"320".into()).parse::<usize>().unwrap();
        assert!((80..=10000).contains(&count));
        let client = reqwest::Client::builder().timeout(StdDuration::from_secs(20)).build().unwrap();
        let mut expected = vec![0_i64;sites.len()];
        let mut reports = vec![];
        for (scenario_index, scenario) in ["multi_tenant","hot_tenant"].iter().enumerate() {
            let mut requests = vec![];
            for index in 0..count {
                let owner = if scenario_index==0 {index%sites.len()} else {0};
                expected[owner]+=1;
                let event = json!({"siteId":sites[owner],"id":Uuid::new_v4(),"type":"pageview","url":format!("https://example.com/load/{index}")});
                requests.push((index,event.clone()));
                if index%10==0 {requests.push((index,event));}
            }
            let expected_requests = requests.len();
            let stop = Arc::new(AtomicBool::new(false));
            let reader_stop=stop.clone();let reader_client=client.clone();let reader_url=url.clone();
            let cookie=fixtures[0].cookie.clone();let site=sites[0];
            let reader=tokio::spawn(async move {
                let mut durations=vec![];
                while !reader_stop.load(Ordering::Relaxed) {
                    let started=Instant::now();
                    let response=reader_client.get(format!("{reader_url}/api/sites/{site}/overview"))
                        .header("cookie",&cookie).header("x-real-ip","198.18.255.254").send().await;
                    match response {
                        Ok(response) if response.status().is_success() => { durations.push(started.elapsed().as_secs_f64()); }
                        other => return Err(format!("dashboard request failed: {other:?}")),
                    }
                    tokio::time::sleep(StdDuration::from_millis(750)).await;
                }
                Ok(durations)
            });
            let started=Instant::now();
            let responses: Vec<_>=stream::iter(requests).map(|(index,event)| {
                let client=client.clone();let url=url.clone();
                async move {
                    let at=Instant::now();
                    let response=client.post(format!("{url}/api/collect"))
                        .header("origin","https://example.com").header("user-agent","Mozilla/5.0 Scaling Test Browser")
                        .header("x-real-ip",format!("198.19.{}.{}",(index/250+scenario_index*40)%255,index%250+1))
                        .json(&event).send().await.unwrap();
                    let status=response.status();let body: Value=response.json().await.unwrap();
                    (status.as_u16(),body,at.elapsed().as_secs_f64())
                }
            }).buffer_unordered(24).collect().await;
            let http_seconds=started.elapsed().as_secs_f64();
            let mut connection=worker.redis.clone();let mut peak=0_i64;
            loop {
                let depth:i64=redis::cmd("XLEN").arg(queue::stream(&worker)).query_async(&mut connection).await.unwrap();
                peak=peak.max(depth);
                if depth==0 {break;}
                if started.elapsed()>StdDuration::from_secs(180) {break;}
                tokio::time::sleep(StdDuration::from_millis(100)).await;
            }
            stop.store(true,Ordering::Relaxed);
            let read_times=reader.await.unwrap().unwrap();
            let seconds=started.elapsed().as_secs_f64();
            assert!(seconds<180.,"queue did not drain");
            for (status,body,_) in &responses { assert_eq!((*status,&body["accepted"]),(202,&Value::Bool(true)),"{body}"); }
            assert_eq!(responses.len(),expected_requests);
            for (index,fixture) in fixtures.iter().enumerate() {
                let stored:i64=sqlx::query_scalar("SELECT count(*) FROM events WHERE site_id=$1").bind(sites[index]).fetch_one(&fixture.state.db).await.unwrap();
                assert_eq!(stored,expected[index],"each accepted unique event must be committed exactly once");
                assert_eq!(billing::account_usage(&fixture.state,&fixture.user).await.unwrap()["events"]["used"],expected[index] as f64);
            }
            analytics_server::jobs::observe(&worker).await.unwrap();
            assert_eq!(queue::inspect(&worker).await.unwrap()["failed"],0);
            let report=json!({"scenario":scenario,"uniqueEvents":count,"requestsIncludingRetries":expected_requests,"concurrency":24,
                "httpSeconds":http_seconds,"drainSeconds":seconds,"uniqueCommittedPerSecond":count as f64/seconds,
                "collectSeconds":percentiles(responses.iter().map(|r|r.2).collect()),"dashboardSeconds":percentiles(read_times),
                "queueDepthAfterRequests":peak,"apiPoolMax":6,"workerPoolMax":8,"apiMetrics":api.metrics.render(&api.db),"workerMetrics":worker.metrics.render(&worker.db)});
            println!("HTTP_LOAD_RESULT {report}");
            reports.push(report);
        }
        let directory=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/artifacts/scaling");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("http-load.json"),serde_json::to_vec_pretty(&json!({"environment":"local debug build, isolated remote Neon branch, loopback Redis; closed-loop load, not a production capacity claim","scenarios":reports})).unwrap()).unwrap();
    }).catch_unwind().await;
    jobs.close().await;
    server.abort();
    api.db.close().await;
    worker.db.close().await;
    for fixture in fixtures {
        fixture.cleanup().await;
    }
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}

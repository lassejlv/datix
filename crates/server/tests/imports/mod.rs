use super::*;

fn path(site: Uuid, environment: Uuid) -> String {
    format!("/api/sites/{site}/environments/{environment}/imports")
}
fn date(ago: i64) -> String {
    (Utc::now().date_naive() - Duration::days(ago)).to_string()
}
fn plausible(ago: i64, pageviews: u64) -> String {
    format!(
        "date,visitors,pageviews,bounces,visits,visit_duration\n{},8,{pageviews},1,9,120\n",
        date(ago)
    )
}
async fn upload(
    f: &Fixture,
    endpoint: &str,
    csv: &str,
    provider: &str,
    timezone: &str,
    fingerprint: Option<&str>,
) -> (u16, Value) {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query
        .append_pair("provider", provider)
        .append_pair("timeZone", timezone)
        .append_pair(
            "filename",
            if provider == "ga4" {
                "analytics.csv"
            } else {
                "imported_visitors.csv"
            },
        )
        .append_pair("webOnly", "true");
    if let Some(hash) = fingerprint {
        query.append_pair("fingerprint", hash);
    }
    let mut request = Request::builder()
        .uri(format!("{endpoint}?{}", query.finish()))
        .method("POST")
        .header("origin", "http://localhost:3057")
        .header("cookie", &f.cookie)
        .header("content-type", "application/octet-stream")
        .body(Body::from(csv.to_owned()))
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(f.ip));
    let response = http::router(f.state.clone(), Arc::new(AtomicBool::new(true)))
        .oneshot(request)
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
async fn reviewed(
    f: &Fixture,
    endpoint: &str,
    csv: &str,
    provider: &str,
    timezone: &str,
) -> String {
    let (status, data) = upload(
        f,
        &format!("{endpoint}/preview"),
        csv,
        provider,
        timezone,
        None,
    )
    .await;
    assert_eq!(status, 200, "{data}");
    data["fingerprint"].as_str().unwrap().to_owned()
}

#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn import_preview_commit_report_duplicate_and_removal_leave_tracking_unbilled() {
    fixture!(f, {
        let site = f.site().await;
        let endpoint = path(site, site);
        let csv = plausible(10, 35);
        let fingerprint = reviewed(&f, &endpoint, &csv, "plausible", "UTC").await;
        let (_, empty, _) = f.request(&endpoint, "GET", None).await;
        assert_eq!(
            empty["imports"].as_array().unwrap().len(),
            0,
            "Preview must not persist data"
        );
        let (status, created) =
            upload(&f, &endpoint, &csv, "plausible", "UTC", Some(&fingerprint)).await;
        assert_eq!(status, 201, "{created}");
        assert_eq!(created["import"]["pageviews"], 35);
        let import = created["import"]["id"].as_str().unwrap();
        let (status, repeated) =
            upload(&f, &endpoint, &csv, "plausible", "UTC", Some(&fingerprint)).await;
        assert_eq!(status, 200, "{repeated}");
        assert_eq!(repeated["duplicate"], true);
        assert_eq!(repeated["import"]["id"], import);
        let query = format!("environment={site}&from={}&to={}", date(10), date(10));
        let (status, overview, _) = f
            .request(&format!("/api/sites/{site}/overview?{query}"), "GET", None)
            .await;
        assert_eq!(status, 200, "{overview}");
        assert_eq!(overview["pageviews"], 35);
        assert_eq!(overview["dailyUniqueVisitors"], 8);
        assert_eq!(overview["customEvents"], 0);
        assert_eq!(overview["imports"]["importedDays"], 1);
        assert_eq!(overview["imports"]["sources"][0]["provider"], "plausible");
        let (_, series, _) = f
            .request(
                &format!("/api/sites/{site}/timeseries?{query}"),
                "GET",
                None,
            )
            .await;
        assert_eq!(series["data"][0]["pageviews"], 35);
        let (_, usage, _) = f.request("/api/usage", "GET", None).await;
        assert_eq!(usage["events"]["used"], 0.0);
        for table in ["events", "daily_stats", "daily_visitors"] {
            let count: i64 =
                sqlx::query_scalar(&format!("SELECT count(*) FROM {table} WHERE site_id=$1"))
                    .bind(site)
                    .fetch_one(&f.state.db)
                    .await
                    .unwrap();
            assert_eq!(count, 0, "{table} was changed by import");
        }
        let (status, conflict) = upload(
            &f,
            &format!("{endpoint}/preview"),
            &plausible(10, 99),
            "plausible",
            "UTC",
            None,
        )
        .await;
        assert_eq!(status, 409, "{conflict}");
        assert_eq!(conflict["error"]["code"], "import_overlap");
        assert_eq!(
            f.request(&format!("{endpoint}/{import}"), "DELETE", None)
                .await
                .0,
            204
        );
        let (_, overview, _) = f
            .request(&format!("/api/sites/{site}/overview?{query}"), "GET", None)
            .await;
        assert_eq!(overview["pageviews"], 0);
        let revision: i64 =
            sqlx::query_scalar("SELECT import_revision FROM environments WHERE id=$1")
                .bind(site)
                .fetch_one(&f.state.db)
                .await
                .unwrap();
        assert_eq!(revision, 2);
    });
}

#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn imports_are_isolated_by_owner_environment_and_origin() {
    fixture!(f, {
        fixture!(other, {
            let site = f.site().await;
            let foreign = other.site().await;
            let endpoint = path(site, site);
            assert_eq!(other.request(&endpoint, "GET", None).await.0, 404);
            assert_eq!(f.request(&path(site, foreign), "GET", None).await.0, 404);
            assert_eq!(
                f.request_headers(&endpoint, "GET", None, &[("cookie", "")])
                    .await
                    .0,
                401
            );
            let (status, _) = upload(
                &other,
                &format!("{endpoint}/preview"),
                &plausible(10, 12),
                "plausible",
                "UTC",
                None,
            )
            .await;
            assert_eq!(status, 404);
            let fingerprint = reviewed(&f, &endpoint, &plausible(10, 12), "plausible", "UTC").await;
            let (_, created) = upload(
                &f,
                &endpoint,
                &plausible(10, 12),
                "plausible",
                "UTC",
                Some(&fingerprint),
            )
            .await;
            let import = created["import"]["id"].as_str().unwrap();
            assert_eq!(
                other
                    .request(&format!("{endpoint}/{import}"), "DELETE", None)
                    .await
                    .0,
                404
            );
            assert_eq!(
                f.request_headers(
                    &format!("{endpoint}/{import}"),
                    "DELETE",
                    None,
                    &[("origin", "https://elsewhere.example")]
                )
                .await
                .0,
                403
            );
            let (_, history, _) = f.request(&endpoint, "GET", None).await;
            assert_eq!(history["imports"].as_array().unwrap().len(), 1);
            assert_eq!(
                f.request(&format!("/api/sites/{site}"), "DELETE", None)
                    .await
                    .0,
                204
            );
            let rows: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM analytics_imports WHERE environment_id=$1",
            )
            .bind(site)
            .fetch_one(&f.state.db)
            .await
            .unwrap();
            assert_eq!(rows, 0);
        });
    });
}

#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn imports_recheck_native_dates_timezone_boundaries_and_the_reviewed_file() {
    fixture!(f, {
        let site = f.site().await;
        let endpoint = path(site, site);
        let csv = plausible(10, 11);
        let fingerprint = reviewed(&f, &endpoint, &csv, "plausible", "UTC").await;
        let (status, mismatch) = upload(
            &f,
            &endpoint,
            &plausible(10, 12),
            "plausible",
            "UTC",
            Some(&fingerprint),
        )
        .await;
        assert_eq!(status, 409, "{mismatch}");
        assert_eq!(mismatch["error"]["code"], "import_changed");
        let insert = "INSERT INTO daily_stats(site_id,day,dimension,value,pageviews,custom_events,visitors) VALUES($1,$2,'total','',7,0,3)";
        sqlx::query(insert)
            .bind(site)
            .bind(Utc::now().date_naive() - Duration::days(9))
            .execute(&f.state.db)
            .await
            .unwrap();
        let (status, overlap) = upload(
            &f,
            &format!("{endpoint}/preview"),
            &csv,
            "plausible",
            "America/New_York",
            None,
        )
        .await;
        assert_eq!(status, 409, "{overlap}");
        assert_eq!(overlap["error"]["code"], "import_live_overlap");
        let (status, body) =
            upload(&f, &endpoint, &csv, "plausible", "UTC", Some(&fingerprint)).await;
        assert_eq!(status, 201, "{body}");
        // A queued native day appearing later takes precedence, even over previously imported data.
        sqlx::query(insert)
            .bind(site)
            .bind(Utc::now().date_naive() - Duration::days(10))
            .execute(&f.state.db)
            .await
            .unwrap();
        let (_, report, _) = f
            .request(
                &format!(
                    "/api/sites/{site}/overview?from={}&to={}",
                    date(10),
                    date(9)
                ),
                "GET",
                None,
            )
            .await;
        assert_eq!(report["pageviews"], 14);
        assert_eq!(report["dailyUniqueVisitors"], 6);
        assert_eq!(report["imports"]["importedDays"], 0);
    });
}

#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn ga4_import_accepts_daily_total_users_and_serializes_concurrent_commits() {
    fixture!(f, {
        let site = f.site().await;
        let endpoint = path(site, site);
        let csv = format!(
            "# GA4 daily export\nDate,Total users,Views\n{},20,10\n",
            date(15).replace('-', "")
        );
        let hash = reviewed(&f, &endpoint, &csv, "ga4", "UTC").await;
        let (one, two) = tokio::join!(
            upload(&f, &endpoint, &csv, "ga4", "UTC", Some(&hash)),
            upload(&f, &endpoint, &csv, "ga4", "UTC", Some(&hash)),
        );
        let mut statuses = [one.0, two.0];
        statuses.sort();
        assert_eq!(statuses, [200, 201], "{one:?} {two:?}");
        let (_, report, _) = f
            .request(
                &format!(
                    "/api/sites/{site}/overview?from={}&to={}",
                    date(15),
                    date(15)
                ),
                "GET",
                None,
            )
            .await;
        assert_eq!(report["pageviews"], 10);
        assert_eq!(
            report["dailyUniqueVisitors"], 20,
            "GA total users can exceed views"
        );
        assert_eq!(
            report["imports"]["sources"][0]["visitorMetric"],
            "ga4_daily_total_users"
        );
        let (status, bad) = upload(
            &f,
            &format!("{endpoint}/preview"),
            &format!(
                "Date,Views,Active users\n{},10,8\n",
                date(20).replace('-', "")
            ),
            "ga4",
            "UTC",
            None,
        )
        .await;
        assert_eq!(status, 400, "{bad}");
        let (status, future) = upload(
            &f,
            &format!("{endpoint}/preview"),
            &plausible(-1, 10),
            "plausible",
            "UTC",
            None,
        )
        .await;
        assert_eq!(status, 400, "{future}");
    });
}

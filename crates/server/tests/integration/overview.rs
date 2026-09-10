use super::*;
#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn overview_comparisons_filters_goals_annotations_and_isolation() {
    fixture!(f, {
        f.pro().await;
        let site = f.site().await;
        let (status, other_site, _) = f
            .request(
                "/api/sites",
                "POST",
                Some(json!({"name":"Other site","domain":"other.example.com"})),
            )
            .await;
        assert_eq!(status, 201, "{other_site}");
        let other: Uuid = other_site["site"]["id"].as_str().unwrap().parse().unwrap();
        let base = format!("/api/sites/{site}/environments/{site}/features");
        let other_base = format!("/api/sites/{other}/environments/{other}/features");
        sqlx::query("UPDATE environments SET feature_settings='{\"goals\":true}' WHERE id=$1")
            .bind(site)
            .execute(&f.state.db)
            .await
            .unwrap();
        let (status, goal, _) = f
            .request(
                &format!("{base}/goals"),
                "POST",
                Some(json!({"name":"Pricing viewed","matchType":"page","matchValue":"/pricing"})),
            )
            .await;
        assert_eq!(status, 200, "{goal}");
        let today = Utc::now().date_naive();
        // Create the goal before the historical events, as real collection requires.
        sqlx::query("UPDATE conversion_goals SET created_at=now()-interval '20 days' WHERE environment_id=$1").bind(site).execute(&f.state.db).await.unwrap();
        for (offset, path, country, device, visitor) in [
            (0, "/pricing", "DK", "desktop", "a"),
            (0, "/pricing", "US", "mobile", "b"),
            (0, "/other", "DK", "desktop", "c"),
            (-3, "/pricing", "DK", "desktop", "d"),
        ] {
            let mut raw = serde_json::to_value(f.event(site)).unwrap();
            let at = Utc::now() + Duration::days(offset);
            raw["receivedAt"] = json!(at);
            raw["day"] = json!(at.date_naive());
            raw["path"] = json!(path);
            raw["country"] = json!(country);
            raw["device"] = json!(device);
            raw["visitor"] = json!(visitor.repeat(64));
            let event: Event = serde_json::from_value(raw).unwrap();
            assert!(ingest::ingest(&f.state, &event, Utc::now()).await.unwrap());
        }
        let (status, live, _) = f.request(&format!("{base}/live"), "GET", None).await;
        assert_eq!(status, 200, "{live}");
        assert_eq!(live["active"], 3);
        assert_eq!(live["recent"].as_array().unwrap().len(), 3);
        assert_eq!(
            f.request(&format!("{other_base}/live"), "GET", None)
                .await
                .1["active"],
            0
        );
        let from = today - Duration::days(2);
        let report_url = format!("{base}/overview?from={from}&to={today}");
        let (status, all, _) = f.request(&report_url, "GET", None).await;
        assert_eq!(status, 200, "{all}");
        assert_eq!(all["overview"]["pageviews"], 3);
        assert_eq!(all["previous"]["overview"]["pageviews"], 1);
        assert_eq!(all["timeseries"]["data"].as_array().unwrap().len(), 3);
        assert_eq!(all["previousRange"]["to"], json!(from - Duration::days(1)));
        assert_eq!(all["goals"]["goals"][0]["conversions"], 2);
        let (status, selected, _) = f
            .request(
                &format!("{report_url}&path=%2Fpricing&country=DK&device=desktop"),
                "GET",
                None,
            )
            .await;
        assert_eq!(status, 200, "{selected}");
        assert_eq!(selected["overview"]["pageviews"], 1);
        assert_eq!(selected["overview"]["dailyUniqueVisitors"], 1);
        assert_eq!(selected["previous"]["overview"]["pageviews"], 1);
        assert_eq!(selected["path"]["data"][0]["value"], "/pricing");
        assert_eq!(selected["country"]["data"].as_array().unwrap().len(), 1);
        assert_eq!(selected["goals"]["goals"][0]["conversions"], 1);
        assert_eq!(selected["goals"]["visitors"], 1);
        let (_, empty, _) = f
            .request(&format!("{report_url}&referrer="), "GET", None)
            .await;
        assert_eq!(empty["overview"]["pageviews"], 0, "{empty}");
        assert!(empty["path"]["data"].as_array().unwrap().is_empty());
        let (_, partial, _) = f
            .request(
                &format!(
                    "{base}/overview?from={}&to={today}&country=DK",
                    today - Duration::days(29)
                ),
                "GET",
                None,
            )
            .await;
        assert!(partial["previous"].is_null());
        let note_url = format!("{base}/annotations");
        let (status, note, _) = f
            .request(
                &note_url,
                "POST",
                Some(json!({"action":"create","day":today,"label":"New homepage"})),
            )
            .await;
        assert_eq!(status, 200, "{note}");
        let id = note["annotation"]["id"].as_str().unwrap();
        let (_, updated, _) = f.request(&report_url, "GET", None).await;
        assert_eq!(updated["annotations"][0]["label"], "New homepage");
        assert_eq!(
            f.request(
                &format!("{other_base}/annotations"),
                "POST",
                Some(json!({"action":"delete","id":id}))
            )
            .await
            .0,
            404
        );
        assert_eq!(
            f.request_headers(
                &note_url,
                "POST",
                Some(json!({"action":"delete","id":id})),
                &[("cookie", "")]
            )
            .await
            .0,
            401
        );
        assert_eq!(
            f.request(
                &note_url,
                "POST",
                Some(json!({"action":"create","day":today,"label":"  "}))
            )
            .await
            .0,
            400
        );
        assert_eq!(
            f.request(
                &format!("/api/sites/{other}/environments/{site}/features/overview"),
                "GET",
                None
            )
            .await
            .0,
            404
        );
        assert_eq!(
            f.request(&note_url, "POST", Some(json!({"action":"delete","id":id})))
                .await
                .0,
            200
        );
        let (_, updated, _) = f.request(&report_url, "GET", None).await;
        assert!(updated["annotations"].as_array().unwrap().is_empty());
    });
}

#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn overview_rolling_24_hours_uses_exact_windows_and_hourly_buckets() {
    fixture!(f, {
        f.pro().await;
        let site = f.site().await;
        let base = format!("/api/sites/{site}/environments/{site}/features");
        let (_, empty, _) = f
            .request(&format!("{base}/overview?window=24h"), "GET", None)
            .await;
        assert_eq!(empty["overview"]["pageviews"], 0, "{empty}");
        assert_eq!(empty["timeseries"]["data"].as_array().unwrap().len(), 24);
        sqlx::query("UPDATE environments SET feature_settings='{\"goals\":true}' WHERE id=$1")
            .bind(site)
            .execute(&f.state.db)
            .await
            .unwrap();
        let (status, goal, _) = f
            .request(
                &format!("{base}/goals"),
                "POST",
                Some(json!({"name":"Pricing viewed","matchType":"page","matchValue":"/pricing"})),
            )
            .await;
        assert_eq!(status, 200, "{goal}");
        sqlx::query("UPDATE conversion_goals SET created_at=now()-interval '4 days' WHERE environment_id=$1").bind(site).execute(&f.state.db).await.unwrap();
        let now = Utc::now();
        let mut current_days = std::collections::HashSet::new();
        for hours in [49, 25, 23, 2, 1] {
            let at = now - Duration::hours(hours);
            if hours < 24 {
                current_days.insert(at.date_naive());
            }
            let mut raw = serde_json::to_value(f.event(site)).unwrap();
            raw["receivedAt"] = json!(at);
            raw["day"] = json!(at.date_naive());
            assert!(
                ingest::ingest(&f.state, &serde_json::from_value(raw).unwrap(), now)
                    .await
                    .unwrap()
            );
        }
        let mut action = serde_json::to_value(f.event(site)).unwrap();
        let at = now - Duration::hours(1);
        action["receivedAt"] = json!(at);
        action["day"] = json!(at.date_naive());
        action["type"] = json!("event");
        action["name"] = json!("signup");
        assert!(
            ingest::ingest(&f.state, &serde_json::from_value(action).unwrap(), now)
                .await
                .unwrap()
        );
        for suffix in ["", "&country=DK&path=%2Fpricing"] {
            let (status, report, _) = f
                .request(&format!("{base}/overview?window=24h{suffix}"), "GET", None)
                .await;
            assert_eq!(status, 200, "{report}");
            assert_eq!(report["overview"]["pageviews"], 3);
            assert_eq!(report["overview"]["customEvents"], 1);
            assert_eq!(
                report["overview"]["dailyUniqueVisitors"],
                json!(current_days.len())
            );
            assert_eq!(report["previous"]["overview"]["pageviews"], 1);
            assert_eq!(report["previous"]["overview"]["customEvents"], 0);
            assert_eq!(report["goals"]["goals"][0]["conversions"], 3);
            assert_eq!(report["event"]["data"][0]["value"], "signup");
            let from =
                chrono::DateTime::parse_from_rfc3339(report["window"]["from"].as_str().unwrap())
                    .unwrap();
            let to = chrono::DateTime::parse_from_rfc3339(report["window"]["to"].as_str().unwrap())
                .unwrap();
            assert_eq!(to - from, Duration::hours(24));
            assert_eq!(report["previousRange"]["to"], report["window"]["from"]);
            let rows = report["timeseries"]["data"].as_array().unwrap();
            assert_eq!(rows.len(), 24);
            assert_eq!(
                rows.iter()
                    .map(|r| r["pageviews"].as_i64().unwrap())
                    .sum::<i64>(),
                3
            );
            for (index, row) in rows.iter().enumerate() {
                let at = chrono::DateTime::parse_from_rfc3339(row["at"].as_str().unwrap()).unwrap();
                assert_eq!(at, from + Duration::hours(index as i64));
            }
        }
        let (_, empty, _) = f
            .request(
                &format!("{base}/overview?window=24h&country=US"),
                "GET",
                None,
            )
            .await;
        assert_eq!(empty["overview"]["pageviews"], 0);
        assert_eq!(empty["goals"]["goals"][0]["conversions"], 0);
        assert_eq!(
            f.request(&format!("{base}/overview?window=bogus"), "GET", None)
                .await
                .0,
            400
        );
    });
}

use super::*;

#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn onboarding_persists_and_blocks_workspace_apis_until_a_verified_subscription() {
    fixture!(f, {
        assert_eq!(
            f.request("/api/usage", "GET", None).await.1["onboardingCompleted"],
            false
        );
        assert_eq!(
            f.request("/api/onboarding/complete", "POST", None).await.0,
            409
        );
        assert_eq!(
            f.request_headers("/api/onboarding/complete", "POST", None, &[("cookie", "")])
                .await
                .0,
            401
        );
        let site = f.site().await;
        assert_eq!(f.request("/api/sites", "GET", None).await.0, 200);
        let base = format!("/api/sites/{site}");
        let features = format!("{base}/environments/{site}/features");
        for (path, method) in [
            (base.clone(), "GET"),
            (base.clone(), "PATCH"),
            (base.clone(), "DELETE"),
            (format!("{base}/installation"), "GET"),
            (format!("{base}/overview"), "GET"),
            (format!("{base}/timeseries"), "GET"),
            (format!("{base}/breakdown?dimension=path"), "GET"),
            (format!("{base}/sessions"), "GET"),
            (format!("{base}/environments"), "GET"),
            (format!("{base}/environments"), "POST"),
            (format!("{base}/environments/{site}"), "PATCH"),
            (format!("{base}/environments/{site}/imports"), "GET"),
            (
                format!("{base}/environments/{site}/imports/preview"),
                "POST",
            ),
            (format!("{features}/overview"), "GET"),
            (format!("{features}/live"), "GET"),
            (format!("{features}/goals"), "POST"),
            (format!("{features}/annotations"), "POST"),
        ] {
            let (status, body, headers) = f.request(&path, method, Some(json!({}))).await;
            assert_eq!(status, 402, "{method} {path}: {body}");
            assert_eq!(body["error"]["code"], "subscription_required");
            assert!(headers.contains_key("x-request-id"));
        }
        assert_eq!(
            f.request_headers(
                "/api/onboarding/complete",
                "POST",
                None,
                &[("origin", "https://other.example")]
            )
            .await
            .0,
            403
        );
        for _ in 0..2 {
            let (status, body, _) = f.request("/api/onboarding/complete", "POST", None).await;
            assert_eq!(status, 200, "{body}");
            assert_eq!(body["onboardingCompleted"], true);
        }
        // Every request loads a fresh identity and the completion survives retries.
        let (_, usage, _) = f.request("/api/usage", "GET", None).await;
        assert_eq!(usage["onboardingCompleted"], true);
        assert!(usage["plan"].is_null());
        assert_eq!(f.request("/api/sites", "GET", None).await.0, 402);
        for path in ["/api/me", "/api/usage"] {
            assert_eq!(f.request(path, "GET", None).await.0, 200, "{path}");
        }
        // This fixture has no provider credentials; billing is reachable and
        // reports its own configuration error rather than the subscription gate.
        let (status, body, _) = f.request("/api/billing", "GET", None).await;
        assert_eq!(status, 503);
        assert_eq!(body["error"]["code"], "billing_unconfigured");
        // A checkout query parameter never grants access.
        assert_eq!(
            f.request(&format!("{base}/overview?checkout_id=paid"), "GET", None)
                .await
                .0,
            402
        );
        f.pro().await;
        assert_eq!(f.request("/api/sites", "GET", None).await.0, 200);
        assert_eq!(
            f.request(&format!("{base}/overview"), "GET", None).await.0,
            200
        );
        assert_eq!(
            f.request(&base, "PATCH", Some(json!({"name":"Subscribed website"})))
                .await
                .0,
            200
        );
    });
}

#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn trials_renewal_cancellation_and_expired_entitlements_control_workspace_access() {
    fixture!(f, {
        let site = f.site().await;
        f.pro().await;
        let base = format!("/api/sites/{site}/overview");
        let original: Value =
            sqlx::query_scalar("SELECT subscriptions FROM billing_customers WHERE owner_id=$1")
                .bind(&f.user)
                .fetch_one(&f.state.db)
                .await
                .unwrap();
        for (status, expired, entitled, expected) in [
            ("active", false, true, 200),
            ("trialing", false, true, 200),
            ("trialing", true, true, 402),
            ("active", true, true, 402),
            ("past_due", false, true, 402),
            ("canceled", false, true, 402),
            ("unpaid", false, true, 402),
            ("incomplete", false, true, 402),
            ("active", false, false, 402),
        ] {
            let mut subscriptions = original.clone();
            subscriptions[0]["status"] = json!(status);
            // Scheduled cancellation preserves access through the paid period.
            subscriptions[0]["cancelAtPeriodEnd"] = json!(true);
            subscriptions[0]["trialEnd"] = json!(Utc::now() + Duration::days(14));
            if expired {
                if status == "trialing" {
                    subscriptions[0]["trialEnd"] = json!(Utc::now() - Duration::seconds(1));
                } else {
                    subscriptions[0]["currentPeriodEnd"] = json!(Utc::now() - Duration::seconds(1));
                }
            }
            if !entitled {
                subscriptions[0]["entitlements"] = Value::Null;
            }
            sqlx::query(
                "UPDATE billing_customers SET subscriptions=$1,updated_at=now() WHERE owner_id=$2",
            )
            .bind(subscriptions)
            .bind(&f.user)
            .execute(&f.state.db)
            .await
            .unwrap();
            let (code, body, _) = f.request(&base, "GET", None).await;
            assert_eq!(
                code, expected,
                "{status}, expired={expired}, entitled={entitled}: {body}"
            );
        }
        let mut exhausted = original;
        exhausted[0]["entitlements"]["remaining"] = json!(0);
        exhausted[0]["entitlements"]["used"] = exhausted[0]["entitlements"]["eventLimit"].clone();
        sqlx::query(
            "UPDATE billing_customers SET subscriptions=$1,updated_at=now() WHERE owner_id=$2",
        )
        .bind(exhausted)
        .bind(&f.user)
        .execute(&f.state.db)
        .await
        .unwrap();
        assert_eq!(f.request(&base, "GET", None).await.0, 200);
        assert_eq!(
            f.request("/api/usage", "GET", None).await.1["pauseReason"],
            "event_limit"
        );
        sqlx::query(
            "UPDATE billing_customers SET updated_at=now()-interval '6 minutes' WHERE owner_id=$1",
        )
        .bind(&f.user)
        .execute(&f.state.db)
        .await
        .unwrap();
        assert_eq!(f.request(&base, "GET", None).await.0, 402);
    });
}

#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn unpaid_onboarding_allows_exactly_one_website_under_concurrency() {
    fixture!(f, {
        let (a, b) = tokio::join!(
            f.request(
                "/api/sites",
                "POST",
                Some(json!({"name":"One","domain":"one.example"}))
            ),
            f.request(
                "/api/sites",
                "POST",
                Some(json!({"name":"Two","domain":"two.example"}))
            )
        );
        let mut statuses = [a.0, b.0];
        statuses.sort();
        assert_eq!(statuses, [201, 402], "{a:?} {b:?}");
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM sites WHERE owner_id=$1")
            .bind(&f.user)
            .fetch_one(&f.state.db)
            .await
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(
            f.request("/api/onboarding/complete", "POST", None).await.0,
            200
        );
        // Removing a website elsewhere must not reset the persisted subscription gate.
        sqlx::query("DELETE FROM sites WHERE owner_id=$1")
            .bind(&f.user)
            .execute(&f.state.db)
            .await
            .unwrap();
        assert_eq!(
            f.request(
                "/api/sites",
                "POST",
                Some(json!({"name":"Again","domain":"again.example"}))
            )
            .await
            .0,
            402
        );
        assert_eq!(
            f.request("/api/usage", "GET", None).await.1["onboardingCompleted"],
            true
        );
    });
}

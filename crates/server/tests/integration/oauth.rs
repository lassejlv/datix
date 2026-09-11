use super::*;
use analytics_core::config::OAuthClient;

#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn oauth_stays_disabled_without_credentials_and_fails_closed() {
    fixture!(f, {
        assert_eq!(
            f.request("/api/preferences", "GET", None).await.1["oauth"],
            json!([])
        );
        for provider in ["github", "google", "azure"] {
            let (status, body, _) = f
                .request(
                    "/api/auth/sign-in/social",
                    "POST",
                    Some(json!({"provider": provider})),
                )
                .await;
            assert_eq!(status, 404, "provider {provider}");
            assert_eq!(body["error"]["code"], "not_found");
        }
        let (status, _, headers) = f
            .request("/api/auth/callback/github?code=x&state=y", "GET", None)
            .await;
        assert_eq!(status, 303);
        assert_eq!(headers["location"], "/signin?oauth=failed");
    });
}

#[tokio::test]
#[ignore = "requires isolated Neon and Redis"]
async fn oauth_begin_issues_authorize_urls_and_rejects_unknown_states() {
    fixture!(f, {
        let mut config = (*f.state.config).clone();
        config.oauth = vec![OAuthClient {
            provider: "github".into(),
            client_id: "test-id".into(),
            client_secret: "test-secret".into(),
        }];
        let state = State {
            config: Arc::new(config),
            db: f.state.db.clone(),
            redis: f.state.redis.clone(),
            redis_client: f.state.redis_client.clone(),
            http: f.state.http.clone(),
            metrics: f.state.metrics.clone(),
            report_cache: f.state.report_cache.clone(),
        };
        assert_eq!(analytics_services::oauth::enabled(&state), vec!["github"]);
        let url = analytics_services::oauth::begin(&state, "github")
            .await
            .unwrap();
        assert!(url.starts_with("https://github.com/login/oauth/authorize?"));
        assert!(url.contains("client_id=test-id"));
        let token = url::Url::parse(&url)
            .unwrap()
            .query_pairs()
            .find(|(key, _)| key == "state")
            .unwrap()
            .1
            .to_string();
        let mut redis = f.state.redis.clone();
        let stored: Option<String> = redis::cmd("GET")
            .arg(format!("analytics:oauth:{token}"))
            .query_async(&mut redis)
            .await
            .unwrap();
        assert_eq!(stored.as_deref(), Some("github"));
        let _: i64 = redis::cmd("DEL")
            .arg(format!("analytics:oauth:{token}"))
            .query_async(&mut redis)
            .await
            .unwrap();
        // Unknown states fail closed without touching the provider.
        let reply = analytics_services::oauth::callback(
            &state,
            "github",
            &format!("code=x&state={}", "0".repeat(64)),
            &axum::http::HeaderMap::new(),
            "127.0.0.1",
        )
        .await
        .unwrap();
        assert_eq!(reply.redirect.as_deref(), Some("/signin?oauth=failed"));
        assert!(reply.cookies.is_empty());
    });
}

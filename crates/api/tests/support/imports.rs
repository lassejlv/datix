use super::call;
use axum::{
    body::{Body, to_bytes},
    extract::ConnectInfo,
    http::{Request, header},
};
use chrono::Datelike;
use datix_api::AppState;
use serde_json::{Value, json};
use std::net::SocketAddr;
use tower::ServiceExt;
use uuid::Uuid;

async fn upload(state: &AppState, path: &str, body: &str, cookie: &str) -> (u16, Value) {
    let request = Request::builder()
        .method("POST")
        .uri(path)
        .header(header::ORIGIN, "http://localhost:3000")
        .header(header::CONTENT_TYPE, "text/csv")
        .header(header::COOKIE, cookie)
        .extension(ConnectInfo(
            "127.0.0.99:12000".parse::<SocketAddr>().unwrap(),
        ))
        .body(Body::from(body.to_owned()))
        .unwrap();
    let response = datix_api::router(state.clone())
        .oneshot(request)
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = to_bytes(response.into_body(), 128 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

/// The parent validates the isolated target before creating this account/environment.
pub async fn verify(state: &AppState, owner: &str, site: &str, environment: &str, cookie: &str) {
    let env = Uuid::parse_str(environment).unwrap();
    let base = format!("/api/sites/{site}/environments/{environment}/imports");
    let rate_key = format!("{}:imports:{owner}", state.config.queue_prefix);
    let year = chrono::Utc::now().year() - 1;
    let last_march = chrono::NaiveDate::from_ymd_opt(year, 3, 31).unwrap();
    let day =
        last_march - chrono::Duration::days(last_march.weekday().num_days_from_sunday().into());
    let csv = format!("date,visitors,pageviews\n{day},3,12");
    let params = "filename=imported_visitors.csv&provider=plausible&timeZone=Europe%2FCopenhagen";
    let (status, preview) = upload(state, &format!("{base}/preview?{params}"), &csv, cookie).await;
    assert_eq!(status, 200, "{preview}");
    assert_eq!(preview["dailyVisitors"], 3);
    assert_eq!(preview["dateBasis"], "provider_calendar_day");
    let fingerprint = preview["fingerprint"].as_str().unwrap();
    let (status, body) = upload(
        state,
        &format!("{base}?{params}&fingerprint=changed"),
        &csv,
        cookie,
    )
    .await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (409, Some("import_changed"))
    );
    let (status, body) = upload(
        state,
        &format!("{base}?{params}&fingerprint={fingerprint}"),
        &csv,
        cookie,
    )
    .await;
    assert_eq!(status, 201, "{body}");
    let id = body["import"]["id"].as_str().unwrap();
    let hours: f64 = sqlx::query_scalar("SELECT extract(epoch FROM (ends_at-starts_at))::float8/3600 FROM imported_daily_stats WHERE environment_id=$1 AND import_id=$2")
        .bind(env).bind(Uuid::parse_str(id).unwrap()).fetch_one(&state.pool).await.unwrap();
    assert_eq!(hours, 23.0);
    let (status, duplicate) = upload(
        state,
        &format!("{base}?{params}&fingerprint={fingerprint}"),
        &csv,
        cookie,
    )
    .await;
    assert_eq!(status, 200, "{duplicate}");
    assert_eq!(duplicate["duplicate"], true);
    assert_eq!(duplicate["import"]["id"], id);
    let revision: i64 = sqlx::query_scalar("SELECT import_revision FROM environments WHERE id=$1")
        .bind(env)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(revision, 2);
    let (status, body) = upload(
        state,
        &format!("{base}/preview?{params}"),
        &csv.replace(",12", ",13"),
        cookie,
    )
    .await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (409, Some("import_overlap"))
    );
    let (status, body) = upload(
        state,
        &format!(
            "{base}/preview?{}",
            params.replace("Europe%2FCopenhagen", "NotATimezone")
        ),
        &csv,
        cookie,
    )
    .await;
    assert_eq!(status, 400, "{body}");
    let (status, _, body) = call(state, "GET", &base, Value::Null, cookie).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["imports"].as_array().unwrap().len(), 1);
    let wrong = format!(
        "/api/sites/{}/environments/{environment}/imports",
        Uuid::new_v4()
    );
    assert_eq!(call(state, "GET", &wrong, Value::Null, cookie).await.0, 404);
    assert_eq!(
        call(
            state,
            "DELETE",
            &format!("{base}/{id}"),
            Value::Null,
            cookie
        )
        .await
        .0,
        204
    );
    assert_eq!(
        call(
            state,
            "DELETE",
            &format!("{base}/{id}"),
            Value::Null,
            cookie
        )
        .await
        .0,
        404
    );
    let rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM imported_daily_stats WHERE environment_id=$1")
            .bind(env)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(rows, 0);
    // A source day extending beyond midnight at the first native UTC day must fail.
    sqlx::query("INSERT INTO daily_stats(site_id,day,dimension,value,pageviews,custom_events,visitors) VALUES($1,$2,'total','',1,0,1)").bind(env).bind(day).execute(&state.pool).await.unwrap();
    let (status, body) = upload(state, &format!("{base}/preview?{params}"), &csv, cookie).await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (409, Some("import_live_overlap"))
    );
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains(&day.to_string())
    );
    sqlx::query("DELETE FROM daily_stats WHERE site_id=$1 AND day=$2")
        .bind(env)
        .bind(day)
        .execute(&state.pool)
        .await
        .unwrap();
    let _: i64 = redis::cmd("DEL")
        .arg(&rate_key)
        .query_async(&mut state.redis.clone())
        .await
        .unwrap();
    // Two concurrent submissions serialize under the owner lock and share one row.
    let ga4 = format!("Date,Views,Total users\n{},12,3", day.format("%Y%m%d"));
    let ga4_params = "filename=export.csv&provider=ga4&timeZone=UTC&webOnly=true";
    let (status, body) = upload(state, &format!("{base}/preview?{ga4_params}"), &ga4, cookie).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["visitorMetric"], "ga4_daily_total_users");
    let path = format!(
        "{base}?{ga4_params}&fingerprint={}",
        body["fingerprint"].as_str().unwrap()
    );
    let (a, b) = tokio::join!(
        upload(state, &path, &ga4, cookie),
        upload(state, &path, &ga4, cookie)
    );
    assert!(matches!((a.0, b.0), (201, 200) | (200, 201)), "{a:?} {b:?}");
    assert_eq!(a.1["import"]["id"], b.1["import"]["id"]);
    let id = a.1["import"]["id"].as_str().unwrap();
    assert_eq!(
        call(
            state,
            "DELETE",
            &format!("{base}/{id}"),
            Value::Null,
            cookie
        )
        .await
        .0,
        204
    );
    let _: () = redis::cmd("SET")
        .arg(&rate_key)
        .arg(12)
        .arg("EX")
        .arg(60)
        .query_async(&mut state.redis.clone())
        .await
        .unwrap();
    let (status, body) = upload(state, &format!("{base}/preview?{params}"), &csv, cookie).await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (429, Some("rate_limited"))
    );
    let _: i64 = redis::cmd("DEL")
        .arg(rate_key)
        .query_async(&mut state.redis.clone())
        .await
        .unwrap();
    // Restore the fixture baseline; analytics checks below use this empty environment.
    sqlx::query("UPDATE environments SET import_revision=0 WHERE id=$1")
        .bind(env)
        .execute(&state.pool)
        .await
        .unwrap();
    assert_eq!(
        call(state, "GET", &base, json!(null), cookie).await.2["imports"],
        json!([])
    );
}

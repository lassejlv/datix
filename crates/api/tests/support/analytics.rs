use super::call;
use datix_api::AppState;
use serde_json::{Value, json};
use uuid::Uuid;

async fn get(state: &AppState, path: &str, cookie: &str) -> Value {
    let (status, _, body) = call(state, "GET", path, Value::Null, cookie).await;
    assert_eq!(status, 200, "{path}: {body}");
    body
}

/// Called only after the parent fixture validates the isolated Neon hostname and database.
pub async fn verify(state: &AppState, site: &str, environment: &str, cookie: &str) {
    let env = Uuid::parse_str(environment).unwrap();
    let today = chrono::Utc::now().date_naive();
    let visitor = "a".repeat(64);
    for (kind, days_ago) in [
        ("pageview", 0),
        ("pageview", 0),
        ("event", 0),
        ("pageview", 3),
    ] {
        sqlx::query("INSERT INTO events(site_id,id,received_at,day,type,name,path,referrer,country,device,visitor) VALUES($1,$2,now()-$3*interval '1 day',current_date-$4,$5,CASE WHEN $5='event' THEN 'purchase' ELSE '' END,'/','example.test','DK','desktop',$6)")
            .bind(env).bind(Uuid::new_v4()).bind(days_ago as f64).bind(days_ago).bind(kind).bind(&visitor).execute(&state.pool).await.unwrap();
    }
    sqlx::query("INSERT INTO daily_stats(site_id,day,dimension,value,pageviews,custom_events,visitors) VALUES($1,current_date-3,'total','',5,2,3),($1,current_date-3,'path','/',5,2,3)")
        .bind(env).execute(&state.pool).await.unwrap();
    let import = Uuid::new_v4();
    let summary = json!({"sourceName":"Fixture","visitorMetric":"daily_unique_visitors","from":today-chrono::Duration::days(5),"to":today,"metrics":["pageviews"],"breakdowns":["path"]});
    sqlx::query("INSERT INTO analytics_imports(id,environment_id,provider,source_timezone,fingerprint,summary) VALUES($1,$2,'plausible','Europe/Copenhagen',$3,$4)")
        .bind(import).bind(env).bind(Uuid::new_v4().to_string()).bind(summary).execute(&state.pool).await.unwrap();
    // Only the earlier imported day is eligible; overlapping imported history is excluded.
    sqlx::query("INSERT INTO imported_daily_stats(environment_id,day,import_id,starts_at,ends_at,pageviews,visitors,custom_events) VALUES($1,current_date-5,$2,current_date-5,current_date-4,10,4,1),($1,current_date,$2,current_date,current_date+1,1000,1000,1000)")
        .bind(env).bind(import).execute(&state.pool).await.unwrap();
    sqlx::query("INSERT INTO imported_breakdowns(environment_id,day,dimension,value,count) VALUES($1,current_date-5,'path','/',10),($1,current_date,'path','/',1000)")
        .bind(env).execute(&state.pool).await.unwrap();
    let base = format!("/api/sites/{site}");
    let feature = format!("{base}/environments/{environment}/features");
    let totals = get(
        state,
        &format!("{base}/overview?environment={environment}"),
        cookie,
    )
    .await;
    assert_eq!(
        (
            totals["pageviews"].as_i64(),
            totals["customEvents"].as_i64(),
            totals["dailyUniqueVisitors"].as_i64()
        ),
        (Some(17), Some(4), Some(8))
    );
    assert_eq!(totals["imports"]["importedDays"], 1);
    assert_eq!(totals["imports"]["calendarDayWarning"], true);
    let series = get(
        state,
        &format!("{base}/timeseries?environment={environment}"),
        cookie,
    )
    .await;
    assert_eq!(series["data"].as_array().unwrap().len(), 30);
    assert_eq!(
        series["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["pageviews"].as_i64().unwrap())
            .sum::<i64>(),
        17
    );
    let breakdown = get(
        state,
        &format!("{base}/breakdown?environment={environment}&dimension=path"),
        cookie,
    )
    .await;
    assert_eq!(breakdown["data"][0], json!({"value":"/","count":17}));
    assert_eq!(
        get(
            state,
            &format!("{base}/installation?environment={environment}"),
            cookie
        )
        .await["receiving"],
        true
    );
    assert_eq!(
        get(state, &format!("{base}/overview"), cookie).await["pageviews"],
        0
    );

    let (status, _, goal) = call(
        state,
        "POST",
        &format!("{feature}/goals"),
        json!({"name":"Purchase","matchType":"event","matchValue":"purchase"}),
        cookie,
    )
    .await;
    assert_eq!(status, 200, "{goal}");
    let goal = goal["goal"]["id"].as_str().unwrap();
    sqlx::query("INSERT INTO goal_conversions(goal_id,environment_id,event_id,received_at,day,visitor,path) SELECT $1,site_id,id,received_at,day,visitor,path FROM events WHERE site_id=$2 AND type='event'")
        .bind(Uuid::parse_str(goal).unwrap()).bind(env).execute(&state.pool).await.unwrap();
    let goals = get(state, &format!("{feature}/goals"), cookie).await;
    assert_eq!(goals["goals"][0]["conversions"], 1);
    assert_eq!(goals["visitors"], 4);
    let (status, _, annotation) = call(
        state,
        "POST",
        &format!("{feature}/annotations"),
        json!({"action":"create","day":today,"label":"Launch"}),
        cookie,
    )
    .await;
    assert_eq!(status, 200, "{annotation}");
    let overview = get(state, &format!("{feature}/overview"), cookie).await;
    assert_eq!(overview["overview"]["pageviews"], 17);
    assert_eq!(overview["annotations"][0]["label"], "Launch");
    assert_eq!(overview["goals"]["goals"][0]["conversions"], 1);
    assert_eq!(overview["previous"]["overview"]["pageviews"], 0);
    let filtered = get(
        state,
        &format!("{feature}/overview?path=%2F&window=24h"),
        cookie,
    )
    .await;
    assert_eq!(filtered["overview"]["pageviews"], 2);
    assert_eq!(filtered["timeseries"]["data"].as_array().unwrap().len(), 24);
    assert_eq!(filtered["filtered"], true);

    let fingerprint = "b".repeat(64);
    for (kind, payload) in [
        (
            "error",
            json!({"message":"Fixture failure","source":"app.js","stack":"fixture"}),
        ),
        ("vital", json!({"name":"LCP","value":100})),
        ("vital", json!({"name":"LCP","value":200})),
    ] {
        sqlx::query("INSERT INTO diagnostic_events(environment_id,id,page_id,received_at,kind,path,device,visitor,fingerprint,payload) VALUES($1,$2,$3,now(),$4,'/','desktop',$5,$6,$7)")
            .bind(env).bind(Uuid::new_v4()).bind(Uuid::new_v4()).bind(kind).bind(&visitor).bind(&fingerprint).bind(payload).execute(&state.pool).await.unwrap();
    }
    assert_eq!(
        get(state, &format!("{feature}/errors"), cookie).await["items"][0]["resolved"],
        false
    );
    let (status, _, _) = call(
        state,
        "POST",
        &format!("{feature}/errors"),
        json!({"fingerprint":fingerprint}),
        cookie,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        get(state, &format!("{feature}/errors"), cookie).await["items"][0]["resolved"],
        true
    );
    let vitals = get(state, &format!("{feature}/web-vitals"), cookie).await;
    assert_eq!(vitals["items"][0]["samples"], 2);
    assert_eq!(vitals["items"][0]["p75"], 175.0);
    assert!(
        get(state, &format!("{feature}/live"), cookie).await["active"]
            .as_i64()
            .unwrap()
            > 0
    );

    sqlx::query("INSERT INTO activity_events(environment_id,id,session_key,visitor_key,received_at,kind,name,path,referrer,country,device,browser,os,details) SELECT $1,gen_random_uuid(),repeat(md5(i::text),2),repeat(md5(i::text),2),now(),'pageview','','/','','DK','desktop','','','{}'::jsonb FROM generate_series(1,51) i")
        .bind(env).execute(&state.pool).await.unwrap();
    let sessions = get(
        state,
        &format!("{base}/sessions?environment={environment}"),
        cookie,
    )
    .await;
    assert_eq!(sessions["sessions"].as_array().unwrap().len(), 50);
    assert_eq!(sessions["hasMore"], true);
    let cursor = sessions["nextCursor"].as_str().unwrap();
    let next = get(
        state,
        &format!("{base}/sessions?environment={environment}&cursor={cursor}"),
        cookie,
    )
    .await;
    assert_eq!(next["hasMore"], false);
    for row in next["sessions"].as_array().unwrap() {
        assert!(
            !sessions["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|seen| seen["id"] == row["id"] && seen["visitorKey"] == row["visitorKey"])
        );
    }
    let (status, _, _) = call(
        state,
        "GET",
        &format!("{base}/sessions?cursor={cursor}"),
        Value::Null,
        cookie,
    )
    .await;
    assert_eq!(status, 400);
    let long_session = "c".repeat(64);
    sqlx::query("INSERT INTO activity_events(environment_id,id,session_key,visitor_key,received_at,kind,name,path,referrer,country,device,browser,os,details) SELECT $1,gen_random_uuid(),$2,$2,now(),'click','','/','','DK','desktop','','',jsonb_build_object('sequence',i) FROM generate_series(1,201) i")
        .bind(env).bind(&long_session).execute(&state.pool).await.unwrap();
    let details = get(
        state,
        &format!("{base}/sessions?environment={environment}&session={long_session}"),
        cookie,
    )
    .await;
    assert_eq!(details["events"].as_array().unwrap().len(), 200);
    let next = get(
        state,
        &format!(
            "{base}/sessions?environment={environment}&session={long_session}&cursor={}",
            details["nextCursor"].as_str().unwrap()
        ),
        cookie,
    )
    .await;
    assert_eq!(next["events"].as_array().unwrap().len(), 1);
    assert_eq!(next["events"][0]["details"]["sequence"], 201);
    let (status, _, _) = call(
        state,
        "DELETE",
        &format!("{feature}/goals/{goal}"),
        Value::Null,
        cookie,
    )
    .await;
    assert_eq!(status, 200);
    let (status, _, _) = call(
        state,
        "POST",
        &format!("{feature}/annotations"),
        json!({"action":"delete","id":annotation["annotation"]["id"]}),
        cookie,
    )
    .await;
    assert_eq!(status, 200);

    // Analytics tables use durable cleanup rather than cascades. Remove only this fixture's rows.
    for table in [
        "events",
        "daily_stats",
        "daily_visitors",
        "activity_events",
        "diagnostic_events",
        "goal_conversions",
        "imported_breakdowns",
        "imported_daily_stats",
        "analytics_imports",
    ] {
        let column = if matches!(table, "events" | "daily_stats" | "daily_visitors") {
            "site_id"
        } else {
            "environment_id"
        };
        sqlx::query(&format!("DELETE FROM {table} WHERE {column}=$1"))
            .bind(env)
            .execute(&state.pool)
            .await
            .unwrap();
    }
}

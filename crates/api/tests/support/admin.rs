use super::call;
use datix_api::AppState;
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

pub async fn verify(state: &AppState, owner: &str, email: &str, site: &str, cookie: &str) {
    assert_eq!(
        call(state, "GET", "/api/admin/status", Value::Null, cookie)
            .await
            .0,
        403
    );
    let mut admin = state.clone();
    let mut config = (*state.config).clone();
    config.admin_emails.insert(email.to_owned());
    admin.config = Arc::new(config);
    let (status, _, body) = call(&admin, "GET", "/api/admin/status", Value::Null, cookie).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["status"], "ok");
    assert_eq!(body["dependencies"]["database"]["schemaVersion"], 2);
    let (_, _, body) = call(
        &admin,
        "GET",
        &format!("/api/admin/users/{owner}"),
        Value::Null,
        cookie,
    )
    .await;
    assert_eq!(body["user"]["email"], email);
    assert_eq!(body["sites"][0]["id"], site);
    let (status, _, body) = call(
        &admin,
        "GET",
        "/api/admin/sites?limit=1",
        Value::Null,
        cookie,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["sites"].as_array().unwrap().len(), 1);
    if let Some(cursor) = body["nextCursor"].as_str() {
        assert_eq!(
            call(
                &admin,
                "GET",
                &format!("/api/admin/sites?cursor={cursor}&limit=1"),
                Value::Null,
                cookie
            )
            .await
            .0,
            200
        );
    }
    assert_eq!(
        call(
            &admin,
            "PATCH",
            &format!("/api/admin/users/{owner}"),
            json!({"suspended":true,"reason":"fixture"}),
            cookie
        )
        .await
        .0,
        409
    );
    assert_eq!(
        call(
            &admin,
            "PATCH",
            &format!("/api/admin/sites/{site}"),
            json!({"suspended":true}),
            cookie
        )
        .await
        .0,
        400
    );
    let (status, _, body) = call(
        &admin,
        "PATCH",
        &format!("/api/admin/sites/{site}"),
        json!({"suspended":true,"reason":"Fixture suspension"}),
        cookie,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["site"]["trackingSuspended"], true);
    assert!(!body["environments"].as_array().unwrap().is_empty());
    let (_, _, tracker) = call(
        state,
        "GET",
        &format!("/api/tracker-config?siteId={site}"),
        Value::Null,
        "",
    )
    .await;
    assert_eq!(tracker["enabled"], false);
    for _ in 0..2 {
        let (status, _, body) = call(
            &admin,
            "PATCH",
            &format!("/api/admin/sites/{site}"),
            json!({"suspended":false}),
            cookie,
        )
        .await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["site"]["suspended"], false);
    }
    let (status, _, audit) = call(
        &admin,
        "GET",
        &format!("/api/admin/audit?targetType=site&targetId={site}&limit=1"),
        Value::Null,
        cookie,
    )
    .await;
    assert_eq!(status, 200, "{audit}");
    assert_eq!(audit["entries"][0]["action"], "site.restored");
    let cursor = audit["nextCursor"].as_str().unwrap();
    let (_, _, older) = call(
        &admin,
        "GET",
        &format!("/api/admin/audit?targetType=site&targetId={site}&cursor={cursor}&limit=1"),
        Value::Null,
        cookie,
    )
    .await;
    assert_eq!(older["entries"][0]["action"], "site.suspended");
    assert!(older["nextCursor"].is_null());

    let target = format!("rust-admin-target-{}", Uuid::new_v4());
    sqlx::query("INSERT INTO public.\"user\"(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Admin fixture target',$2,true,now(),now())").bind(&target).bind(format!("{target}@example.test")).execute(&state.pool).await.unwrap();
    sqlx::query("INSERT INTO session(id,expires_at,token,created_at,updated_at,user_id) VALUES($1,now()+interval '1 day',$2,now(),now(),$3)").bind(Uuid::new_v4().to_string()).bind(Uuid::new_v4().to_string()).bind(&target).execute(&state.pool).await.unwrap();
    let (status, _, body) = call(
        &admin,
        "PATCH",
        &format!("/api/admin/users/{target}"),
        json!({"suspended":true,"reason":"Fixture policy"}),
        cookie,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["user"]["activeSessionCount"], 0);
    assert_eq!(body["user"]["suspended"], true);
    let (_, _, audit) = call(
        &admin,
        "GET",
        &format!("/api/admin/audit?targetType=user&targetId={target}"),
        Value::Null,
        cookie,
    )
    .await;
    assert_eq!(audit["entries"][0]["metadata"]["sessionsRevoked"], 1);
    assert_eq!(
        audit["entries"][0]["metadata"]["suspensionEmail"],
        "disabled"
    );
    let (status, _, _) = call(
        &admin,
        "PATCH",
        &format!("/api/admin/users/{target}"),
        json!({"suspended":true,"reason":"Updated internal reason"}),
        cookie,
    )
    .await;
    assert_eq!(status, 200);
    let (_, _, updated_audit) = call(
        &admin,
        "GET",
        &format!("/api/admin/audit?targetType=user&targetId={target}"),
        Value::Null,
        cookie,
    )
    .await;
    assert_eq!(
        updated_audit["entries"][0]["action"],
        "user.suspension_updated"
    );
    assert!(
        updated_audit["entries"][0]["metadata"]
            .get("suspensionEmail")
            .is_none()
    );
    assert_eq!(
        updated_audit["entries"][1]["metadata"]["suspensionEmail"],
        "disabled"
    );
    assert_eq!(
        call(
            &admin,
            "GET",
            "/api/admin/users?status=suspended&search=rust-admin-target",
            Value::Null,
            cookie
        )
        .await
        .0,
        200
    );
    sqlx::query("DELETE FROM admin_audit_log WHERE actor_user_id=$1 AND target_id=ANY($2)")
        .bind(owner)
        .bind(vec![site.to_owned(), target.clone()])
        .execute(&state.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM public.\"user\" WHERE id=$1")
        .bind(target)
        .execute(&state.pool)
        .await
        .unwrap();
}

use crate::call;
use axum::{
    body::Body,
    http::{Request, header},
};
use datix_api::AppState;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;
use uuid::Uuid;

pub async fn verify(state: &AppState, owner: &str, email: &str, cookie: &str) -> Uuid {
    let (code, _, _) = call(state, "GET", "/api/legal/agreement", Value::Null, "").await;
    assert_eq!(code, 401);
    let (code, _, template) = call(state, "GET", "/api/dpa/download", Value::Null, "").await;
    assert_eq!(code, 200);
    assert!(template.as_str().unwrap().contains("Unaccepted template"));
    let (code, _, result) = call(state, "GET", "/api/legal/agreement", Value::Null, cookie).await;
    assert_eq!(code, 200);
    assert!(result["acceptance"].is_null());
    let mut input = result["current"].clone();
    input["customerName"] = json!("Fixture <script>alert(1)</script> Ltd");
    input["customerRole"] = json!("processor");
    input["signerName"] = json!("Fixture signer");
    input["signerTitle"] = json!("Owner");
    input["accepted"] = json!(false);
    let (code, _, _) = call(state, "POST", "/api/legal/agreement", input.clone(), cookie).await;
    assert_eq!(code, 400);
    input["accepted"] = json!(true);
    let mut stale = input.clone();
    stale["dpaSha256"] = json!("old");
    let (code, _, rejected) = call(state, "POST", "/api/legal/agreement", stale, cookie).await;
    assert_eq!(code, 409);
    assert_eq!(rejected["error"]["code"], "agreement_changed");
    let response = datix_api::router(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/legal/agreement")
                .header(header::ORIGIN, "https://untrusted.example.test")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::COOKIE, cookie)
                .body(Body::from(input.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    let (code, _, blocked) = call(
        state,
        "POST",
        "/api/sites",
        json!({"name":"Blocked","domain":"blocked.test"}),
        cookie,
    )
    .await;
    assert_eq!(code, 403);
    assert_eq!(blocked["error"]["code"], "agreement_required");
    let (code, _, usage) = call(state, "GET", "/api/usage", Value::Null, cookie).await;
    assert_eq!(code, 200);
    assert_eq!(usage["pauseReason"], "agreement_required");
    let (code, _, accepted) =
        call(state, "POST", "/api/legal/agreement", input.clone(), cookie).await;
    assert_eq!(code, 200, "{accepted}");
    let receipt = &accepted["acceptance"];
    assert_eq!(receipt["signerEmail"], email);
    assert_eq!(receipt["customerRole"], "processor");
    let id = Uuid::parse_str(receipt["id"].as_str().unwrap()).unwrap();
    input["signerName"] = json!("Retry must not overwrite");
    let (_, _, retry) = call(state, "POST", "/api/legal/agreement", input, cookie).await;
    assert_eq!(retry["acceptance"], *receipt);
    assert_eq!(retry["history"].as_array().unwrap().len(), 1);
    let stored: (String, String, String, String) = sqlx::query_as("SELECT dpa_html,terms_html,dpa_sha256,terms_sha256 FROM legal_acceptances WHERE id=$1 AND owner_id=$2")
        .bind(id).bind(owner).fetch_one(&state.pool).await.unwrap();
    assert_eq!(hex::encode(Sha256::digest(stored.0.as_bytes())), stored.2);
    assert_eq!(hex::encode(Sha256::digest(stored.1.as_bytes())), stored.3);
    let path = format!("/api/legal/agreement/{id}/download");
    let (code, headers, copy) = call(state, "GET", &path, Value::Null, cookie).await;
    assert_eq!(code, 200);
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert!(
        headers[header::CONTENT_DISPOSITION]
            .to_str()
            .unwrap()
            .contains("attachment")
    );
    let html = copy.as_str().unwrap();
    assert!(html.contains(&stored.0));
    assert!(html.contains(&stored.1));
    assert!(html.contains("Fixture &lt;script&gt;alert(1)&lt;/script&gt; Ltd"));
    assert!(!html.contains("Fixture <script>"));
    let other = format!("legal-other-{}", Uuid::new_v4());
    sqlx::query("INSERT INTO public.\"user\"(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Other legal fixture',$2,true,now(),now())")
        .bind(&other).bind(format!("{other}@example.test")).execute(&state.pool).await.unwrap();
    let other_id: Uuid = sqlx::query_scalar("INSERT INTO legal_acceptances(owner_id,customer_name,customer_role,signer_name,signer_title,signer_email,dpa_version,terms_version,dpa_sha256,terms_sha256,dpa_html,terms_html) SELECT $1,customer_name,customer_role,signer_name,signer_title,signer_email,dpa_version,terms_version,dpa_sha256,terms_sha256,dpa_html,terms_html FROM legal_acceptances WHERE id=$2 RETURNING id")
        .bind(&other).bind(id).fetch_one(&state.pool).await.unwrap();
    let (code, _, _) = call(
        state,
        "GET",
        &format!("/api/legal/agreement/{other_id}/download"),
        Value::Null,
        cookie,
    )
    .await;
    assert_eq!(code, 404);
    sqlx::query("DELETE FROM public.\"user\" WHERE id=$1")
        .bind(other)
        .execute(&state.pool)
        .await
        .unwrap();
    let preserved: bool = sqlx::query_scalar("SELECT owner_id IS NULL AND signer_name='Fixture signer' FROM legal_acceptances WHERE id=$1").bind(other_id).fetch_one(&state.pool).await.unwrap();
    assert!(preserved);
    sqlx::query("DELETE FROM legal_acceptances WHERE id=$1")
        .bind(other_id)
        .execute(&state.pool)
        .await
        .unwrap();
    id
}

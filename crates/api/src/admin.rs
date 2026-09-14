use crate::{
    AppState,
    error::ApiError,
    http::{Owner, json_body},
    sites::identifier,
};
use axum::{
    Extension, Json, Router,
    extract::{Path, Query, Request, State},
    http::StatusCode,
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use std::collections::HashMap;

const USERS: &str = include_str!("admin/user.sql");
const SITES: &str = include_str!("admin/site.sql");

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/admin/sentry-test", post(sentry_test))
        .route("/api/admin/{resource}", get(list))
        .route("/api/admin/{resource}/{id}", get(detail).patch(update))
}

async fn sentry_test(
    State(state): State<AppState>,
    Extension(actor): Extension<Owner>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    authorize_sentry_test(&actor, state.config.external_effects)?;
    // Shared across API instances; repeated clicks must not flood the project.
    let acquired: Option<String> = redis::cmd("SET")
        .arg(format!("{}:admin:sentry-test", state.config.queue_prefix))
        .arg("1")
        .arg("NX")
        .arg("EX")
        .arg(30)
        .query_async(&mut state.redis.clone())
        .await?;
    if acquired.is_none() {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "Wait 30 seconds before sending another Sentry test.",
        ));
    }
    let event = crate::monitoring::admin_test_event();
    let event_id = event.event_id.simple().to_string();
    // Record the request before the external effect; do not claim delivery in the audit log.
    sqlx::query("INSERT INTO admin_audit_log(actor_user_id,action,target_type,target_id,metadata) VALUES($1,'sentry.test_requested','user',$1,$2)")
        .bind(&actor.id).bind(json!({"eventId":event_id})).execute(&state.pool).await?;
    if sentry::capture_event(event).is_nil() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "sentry_discarded",
            "Sentry discarded the test event. Check the error sample rate.",
        ));
    }
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({"status":"queued","eventId":event_id})),
    ))
}

fn authorize_sentry_test(actor: &Owner, external_effects: bool) -> Result<(), ApiError> {
    authorized(actor)?;
    if !external_effects
        || !sentry::Hub::current()
            .client()
            .is_some_and(|client| client.is_enabled())
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "sentry_disabled",
            "Backend Sentry reporting is not enabled.",
        ));
    }
    Ok(())
}

fn authorized(owner: &Owner) -> Result<(), ApiError> {
    if !owner.admin {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "forbidden",
            "Administrator access is required.",
        ));
    }
    Ok(())
}
fn missing() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "not_found", "Not found.")
}

fn camel(value: Value) -> Value {
    let Some(row) = value.as_object() else {
        return value;
    };
    Value::Object(
        row.iter()
            .map(|(key, value)| {
                let mut camel = String::new();
                let mut upper = false;
                for c in key.chars() {
                    if c == '_' {
                        upper = true;
                    } else {
                        camel.push(if upper { c.to_ascii_uppercase() } else { c });
                        upper = false;
                    }
                }
                (camel, value.clone())
            })
            .collect(),
    )
}
fn wrap(sql: String) -> String {
    format!("SELECT to_jsonb(result) FROM ({sql}) result")
}

async fn status(state: &AppState) -> Result<Value, ApiError> {
    let counts=sqlx::query("SELECT (SELECT count(*) FROM public.\"user\") AS users,(SELECT count(*) FROM user_suspensions) AS suspended_users,(SELECT count(*) FROM sites) AS sites,(SELECT count(*) FROM sites s WHERE EXISTS(SELECT 1 FROM site_suspensions WHERE site_id=s.id) OR EXISTS(SELECT 1 FROM user_suspensions WHERE user_id=s.owner_id)) AS suspended_sites,(SELECT count(*) FROM environments) AS environments,(SELECT count(*) FROM session WHERE expires_at>now() AT TIME ZONE 'UTC') AS sessions,(SELECT count(*) FROM datix_schema_migrations) AS version").fetch_one(&state.pool).await?;
    let mut redis = state.redis.clone();
    let ping = redis::cmd("PING");
    let (database, redis, queue) = tokio::join!(
        sqlx::query("SELECT 1").execute(&state.pool),
        ping.query_async::<String>(&mut redis),
        state.queue.counts()
    );
    let pending = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM ingestion_receipts WHERE state='pending'",
    )
    .fetch_one(&state.pool)
    .await;
    let database_ok = database.is_ok();
    let redis_ok = redis.as_deref() == Ok("PONG");
    let queue_ok = queue.is_ok();
    let pending_ok = pending.is_ok();
    if !(database_ok && redis_ok && queue_ok && pending_ok) {
        tracing::error!(
            database_ok,
            redis_ok,
            queue_ok,
            pending_ok,
            "Administrative status check degraded"
        );
    }
    Ok(
        json!({"status":if database_ok && redis_ok && queue_ok && pending_ok {"ok"} else {"degraded"},"service":{"name":"analytics","version":"1","role":state.config.role},
        "dependencies":{"database":{"status":if database_ok {"ok"} else {"unavailable"},"schemaVersion":counts.get::<i64,_>("version")},"redis":{"status":if redis_ok {"ok"} else {"unavailable"}}},
        "counts":{"users":{"total":counts.get::<i64,_>("users"),"suspended":counts.get::<i64,_>("suspended_users")},"sites":{"total":counts.get::<i64,_>("sites"),"suspended":counts.get::<i64,_>("suspended_sites")},"environments":counts.get::<i64,_>("environments"),"activeSessions":counts.get::<i64,_>("sessions")},
        "queue":{"pending":queue.as_ref().ok().zip(pending.ok()).map(|((waiting,active,_),pending)|waiting+active+pending),"failed":queue.as_ref().ok().map(|(_,_,failed)|failed)}}),
    )
}

async fn list(
    State(state): State<AppState>,
    Extension(actor): Extension<Owner>,
    Path(resource): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    authorized(&actor)?;
    if resource == "status" {
        return Ok(Json(status(&state).await?));
    }
    let limit = query
        .get("limit")
        .map(|s| s.parse::<i64>())
        .transpose()
        .map_err(|_| ApiError::invalid())?
        .unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::invalid());
    }
    if resource == "audit" {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Filter {
            target_type: Option<String>,
            target_id: Option<String>,
            cursor: Option<String>,
            #[serde(rename = "limit")]
            _limit: Option<String>,
        }
        let filter: Filter =
            serde_json::from_value(json!(query)).map_err(|_| ApiError::invalid())?;
        if filter
            .target_type
            .as_ref()
            .is_some_and(|s| !matches!(s.as_str(), "user" | "site"))
            || filter
                .target_id
                .as_ref()
                .is_some_and(|s| s.is_empty() || s.len() > 128)
            || filter
                .cursor
                .as_ref()
                .is_some_and(|s| s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()))
        {
            return Err(ApiError::invalid());
        }
        let cursor = filter
            .cursor
            .as_ref()
            .map(|s| s.parse::<i64>())
            .transpose()
            .map_err(|_| ApiError::invalid())?;
        let sql=wrap("SELECT id,actor_user_id,action,target_type,target_id,reason,metadata,created_at FROM admin_audit_log WHERE ($1::text IS NULL OR target_type=$1) AND ($2::text IS NULL OR target_id=$2) AND ($3::bigint IS NULL OR id<$3) ORDER BY id DESC LIMIT $4".into());
        let mut rows: Vec<Value> = sqlx::query_scalar(&sql)
            .bind(filter.target_type)
            .bind(filter.target_id)
            .bind(cursor)
            .bind(limit + 1)
            .fetch_all(&state.pool)
            .await?;
        let cursor = if rows.len() > limit as usize {
            Some(rows[limit as usize - 1]["id"].to_string())
        } else {
            None
        };
        rows.truncate(limit as usize);
        return Ok(Json(
            json!({"entries":rows.into_iter().map(camel).collect::<Vec<_>>(),"nextCursor":cursor}),
        ));
    }
    let (source, alias, table, kind, suspended, search) = match resource.as_str() {
        "users" => (
            USERS,
            "u",
            "public.\"user\"",
            "text",
            "us.user_id IS NOT NULL",
            "u.id ILIKE $1 OR u.name ILIKE $1 OR u.email ILIKE $1",
        ),
        "sites" => (
            SITES,
            "s",
            "sites",
            "uuid",
            "(ss.site_id IS NOT NULL OR us.user_id IS NOT NULL)",
            "s.name ILIKE $1 OR s.domain ILIKE $1 OR u.email ILIKE $1",
        ),
        _ => return Err(missing()),
    };
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Options {
        search: Option<String>,
        status: Option<String>,
        cursor: Option<String>,
        #[serde(rename = "limit")]
        _limit: Option<String>,
    }
    let options: Options = serde_json::from_value(json!(query)).map_err(|_| ApiError::invalid())?;
    let status = options.status.as_deref().unwrap_or("all");
    if !matches!(status, "all" | "active" | "suspended")
        || options
            .search
            .as_ref()
            .is_some_and(|s| s.is_empty() || s.len() > 100)
        || options
            .cursor
            .as_ref()
            .is_some_and(|s| s.is_empty() || s.len() > 128)
    {
        return Err(ApiError::invalid());
    }
    if let Some(cursor) = &options.cursor {
        if resource == "sites" {
            identifier(cursor)?;
        }
        let present: bool = sqlx::query_scalar(&format!(
            "SELECT EXISTS(SELECT 1 FROM {table} WHERE id=$1::{kind})"
        ))
        .bind(cursor)
        .fetch_one(&state.pool)
        .await?;
        if !present {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "Invalid cursor.",
            ));
        }
    }
    let pattern = options.search.map(|s| {
        format!(
            "%{}%",
            s.replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        )
    });
    let sql = wrap(format!(
        "{source} WHERE ($1::text IS NULL OR {search}) AND ($2='all' OR ($2='suspended' AND {suspended}) OR ($2='active' AND NOT ({suspended}))) AND ($3::{kind} IS NULL OR ({alias}.created_at,{alias}.id)<(SELECT created_at,id FROM {table} WHERE id=$3::{kind})) ORDER BY {alias}.created_at DESC,{alias}.id DESC LIMIT $4"
    ));
    let mut rows: Vec<Value> = sqlx::query_scalar(&sql)
        .bind(pattern)
        .bind(status)
        .bind(options.cursor)
        .bind(limit + 1)
        .fetch_all(&state.pool)
        .await?;
    let cursor = if rows.len() > limit as usize {
        rows[limit as usize - 1]["id"].clone()
    } else {
        Value::Null
    };
    rows.truncate(limit as usize);
    Ok(Json(
        json!({resource:rows.into_iter().map(camel).collect::<Vec<_>>(),"nextCursor":cursor}),
    ))
}

async fn detail(
    State(state): State<AppState>,
    Extension(actor): Extension<Owner>,
    Path((resource, id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    authorized(&actor)?;
    if resource == "status" {
        return Ok(Json(status(&state).await?));
    }
    Ok(Json(read(&state, &resource, &id).await?))
}

async fn read(state: &AppState, resource: &str, id: &str) -> Result<Value, ApiError> {
    let sql = match resource {
        "users" => wrap(format!("{USERS} WHERE u.id=$1")),
        "sites" => {
            identifier(id)?;
            wrap(format!("{SITES} WHERE s.id=$1::uuid"))
        }
        _ => return Err(missing()),
    };
    let row: Value = sqlx::query_scalar(&sql)
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(missing)?;
    if resource == "users" {
        let sites: Vec<Value> = sqlx::query_scalar(&wrap(format!(
            "{SITES} WHERE s.owner_id=$1 ORDER BY s.created_at DESC,s.id DESC"
        )))
        .bind(id)
        .fetch_all(&state.pool)
        .await?;
        let subscriptions:Option<Value>=sqlx::query_scalar("SELECT subscriptions FROM billing_customers WHERE owner_id=$1 AND deleted=false ORDER BY updated_at DESC LIMIT 1").bind(id).fetch_optional(&state.pool).await?;
        Ok(
            json!({"user":camel(row),"sites":sites.into_iter().map(camel).collect::<Vec<_>>(),"subscriptions":subscriptions.unwrap_or_else(||json!([]))}),
        )
    } else {
        let environments:Vec<Value>=sqlx::query_scalar(&wrap("SELECT id,name,domain,enabled,allow_localhost,tracking_mode,created_at FROM environments WHERE site_id=$1::uuid ORDER BY created_at,id".into())).bind(id).fetch_all(&state.pool).await?;
        Ok(
            json!({"site":camel(row),"environments":environments.into_iter().map(camel).collect::<Vec<_>>()}),
        )
    }
}

async fn update(
    State(state): State<AppState>,
    Extension(actor): Extension<Owner>,
    Path((resource, id)): Path<(String, String)>,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    authorized(&actor)?;
    if resource == "status" {
        return Ok(Json(status(&state).await?));
    }
    let (table, column, kind, target_table) = match resource.as_str() {
        "users" => ("user_suspensions", "user_id", "text", "public.\"user\""),
        "sites" => {
            identifier(&id)?;
            ("site_suspensions", "site_id", "uuid", "sites")
        }
        _ => return Err(missing()),
    };
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input {
        suspended: bool,
        reason: Option<String>,
    }
    let input: Input = json_body(request).await?;
    if input
        .reason
        .as_ref()
        .is_some_and(|s| s.is_empty() || s.encode_utf16().count() > 500)
    {
        return Err(ApiError::invalid());
    }
    if input.suspended && input.reason.as_ref().is_none_or(|s| s.trim().is_empty()) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "A reason is required when suspending access.",
        ));
    }
    let mut tx = state.pool.begin().await?;
    let target = sqlx::query(&format!(
        "SELECT * FROM {target_table} WHERE id=$1::{kind} FOR UPDATE"
    ))
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(missing)?;
    if resource == "users"
        && input.suspended
        && (id == actor.id
            || state
                .config
                .admin_emails
                .contains(&target.get::<String, _>("email").to_lowercase()))
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "cannot_suspend_admin",
            "Configured administrator accounts cannot be suspended.",
        ));
    }
    let previous: bool = sqlx::query_scalar(&format!(
        "SELECT EXISTS(SELECT 1 FROM {table} WHERE {column}=$1::{kind})"
    ))
    .bind(&id)
    .fetch_one(&mut *tx)
    .await?;
    let mut revoked = 0;
    if input.suspended {
        sqlx::query(&format!("INSERT INTO {table}({column},reason,suspended_by) VALUES($1::{kind},$2,$3) ON CONFLICT({column}) DO UPDATE SET reason=excluded.reason,suspended_at=now(),suspended_by=excluded.suspended_by"))
            .bind(&id).bind(input.reason.as_ref().map(|s|s.trim())).bind(&actor.id).execute(&mut *tx).await?;
        if resource == "users" {
            revoked = sqlx::query("DELETE FROM session WHERE user_id=$1")
                .bind(&id)
                .execute(&mut *tx)
                .await?
                .rows_affected();
        }
    } else if previous {
        sqlx::query(&format!("DELETE FROM {table} WHERE {column}=$1::{kind}"))
            .bind(&id)
            .execute(&mut *tx)
            .await?;
    }
    if input.suspended || previous {
        let target_type = if resource == "users" { "user" } else { "site" };
        let action = format!(
            "{target_type}.{}",
            if input.suspended {
                if previous {
                    "suspension_updated"
                } else {
                    "suspended"
                }
            } else {
                "restored"
            }
        );
        sqlx::query("INSERT INTO admin_audit_log(actor_user_id,action,target_type,target_id,reason,metadata) VALUES($1,$2,$3,$4,$5,$6)")
            .bind(&actor.id).bind(action).bind(target_type).bind(&id).bind(input.reason).bind(json!({"sessionsRevoked":revoked})).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Json(read(&state, &resource, &id).await?))
}

#[cfg(test)]
mod sentry_tests {
    use super::*;

    #[test]
    fn test_issue_requires_admin_and_enabled_reporting() {
        let mut actor = Owner {
            id: "fixture".into(),
            name: "Fixture".into(),
            email: "fixture@example.test".into(),
            admin: false,
        };
        assert_eq!(
            authorize_sentry_test(&actor, true).unwrap_err().status,
            StatusCode::FORBIDDEN
        );
        actor.admin = true;
        assert_eq!(
            authorize_sentry_test(&actor, false).unwrap_err().code,
            "sentry_disabled"
        );
        let hub = std::sync::Arc::new(sentry::Hub::new(
            None,
            std::sync::Arc::new(sentry::Scope::default()),
        ));
        sentry::Hub::run(hub, || {
            assert_eq!(
                authorize_sentry_test(&actor, true).unwrap_err().code,
                "sentry_disabled"
            );
        });
    }
}

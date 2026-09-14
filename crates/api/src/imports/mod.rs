mod csv;
mod error;
mod fingerprint;
mod parse;
#[cfg(test)]
mod tests;
mod zip;

use crate::{AppState, error::ApiError, http::Owner, sites};
use axum::{
    Extension, Json, Router,
    extract::{Path, Query, Request, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use error::Error;
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use std::collections::{BTreeSet, HashMap};
use tokio::sync::Semaphore;
use uuid::Uuid;

// Bound both in-flight upload memory and CPU work. Reject excess work instead
// of filling the blocking executor with requests that already hold 10 MB bodies.
static UPLOADS: Semaphore = Semaphore::const_new(2);
type Params = HashMap<String, String>;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/sites/{site}/environments/{environment}/imports",
            get(list).post(create),
        )
        .route(
            "/api/sites/{site}/environments/{environment}/imports/preview",
            post(preview),
        )
        .route(
            "/api/sites/{site}/environments/{environment}/imports/{id}",
            delete(remove),
        )
}
async fn list(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path((site, environment)): Path<(String, String)>,
) -> Result<Json<Value>, Error> {
    let env = sites::environment(&state, &owner.id, &site, &environment).await?;
    let imports: Vec<Value> = sqlx::query_scalar("SELECT summary || jsonb_build_object('id',id,'createdAt',created_at) FROM analytics_imports WHERE environment_id=$1 ORDER BY created_at DESC,id DESC")
        .bind(env.id).fetch_all(&state.pool).await?;
    Ok(Json(json!({"imports":imports})))
}
async fn remove(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path((site, environment, id)): Path<(String, String, String)>,
) -> Result<StatusCode, Error> {
    let env = sites::environment(&state, &owner.id, &site, &environment).await?;
    let id = sites::identifier(&id)?;
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT id FROM \"user\" WHERE id=$1 FOR UPDATE")
        .bind(&owner.id)
        .execute(&mut *tx)
        .await?;
    let exists: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM environments WHERE id=$1 FOR UPDATE")
            .bind(env.id)
            .fetch_optional(&mut *tx)
            .await?;
    if exists.is_none() {
        return Err(Error::invalid("Environment no longer exists."));
    }
    state.storage.remove_archive(env.id, id).await?;
    let deleted = sqlx::query("DELETE FROM analytics_imports WHERE environment_id=$1 AND id=$2")
        .bind(env.id)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    if deleted.rows_affected() == 0 {
        return Err(Error::new(
            StatusCode::NOT_FOUND,
            "import_not_found",
            "Import not found in this environment.",
        ));
    }
    revision(&mut tx, env.id).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn preview(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path((site, environment)): Path<(String, String)>,
    Query(query): Query<Params>,
    request: Request,
) -> Result<Response, Error> {
    upload(state, owner, site, environment, query, request, false).await
}
async fn create(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path((site, environment)): Path<(String, String)>,
    Query(query): Query<Params>,
    request: Request,
) -> Result<Response, Error> {
    upload(state, owner, site, environment, query, request, true).await
}

#[derive(sqlx::FromRow)]
struct Bounds {
    day: String,
    starts: DateTime<Utc>,
    ends: DateTime<Utc>,
}
#[derive(Serialize)]
struct Prepared {
    summary: Value,
    days: Value,
    breakdowns: Value,
}

async fn upload(
    state: AppState,
    owner: Owner,
    site: String,
    environment: String,
    query: Params,
    request: Request,
    create: bool,
) -> Result<Response, Error> {
    let env = sites::environment(&state, &owner.id, &site, &environment).await?;
    let name = query.get("filename").cloned().unwrap_or_default();
    let provider = query.get("provider").cloned().unwrap_or_default();
    let zone = query.get("timeZone").cloned().unwrap_or_default();
    if csv::trim(&name).is_empty()
        || name.encode_utf16().count() > 200
        || name.contains(['/', '\\'])
    {
        return Err(Error::invalid(
            "Use the export filename without a folder path.",
        ));
    }
    if provider == "ga4" && query.get("webOnly").map(String::as_str) != Some("true") {
        return Err(Error::invalid(
            "Confirm that the Google Analytics export contains only web traffic. Views can also include app screens.",
        ));
    }
    let content_type = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("");
    if !matches!(
        content_type,
        "text/csv" | "application/zip" | "application/octet-stream"
    ) {
        return Err(Error::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_media_type",
            "Upload a CSV file or Plausible export ZIP.",
        ));
    }
    let rate: i64 = redis::cmd("EVAL").arg("local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],60) end;return n").arg(1)
        .arg(format!("{}:imports:{}", state.config.queue_prefix, owner.id)).query_async(&mut state.redis.clone()).await?;
    if rate > 12 {
        return Err(Error::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "Too many requests. Try again in a minute.",
        ));
    }
    let permit = UPLOADS
        .try_acquire()
        .map_err(|_| Error::from(ApiError::unavailable()))?;
    let bytes = axum::body::to_bytes(request.into_body(), parse::MAX_UPLOAD)
        .await
        .map_err(|_| {
            Error::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "body_too_large",
                "Request body is too large.",
            )
        })?;
    let (parse_provider, parse_name) = (provider.clone(), name.clone());
    let (data, permit) = tokio::task::spawn_blocking(move || {
        parse::parse(&parse_provider, parse_name, bytes.to_vec()).map(|data| (data, permit))
    })
    .await
    .map_err(|_| ApiError::unavailable())??;
    let valid: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=$1)")
            .bind(&zone)
            .fetch_one(&state.pool)
            .await?;
    if !valid {
        return Err(Error::invalid(
            "Choose a valid IANA source timezone, such as Europe/Copenhagen or UTC.",
        ));
    }
    let bounds: Vec<Bounds> = sqlx::query_as("SELECT d.day::text,(d.day::timestamp AT TIME ZONE $1) AS starts,((d.day+1)::timestamp AT TIME ZONE $1) AS ends FROM jsonb_to_recordset($2::jsonb) d(day date)")
        .bind(&zone).bind(json!(data.days)).fetch_all(&state.pool).await?;
    let prepared = tokio::task::spawn_blocking(move || {
        let result = prepare(data, name, provider, zone, bounds);
        drop(permit);
        result
    })
    .await
    .map_err(|_| ApiError::unavailable())??;
    if create
        && query.get("fingerprint").map(String::as_str) != prepared.summary["fingerprint"].as_str()
    {
        return Err(Error::conflict(
            "import_changed",
            "The import changed after preview. Review the file again before importing.",
        ));
    }
    let mut tx = state.pool.begin().await?;
    let mut archived = None;
    let result = save(
        &state,
        &owner.id,
        env.site_id,
        env.id,
        &mut tx,
        &prepared,
        create,
        &mut archived,
    )
    .await;
    let result = match result {
        Ok(result) => {
            // An ambiguous COMMIT must not delete an archive belonging to a
            // possibly committed row. A retry is resolved by the fingerprint.
            tx.commit().await?;
            result
        }
        Err(error) => {
            if tx.rollback().await.is_ok()
                && let Some(id) = archived
                && state.storage.remove_archive(env.id, id).await.is_err()
            {
                tracing::warn!("Import archive cleanup failed");
            }
            return Err(error);
        }
    };
    let status = if create && result["duplicate"] == false {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(result)).into_response())
}

fn prepare(
    data: parse::Parsed,
    name: String,
    provider: String,
    zone: String,
    bounds: Vec<Bounds>,
) -> Result<Prepared, Error> {
    let now = Utc::now();
    let today = now.date_naive().to_string();
    let cutoff = (now.date_naive() - Duration::days(729)).to_string();
    let bounds: HashMap<_, _> = bounds.into_iter().map(|b| (b.day.clone(), b)).collect();
    let mut days = Vec::with_capacity(data.days.len());
    let (mut pageviews, mut visitors, mut custom) = (0_i64, 0_i64, 0_i64);
    for row in data.days {
        let b = bounds.get(&row.day).filter(|b| row.day >= cutoff && row.day < today && b.ends <= now && b.starts < b.ends)
            .ok_or_else(|| Error::invalid("Import complete dates within the last 730 days, ending no later than yesterday."))?;
        pageviews += row.pageviews;
        visitors += row.visitors;
        custom += row.custom;
        let mut row = json!(row);
        row["starts"] = json!(b.starts.to_rfc3339_opts(SecondsFormat::Millis, true));
        row["ends"] = json!(b.ends.to_rfc3339_opts(SecondsFormat::Millis, true));
        days.push(row);
    }
    if [pageviews, visitors, custom]
        .iter()
        .any(|&n| n > 9_007_199_254_740_991)
    {
        return Err(Error::invalid(
            "Imported totals exceed the supported count limit.",
        ));
    }
    let dimensions: BTreeSet<_> = data
        .breakdowns
        .iter()
        .map(|b| b.dimension.clone())
        .collect();
    let mut canonical = json!({"provider":provider,"timeZone":zone,"days":days,"breakdowns":data.breakdowns,"metrics":data.metrics});
    let fingerprint = fingerprint::fingerprint(&canonical)?;
    let days = canonical["days"].take();
    let breakdowns = canonical["breakdowns"].take();
    let summary = json!({"fingerprint":fingerprint,"provider":provider,"sourceName":name,"timeZone":zone,
        "visitorMetric":if provider=="ga4" {"ga4_daily_total_users"} else {"plausible_daily_visitors"},"dateBasis":"provider_calendar_day",
        "from":days[0]["day"],"to":days[days.as_array().map_or(0, Vec::len)-1]["day"],"days":days.as_array().map_or(0, Vec::len),
        "rowCount":days.as_array().map_or(0, Vec::len)+data.breakdowns.len(),"pageviews":pageviews,"dailyVisitors":visitors,"customEvents":custom,
        "metrics":data.metrics,"breakdowns":dimensions,"warnings":data.warnings,"files":data.files,"duplicate":false});
    Ok(Prepared {
        summary,
        days,
        breakdowns,
    })
}

#[allow(clippy::too_many_arguments)]
async fn save(
    state: &AppState,
    owner: &str,
    site: Uuid,
    env: Uuid,
    tx: &mut PgConnection,
    data: &Prepared,
    create: bool,
    archived: &mut Option<Uuid>,
) -> Result<Value, Error> {
    if create {
        sqlx::query("SELECT id FROM \"user\" WHERE id=$1 FOR UPDATE")
            .bind(owner)
            .execute(&mut *tx)
            .await?;
        sqlx::query("SELECT id FROM sites WHERE id=$1 AND owner_id=$2 FOR UPDATE")
            .bind(site)
            .bind(owner)
            .execute(&mut *tx)
            .await?;
        let exists: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM environments WHERE id=$1 AND site_id=$2 FOR UPDATE")
                .bind(env)
                .bind(site)
                .fetch_optional(&mut *tx)
                .await?;
        if exists.is_none() {
            return Err(Error::invalid("Environment no longer exists."));
        }
    }
    let found: Option<Value> = sqlx::query_scalar("SELECT summary || jsonb_build_object('id',id,'createdAt',created_at,'duplicate',true) FROM analytics_imports WHERE environment_id=$1 AND fingerprint=$2")
        .bind(env).bind(data.summary["fingerprint"].as_str()).fetch_optional(&mut *tx).await?;
    if let Some(found) = found {
        if create {
            revision(tx, env).await?;
        }
        return Ok(if create {
            json!({"import":found,"duplicate":true})
        } else {
            found
        });
    }
    let native: Option<String> = sqlx::query_scalar("SELECT min(day)::text FROM (SELECT min(day) AS day FROM events WHERE site_id=$1 UNION ALL SELECT min(day) FROM daily_stats WHERE site_id=$1 AND dimension='total') d")
        .bind(env).fetch_one(&mut *tx).await?;
    if let Some(native) = native {
        let boundary = format!("{native}T00:00:00.000Z");
        if data.days.as_array().is_some_and(|days| {
            days.iter().any(|d| {
                d["ends"]
                    .as_str()
                    .is_some_and(|end| end > boundary.as_str())
            })
        }) {
            return Err(Error::conflict(
                "import_live_overlap",
                format!(
                    "Live analytics starts on {native} UTC. Export source days that end before that boundary; the source timezone may require excluding the preceding calendar day."
                ),
            ));
        }
    }
    let overlap: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM imported_daily_stats existing JOIN jsonb_to_recordset($2::jsonb) incoming(day date,starts timestamptz,ends timestamptz) ON existing.day=incoming.day OR (existing.starts_at<incoming.ends AND existing.ends_at>incoming.starts) WHERE existing.environment_id=$1)")
        .bind(env).bind(&data.days).fetch_one(&mut *tx).await?;
    if overlap {
        return Err(Error::conflict(
            "import_overlap",
            "These dates overlap an existing import. Remove the earlier import before replacing its dates.",
        ));
    }
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM analytics_imports WHERE environment_id=$1")
            .bind(env)
            .fetch_one(&mut *tx)
            .await?;
    if count >= 50 {
        return Err(Error::conflict(
            "import_limit",
            "An environment supports up to 50 imports.",
        ));
    }
    if !create {
        return Ok(data.summary.clone());
    }
    let id = Uuid::new_v4();
    *archived = Some(id);
    state.storage.archive(env, id, data).await?;
    let created: DateTime<Utc> = sqlx::query_scalar("INSERT INTO analytics_imports(id,environment_id,provider,source_timezone,fingerprint,summary) VALUES($1,$2,$3,$4,$5,$6) RETURNING created_at")
        .bind(id).bind(env).bind(data.summary["provider"].as_str()).bind(data.summary["timeZone"].as_str()).bind(data.summary["fingerprint"].as_str()).bind(&data.summary).fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO imported_daily_stats(environment_id,day,import_id,starts_at,ends_at,pageviews,visitors,custom_events) SELECT $1,d.day,$2,d.starts,d.ends,d.pageviews,d.visitors,d.custom FROM jsonb_to_recordset($3::jsonb) d(day date,starts timestamptz,ends timestamptz,pageviews bigint,visitors bigint,custom bigint)")
        .bind(env).bind(id).bind(&data.days).execute(&mut *tx).await?;
    if let Some(rows) = data.breakdowns.as_array() {
        for rows in rows.chunks(2000) {
            sqlx::query("INSERT INTO imported_breakdowns(environment_id,day,dimension,value,count) SELECT $1,d.day,d.dimension,d.value,d.count FROM jsonb_to_recordset($2::jsonb) d(day date,dimension text,value text,count bigint)")
                .bind(env).bind(json!(rows)).execute(&mut *tx).await?;
        }
    }
    revision(tx, env).await?;
    let mut summary = data.summary.clone();
    summary["id"] = json!(id);
    summary["createdAt"] = json!(created.to_rfc3339_opts(SecondsFormat::Millis, true));
    Ok(json!({"import":summary,"duplicate":false}))
}
async fn revision(tx: &mut PgConnection, env: Uuid) -> Result<(), Error> {
    sqlx::query("UPDATE environments SET import_revision=import_revision+1 WHERE id=$1")
        .bind(env)
        .execute(tx)
        .await?;
    Ok(())
}

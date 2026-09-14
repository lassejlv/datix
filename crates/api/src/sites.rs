use axum::{
    Extension, Json, Router,
    extract::{Path, Request, State},
    http::StatusCode,
    routing::get,
};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::{
    AppState, billing,
    error::ApiError,
    http::{Owner, json_body},
};

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub id: Uuid,
    pub site_id: Uuid,
    pub name: String,
    pub domain: String,
    pub enabled: bool,
    pub allow_localhost: bool,
    pub created_at: DateTime<Utc>,
    pub tracking_mode: String,
    pub tracking_settings: Value,
    pub feature_settings: Value,
    pub import_revision: i64,
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Site {
    pub id: Uuid,
    pub owner_id: String,
    pub name: String,
    pub domain: String,
    pub credit_budget: Option<f64>,
    pub enabled: bool,
    pub allow_localhost: bool,
    pub created_at: DateTime<Utc>,
    #[sqlx(skip)]
    pub environments: Vec<Environment>,
}

const SITE_COLUMNS: &str = "id,owner_id,name,domain,credit_budget::float8 AS credit_budget,enabled,allow_localhost,created_at";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/sites", get(list).post(create))
        .route("/api/sites/{site}", get(one).patch(update).delete(delete))
        .route(
            "/api/sites/{site}/environments",
            get(list_environments).post(create_environment),
        )
        .route(
            "/api/sites/{site}/environments/{environment}",
            get(one_environment)
                .patch(update_environment)
                .delete(delete_environment),
        )
}

pub(crate) fn identifier(value: &str) -> Result<Uuid, ApiError> {
    if value.len() != 36 || [8, 13, 18, 23].iter().any(|i| value.as_bytes()[*i] != b'-') {
        return Err(ApiError::invalid());
    }
    Uuid::parse_str(value).map_err(|_| ApiError::invalid())
}

pub(crate) fn valid_name(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|n| !n.trim().is_empty() && n.encode_utf16().count() <= 80)
}

fn domain(value: &str) -> Result<String, ApiError> {
    let host = value.trim().trim_end_matches('.').to_lowercase();
    if host.is_empty()
        || value.len() > 253
        || !host
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
        || host.contains("..")
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Use a hostname without a protocol or path.",
        ));
    }
    Ok(host)
}

pub async fn owned(
    connection: &mut PgConnection,
    owner: &str,
    site: Uuid,
) -> Result<Site, ApiError> {
    sqlx::query_as(&format!(
        "SELECT {SITE_COLUMNS} FROM sites WHERE owner_id=$1 AND id=$2"
    ))
    .bind(owner)
    .bind(site)
    .fetch_optional(connection)
    .await?
    .ok_or_else(ApiError::missing_site)
}

pub(crate) async fn environment(
    state: &AppState,
    owner: &str,
    site: &str,
    key: &str,
) -> Result<Environment, ApiError> {
    let site = identifier(site)?;
    let key = identifier(key)?;
    let mut connection = state.pool.acquire().await?;
    owned(&mut connection, owner, site).await?;
    sqlx::query_as("SELECT * FROM environments WHERE site_id=$1 AND id=$2")
        .bind(site)
        .bind(key)
        .fetch_optional(&mut *connection)
        .await?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                "environment_not_found",
                "Environment not found.",
            )
        })
}

pub async fn get_sites(
    state: &AppState,
    owner: &str,
    site: Option<Uuid>,
) -> Result<Vec<Site>, ApiError> {
    let mut sites:Vec<Site>=sqlx::query_as(&format!("SELECT {SITE_COLUMNS} FROM sites WHERE owner_id=$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY created_at,id LIMIT 100"))
        .bind(owner).bind(site).fetch_all(&state.pool).await?;
    if site.is_some() && sites.is_empty() {
        return Err(ApiError::missing_site());
    }
    if !sites.is_empty() {
        let mut environments:Vec<Environment>=sqlx::query_as("SELECT * FROM environments WHERE site_id=ANY($1) ORDER BY (id=site_id) DESC,created_at,id")
            .bind(sites.iter().map(|s|s.id).collect::<Vec<_>>()).fetch_all(&state.pool).await?;
        for environment in environments.drain(..) {
            if let Some(site) = sites.iter_mut().find(|s| s.id == environment.site_id) {
                site.environments.push(environment);
            }
        }
    }
    Ok(sites)
}

async fn list(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        json!({"sites":get_sites(&state,&owner.id,None).await?}),
    ))
}
async fn one(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path(site): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        json!({"site":get_sites(&state,&owner.id,Some(identifier(&site)?)).await?.into_iter().next()}),
    ))
}
async fn create(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    request: Request,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let input: Value = json_body(request).await?;
    let object = input.as_object().ok_or_else(ApiError::invalid)?;
    if object
        .keys()
        .any(|k| !matches!(k.as_str(), "name" | "domain"))
        || !valid_name(&input["name"])
    {
        return Err(ApiError::invalid());
    }
    let name = input["name"].as_str().ok_or_else(ApiError::invalid)?.trim();
    let domain = domain(input["domain"].as_str().ok_or_else(ApiError::invalid)?)?;
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT id FROM public.\"user\" WHERE id=$1 FOR UPDATE")
        .bind(&owner.id)
        .execute(&mut *tx)
        .await?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM sites WHERE owner_id=$1")
        .bind(&owner.id)
        .fetch_one(&mut *tx)
        .await?;
    let active = billing::allowance(
        &mut tx,
        &owner.id,
        state.billing.organization_id(),
        state.config.external_effects,
    )
    .await?;
    let completed: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM account_onboarding WHERE owner_id=$1)")
            .bind(&owner.id)
            .fetch_one(&mut *tx)
            .await?;
    if active.is_none() && (count > 0 || completed) {
        return Err(ApiError::subscription_required());
    }
    if active
        .as_ref()
        .and_then(|a| a.entitlement.website_limit)
        .is_some_and(|limit| count >= limit)
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "site_limit",
            "Your website allowance has been reached.",
        ));
    }
    let id:Option<Uuid>=sqlx::query_scalar("INSERT INTO sites(owner_id,name,domain) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id").bind(&owner.id).bind(name).bind(domain).fetch_optional(&mut *tx).await?;
    let id = id.ok_or_else(|| {
        ApiError::new(
            StatusCode::CONFLICT,
            "site_exists",
            "You already added this domain.",
        )
    })?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"site":get_sites(&state,&owner.id,Some(id)).await?.into_iter().next()})),
    ))
}

async fn update(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path(site): Path<String>,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    let id = identifier(&site)?;
    let input: Value = json_body(request).await?;
    let object = input.as_object().ok_or_else(ApiError::invalid)?;
    if object.is_empty()
        || object.keys().any(|k| {
            !matches!(
                k.as_str(),
                "name" | "enabled" | "allowLocalhost" | "creditBudget"
            )
        })
    {
        return Err(ApiError::invalid());
    }
    if input.get("name").is_some_and(|n| !valid_name(n))
        || ["enabled", "allowLocalhost"]
            .iter()
            .any(|k| input.get(k).is_some_and(|v| !v.is_boolean()))
    {
        return Err(ApiError::invalid());
    }
    let budget = input.get("creditBudget");
    if budget.is_some_and(|b| {
        !b.is_null()
            && b.as_f64().is_none_or(|n| {
                !(0.15..=1e9).contains(&n) || (n * 100.0 - (n * 100.0).round()).abs() > 1e-5
            })
    }) {
        return Err(ApiError::invalid());
    }
    let mut tx = state.pool.begin().await?;
    owned(&mut tx, &owner.id, id).await?;
    sqlx::query("SELECT id FROM public.\"user\" WHERE id=$1 FOR UPDATE")
        .bind(&owner.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE sites SET name=coalesce($1,name),enabled=coalesce($2,enabled),allow_localhost=coalesce($3,allow_localhost),credit_budget=CASE WHEN $4 THEN $5::float8::numeric ELSE credit_budget END WHERE id=$6 AND owner_id=$7")
        .bind(input["name"].as_str()).bind(input["enabled"].as_bool()).bind(input["allowLocalhost"].as_bool()).bind(budget.is_some()).bind(budget.and_then(Value::as_f64)).bind(id).bind(&owner.id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(
        json!({"site":get_sites(&state,&owner.id,Some(id)).await?.into_iter().next()}),
    ))
}
async fn delete(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path(site): Path<String>,
) -> Result<StatusCode, ApiError> {
    let id = identifier(&site)?;
    let deleted = sqlx::query("DELETE FROM sites WHERE id=$1 AND owner_id=$2")
        .bind(id)
        .bind(&owner.id)
        .execute(&state.pool)
        .await?;
    if deleted.rows_affected() == 0 {
        return Err(ApiError::missing_site());
    }
    Ok(StatusCode::NO_CONTENT)
}
async fn list_environments(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path(site): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let sites = get_sites(&state, &owner.id, Some(identifier(&site)?)).await?;
    Ok(Json(
        json!({"environments":sites.into_iter().next().ok_or_else(ApiError::missing_site)?.environments}),
    ))
}
async fn one_environment(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path((site, environment)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let sites = get_sites(&state, &owner.id, Some(identifier(&site)?)).await?;
    let environment = identifier(&environment)?;
    let environment = sites
        .into_iter()
        .next()
        .ok_or_else(ApiError::missing_site)?
        .environments
        .into_iter()
        .find(|e| e.id == environment)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                "environment_not_found",
                "Environment not found.",
            )
        })?;
    Ok(Json(json!({"environment":environment})))
}

async fn create_environment(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path(site): Path<String>,
    request: Request,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let environment = save_environment(
        &state,
        &owner.id,
        identifier(&site)?,
        None,
        json_body(request).await?,
    )
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"environment":environment})),
    ))
}
async fn update_environment(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path((site, environment)): Path<(String, String)>,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    let environment = save_environment(
        &state,
        &owner.id,
        identifier(&site)?,
        Some(identifier(&environment)?),
        json_body(request).await?,
    )
    .await?;
    Ok(Json(json!({"environment":environment})))
}

async fn save_environment(
    state: &AppState,
    owner: &str,
    site: Uuid,
    id: Option<Uuid>,
    input: Value,
) -> Result<Environment, ApiError> {
    let object = input.as_object().ok_or_else(ApiError::invalid)?;
    if object.keys().any(|k| {
        !matches!(
            k.as_str(),
            "name"
                | "domain"
                | "enabled"
                | "allowLocalhost"
                | "trackingMode"
                | "trackingSettings"
                | "featureSettings"
        )
    }) || input.get("name").is_some_and(|n| !valid_name(n))
        || ["enabled", "allowLocalhost"]
            .iter()
            .any(|k| input.get(k).is_some_and(|v| !v.is_boolean()))
    {
        return Err(ApiError::invalid());
    }
    if input
        .get("trackingMode")
        .is_some_and(|v| !matches!(v.as_str(), Some("cookieless" | "sessions" | "local")))
    {
        return Err(ApiError::invalid());
    }
    for (key, allowed) in [
        (
            "trackingSettings",
            &[
                "pageview",
                "custom",
                "click",
                "outbound",
                "download",
                "form_submit",
                "scroll",
                "engagement",
                "referrer",
                "country",
                "device",
                "dimensions",
                "language",
                "coordinates",
            ][..],
        ),
        ("featureSettings", &["goals", "errors", "webVitals"][..]),
    ] {
        if let Some(value) = input.get(key)
            && value.as_object().is_none_or(|o| {
                o.iter()
                    .any(|(k, v)| !allowed.contains(&k.as_str()) || !v.is_boolean())
            })
        {
            return Err(ApiError::invalid());
        }
    }
    let domain = input
        .get("domain")
        .map(|v| domain(v.as_str().ok_or_else(ApiError::invalid)?))
        .transpose()?;
    if id == Some(site) && domain.is_some() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Use a separate environment for a different domain.",
        ));
    }
    if id.is_none()
        && (!input.get("name").is_some_and(valid_name) || input.get("enabled").is_some())
    {
        return Err(ApiError::invalid());
    }
    let mut tx = state.pool.begin().await?;
    let website = owned(&mut tx, owner, site).await?;
    sqlx::query("SELECT id FROM sites WHERE id=$1 AND owner_id=$2 FOR UPDATE")
        .bind(site)
        .bind(owner)
        .execute(&mut *tx)
        .await?;
    let environment = if let Some(id) = id {
        let environment:Environment=sqlx::query_as("UPDATE environments SET name=coalesce($1,name),domain=coalesce($2,domain),enabled=coalesce($3,enabled),allow_localhost=coalesce($4,allow_localhost),tracking_mode=coalesce($5,tracking_mode),tracking_settings=coalesce($6,tracking_settings),feature_settings=coalesce($7,feature_settings) WHERE site_id=$8 AND id=$9 RETURNING *")
            .bind(input["name"].as_str()).bind(domain).bind(input["enabled"].as_bool()).bind(input["allowLocalhost"].as_bool()).bind(input["trackingMode"].as_str()).bind(input.get("trackingSettings")).bind(input.get("featureSettings")).bind(site).bind(id).fetch_optional(&mut *tx).await?.ok_or_else(ApiError::missing_site)?;
        if id == site {
            sqlx::query("UPDATE sites SET enabled=$1,allow_localhost=$2 WHERE id=$3")
                .bind(environment.enabled)
                .bind(environment.allow_localhost)
                .bind(site)
                .execute(&mut *tx)
                .await?;
        }
        environment
    } else {
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM environments WHERE site_id=$1")
            .bind(site)
            .fetch_one(&mut *tx)
            .await?;
        if count >= 20 {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "environment_limit",
                "A website can have at most 20 environments.",
            ));
        }
        sqlx::query_as("INSERT INTO environments(site_id,name,domain,allow_localhost,tracking_mode,tracking_settings,feature_settings) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *")
            .bind(site).bind(input["name"].as_str()).bind(domain.unwrap_or(website.domain)).bind(input["allowLocalhost"].as_bool().unwrap_or(false)).bind(input["trackingMode"].as_str().unwrap_or("cookieless"))
            .bind(input.get("trackingSettings").cloned().unwrap_or_else(||json!({}))).bind(input.get("featureSettings").cloned().unwrap_or_else(||json!({}))).fetch_one(&mut *tx).await?
    };
    tx.commit().await?;
    Ok(environment)
}
async fn delete_environment(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path((site, environment)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    let site = identifier(&site)?;
    let environment = identifier(&environment)?;
    let mut connection = state.pool.acquire().await?;
    owned(&mut connection, &owner.id, site).await?;
    if site == environment {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "default_environment",
            "The default environment cannot be deleted. Delete the website to remove all its environments.",
        ));
    }
    let deleted = sqlx::query("DELETE FROM environments WHERE site_id=$1 AND id=$2")
        .bind(site)
        .bind(environment)
        .execute(&mut *connection)
        .await?;
    if deleted.rows_affected() == 0 {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "environment_not_found",
            "Environment not found.",
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}

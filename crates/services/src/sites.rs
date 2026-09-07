use analytics_core::{
    Error, Result, State,
    models::{Environments, Sites},
    validation::{self, decode},
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

const SITE_COLUMNS: &str =
    "id, owner_id, name, domain, enabled, allow_localhost, credit_budget::text, created_at";
pub async fn owned(state: &State, owner: &str, id: Uuid) -> Result<Sites> {
    sqlx::query_as::<_, Sites>(&format!(
        "SELECT {SITE_COLUMNS} FROM sites WHERE id=$1 AND owner_id=$2"
    ))
    .bind(id)
    .bind(owner)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| Error::new(404, "site_not_found", "Website not found."))
}
pub async fn environment(state: &State, site: Uuid, id: Uuid) -> Result<Environments> {
    sqlx::query_as::<_, Environments>("SELECT * FROM environments WHERE id=$1 AND site_id=$2")
        .bind(id)
        .bind(site)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| Error::new(404, "environment_not_found", "Environment not found."))
}
pub fn site_json(site: &Sites) -> Value {
    let mut value = serde_json::to_value(site).expect("serializable model");
    value["creditBudget"] = site
        .credit_budget
        .as_ref()
        .and_then(|v| v.parse::<f64>().ok())
        .map_or(Value::Null, |n| json!(n));
    value
}
pub async fn with_environments(state: &State, rows: Vec<Sites>) -> Result<Vec<Value>> {
    let ids: Vec<Uuid> = rows.iter().map(|s| s.id).collect();
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let envs = sqlx::query_as::<_, Environments>(
        "SELECT * FROM environments WHERE site_id=ANY($1) ORDER BY created_at,id",
    )
    .bind(&ids)
    .fetch_all(&state.db)
    .await?;
    Ok(rows
        .iter()
        .map(|site| {
            let mut value = site_json(site);
            let mut environments: Vec<_> = envs.iter().filter(|e| e.site_id == site.id).collect();
            environments.sort_by_key(|e| e.id != site.id);
            value["environments"] = json!(environments);
            value
        })
        .collect())
}
pub async fn list(state: &State, owner: &str) -> Result<Value> {
    let rows = sqlx::query_as::<_, Sites>(&format!(
        "SELECT {SITE_COLUMNS} FROM sites WHERE owner_id=$1 ORDER BY created_at LIMIT 100"
    ))
    .bind(owner)
    .fetch_all(&state.db)
    .await?;
    Ok(json!({"sites":with_environments(state,rows).await?}))
}
pub async fn get(state: &State, site: Sites) -> Result<Value> {
    Ok(json!({"site":with_environments(state,vec![site]).await?.remove(0)}))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateSite {
    name: String,
    domain: String,
}
pub async fn create(state: &State, owner: &str, body: Value) -> Result<Value> {
    validation::reject_nulls(&body, &[])?;
    let input: CreateSite = decode(body)?;
    let name = validation::name(&input.name, 80)?;
    let domain = validation::domain(&input.domain)?;
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT id FROM \"user\" WHERE id=$1 FOR UPDATE")
        .bind(owner)
        .fetch_one(&mut *tx)
        .await?;
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM sites WHERE owner_id=$1")
        .bind(owner)
        .fetch_one(&mut *tx)
        .await?;
    if total >= 10 {
        return Err(Error::new(
            409,
            "site_limit",
            "Pro supports up to 10 websites.",
        ));
    }
    let site=sqlx::query_as::<_,Sites>(&format!("INSERT INTO sites(owner_id,name,domain) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING {SITE_COLUMNS}"))
 .bind(owner).bind(name).bind(domain).fetch_optional(&mut *tx).await?.ok_or_else(||Error::new(409,"site_exists","You already added this domain."))?;
    tx.commit().await?;
    get(state, site).await
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateSite {
    name: Option<String>,
    enabled: Option<bool>,
    allow_localhost: Option<bool>,
    credit_budget: Option<f64>,
}
pub async fn update(state: &State, site: Sites, body: Value) -> Result<Value> {
    validation::reject_nulls(&body, &["creditBudget"])?;
    let input: UpdateSite = decode(body.clone())?;
    if body.as_object().is_none_or(|v| v.is_empty()) {
        return Err(Error::invalid("Provide a website setting to update."));
    }
    let name = input
        .name
        .as_deref()
        .map(|s| validation::name(s, 80))
        .transpose()?;
    let budget_set = body.get("creditBudget").is_some();
    if let Some(n) = input.credit_budget
        && (!n.is_finite()
            || !(0.15..=1e9).contains(&n)
            || (n * 100.0 - (n * 100.0).round()).abs() > 1e-5)
    {
        return Err(Error::invalid("Invalid credit budget."));
    }
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT id FROM \"user\" WHERE id=$1 FOR UPDATE")
        .bind(&site.owner_id)
        .fetch_one(&mut *tx)
        .await?;
    let updated=sqlx::query_as::<_,Sites>(&format!("UPDATE sites SET name=coalesce($1,name),enabled=coalesce($2,enabled),allow_localhost=coalesce($3,allow_localhost),credit_budget=CASE WHEN $4 THEN $5::text::numeric ELSE credit_budget END WHERE id=$6 AND owner_id=$7 RETURNING {SITE_COLUMNS}"))
 .bind(name).bind(input.enabled).bind(input.allow_localhost).bind(budget_set).bind(input.credit_budget.map(|n|format!("{n:.2}"))).bind(site.id).bind(&site.owner_id).fetch_optional(&mut *tx).await?.ok_or_else(||Error::new(404,"site_not_found","Website not found."))?;
    tx.commit().await?;
    get(state, updated).await
}
pub async fn delete(state: &State, site: &Sites) -> Result<()> {
    sqlx::query("DELETE FROM sites WHERE id=$1 AND owner_id=$2")
        .bind(site.id)
        .bind(&site.owner_id)
        .execute(&state.db)
        .await?;
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EnvironmentInput {
    name: Option<String>,
    domain: Option<String>,
    tracking_mode: Option<String>,
    tracking_settings: Option<Value>,
    allow_localhost: Option<bool>,
    enabled: Option<bool>,
}
fn validate_environment(input: &mut EnvironmentInput) -> Result<()> {
    if let Some(name) = &input.name {
        input.name = Some(validation::name(name, 40)?)
    }
    if let Some(domain) = &input.domain {
        input.domain = Some(validation::domain(domain)?)
    }
    if input
        .tracking_mode
        .as_deref()
        .is_some_and(|m| !["cookieless", "sessions", "local"].contains(&m))
    {
        return Err(Error::invalid("Invalid tracking mode."));
    }
    if let Some(settings) = &input.tracking_settings {
        crate::tracking::validate_settings(settings)?;
    }
    Ok(())
}
fn conflict(error: sqlx::Error) -> Error {
    if error
        .as_database_error()
        .is_some_and(|e| e.code().is_some_and(|c| c == "23505"))
    {
        Error::new(
            409,
            "environment_exists",
            "This website already has an environment with that name.",
        )
    } else {
        error.into()
    }
}
pub async fn create_environment(state: &State, site: &Sites, body: Value) -> Result<Value> {
    if body.get("enabled").is_some() {
        return Err(Error::invalid("Unknown environment field: enabled."));
    }
    validation::reject_nulls(&body, &[])?;
    let mut input: EnvironmentInput = decode(body)?;
    validate_environment(&mut input)?;
    let name = input
        .name
        .ok_or_else(|| Error::invalid("Environment name is required."))?;
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT id FROM sites WHERE id=$1 FOR UPDATE")
        .bind(site.id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| Error::new(404, "site_not_found", "Website not found."))?;
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM environments WHERE site_id=$1")
        .bind(site.id)
        .fetch_one(&mut *tx)
        .await?;
    if total >= 20 {
        return Err(Error::new(
            409,
            "environment_limit",
            "A website can have at most 20 environments.",
        ));
    }
    let environment=sqlx::query_as::<_,Environments>("INSERT INTO environments(site_id,name,domain,tracking_mode,tracking_settings,allow_localhost) VALUES($1,$2,$3,$4,$5,$6) RETURNING *")
 .bind(site.id).bind(name).bind(input.domain.unwrap_or_else(||site.domain.clone())).bind(input.tracking_mode.unwrap_or_else(||"cookieless".into())).bind(input.tracking_settings.unwrap_or(json!({}))).bind(input.allow_localhost.unwrap_or(false)).fetch_one(&mut *tx).await.map_err(conflict)?;
    tx.commit().await?;
    Ok(json!({"environment":environment}))
}
pub async fn update_environment(
    state: &State,
    site: &Sites,
    id: Uuid,
    body: Value,
) -> Result<Value> {
    if body.as_object().is_none_or(|v| v.is_empty()) {
        return Err(Error::invalid("Provide an environment setting to update."));
    }
    validation::reject_nulls(&body, &[])?;
    let mut input: EnvironmentInput = decode(body)?;
    validate_environment(&mut input)?;
    if id == site.id && input.domain.is_some() {
        return Err(Error::new(
            400,
            "default_domain_immutable",
            "Use a separate environment for a different domain.",
        ));
    }
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT id FROM sites WHERE id=$1 FOR UPDATE")
        .bind(site.id)
        .fetch_one(&mut *tx)
        .await?;
    let environment=sqlx::query_as::<_,Environments>("UPDATE environments SET name=coalesce($1,name),domain=coalesce($2,domain),tracking_mode=coalesce($3,tracking_mode),tracking_settings=coalesce($4,tracking_settings),allow_localhost=coalesce($5,allow_localhost),enabled=coalesce($6,enabled) WHERE site_id=$7 AND id=$8 RETURNING *")
 .bind(input.name).bind(input.domain).bind(input.tracking_mode).bind(input.tracking_settings).bind(input.allow_localhost).bind(input.enabled).bind(site.id).bind(id).fetch_optional(&mut *tx).await.map_err(conflict)?.ok_or_else(||Error::new(404,"environment_not_found","Environment not found."))?;
    if id == site.id {
        sqlx::query("UPDATE sites SET enabled=$1,allow_localhost=$2 WHERE id=$3")
            .bind(environment.enabled)
            .bind(environment.allow_localhost)
            .bind(site.id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(json!({"environment":environment}))
}
pub async fn delete_environment(state: &State, site: Uuid, id: Uuid) -> Result<()> {
    if site == id {
        return Err(Error::new(
            409,
            "default_environment",
            "The default environment cannot be deleted. Delete the website to remove all its environments.",
        ));
    }
    let rows = sqlx::query("DELETE FROM environments WHERE site_id=$1 AND id=$2")
        .bind(site)
        .bind(id)
        .execute(&state.db)
        .await?
        .rows_affected();
    if rows == 0 {
        return Err(Error::new(
            404,
            "environment_not_found",
            "Environment not found.",
        ));
    }
    Ok(())
}

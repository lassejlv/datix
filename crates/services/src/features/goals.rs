use analytics_core::{
    Error, Result, State,
    validation::{self, DateRange},
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    name: String,
    match_type: String,
    match_value: String,
}
pub async fn create(state: &State, env: Uuid, body: Value) -> Result<Value> {
    let input: Input = validation::decode(body)?;
    let name = validation::name(&input.name, 80)?;
    let value = validation::name(&input.match_value, 2048)?;
    if !(input.match_type == "event"
        && regex::Regex::new(r"^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$")
            .unwrap()
            .is_match(&value)
        || input.match_type == "page" && value.starts_with('/') && !value.contains(['?', '#']))
    {
        return Err(Error::invalid(
            "Use an event name or a page path without a query string.",
        ));
    }
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT id FROM environments WHERE id=$1 FOR UPDATE")
        .bind(env)
        .execute(&mut *tx)
        .await?;
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM conversion_goals WHERE environment_id=$1")
            .bind(env)
            .fetch_one(&mut *tx)
            .await?;
    if count >= 20 {
        return Err(Error::invalid("An environment can have up to 20 goals."));
    }
    let row:Option<Value>=sqlx::query_scalar("INSERT INTO conversion_goals(environment_id,name,match_type,match_value) VALUES($1,$2,$3,$4) ON CONFLICT(environment_id,match_type,match_value) DO NOTHING RETURNING jsonb_build_object('id',id,'name',name,'matchType',match_type,'matchValue',match_value)")
        .bind(env).bind(name).bind(input.match_type).bind(value).fetch_optional(&mut *tx).await?;
    let row = row.ok_or_else(|| Error::invalid("A goal already tracks this conversion."))?;
    tx.commit().await?;
    Ok(json!({"goal":row}))
}
pub async fn delete(state: &State, env: Uuid, goal: Uuid) -> Result<Value> {
    let n = sqlx::query("DELETE FROM conversion_goals WHERE id=$1 AND environment_id=$2")
        .bind(goal)
        .bind(env)
        .execute(&state.db)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(Error::new(404, "goal_not_found", "Goal not found."));
    }
    Ok(json!({"deleted":true}))
}
pub async fn report(state: &State, env: Uuid, range: &DateRange) -> Result<Value> {
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',g.id,'name',g.name,'matchType',g.match_type,'matchValue',g.match_value,'createdAt',g.created_at,'conversions',count(c.event_id),'visitors',count(DISTINCT (c.day,c.visitor)) FILTER(WHERE c.event_id IS NOT NULL)) FROM conversion_goals g LEFT JOIN goal_conversions c ON c.goal_id=g.id AND c.day BETWEEN $2 AND $3 WHERE g.environment_id=$1 GROUP BY g.id ORDER BY g.created_at,g.id")
        .bind(env).bind(range.from).bind(range.to).fetch_all(&state.db).await?;
    let visitors: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM daily_visitors WHERE site_id=$1 AND day BETWEEN $2 AND $3",
    )
    .bind(env)
    .bind(range.from)
    .bind(range.to)
    .fetch_one(&state.db)
    .await?;
    Ok(json!({"goals":rows,"visitors":visitors}))
}

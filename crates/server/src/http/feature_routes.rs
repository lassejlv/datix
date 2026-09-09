use super::*;
use analytics_services::features::{diagnostics, goals, pulse};
async fn environment(
    state: &State,
    c: &Context,
    site: &str,
    env: &str,
) -> Result<analytics_core::models::Environments> {
    let site = load_site(state, c, site).await?;
    sites::environment(state, site.id, id(env)?).await
}
pub(super) async fn report(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
    Path((site, env, feature)): Path<(String, String, String)>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    let env = environment(&state, &c, &site, &env).await?;
    let range = DateRange::parse(&params)?;
    Ok(Json(match feature.as_str() {
        "goals" => goals::report(&state, env.id, &range).await?,
        "errors" => diagnostics::report(&state, env.id, "error", &range).await?,
        "web-vitals" => diagnostics::report(&state, env.id, "vital", &range).await?,
        "globe" => analytics_services::features::geography::report(&state, env.id).await?,
        "pulse" => pulse::report(&state, env.id).await?,
        _ => return Err(Error::new(404, "not_found", "Feature not found.")),
    }))
}
pub(super) async fn configure(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
    Path((site, env, feature)): Path<(String, String, String)>,
    request: Request,
) -> Result<Json<Value>> {
    let env = environment(&state, &c, &site, &env).await?;
    let body = read_json(request).await?;
    Ok(Json(match feature.as_str() {
        "goals" => goals::create(&state, env.id, body).await?,
        "pulse" => pulse::configure(&state, env.id, &env.domain, body).await?,
        "errors" => {
            diagnostics::resolve(&state, env.id, body["fingerprint"].as_str().unwrap_or("")).await?
        }
        _ => return Err(Error::new(404, "not_found", "Feature not found.")),
    }))
}
pub(super) async fn delete_goal(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
    Path((site, env, goal)): Path<(String, String, String)>,
) -> Result<Json<Value>> {
    let env = environment(&state, &c, &site, &env).await?;
    Ok(Json(goals::delete(&state, env.id, id(&goal)?).await?))
}
pub(super) async fn telemetry(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
    request: Request,
) -> Result<(StatusCode, Json<Value>)> {
    let headers = request.headers().clone();
    let body = read_json(request).await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(diagnostics::collect(&state, &headers, body, &c.ip).await?),
    ))
}

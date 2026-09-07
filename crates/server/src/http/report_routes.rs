use super::*;

pub(super) async fn report_environment(
    state: &State,
    c: &Context,
    key: &str,
    params: &HashMap<String, String>,
) -> Result<Uuid> {
    let site = load_site(state, c, key).await?;
    let env = params
        .get("environment")
        .map(|s| id(s))
        .transpose()?
        .unwrap_or(site.id);
    Ok(sites::environment(state, site.id, env).await?.id)
}
pub(super) async fn installation(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
    Path(key): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    let env = report_environment(&state, &c, &key, &params).await?;
    Ok(Json(reports::installation(&state, env).await?))
}
pub(super) async fn overview(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
    Path(key): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    let env = report_environment(&state, &c, &key, &params).await?;
    Ok(Json(
        reports::overview(&state, env, DateRange::parse(&params)?).await?,
    ))
}
pub(super) async fn timeseries(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
    Path(key): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    let env = report_environment(&state, &c, &key, &params).await?;
    Ok(Json(
        reports::timeseries(&state, env, DateRange::parse(&params)?).await?,
    ))
}
pub(super) async fn breakdown(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
    Path(key): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    let env = report_environment(&state, &c, &key, &params).await?;
    Ok(Json(
        reports::breakdown(&state, env, DateRange::parse(&params)?, &params).await?,
    ))
}
pub(super) async fn sessions(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
    Path(key): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    let env = report_environment(&state, &c, &key, &params).await?;
    Ok(Json(
        reports::sessions(&state, env, DateRange::parse(&params)?, &params).await?,
    ))
}

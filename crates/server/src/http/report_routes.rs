use super::*;

pub(super) async fn report_environment(
    state: &State,
    c: &Context,
    key: &str,
    params: &HashMap<String, String>,
) -> Result<(Uuid, i64)> {
    let site = load_site(state, c, key).await?;
    let env = params
        .get("environment")
        .map(|s| id(s))
        .transpose()?
        .unwrap_or(site.id);
    let environment = sites::environment(state, site.id, env).await?;
    Ok((environment.id, environment.import_revision))
}
pub(super) async fn installation(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
    Path(key): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    let (env, _) = report_environment(&state, &c, &key, &params).await?;
    Ok(Json(reports::installation(&state, env).await?))
}
pub(super) async fn overview(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
    Path(key): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    let (env, revision) = report_environment(&state, &c, &key, &params).await?;
    let range = DateRange::parse(&params)?;
    Ok(Json(
        reports::cached(
            &state,
            env,
            revision,
            "overview",
            &range,
            &params,
            reports::overview(&state, env, range.clone()),
        )
        .await?,
    ))
}
pub(super) async fn timeseries(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
    Path(key): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    let (env, revision) = report_environment(&state, &c, &key, &params).await?;
    let range = DateRange::parse(&params)?;
    Ok(Json(
        reports::cached(
            &state,
            env,
            revision,
            "timeseries",
            &range,
            &params,
            reports::timeseries(&state, env, range.clone()),
        )
        .await?,
    ))
}
pub(super) async fn breakdown(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
    Path(key): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    let (env, revision) = report_environment(&state, &c, &key, &params).await?;
    let range = DateRange::parse(&params)?;
    Ok(Json(
        reports::cached(
            &state,
            env,
            revision,
            "breakdown",
            &range,
            &params,
            reports::breakdown(&state, env, range.clone(), &params),
        )
        .await?,
    ))
}
pub(super) async fn sessions(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
    Path(key): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Value>> {
    let (env, revision) = report_environment(&state, &c, &key, &params).await?;
    let range = DateRange::parse(&params)?;
    Ok(Json(
        reports::cached(
            &state,
            env,
            revision,
            "sessions",
            &range,
            &params,
            reports::sessions(&state, env, range.clone(), &params),
        )
        .await?,
    ))
}

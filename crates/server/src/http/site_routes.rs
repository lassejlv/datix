use super::*;

pub(super) async fn list_sites(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
) -> Result<Json<Value>> {
    Ok(Json(sites::list(&state, &owner(&c)?.id).await?))
}
pub(super) async fn create_site(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
    request: Request,
) -> Result<(StatusCode, Json<Value>)> {
    Ok((
        StatusCode::CREATED,
        Json(sites::create(&state, &owner(&c)?.id, read_json(request).await?).await?),
    ))
}
pub(super) async fn load_site(
    state: &State,
    c: &Context,
    key: &str,
) -> Result<analytics_core::models::Sites> {
    sites::owned(state, &owner(c)?.id, id(key)?).await
}
pub(super) async fn get_site(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
    Path(key): Path<String>,
) -> Result<Json<Value>> {
    let site = load_site(&state, &c, &key).await?;
    Ok(Json(sites::get(&state, site).await?))
}
pub(super) async fn update_site(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
    Path(key): Path<String>,
    request: Request,
) -> Result<Json<Value>> {
    let site = load_site(&state, &c, &key).await?;
    Ok(Json(
        sites::update(&state, site, read_json(request).await?).await?,
    ))
}
pub(super) async fn delete_site(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
    Path(key): Path<String>,
) -> Result<StatusCode> {
    let site = load_site(&state, &c, &key).await?;
    sites::delete(&state, &site).await?;
    Ok(StatusCode::NO_CONTENT)
}
pub(super) async fn list_environments(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
    Path(key): Path<String>,
) -> Result<Json<Value>> {
    let site = load_site(&state, &c, &key).await?;
    let mut data = sites::get(&state, site).await?;
    Ok(Json(
        json!({"environments":data["site"]["environments"].take()}),
    ))
}
pub(super) async fn create_environment(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
    Path(key): Path<String>,
    request: Request,
) -> Result<(StatusCode, Json<Value>)> {
    let site = load_site(&state, &c, &key).await?;
    Ok((
        StatusCode::CREATED,
        Json(sites::create_environment(&state, &site, read_json(request).await?).await?),
    ))
}
pub(super) async fn get_environment(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
    Path((key, env)): Path<(String, String)>,
) -> Result<Json<Value>> {
    let site = load_site(&state, &c, &key).await?;
    Ok(Json(
        json!({"environment":sites::environment(&state,site.id,id(&env)?).await?}),
    ))
}
pub(super) async fn update_environment(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
    Path((key, env)): Path<(String, String)>,
    request: Request,
) -> Result<Json<Value>> {
    let site = load_site(&state, &c, &key).await?;
    Ok(Json(
        sites::update_environment(&state, &site, id(&env)?, read_json(request).await?).await?,
    ))
}
pub(super) async fn delete_environment(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
    Path((key, env)): Path<(String, String)>,
) -> Result<StatusCode> {
    let site = load_site(&state, &c, &key).await?;
    sites::delete_environment(&state, site.id, id(&env)?).await?;
    Ok(StatusCode::NO_CONTENT)
}

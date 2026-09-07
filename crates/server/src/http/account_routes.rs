use super::*;

pub(super) async fn me(Extension(context): Extension<Context>) -> Result<Json<Value>> {
    let user = owner(&context)?;
    Ok(Json(
        json!({"user":{"id":user.id,"name":user.name,"email":user.email}}),
    ))
}
pub(super) async fn usage(
    AppState(state): AppState<State>,
    Extension(context): Extension<Context>,
) -> Result<Json<Value>> {
    let user = owner(&context)?;
    let mut usage = billing::account_usage(&state, &user.id).await?;
    usage["protection"] = abuse::summary(&state, &user.id).await?;
    Ok(Json(usage))
}
pub(super) async fn billing_root(
    state: AppState<State>,
    context: Extension<Context>,
    request: Request,
) -> Result<Json<Value>> {
    billing_operation(state, context, Path(String::new()), request).await
}
pub(super) async fn billing_operation(
    AppState(state): AppState<State>,
    Extension(context): Extension<Context>,
    Path(path): Path<String>,
    request: Request,
) -> Result<Json<Value>> {
    let method = request.method().to_string();
    let body = if path == "checkout" && method == "POST" {
        read_json(request).await?
    } else {
        Value::Null
    };
    Ok(Json(
        billing::provider::handle(&state, owner(&context)?, &path, &method, body).await?,
    ))
}

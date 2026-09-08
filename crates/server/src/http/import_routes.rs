use super::*;
use analytics_services::imports::{self, parse::ImportData};

const MAX_UPLOAD: usize = 10 * 1024 * 1024;
static PARSERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

async fn environment(state: &State, c: &Context, site: &str, env: &str) -> Result<Uuid> {
    let site = load_site(state, c, site).await?;
    Ok(sites::environment(state, site.id, id(env)?).await?.id)
}

async fn upload(
    state: &State,
    c: &Context,
    params: &HashMap<String, String>,
    request: Request,
) -> Result<(String, ImportData)> {
    state.limit("imports", &owner(c)?.id, 12).await?;
    let _permit = PARSERS.try_acquire().map_err(|_| {
        Error::new(
            429,
            "import_busy",
            "Another import is being read. Try again shortly.",
        )
    })?;
    let media = request
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim();
    if !["application/octet-stream", "text/csv", "application/zip"].contains(&media) {
        return Err(Error::new(
            415,
            "unsupported_media_type",
            "Upload a CSV file or Plausible export ZIP.",
        ));
    }
    let source_name = analytics_core::validation::name(
        params.get("filename").map(String::as_str).unwrap_or(""),
        200,
    )?;
    if source_name.contains(['/', '\\']) {
        return Err(Error::invalid(
            "Use the export filename without a folder path.",
        ));
    }
    let provider = params.get("provider").cloned().unwrap_or_default();
    if provider == "ga4" && params.get("webOnly").map(String::as_str) != Some("true") {
        return Err(Error::invalid(
            "Confirm that the Google Analytics export contains only web traffic. Views can also include app screens.",
        ));
    }
    let timezone = params.get("timeZone").cloned().unwrap_or_default();
    let bytes = read_body(request, MAX_UPLOAD).await?;
    let filename = source_name.clone();
    let data = tokio::task::spawn_blocking(move || {
        imports::parse::parse(&provider, &timezone, &filename, &bytes)
    })
    .await
    .map_err(|_| Error::unavailable())??;
    Ok((source_name, data))
}

pub(super) async fn list_imports(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
    Path((site, env)): Path<(String, String)>,
) -> Result<Json<Value>> {
    let env = environment(&state, &c, &site, &env).await?;
    Ok(Json(imports::list(&state, &owner(&c)?.id, env).await?))
}

pub(super) async fn preview_import(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
    Path((site, env)): Path<(String, String)>,
    Query(params): Query<HashMap<String, String>>,
    request: Request,
) -> Result<Json<Value>> {
    let env = environment(&state, &c, &site, &env).await?;
    let (name, data) = upload(&state, &c, &params, request).await?;
    Ok(Json(
        imports::preview(&state, &owner(&c)?.id, env, &name, &data).await?,
    ))
}

pub(super) async fn create_import(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
    Path((site, env)): Path<(String, String)>,
    Query(params): Query<HashMap<String, String>>,
    request: Request,
) -> Result<(StatusCode, Json<Value>)> {
    let env = environment(&state, &c, &site, &env).await?;
    let fingerprint = params
        .get("fingerprint")
        .ok_or_else(|| Error::invalid("Review this export before importing it."))?;
    if fingerprint.len() != 64 || !fingerprint.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(Error::invalid("Review this export before importing it."));
    }
    let (name, data) = upload(&state, &c, &params, request).await?;
    let result = imports::create(&state, &owner(&c)?.id, env, &name, &data, fingerprint).await?;
    let status = if result["duplicate"] == true {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((status, Json(result)))
}

pub(super) async fn delete_import(
    AppState(state): AppState<State>,
    Extension(c): Extension<Context>,
    Path((site, env, import)): Path<(String, String, String)>,
) -> Result<StatusCode> {
    let env = environment(&state, &c, &site, &env).await?;
    imports::remove(&state, &owner(&c)?.id, env, id(&import)?).await?;
    Ok(StatusCode::NO_CONTENT)
}

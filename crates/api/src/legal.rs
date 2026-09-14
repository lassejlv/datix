use crate::{
    AppState,
    error::ApiError,
    http::{Owner, json_body},
};
use axum::{
    Extension, Json, Router,
    extract::{Path, Request, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, Row};
use std::sync::LazyLock;
use uuid::Uuid;

const DPA: &str = include_str!("../../../web/src/content/legal/dpa.html");
const TERMS: &str = include_str!("../../../web/src/content/legal/terms.html");

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Versions {
    dpa_version: String,
    terms_version: String,
}

static VERSIONS: LazyLock<Versions> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../config/legal.json")).expect("legal versions")
});
static DPA_HASH: LazyLock<String> = LazyLock::new(|| hex::encode(Sha256::digest(DPA.as_bytes())));
static TERMS_HASH: LazyLock<String> =
    LazyLock::new(|| hex::encode(Sha256::digest(TERMS.as_bytes())));

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/dpa/download", get(template_download))
        .route("/api/legal/agreement", get(status).post(accept))
        .route("/api/legal/agreement/{id}/download", get(receipt_download))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AcceptanceInput {
    customer_name: String,
    customer_role: String,
    signer_name: String,
    signer_title: String,
    dpa_version: String,
    terms_version: String,
    dpa_sha256: String,
    terms_sha256: String,
    accepted: bool,
}

impl AcceptanceInput {
    fn validate(&mut self) -> Result<(), ApiError> {
        for (value, limit) in [
            (&mut self.customer_name, 200),
            (&mut self.signer_name, 200),
            (&mut self.signer_title, 120),
        ] {
            *value = value.trim().to_owned();
            if value.is_empty()
                || value.chars().count() > limit
                || value.chars().any(char::is_control)
            {
                return Err(ApiError::invalid());
            }
        }
        if !self.accepted || !matches!(self.customer_role.as_str(), "controller" | "processor") {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "agreement_acceptance_required",
                "Confirm your authority and accept the Terms and DPA.",
            ));
        }
        if self.dpa_version != VERSIONS.dpa_version
            || self.terms_version != VERSIONS.terms_version
            || self.dpa_sha256 != *DPA_HASH
            || self.terms_sha256 != *TERMS_HASH
        {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "agreement_changed",
                "The agreement has changed. Reload and review the current documents before accepting.",
            ));
        }
        Ok(())
    }
}

pub async fn has_accepted(connection: &mut PgConnection, owner: &str) -> Result<bool, ApiError> {
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM legal_acceptances WHERE owner_id=$1 AND dpa_version=$2 AND terms_version=$3 AND dpa_sha256=$4 AND terms_sha256=$5)")
        .bind(owner).bind(&VERSIONS.dpa_version).bind(&VERSIONS.terms_version)
        .bind(&*DPA_HASH).bind(&*TERMS_HASH).fetch_one(connection).await?)
}

pub async fn require(state: &AppState, owner: &str) -> Result<(), ApiError> {
    if !has_accepted(&mut *state.pool.acquire().await?, owner).await? {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "agreement_required",
            "Accept the Terms and Data Processing Agreement in your account before collecting or importing analytics.",
        ));
    }
    Ok(())
}

async fn agreement_status(state: &AppState, owner: &str) -> Result<Value, ApiError> {
    let rows = sqlx::query("SELECT id,customer_name,customer_role,signer_name,signer_title,signer_email,dpa_version,terms_version,dpa_sha256,terms_sha256,accepted_at FROM legal_acceptances WHERE owner_id=$1 ORDER BY accepted_at DESC,id DESC")
        .bind(owner).fetch_all(&state.pool).await?;
    let history: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "id":row.get::<Uuid,_>("id"),
                "customerName":row.get::<String,_>("customer_name"),
                "customerRole":row.get::<String,_>("customer_role"),
                "signerName":row.get::<String,_>("signer_name"),
                "signerTitle":row.get::<String,_>("signer_title"),
                "signerEmail":row.get::<String,_>("signer_email"),
                "acceptedAt":row.get::<DateTime<Utc>,_>("accepted_at"),
                "dpaVersion":row.get::<String,_>("dpa_version"),
                "termsVersion":row.get::<String,_>("terms_version"),
                "dpaSha256":row.get::<String,_>("dpa_sha256"),
                "termsSha256":row.get::<String,_>("terms_sha256"),
            })
        })
        .collect();
    let acceptance = history.iter().find(|entry| {
        entry["dpaVersion"] == VERSIONS.dpa_version
            && entry["termsVersion"] == VERSIONS.terms_version
            && entry["dpaSha256"] == *DPA_HASH
            && entry["termsSha256"] == *TERMS_HASH
    });
    Ok(json!({
        "current": {
            "dpaVersion": VERSIONS.dpa_version,
            "termsVersion": VERSIONS.terms_version,
            "dpaSha256": *DPA_HASH,
            "termsSha256": *TERMS_HASH,
        },
        "acceptance": acceptance,
        "history": history,
    }))
}

async fn status(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(agreement_status(&state, &owner.id).await?))
}

async fn accept(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    request: Request,
) -> Result<Json<Value>, ApiError> {
    let mut input: AcceptanceInput = json_body(request).await?;
    input.validate()?;
    // Identity and time come from the verified session and database, never the request.
    // Retries preserve the original snapshot, representative and acceptance time.
    sqlx::query("INSERT INTO legal_acceptances(owner_id,customer_name,customer_role,signer_name,signer_title,signer_email,dpa_version,terms_version,dpa_sha256,terms_sha256,dpa_html,terms_html) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(owner_id,dpa_version,terms_version) DO NOTHING")
        .bind(&owner.id).bind(input.customer_name).bind(input.customer_role)
        .bind(input.signer_name).bind(input.signer_title).bind(&owner.email)
        .bind(&VERSIONS.dpa_version).bind(&VERSIONS.terms_version)
        .bind(&*DPA_HASH).bind(&*TERMS_HASH).bind(DPA).bind(TERMS)
        .execute(&state.pool).await?;
    let result = agreement_status(&state, &owner.id).await?;
    if result["acceptance"].is_null() {
        // A published version must not silently acquire different text.
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "agreement_version_conflict",
            "This agreement version has inconsistent text. Contact hello@usedatix.com.",
        ));
    }
    Ok(Json(result))
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn download(body: String, filename: &str) -> Response {
    let html = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Datix agreement</title><style>body{{font:16px/1.6 system-ui,sans-serif;max-width:800px;margin:48px auto;padding:0 24px;color:#17201b}}h1{{font-size:32px;line-height:1.2}}h2{{font-size:21px;margin-top:32px}}h3{{font-size:18px}}a{{color:inherit}}li{{margin:8px 0}}table{{border-collapse:collapse;width:100%}}td,th{{text-align:left;border:1px solid #ccc;padding:8px}}.receipt{{border:1px solid #ccc;padding:20px;overflow-wrap:anywhere}}.terms{{break-before:page}}@media print{{body{{margin:0;max-width:none;font-size:10pt}}h1,h2,h3{{break-after:avoid}}tr{{break-inside:avoid}}}}</style></head><body>{body}</body></html>"
    );
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8".to_owned()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{filename}.html\""),
            ),
        ],
        html,
    )
        .into_response()
}

async fn template_download() -> Response {
    download(
        format!(
            "<p><strong>Unaccepted template.</strong> Complete acceptance from your verified Datix account. You can print this file or save it as PDF.</p>{DPA}<section class=\"terms\">{TERMS}</section>"
        ),
        &format!("datix-dpa-{}", VERSIONS.dpa_version),
    )
}

async fn receipt_download(
    State(state): State<AppState>,
    Extension(owner): Extension<Owner>,
    Path(id): Path<Uuid>,
) -> Result<Response, ApiError> {
    let row = sqlx::query("SELECT * FROM legal_acceptances WHERE id=$1 AND owner_id=$2")
        .bind(id)
        .bind(&owner.id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "not_found", "Agreement not found."))?;
    let mut receipt = String::from(
        "<section class=\"receipt\"><h1>Agreement acceptance record</h1><p>Datix — Lasse Vestergaard, 9000 Aalborg, Denmark · hello@usedatix.com</p>",
    );
    for (label, key) in [
        ("Customer legal name", "customer_name"),
        ("Customer role", "customer_role"),
        ("Representative", "signer_name"),
        ("Representative role", "signer_title"),
        ("Verified account email at acceptance", "signer_email"),
        ("DPA version", "dpa_version"),
        ("Terms version", "terms_version"),
        ("DPA SHA-256", "dpa_sha256"),
        ("Terms SHA-256", "terms_sha256"),
    ] {
        receipt.push_str(&format!(
            "<p><strong>{label}:</strong> {}</p>",
            escape(row.get(key))
        ));
    }
    receipt.push_str(&format!("<p><strong>Accepted at (UTC):</strong> {}</p><p><strong>Record:</strong> {id}</p><p>The representative explicitly confirmed authority and accepted both documents from a verified account. The exact accepted text follows. Print this file to save a PDF.</p></section>", row.get::<DateTime<Utc>,_>("accepted_at").to_rfc3339()));
    receipt.push_str(row.get("dpa_html"));
    receipt.push_str("<section class=\"terms\">");
    receipt.push_str(row.get("terms_html"));
    receipt.push_str("</section>");
    Ok(download(receipt, &format!("datix-agreement-{id}")))
}

#[cfg(test)]
pub(crate) async fn fixture(state: &AppState, owner: &str) {
    sqlx::query("INSERT INTO legal_acceptances(owner_id,customer_name,customer_role,signer_name,signer_title,signer_email,dpa_version,terms_version,dpa_sha256,terms_sha256,dpa_html,terms_html) VALUES($1,'Ingestion fixture','controller','Fixture','Owner','fixture@example.test',$2,$3,$4,$5,$6,$7)")
        .bind(owner).bind(&VERSIONS.dpa_version).bind(&VERSIONS.terms_version)
        .bind(&*DPA_HASH).bind(&*TERMS_HASH).bind(DPA).bind(TERMS)
        .execute(&state.pool).await.unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acceptance_requires_explicit_authority_current_text_and_bounded_identity() {
        let mut input = AcceptanceInput {
            customer_name: " Example Ltd ".into(),
            customer_role: "controller".into(),
            signer_name: "Sam".into(),
            signer_title: "Owner".into(),
            dpa_version: VERSIONS.dpa_version.clone(),
            terms_version: VERSIONS.terms_version.clone(),
            dpa_sha256: DPA_HASH.clone(),
            terms_sha256: TERMS_HASH.clone(),
            accepted: true,
        };
        input.validate().unwrap();
        assert_eq!(input.customer_name, "Example Ltd");
        input.accepted = false;
        assert!(input.validate().is_err());
        input.accepted = true;
        input.dpa_sha256 = "old".into();
        assert_eq!(input.validate().unwrap_err().code, "agreement_changed");
        input.dpa_sha256 = DPA_HASH.clone();
        input.signer_name = "\n".into();
        assert!(input.validate().is_err());
        assert_eq!(escape("<script>\"&'"), "&lt;script&gt;&quot;&amp;&#39;");
    }
}

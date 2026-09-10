use analytics_core::{Error, Result, State};

pub async fn completed(state: &State, owner: &str) -> Result<bool> {
    Ok(
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM account_onboarding WHERE owner_id=$1)")
            .bind(owner)
            .fetch_one(&state.db)
            .await?,
    )
}

pub async fn complete(state: &State, owner: &str) -> Result<()> {
    let mut tx = state.db.begin().await?;
    // Share the website-creation lock so completion cannot race the free setup slot.
    sqlx::query("SELECT id FROM \"user\" WHERE id=$1 FOR UPDATE")
        .bind(owner)
        .fetch_one(&mut *tx)
        .await?;
    let has_site: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sites WHERE owner_id=$1)")
        .bind(owner)
        .fetch_one(&mut *tx)
        .await?;
    if !has_site {
        return Err(Error::new(
            409,
            "website_required",
            "Add your website before choosing a plan.",
        ));
    }
    sqlx::query("INSERT INTO account_onboarding(owner_id) VALUES($1) ON CONFLICT DO NOTHING")
        .bind(owner)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

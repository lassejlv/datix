use analytics_core::{Result,State};
use serde_json::{Value,json};
use uuid::Uuid;
pub async fn report(state:&State,env:Uuid)->Result<Value>{
    let countries:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('code',country,'visitors',count(DISTINCT (day,visitor))) FROM events WHERE site_id=$1 AND received_at>now()-interval '24 hours' GROUP BY country ORDER BY count(DISTINCT (day,visitor)) DESC").bind(env).fetch_all(&state.db).await?;
    let active:i64=sqlx::query_scalar("SELECT count(DISTINCT (day,visitor)) FROM events WHERE site_id=$1 AND received_at>now()-interval '5 minutes'").bind(env).fetch_one(&state.db).await?;
    let recent:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',visitor,'country',country,'path',path,'at',received_at,'name',name,'type',type) FROM events WHERE site_id=$1 AND received_at>now()-interval '24 hours' ORDER BY received_at DESC LIMIT 15").bind(env).fetch_all(&state.db).await?;
    let referrers:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('value',referrer,'count',count(*)) FROM events WHERE site_id=$1 AND received_at>now()-interval '24 hours' AND type='pageview' GROUP BY referrer ORDER BY count(*) DESC LIMIT 4").bind(env).fetch_all(&state.db).await?;
    let devices:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('value',device,'count',count(*)) FROM events WHERE site_id=$1 AND received_at>now()-interval '24 hours' AND type='pageview' GROUP BY device ORDER BY count(*) DESC LIMIT 4").bind(env).fetch_all(&state.db).await?;
    Ok(json!({"countries":countries,"active":active,"recent":recent,"referrers":referrers,"devices":devices}))
}

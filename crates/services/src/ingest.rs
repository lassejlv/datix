//! Bounded owner batches amortize quota checks and writes without weakening transactional admission.
use crate::{
    billing::{allowance, usage},
    tracking::Event,
};
use analytics_core::{Error, Result, State};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde_json::json;
use sqlx::{PgConnection, Postgres, QueryBuilder};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::atomic::Ordering::Relaxed,
    time::Instant,
};
use uuid::Uuid;

#[derive(sqlx::FromRow)]
struct Parent {
    id: Uuid,
    site_id: Uuid,
    owner_id: String,
}
#[derive(sqlx::FromRow)]
struct Environment {
    id: Uuid,
    site_id: Uuid,
    tracking_settings: serde_json::Value,
    allow_localhost: bool,
    enabled: bool,
}
type Stats = BTreeMap<(Uuid, NaiveDate, String, String), (i64, i64, i64)>;
type Outbox = BTreeMap<(String, DateTime<Utc>, NaiveDate), (i64, DateTime<Utc>)>;

pub async fn ingest(state: &State, event: &Event, now: DateTime<Utc>) -> Result<bool> {
    ingest_batch(state, std::slice::from_ref(event), now)
        .await
        .remove(0)
}

/// Results retain input order. Failure for one owner cannot hide another owner's committed work.
pub async fn ingest_batch(
    state: &State,
    events: &[Event],
    now: DateTime<Utc>,
) -> Vec<Result<bool>> {
    let started = Instant::now();
    let mut results: Vec<Result<bool>> = events.iter().map(|_| Ok(false)).collect();
    if events.is_empty() {
        return results;
    }
    if events.len() > 128 {
        return events
            .iter()
            .map(|_| {
                Err(Error::invalid(
                    "Ingestion batches contain at most 128 events.",
                ))
            })
            .collect();
    }
    let ids: Vec<_> = events.iter().map(Event::environment).collect();
    let parents = match sqlx::query_as::<_, Parent>(
        "SELECT e.id,e.site_id,s.owner_id FROM environments e JOIN sites s ON s.id=e.site_id WHERE e.id=ANY($1)"
    ).bind(&ids).fetch_all(&state.db).await {
        Ok(rows) => rows.into_iter().map(|p| (p.id, p)).collect::<HashMap<_,_>>(),
        Err(error) => {
            let _ = Error::from(error);
            return events.iter().map(|_| Err(Error::unavailable())).collect();
        }
    };
    let mut owners: BTreeMap<&str, Vec<(usize, &Event)>> = BTreeMap::new();
    for (index, event) in events.iter().enumerate() {
        if let Err(error) = event.validate() {
            results[index] = Err(error);
            continue;
        }
        if event.received_at < now - Duration::days(30)
            || event.received_at > now + Duration::seconds(60)
        {
            continue;
        }
        if let Some(parent) = parents
            .get(&event.environment())
            .filter(|p| p.site_id == event.site_id)
        {
            owners
                .entry(&parent.owner_id)
                .or_default()
                .push((index, event));
        }
    }
    for (owner, batch) in owners {
        match ingest_owner(state, owner, &batch, now).await {
            Ok(inserted) => {
                for (index, _) in &batch {
                    results[*index] = Ok(inserted.contains(index));
                }
            }
            Err(_) => {
                for (index, _) in &batch {
                    results[*index] = Err(Error::unavailable());
                }
            }
        }
    }
    for (event, result) in events.iter().zip(&results) {
        match result {
            Ok(true) => {
                state.metrics.committed.fetch_add(1, Relaxed);
                state.metrics.event_delay_seconds.observe(
                    (Utc::now() - event.received_at).num_milliseconds().max(0) as f64 / 1000.,
                );
            }
            Ok(false) => {
                state.metrics.skipped.fetch_add(1, Relaxed);
            }
            Err(_) => {}
        }
    }
    state
        .metrics
        .batch_seconds
        .observe(started.elapsed().as_secs_f64());
    results
}

async fn ingest_owner(
    state: &State,
    owner: &str,
    batch: &[(usize, &Event)],
    now: DateTime<Utc>,
) -> Result<HashSet<usize>> {
    let mut tx = state.begin().await?;
    // Settings and account deletion use this same first lock. One lock serves the entire batch.
    if sqlx::query("SELECT id FROM \"user\" WHERE id=$1 FOR UPDATE")
        .bind(owner)
        .fetch_optional(&mut *tx)
        .await?
        .is_none()
    {
        return Ok(HashSet::new());
    }
    let ids: Vec<_> = batch.iter().map(|(_, e)| e.environment()).collect();
    let environments: HashMap<_, _> = sqlx::query_as::<_, Environment>(
        "SELECT e.id,e.site_id,e.tracking_settings,e.allow_localhost,e.enabled FROM environments e JOIN sites s ON s.id=e.site_id WHERE e.id=ANY($1) AND s.owner_id=$2 ORDER BY s.id,e.id FOR KEY SHARE OF s,e"
    ).bind(&ids).bind(owner).fetch_all(&mut *tx).await?.into_iter().map(|e| (e.id, e)).collect();
    let (active, websites) = usage::account_allowance(&mut tx, owner, now).await?;
    let Some(active) = active else {
        return Ok(HashSet::new());
    };
    let allowed: HashMap<_, _> = websites.iter().take(10).map(|w| (w.id, w)).collect();
    let event_ids: Vec<_> = batch.iter().map(|(_, e)| e.id).collect();
    let duplicates: HashSet<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT e.environment_id,e.id FROM event_receipts e JOIN unnest($1::uuid[],$2::uuid[]) AS input(site_id,id) ON e.environment_id=input.site_id AND e.id=input.id WHERE e.kind=0"
    ).bind(&ids).bind(&event_ids).fetch_all(&mut *tx).await?.into_iter().collect();
    let mut candidates = vec![];
    let mut seen = duplicates;
    for (index, event) in batch {
        let Some(environment) = environments.get(&event.environment()).filter(|e| {
            e.site_id == event.site_id && e.enabled && (!event.localhost || e.allow_localhost)
        }) else {
            continue;
        };
        let Some(website) = allowed.get(&event.site_id) else {
            continue;
        };
        let Some(event) = event.apply_policy(&environment.tracking_settings) else {
            continue;
        };
        let Some(period) = allowance::period(&active.subscription, event.received_at) else {
            continue;
        };
        if seen.contains(&(event.environment(), event.id)) {
            continue;
        }
        candidates.push((
            *index,
            event,
            period,
            usage::budget_units(&website.credit_budget),
        ));
    }
    if candidates.is_empty() {
        return Ok(HashSet::new());
    }
    let periods: Vec<_> = candidates.iter().map(|(_, _, p, _)| p.start).collect();
    let usage_rows: Vec<(Uuid, DateTime<Utc>, i64)> = sqlx::query_as(
        "SELECT site_id,period_start,(events*100)::bigint FROM billing_usage WHERE owner_id=$1 AND period_start=ANY($2)"
    ).bind(owner).bind(&periods).fetch_all(&mut *tx).await?;
    let mut site_used: HashMap<(DateTime<Utc>, Uuid), i64> = HashMap::new();
    let mut account_used: HashMap<DateTime<Utc>, i64> = HashMap::new();
    for (site, start, units) in usage_rows {
        site_used.insert((start, site), units);
        *account_used.entry(start).or_default() += units;
    }
    let mut admitted = vec![];
    for (index, event, period, budget) in candidates {
        if seen.contains(&(event.environment(), event.id)) {
            continue;
        }
        let used = account_used.entry(period.start).or_default();
        let site = site_used.entry((period.start, event.site_id)).or_default();
        let remaining = (active.event_limit * 100 - *used).max(0);
        let site_remaining = budget.map_or(i64::MAX, |limit| (limit - *site).max(0));
        let units = event.units();
        if remaining == 0 || site_remaining < 15 || units > remaining || units > site_remaining {
            continue;
        }
        seen.insert((event.environment(), event.id));
        *used += units;
        *site += units;
        admitted.push((index, event, period));
    }
    if admitted.is_empty() {
        return Ok(HashSet::new());
    }
    let mut insert = QueryBuilder::<Postgres>::new(
        "INSERT INTO events(site_id,id,received_at,day,type,name,path,referrer,country,device,visitor) ",
    );
    insert.push_values(&admitted, |mut b, (_, e, _)| {
        b.push_bind(e.environment())
            .push_bind(e.id)
            .push_bind(e.received_at)
            .push_bind(e.day)
            .push_bind(&e.event_type)
            .push_bind(&e.name)
            .push_bind(&e.path)
            .push_bind(&e.referrer)
            .push_bind(&e.country)
            .push_bind(&e.device)
            .push_bind(&e.visitor);
    });
    insert.push(" ON CONFLICT DO NOTHING RETURNING site_id,id");
    let stored: HashSet<(Uuid, Uuid)> = insert
        .build_query_as()
        .persistent(false)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .collect();
    admitted.retain(|(_, e, _)| stored.contains(&(e.environment(), e.id)));
    if admitted.is_empty() {
        return Ok(HashSet::new());
    }
    let activity: Vec<_> = admitted
        .iter()
        .filter_map(|(_, e, _)| e.activity.as_ref().map(|a| (e, a)))
        .collect();
    if !activity.is_empty() {
        let mut insert = QueryBuilder::<Postgres>::new(
            "INSERT INTO activity_events(environment_id,id,session_key,visitor_key,received_at,kind,name,path,referrer,country,device,browser,os,details) ",
        );
        insert.push_values(&activity, |mut b, (e, a)| {
            b.push_bind(e.environment())
                .push_bind(e.id)
                .push_bind(&a.session_key)
                .push_bind(&a.visitor_key)
                .push_bind(e.received_at)
                .push_bind(&a.kind)
                .push_bind(&e.name)
                .push_bind(&e.path)
                .push_bind(&e.referrer)
                .push_bind(&e.country)
                .push_bind(&e.device)
                .push_bind(&a.browser)
                .push_bind(&a.os)
                .push_bind(json!(a.details));
        });
        insert.push(" ON CONFLICT DO NOTHING");
        insert.build().persistent(false).execute(&mut *tx).await?;
    }
    let mut usage: BTreeMap<(Uuid, DateTime<Utc>, DateTime<Utc>), i64> = BTreeMap::new();
    let mut outbox = Outbox::new();
    let mut stats: Stats = BTreeMap::new();
    for (_, event, period) in &admitted {
        let units = event.units();
        if units > 0 {
            *usage
                .entry((event.site_id, period.start, period.end))
                .or_default() += units;
            let delivery = outbox
                .entry((event.event_type.clone(), period.start, event.day))
                .or_insert((0, event.received_at));
            delivery.0 += units;
            delivery.1 = delivery.1.min(event.received_at);
        }
        let pageview = event.event_type == "pageview";
        if event
            .activity
            .as_ref()
            .is_none_or(|a| a.kind != "engagement")
        {
            add_stat(
                &mut stats,
                event,
                "total",
                "",
                pageview as i64,
                (!pageview) as i64,
            );
            if pageview {
                for (dimension, value) in [
                    ("path", &event.path),
                    ("referrer", &event.referrer),
                    ("country", &event.country),
                    ("device", &event.device),
                ] {
                    add_stat(&mut stats, event, dimension, value, 1, 0);
                }
            } else {
                add_stat(&mut stats, event, "event", &event.name, 0, 1);
            }
        }
    }
    if !usage.is_empty() {
        let rows: Vec<_> = usage.iter().map(|((site, start, end), units)| json!({"site":site,"start":start,"end":end,"units":units})).collect();
        sqlx::query("INSERT INTO billing_usage(owner_id,site_id,period_start,period_end,events) SELECT $1,r.site,r.start,r.\"end\",r.units::numeric/100 FROM jsonb_to_recordset($2) r(site uuid,start timestamptz,\"end\" timestamptz,units bigint) ON CONFLICT(owner_id,period_start,site_id) DO UPDATE SET events=billing_usage.events+excluded.events,period_end=excluded.period_end")
            .bind(owner).bind(json!(rows)).execute(&mut *tx).await?;
        let rows: Vec<_> = outbox
            .iter()
            .map(|((kind, _, _), (units, at))| json!({"kind":kind,"units":units,"at":at}))
            .collect();
        sqlx::query("INSERT INTO billing_outbox(owner_id,event_type,event_count,occurred_at) SELECT $1,r.kind,r.units::numeric/100,r.at FROM jsonb_to_recordset($2) r(kind text,units bigint,at timestamptz)")
            .bind(owner).bind(json!(rows)).execute(&mut *tx).await?;
    }
    let visitors: Vec<_> = admitted
        .iter()
        .filter(|(_, e, _)| e.event_type == "pageview")
        .collect();
    if !visitors.is_empty() {
        let mut insert =
            QueryBuilder::<Postgres>::new("INSERT INTO daily_visitors(site_id,day,visitor) ");
        insert.push_values(&visitors, |mut b, (_, e, _)| {
            b.push_bind(e.environment())
                .push_bind(e.day)
                .push_bind(&e.visitor);
        });
        insert.push(" ON CONFLICT DO NOTHING RETURNING site_id,day");
        let new: Vec<(Uuid, NaiveDate)> = insert
            .build_query_as()
            .persistent(false)
            .fetch_all(&mut *tx)
            .await?;
        for (environment, day) in new {
            stats
                .entry((environment, day, "total".into(), "".into()))
                .or_default()
                .2 += 1;
        }
    }
    write_stats(&mut tx, stats).await?;
    tx.commit().await?;
    Ok(admitted.into_iter().map(|(index, _, _)| index).collect())
}

fn add_stat(
    stats: &mut Stats,
    event: &Event,
    dimension: &str,
    value: &str,
    pageviews: i64,
    custom: i64,
) {
    let entry = stats
        .entry((
            event.environment(),
            event.day,
            dimension.into(),
            value.into(),
        ))
        .or_default();
    entry.0 += pageviews;
    entry.1 += custom;
}
async fn write_stats(conn: &mut PgConnection, stats: Stats) -> Result<()> {
    if stats.is_empty() {
        return Ok(());
    }
    let rows: Vec<_> = stats.into_iter().map(|((site, day, dimension, value), (pageviews, custom, visitors))|
        json!({"site":site,"day":day,"dimension":dimension,"value":value,"pageviews":pageviews,"custom":custom,"visitors":visitors})).collect();
    sqlx::query("INSERT INTO daily_stats(site_id,day,dimension,value,pageviews,custom_events,visitors) SELECT r.site,r.day,r.dimension,r.value,r.pageviews,r.custom,r.visitors FROM jsonb_to_recordset($1) r(site uuid,day date,dimension text,value text,pageviews bigint,custom bigint,visitors bigint) ON CONFLICT(site_id,day,dimension,value) DO UPDATE SET pageviews=daily_stats.pageviews+excluded.pageviews,custom_events=daily_stats.custom_events+excluded.custom_events,visitors=daily_stats.visitors+excluded.visitors")
        .bind(json!(rows)).execute(conn).await?;
    Ok(())
}

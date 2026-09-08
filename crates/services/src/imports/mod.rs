//! Historical provider aggregates never enter the live collection or billing pipeline.
use analytics_core::{Error, Result, State, validation};
use chrono::{DateTime, Duration, LocalResult, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgConnection;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub mod parse;
pub use parse::ImportData;

struct Prepared {
    fingerprint: String,
    summary: Value,
    days: Vec<Value>,
    breakdowns: Vec<Value>,
    breakdown_totals: BTreeMap<String, i64>,
}

fn invalid(message: impl Into<String>) -> Error {
    Error::new(400, "invalid_import", message)
}

// Midnight can repeat or disappear when a source timezone changes its UTC offset.
// Use the widest possible interval, refusing rare unsupported calendar transitions.
fn boundary(tz: Tz, day: NaiveDate, latest: bool) -> Result<DateTime<Utc>> {
    let midnight = day
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| invalid("Invalid source date."))?;
    for minute in 0..=180 {
        match tz.from_local_datetime(&(midnight + Duration::minutes(minute))) {
            LocalResult::Single(at) => return Ok(at.with_timezone(&Utc)),
            LocalResult::Ambiguous(a, b) => {
                return Ok(if latest { a.max(b) } else { a.min(b) }.with_timezone(&Utc));
            }
            LocalResult::None => {}
        }
    }
    Err(invalid(
        "This timezone contains an unsupported calendar transition. Export these dates in UTC instead.",
    ))
}

fn add(total: &mut i64, amount: i64) -> Result<()> {
    if amount < 0 {
        return Err(invalid(
            "Imported counts must be nonnegative whole numbers.",
        ));
    }
    *total = total
        .checked_add(amount)
        .filter(|n| *n <= 9_007_199_254_740_991)
        .ok_or_else(|| invalid("Imported totals exceed the supported count limit."))?;
    Ok(())
}

fn prepare(source_name: &str, data: &ImportData, now: DateTime<Utc>) -> Result<Prepared> {
    let source_name = validation::name(source_name, 255)?;
    let tz: Tz = data.timezone.parse().map_err(|_| {
        invalid("Choose a valid IANA source timezone, such as Europe/Copenhagen or UTC.")
    })?;
    if data.days.is_empty() || data.days.len() > 730 || data.breakdowns.len() > 100_000 {
        return Err(invalid(
            "Import 1–730 daily totals and at most 100,000 breakdown rows.",
        ));
    }
    let mut totals = [0i64; 3];
    let mut days = BTreeMap::new();
    for row in &data.days {
        if row.day < now.date_naive() - Duration::days(729) || row.day >= now.date_naive() {
            return Err(invalid(
                "Import complete dates within the last 730 days, ending no later than yesterday.",
            ));
        }
        let next = row
            .day
            .succ_opt()
            .ok_or_else(|| invalid("Invalid source date."))?;
        let starts = boundary(tz, row.day, false)?;
        let ends = boundary(tz, next, true)?;
        if starts >= ends || ends > now {
            return Err(invalid(
                "A source day is still in progress. Export only complete days in the selected timezone.",
            ));
        }
        add(&mut totals[0], row.pageviews)?;
        add(&mut totals[1], row.visitors)?;
        add(&mut totals[2], row.custom_events)?;
        let value = json!({"day":row.day,"starts":starts,"ends":ends,"pageviews":row.pageviews,"visitors":row.visitors,"custom":row.custom_events});
        if days.insert(row.day, value).is_some() {
            return Err(invalid(
                "An import can contain only one daily total per date.",
            ));
        }
    }
    let mut breakdowns = BTreeMap::new();
    let mut breakdown_totals = BTreeMap::new();
    let mut dimensions = BTreeSet::new();
    for row in &data.breakdowns {
        if !["path", "referrer", "country", "device", "event"].contains(&row.dimension.as_str())
            || !days.contains_key(&row.day)
            || row.count < 0
            || row.value.len() > 2048
            || row.value.chars().any(char::is_control)
        {
            return Err(invalid(
                "A breakdown row has an invalid date, dimension, value or count.",
            ));
        }
        dimensions.insert(row.dimension.clone());
        add(
            breakdown_totals.entry(row.dimension.clone()).or_default(),
            row.count,
        )?;
        let key = (row.day, row.dimension.clone(), row.value.clone());
        if breakdowns.insert(key, json!({"day":row.day,"dimension":row.dimension,"value":row.value,"count":row.count})).is_some() {
            return Err(invalid("A breakdown contains duplicate date and dimension values."));
        }
    }
    let metrics: BTreeSet<_> = data.metrics.iter().cloned().collect();
    if !metrics.contains("pageviews")
        || !metrics.contains("dailyUniqueVisitors")
        || metrics
            .iter()
            .any(|m| !["pageviews", "dailyUniqueVisitors", "customEvents"].contains(&m.as_str()))
        || (!metrics.contains("customEvents") && (totals[2] != 0 || dimensions.contains("event")))
    {
        return Err(invalid(
            "The import's available metrics do not match its daily totals.",
        ));
    }
    let from = *days.first_key_value().unwrap().0;
    let to = *days.last_key_value().unwrap().0;
    let days: Vec<Value> = days.into_values().collect();
    let breakdowns: Vec<Value> = breakdowns.into_values().collect();
    let canonical = json!({"provider":data.provider.as_str(),"timeZone":tz.name(),"days":days,"breakdowns":breakdowns,"metrics":metrics});
    let fingerprint = hex::encode(Sha256::digest(canonical.to_string().as_bytes()));
    let summary = json!({
        "fingerprint":fingerprint,"provider":data.provider.as_str(),"sourceName":source_name,
        "timeZone":tz.name(),"visitorMetric":data.provider.visitor_metric(),"dateBasis":"provider_calendar_day",
        "from":from,"to":to,"days":days.len(),"rowCount":days.len()+breakdowns.len(),
        "pageviews":totals[0],"dailyVisitors":totals[1],"customEvents":totals[2],
        "metrics":metrics,"breakdowns":dimensions,"warnings":data.warnings,"files":data.files,"duplicate":false
    });
    Ok(Prepared {
        fingerprint,
        summary,
        days,
        breakdowns,
        breakdown_totals,
    })
}

async fn authorized(
    conn: &mut PgConnection,
    owner: &str,
    environment: Uuid,
    lock: bool,
) -> Result<()> {
    if lock {
        // Match ingestion/account settings: owner, then site, then environment.
        if sqlx::query("SELECT id FROM \"user\" WHERE id=$1 FOR UPDATE")
            .bind(owner)
            .fetch_optional(&mut *conn)
            .await?
            .is_none()
        {
            return Err(Error::new(
                404,
                "environment_not_found",
                "Environment not found.",
            ));
        }
    }
    if lock {
        // Keep lock acquisition explicit: PostgreSQL need not lock joined rows in SQL list order.
        let site: Option<Uuid> = sqlx::query_scalar("SELECT s.id FROM sites s JOIN environments e ON e.site_id=s.id WHERE e.id=$1 AND s.owner_id=$2 FOR UPDATE OF s")
            .bind(environment).bind(owner).fetch_optional(&mut *conn).await?;
        let Some(site) = site else {
            return Err(Error::new(
                404,
                "environment_not_found",
                "Environment not found.",
            ));
        };
        if sqlx::query("SELECT id FROM environments WHERE id=$1 AND site_id=$2 FOR UPDATE")
            .bind(environment)
            .bind(site)
            .fetch_optional(conn)
            .await?
            .is_none()
        {
            return Err(Error::new(
                404,
                "environment_not_found",
                "Environment not found.",
            ));
        }
        return Ok(());
    }
    if sqlx::query_scalar::<_, Uuid>("SELECT e.id FROM environments e JOIN sites s ON s.id=e.site_id WHERE e.id=$1 AND s.owner_id=$2")
        .bind(environment)
        .bind(owner)
        .fetch_optional(conn)
        .await?
        .is_none()
    {
        return Err(Error::new(
            404,
            "environment_not_found",
            "Environment not found.",
        ));
    }
    Ok(())
}

async fn duplicate(
    conn: &mut PgConnection,
    environment: Uuid,
    fingerprint: &str,
) -> Result<Option<Value>> {
    Ok(sqlx::query_scalar("SELECT summary || jsonb_build_object('id',id,'createdAt',created_at,'duplicate',true) FROM analytics_imports WHERE environment_id=$1 AND fingerprint=$2")
        .bind(environment).bind(fingerprint).fetch_optional(conn).await?)
}

async fn available(conn: &mut PgConnection, environment: Uuid, prepared: &Prepared) -> Result<()> {
    let live: Option<NaiveDate> = sqlx::query_scalar(
        "SELECT min(day) FROM daily_stats WHERE site_id=$1 AND dimension='total'",
    )
    .bind(environment)
    .fetch_one(&mut *conn)
    .await?;
    if let Some(day) = live {
        let limit = day.and_hms_opt(0, 0, 0).unwrap().and_utc();
        let overlaps = prepared.days.iter().any(|r| {
            r["ends"]
                .as_str()
                .and_then(|s| s.parse::<DateTime<Utc>>().ok())
                .is_none_or(|end| end > limit)
        });
        if overlaps {
            return Err(Error::new(
                409,
                "import_live_overlap",
                format!(
                    "Live analytics starts on {day} UTC. Export source days that end before that boundary; the source timezone may require excluding the preceding calendar day."
                ),
            ));
        }
    }
    let overlap: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM imported_daily_stats existing JOIN jsonb_to_recordset($2) incoming(day date,starts timestamptz,ends timestamptz) ON existing.day=incoming.day OR (existing.starts_at<incoming.ends AND existing.ends_at>incoming.starts) WHERE existing.environment_id=$1)")
        .bind(environment).bind(json!(prepared.days)).fetch_one(&mut *conn).await?;
    if overlap {
        return Err(Error::new(
            409,
            "import_overlap",
            "These dates overlap an existing import. Remove the earlier import before replacing its dates.",
        ));
    }
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM analytics_imports WHERE environment_id=$1")
            .bind(environment)
            .fetch_one(&mut *conn)
            .await?;
    if count >= 50 {
        return Err(Error::new(
            409,
            "import_limit",
            "An environment supports up to 50 imports. Remove an earlier import before adding another.",
        ));
    }
    let exceeds: bool = sqlx::query_scalar("SELECT coalesce(sum(pageviews),0)+($2->>'pageviews')::numeric>9007199254740991 OR coalesce(sum(visitors),0)+($2->>'dailyVisitors')::numeric>9007199254740991 OR coalesce(sum(custom_events),0)+($2->>'customEvents')::numeric>9007199254740991 FROM imported_daily_stats WHERE environment_id=$1")
        .bind(environment).bind(&prepared.summary).fetch_one(&mut *conn).await?;
    if exceeds {
        return Err(invalid(
            "The combined imported totals exceed the supported count limit.",
        ));
    }
    if !prepared.breakdown_totals.is_empty() {
        let exceeds: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM jsonb_each_text($2) incoming(dimension,total) LEFT JOIN (SELECT dimension,sum(count) AS total FROM imported_breakdowns WHERE environment_id=$1 GROUP BY dimension) existing USING(dimension) WHERE coalesce(existing.total,0)+incoming.total::numeric>9007199254740991)")
            .bind(environment).bind(json!(prepared.breakdown_totals)).fetch_one(conn).await?;
        if exceeds {
            return Err(invalid(
                "The combined imported breakdown totals exceed the supported count limit.",
            ));
        }
    }
    Ok(())
}

pub async fn preview(
    state: &State,
    owner: &str,
    environment: Uuid,
    source_name: &str,
    data: &ImportData,
) -> Result<Value> {
    let prepared = prepare(source_name, data, Utc::now())?;
    let mut tx = state.begin().await?;
    sqlx::query("SET TRANSACTION READ ONLY")
        .execute(&mut *tx)
        .await?;
    authorized(&mut tx, owner, environment, false).await?;
    if let Some(existing) = duplicate(&mut tx, environment, &prepared.fingerprint).await? {
        return Ok(existing);
    }
    available(&mut tx, environment, &prepared).await?;
    Ok(prepared.summary)
}

pub async fn create(
    state: &State,
    owner: &str,
    environment: Uuid,
    source_name: &str,
    data: &ImportData,
    expected_fingerprint: &str,
) -> Result<Value> {
    let prepared = prepare(source_name, data, Utc::now())?;
    if expected_fingerprint != prepared.fingerprint {
        return Err(Error::new(
            409,
            "import_changed",
            "The import changed after preview. Review the file again before importing.",
        ));
    }
    let mut tx = state.begin().await?;
    authorized(&mut tx, owner, environment, true).await?;
    if let Some(existing) = duplicate(&mut tx, environment, &prepared.fingerprint).await? {
        return Ok(json!({"import":existing,"duplicate":true}));
    }
    available(&mut tx, environment, &prepared).await?;
    let id = Uuid::new_v4();
    let created: DateTime<Utc> = sqlx::query_scalar("INSERT INTO analytics_imports(id,environment_id,provider,source_timezone,fingerprint,summary) VALUES($1,$2,$3,$4,$5,$6) RETURNING created_at")
        .bind(id).bind(environment).bind(data.provider.as_str()).bind(&data.timezone).bind(&prepared.fingerprint).bind(&prepared.summary)
        .fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO imported_daily_stats(environment_id,day,import_id,starts_at,ends_at,pageviews,visitors,custom_events) SELECT $1,r.day,$2,r.starts,r.ends,r.pageviews,r.visitors,r.custom FROM jsonb_to_recordset($3) r(day date,starts timestamptz,ends timestamptz,pageviews bigint,visitors bigint,custom bigint)")
        .bind(environment).bind(id).bind(json!(prepared.days)).execute(&mut *tx).await?;
    // Bound each database message even when a ZIP contains many breakdown rows.
    for chunk in prepared.breakdowns.chunks(2000) {
        sqlx::query("INSERT INTO imported_breakdowns(environment_id,day,dimension,value,count) SELECT $1,r.day,r.dimension,r.value,r.count FROM jsonb_to_recordset($2) r(day date,dimension text,value text,count bigint)")
            .bind(environment).bind(json!(chunk)).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE environments SET import_revision=import_revision+1 WHERE id=$1")
        .bind(environment)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let mut summary = prepared.summary;
    summary["id"] = json!(id);
    summary["createdAt"] = json!(created);
    Ok(json!({"import":summary,"duplicate":false}))
}

pub async fn list(state: &State, owner: &str, environment: Uuid) -> Result<Value> {
    let mut conn = state.acquire().await?;
    authorized(&mut conn, owner, environment, false).await?;
    let imports: Vec<Value> = sqlx::query_scalar("SELECT summary || jsonb_build_object('id',id,'createdAt',created_at) FROM analytics_imports WHERE environment_id=$1 ORDER BY created_at DESC,id DESC")
        .bind(environment).fetch_all(&mut *conn).await?;
    Ok(json!({"imports":imports}))
}

pub async fn remove(state: &State, owner: &str, environment: Uuid, import: Uuid) -> Result<()> {
    let mut tx = state.begin().await?;
    authorized(&mut tx, owner, environment, true).await?;
    let removed = sqlx::query("DELETE FROM analytics_imports WHERE environment_id=$1 AND id=$2")
        .bind(environment)
        .bind(import)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if removed == 0 {
        return Err(Error::new(
            404,
            "import_not_found",
            "Import not found in this environment.",
        ));
    }
    sqlx::query("UPDATE environments SET import_revision=import_revision+1 WHERE id=$1")
        .bind(environment)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use parse::{ImportedBreakdown, ImportedDay, Provider};

    fn sample() -> ImportData {
        ImportData {
            provider: Provider::Plausible,
            timezone: "UTC".into(),
            days: vec![
                ImportedDay {
                    day: NaiveDate::from_ymd_opt(2026, 9, 5).unwrap(),
                    pageviews: 12,
                    visitors: 9,
                    custom_events: 0,
                },
                ImportedDay {
                    day: NaiveDate::from_ymd_opt(2026, 9, 6).unwrap(),
                    pageviews: 15,
                    visitors: 11,
                    custom_events: 0,
                },
            ],
            breakdowns: vec![
                ImportedBreakdown {
                    day: NaiveDate::from_ymd_opt(2026, 9, 5).unwrap(),
                    dimension: "path".into(),
                    value: "/".into(),
                    count: 12,
                },
                ImportedBreakdown {
                    day: NaiveDate::from_ymd_opt(2026, 9, 6).unwrap(),
                    dimension: "path".into(),
                    value: "/".into(),
                    count: 15,
                },
            ],
            warnings: vec![],
            files: vec!["visitors.csv".into(), "pages.csv".into()],
            metrics: vec!["pageviews".into(), "dailyUniqueVisitors".into()],
        }
    }

    #[test]
    fn equivalent_exports_share_a_fingerprint_after_reordering_or_renaming() {
        let now = "2026-09-08T12:00:00Z".parse().unwrap();
        let mut data = sample();
        let first = prepare("export.zip", &data, now).unwrap();
        data.days.reverse();
        data.breakdowns.reverse();
        data.files.reverse();
        data.metrics.reverse();
        let second = prepare("renamed.zip", &data, now).unwrap();
        assert_eq!(first.fingerprint, second.fingerprint);
        assert_eq!(first.summary["pageviews"], 27);
        assert_eq!(first.summary["dailyVisitors"], 20);
        data.days[0].pageviews += 1;
        assert_ne!(
            first.fingerprint,
            prepare("renamed.zip", &data, now).unwrap().fingerprint
        );
    }

    #[test]
    fn a_day_must_be_complete_in_its_source_timezone() {
        let mut data = sample();
        data.timezone = "America/New_York".into();
        data.days.truncate(1);
        data.days[0].day = NaiveDate::from_ymd_opt(2026, 9, 7).unwrap();
        data.breakdowns.clear();
        let error = prepare("export.csv", &data, "2026-09-08T00:30:00Z".parse().unwrap())
            .err()
            .unwrap();
        assert!(error.message.contains("still in progress"));
        assert!(prepare("export.csv", &data, "2026-09-08T05:00:00Z".parse().unwrap()).is_ok());
    }

    #[test]
    fn imported_totals_cannot_exceed_exact_javascript_integer_precision() {
        let mut data = sample();
        data.days[0].pageviews = 9_007_199_254_740_991;
        assert!(prepare("export.csv", &data, "2026-09-08T12:00:00Z".parse().unwrap()).is_err());
    }

    #[test]
    fn source_dates_keep_real_dst_boundaries() {
        let tz: Tz = "Europe/Copenhagen".parse().unwrap();
        let before = boundary(tz, NaiveDate::from_ymd_opt(2026, 3, 29).unwrap(), false).unwrap();
        let after = boundary(tz, NaiveDate::from_ymd_opt(2026, 3, 30).unwrap(), true).unwrap();
        assert_eq!((after - before).num_hours(), 23);
        assert_eq!(after.to_rfc3339(), "2026-03-29T22:00:00+00:00");
    }

    #[test]
    fn a_negative_utc_offset_can_overlap_the_next_utc_date() {
        let tz: Tz = "America/New_York".parse().unwrap();
        let end = boundary(tz, NaiveDate::from_ymd_opt(2026, 7, 2).unwrap(), true).unwrap();
        assert_eq!(end.to_rfc3339(), "2026-07-02T04:00:00+00:00");
    }
}

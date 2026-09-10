//! Overview composition. Cross-filters use retained native events, never marginal aggregates.
use super::*;
use analytics_core::validation;
use serde::Deserialize;

const FILTERED: &str = "WITH filtered AS MATERIALIZED (
 SELECT * FROM events WHERE site_id=$1 AND day BETWEEN $2 AND $3
 AND received_at >= $8::timestamptz AND received_at < $9::timestamptz
 AND ($4::text IS NULL OR path=$4) AND ($5::text IS NULL OR referrer=$5)
 AND ($6::text IS NULL OR country=$6) AND ($7::text IS NULL OR device=$7)
)";

fn filters(params: &HashMap<String, String>) -> Result<[Option<&str>; 4]> {
    let mut values = [None; 4];
    for (index, key) in ["path", "referrer", "country", "device"].iter().enumerate() {
        if let Some(value) = params.get(*key) {
            if value.len() > 2048 || value.chars().any(char::is_control) {
                return Err(Error::invalid("Invalid overview filter."));
            }
            values[index] = Some(value.as_str());
        }
    }
    Ok(values)
}

#[derive(Clone, Copy)]
struct TimeWindow {
    start: DateTime<Utc>,
    end: DateTime<Utc>,
}
impl TimeWindow {
    fn range(self) -> DateRange {
        let from = self.start.date_naive();
        let to = (self.end - Duration::microseconds(1)).date_naive();
        DateRange {
            from,
            to,
            days: (to - from).num_days() + 1,
            timezone: "UTC",
        }
    }
}
fn retained_window(range: &DateRange) -> TimeWindow {
    let cutoff = Utc::now().date_naive() - Duration::days(29);
    TimeWindow {
        start: range
            .from
            .max(cutoff)
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc(),
        end: (range.to + Duration::days(1))
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc(),
    }
}

async fn period(
    state: &State,
    env: Uuid,
    range: &DateRange,
    params: &HashMap<String, String>,
    full: bool,
    hourly: Option<TimeWindow>,
) -> Result<Value> {
    let values = filters(params)?;
    if hourly.is_some() || values.iter().any(Option::is_some) {
        let bounds = hourly.unwrap_or_else(|| retained_window(range));
        let dimensions = if full {
            vec!["path", "referrer", "country", "device", "event"]
        } else {
            vec![]
        };
        let mut extras = String::new();
        for dimension in dimensions {
            let (column, kind) = if dimension == "event" {
                ("name", "event")
            } else {
                (dimension, "pageview")
            };
            extras.push_str(&format!(",'{dimension}',jsonb_build_object('data',coalesce((SELECT jsonb_agg(jsonb_build_object('value',value,'count',n) ORDER BY n DESC,value) FROM (SELECT {column} AS value,count(*) AS n FROM filtered WHERE type='{kind}' GROUP BY {column} ORDER BY n DESC,value LIMIT 10) b),'[]'::jsonb))"));
        }
        let (bucket, series, point_time) = if hourly.is_some() {
            (
                "date_bin(interval '1 hour',received_at,$8::timestamptz)",
                "generate_series($8::timestamptz,$9::timestamptz-interval '1 hour',interval '1 hour')",
                "'at',at,",
            )
        } else {
            (
                "day::timestamp AT TIME ZONE 'UTC'",
                "generate_series($2::date::timestamp AT TIME ZONE 'UTC',$3::date::timestamp AT TIME ZONE 'UTC',interval '1 day')",
                "",
            )
        };
        let sql = format!(
            "{FILTERED}, buckets AS (SELECT {bucket} AS at,count(*) FILTER(WHERE type='pageview') AS pageviews,count(*) FILTER(WHERE type='event') AS custom_events,count(DISTINCT (day,visitor)) AS visitors FROM filtered GROUP BY 1), series AS (SELECT d AS at,coalesce(pageviews,0) AS pageviews,coalesce(custom_events,0) AS custom_events,coalesce(visitors,0) AS visitors FROM {series} d LEFT JOIN buckets ON buckets.at=d) SELECT jsonb_build_object('overview',jsonb_build_object('pageviews',coalesce(sum(pageviews),0),'customEvents',coalesce(sum(custom_events),0),'dailyUniqueVisitors',(SELECT count(DISTINCT (day,visitor)) FROM filtered)),'timeseries',jsonb_build_object('data',jsonb_agg(jsonb_build_object('day',(at AT TIME ZONE 'UTC')::date,{point_time}'pageviews',pageviews,'customEvents',custom_events,'dailyUniqueVisitors',visitors) ORDER BY at)){extras}) FROM series"
        );
        return Ok(sqlx::query_scalar(&sql)
            .bind(env)
            .bind(range.from)
            .bind(range.to)
            .bind(values[0])
            .bind(values[1])
            .bind(values[2])
            .bind(values[3])
            .bind(bounds.start)
            .bind(bounds.end)
            .fetch_one(&state.db)
            .await?);
    }
    let mut result = json!({"overview":super::overview(state,env,range.clone()).await?,"timeseries":super::timeseries(state,env,range.clone()).await?});
    if full {
        for dimension in ["path", "referrer", "country", "device", "event"] {
            let mut p = HashMap::new();
            p.insert("dimension".into(), dimension.into());
            result[dimension] = super::breakdown(state, env, range.clone(), &p).await?;
        }
    }
    Ok(result)
}

pub async fn report(
    state: &State,
    env: Uuid,
    revision: i64,
    range: &DateRange,
    params: &HashMap<String, String>,
) -> Result<Value> {
    let hourly = match params.get("window").map(String::as_str) {
        None => None,
        Some("24h") => {
            let end = Utc::now();
            Some(TimeWindow {
                start: end - Duration::hours(24),
                end,
            })
        }
        Some(_) => return Err(Error::invalid("Invalid overview window.")),
    };
    let hourly_range = hourly.map(TimeWindow::range);
    let range = hourly_range.as_ref().unwrap_or(range);
    let values = filters(params)?;
    let filtered = values.iter().any(Option::is_some);
    let cutoff = Utc::now().date_naive() - Duration::days(29);
    let previous_hourly = hourly.map(|w| TimeWindow {
        start: w.start - Duration::hours(24),
        end: w.start,
    });
    let previous = previous_hourly
        .map(TimeWindow::range)
        .unwrap_or_else(|| DateRange {
            from: range.from - Duration::days(range.days),
            to: range.from - Duration::days(1),
            days: range.days,
            timezone: "UTC",
        });
    let mut report = if hourly.is_some() {
        // One captured timestamp defines every report in this rolling window.
        period(state, env, range, params, true, hourly).await?
    } else {
        cached(
            state,
            env,
            revision,
            "overview-page",
            range,
            params,
            period(state, env, range, params, true, None),
        )
        .await?
    };
    // Missing retention history is not a zero baseline.
    let can_compare = hourly.is_some()
        || previous.from
            >= if filtered {
                cutoff
            } else {
                Utc::now().date_naive() - Duration::days(729)
            };
    report["previous"] = if let Some(window) = previous_hourly {
        period(state, env, &previous, params, false, Some(window)).await?
    } else if can_compare {
        cached(
            state,
            env,
            revision,
            "overview-previous",
            &previous,
            params,
            period(state, env, &previous, params, false, None),
        )
        .await?
    } else {
        Value::Null
    };
    report["previousRange"] = if let Some(window) = previous_hourly {
        json!({"from":window.start,"to":window.end})
    } else {
        json!(previous)
    };
    if let Some(window) = hourly {
        report["window"] = json!({"from":window.start,"to":window.end,"interval":"hour"});
    }
    report["filtered"] = json!(filtered);
    report["retainedFrom"] = json!(cutoff);
    report["partial"] = json!(filtered && range.from < cutoff);
    report["annotations"] = sqlx::query_scalar("SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'day',day,'label',label) ORDER BY day,created_at,id),'[]'::jsonb) FROM overview_annotations WHERE environment_id=$1 AND day BETWEEN $2 AND $3").bind(env).bind(range.from).bind(range.to).fetch_one(&state.db).await?;
    // Match actual recorded conversions to the same event scope as the traffic denominator.
    let sql = format!(
        "{FILTERED} SELECT jsonb_build_object('goals',coalesce((SELECT jsonb_agg(row ORDER BY created_at,id) FROM (SELECT g.created_at,g.id,jsonb_build_object('id',g.id,'name',g.name,'conversions',count(c.event_id),'visitors',count(DISTINCT (c.day,c.visitor)) FILTER(WHERE c.event_id IS NOT NULL)) AS row FROM conversion_goals g LEFT JOIN (goal_conversions c JOIN filtered e ON e.id=c.event_id AND e.site_id=c.environment_id AND e.received_at=c.received_at) ON c.goal_id=g.id WHERE g.environment_id=$1 GROUP BY g.id) goals),'[]'::jsonb),'visitors',(SELECT count(DISTINCT (day,visitor)) FROM filtered))"
    );
    let bounds = hourly.unwrap_or_else(|| retained_window(range));
    report["goals"] = sqlx::query_scalar(&sql)
        .bind(env)
        .bind(range.from)
        .bind(range.to)
        .bind(values[0])
        .bind(values[1])
        .bind(values[2])
        .bind(values[3])
        .bind(bounds.start)
        .bind(bounds.end)
        .fetch_one(&state.db)
        .await?;
    Ok(report)
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum AnnotationInput {
    Create { day: String, label: String },
    Delete { id: Uuid },
}
pub async fn annotate(state: &State, env: Uuid, body: Value) -> Result<Value> {
    match validation::decode(body)? {
        AnnotationInput::Create { day, label } => {
            let label = validation::name(&label, 120)?;
            let mut params = HashMap::new();
            params.insert("from".into(), day.clone());
            params.insert("to".into(), day);
            let range = DateRange::parse(&params)?;
            let mut tx = state.db.begin().await?;
            sqlx::query("SELECT id FROM environments WHERE id=$1 FOR UPDATE")
                .bind(env)
                .execute(&mut *tx)
                .await?;
            let count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM overview_annotations WHERE environment_id=$1",
            )
            .bind(env)
            .fetch_one(&mut *tx)
            .await?;
            if count >= 500 {
                return Err(Error::invalid(
                    "An environment can have up to 500 annotations.",
                ));
            }
            let row:Value=sqlx::query_scalar("INSERT INTO overview_annotations(environment_id,day,label) VALUES($1,$2,$3) RETURNING jsonb_build_object('id',id,'day',day,'label',label)").bind(env).bind(range.from).bind(label).fetch_one(&mut *tx).await?;
            tx.commit().await?;
            Ok(json!({"annotation":row}))
        }
        AnnotationInput::Delete { id } => {
            let n =
                sqlx::query("DELETE FROM overview_annotations WHERE environment_id=$1 AND id=$2")
                    .bind(env)
                    .bind(id)
                    .execute(&state.db)
                    .await?
                    .rows_affected();
            if n == 0 {
                return Err(Error::new(
                    404,
                    "annotation_not_found",
                    "Annotation not found.",
                ));
            }
            Ok(json!({"deleted":true}))
        }
    }
}

pub async fn live(state: &State, env: Uuid) -> Result<Value> {
    Ok(sqlx::query_scalar("WITH recent AS MATERIALIZED (SELECT * FROM events WHERE site_id=$1 AND received_at>now()-interval '5 minutes') SELECT jsonb_build_object('active',(SELECT count(DISTINCT (day,visitor)) FROM recent),'recent',coalesce((SELECT jsonb_agg(jsonb_build_object('path',path,'country',country,'at',received_at) ORDER BY received_at DESC) FROM (SELECT * FROM recent ORDER BY received_at DESC,id LIMIT 10) r),'[]'::jsonb))").bind(env).fetch_one(&state.db).await?)
}

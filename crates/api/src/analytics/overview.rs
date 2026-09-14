use super::{
    Parameters, features, read_transaction,
    reports::{self, DateRange},
};
use crate::{AppState, error::ApiError};
use chrono::{DateTime, Duration, NaiveDate, SecondsFormat, Utc};
use serde_json::{Value, json};
use uuid::Uuid;

const FILTERED: &str = "WITH filtered AS MATERIALIZED (SELECT * FROM events WHERE site_id=$1 AND day BETWEEN $2 AND $3 AND received_at>=$8::timestamptz AND received_at<$9::timestamptz AND ($4::text IS NULL OR path=$4) AND ($5::text IS NULL OR referrer=$5) AND ($6::text IS NULL OR country=$6) AND ($7::text IS NULL OR device=$7))";

fn midnight(day: NaiveDate) -> Result<DateTime<Utc>, ApiError> {
    day.and_hms_opt(0, 0, 0)
        .map(|d| d.and_utc())
        .ok_or_else(ApiError::invalid)
}

fn timestamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

struct Window<'a> {
    state: &'a AppState,
    env: Uuid,
    hourly: bool,
    filtered: bool,
    values: [Option<&'a str>; 4],
    cutoff: NaiveDate,
}

impl Window<'_> {
    async fn build(
        &self,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
        full: bool,
    ) -> Result<Value, ApiError> {
        let range = DateRange {
            from: start.date_naive(),
            to: (end - Duration::milliseconds(1)).date_naive(),
            days: 0,
        };
        if !self.hourly && !self.filtered {
            let query = range.parameters();
            let mut result = json!({
                "overview":reports::report(self.state,self.env,"overview",&query).await?,
                "timeseries":reports::report(self.state,self.env,"timeseries",&query).await?
            });
            if full {
                for dimension in ["path", "referrer", "country", "device", "event"] {
                    let mut query = query.clone();
                    query.insert("dimension".into(), dimension.into());
                    result[dimension] =
                        reports::report(self.state, self.env, "breakdown", &query).await?;
                }
            }
            return Ok(result);
        }
        let bounds_start = if self.hourly {
            start
        } else {
            start.max(midnight(self.cutoff)?)
        };
        let mut extra = String::new();
        if full {
            // Only fixed identifiers are interpolated; every request filter remains bound.
            for (dimension, column, kind) in [
                ("path", "path", "pageview"),
                ("referrer", "referrer", "pageview"),
                ("country", "country", "pageview"),
                ("device", "device", "pageview"),
                ("event", "name", "event"),
            ] {
                extra.push_str(&format!(", '{dimension}',jsonb_build_object('data',coalesce((SELECT jsonb_agg(jsonb_build_object('value',value,'count',n) ORDER BY n DESC,value) FROM (SELECT {column} AS value,count(*) AS n FROM filtered WHERE type='{kind}' GROUP BY {column} ORDER BY n DESC,value LIMIT 10) b),'[]'::jsonb))"));
            }
        }
        let (bucket, series, at) = if self.hourly {
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
        let statement = format!(
            "{FILTERED},buckets AS (SELECT {bucket} AS at,count(*) FILTER(WHERE type='pageview') AS pageviews,count(*) FILTER(WHERE type='event') AS custom_events,count(DISTINCT(day,visitor)) AS visitors FROM filtered GROUP BY 1),series AS (SELECT d AS at,coalesce(pageviews,0) AS pageviews,coalesce(custom_events,0) AS custom_events,coalesce(visitors,0) AS visitors FROM {series} d LEFT JOIN buckets ON buckets.at=d) SELECT jsonb_build_object('overview',jsonb_build_object('pageviews',coalesce(sum(pageviews),0),'customEvents',coalesce(sum(custom_events),0),'dailyUniqueVisitors',(SELECT count(DISTINCT(day,visitor)) FROM filtered)),'timeseries',jsonb_build_object('data',jsonb_agg(jsonb_build_object('day',(at AT TIME ZONE 'UTC')::date,{at}'pageviews',pageviews,'customEvents',custom_events,'dailyUniqueVisitors',visitors) ORDER BY at)){extra}) FROM series"
        );
        let mut tx = read_transaction(self.state).await?;
        Ok(sqlx::query_scalar(&statement)
            .bind(self.env)
            .bind(range.from)
            .bind(range.to)
            .bind(self.values[0])
            .bind(self.values[1])
            .bind(self.values[2])
            .bind(self.values[3])
            .bind(bounds_start)
            .bind(end)
            .fetch_one(&mut *tx)
            .await?)
    }
}

pub(super) async fn read(
    state: &AppState,
    env: Uuid,
    query: &Parameters,
) -> Result<Value, ApiError> {
    let now = DateTime::from_timestamp_millis(Utc::now().timestamp_millis())
        .ok_or_else(ApiError::unavailable)?;
    let cutoff = (now - Duration::days(29)).date_naive();
    let values =
        ["path", "referrer", "country", "device"].map(|key| query.get(key).map(String::as_str));
    if values
        .iter()
        .flatten()
        .any(|v| v.encode_utf16().count() > 2048 || v.bytes().any(|b| b <= 31 || b == 127))
    {
        return Err(ApiError::invalid());
    }
    let window = query.get("window").filter(|v| !v.is_empty());
    if window.is_some_and(|v| v != "24h") {
        return Err(ApiError::invalid());
    }
    let hourly = window.is_some();
    let filtered = values.iter().any(Option::is_some);
    let range = if hourly {
        DateRange::parse(
            &[
                (
                    "from".into(),
                    (now - Duration::days(1)).date_naive().to_string(),
                ),
                ("to".into(), now.date_naive().to_string()),
            ]
            .into(),
        )?
    } else {
        DateRange::parse(query)?
    };
    let current_start = if hourly {
        now - Duration::days(1)
    } else {
        midnight(range.from)?
    };
    let current_end = if hourly {
        now
    } else {
        midnight(range.to)? + Duration::days(1)
    };
    let prior_start = current_start - (current_end - current_start);
    let prior_end = current_start;
    let builder = Window {
        state,
        env,
        hourly,
        filtered,
        values,
        cutoff,
    };
    let mut current = builder.build(current_start, current_end, true).await?;
    let compare = hourly
        || prior_start
            >= midnight(if filtered {
                cutoff
            } else {
                now.date_naive() - Duration::days(729)
            })?;
    current["previous"] = if compare {
        builder.build(prior_start, prior_end, false).await?
    } else {
        Value::Null
    };
    current["previousRange"] = if hourly {
        json!({"from":timestamp(prior_start),"to":timestamp(prior_end)})
    } else {
        json!({"from":prior_start.date_naive(),"to":(prior_end-Duration::days(1)).date_naive(),"days":range.days,"timezone":"UTC"})
    };
    if hourly {
        current["window"] =
            json!({"from":timestamp(current_start),"to":timestamp(current_end),"interval":"hour"});
    }
    current["filtered"] = json!(filtered);
    current["retainedFrom"] = json!(cutoff);
    current["partial"] = json!(filtered && range.from < cutoff);
    let mut tx = read_transaction(state).await?;
    let annotations:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'day',day::text,'label',label) FROM overview_annotations WHERE environment_id=$1 AND day BETWEEN $2 AND $3 ORDER BY day,created_at,id")
        .bind(env).bind(range.from).bind(range.to).fetch_all(&mut *tx).await?;
    current["annotations"] = json!(annotations);
    let bounds_start = if hourly {
        current_start
    } else {
        current_start.max(midnight(cutoff)?)
    };
    let counts:Vec<Value>=sqlx::query_scalar(&format!("{FILTERED} SELECT jsonb_build_object('goal_id',c.goal_id,'conversions',count(*),'visitors',count(DISTINCT(c.day,c.visitor))) FROM goal_conversions c JOIN filtered e ON e.id=c.event_id AND e.site_id=c.environment_id AND e.received_at=c.received_at GROUP BY c.goal_id"))
        .bind(env).bind(range.from).bind(range.to).bind(values[0]).bind(values[1]).bind(values[2]).bind(values[3]).bind(bounds_start).bind(current_end).fetch_all(&mut *tx).await?;
    let visitors: i64 = sqlx::query_scalar(&format!(
        "{FILTERED} SELECT count(DISTINCT(day,visitor)) FROM filtered"
    ))
    .bind(env)
    .bind(range.from)
    .bind(range.to)
    .bind(values[0])
    .bind(values[1])
    .bind(values[2])
    .bind(values[3])
    .bind(bounds_start)
    .bind(current_end)
    .fetch_one(&mut *tx)
    .await?;
    current["goals"] = features::goals(&mut tx, env, counts, visitors).await?;
    Ok(current)
}

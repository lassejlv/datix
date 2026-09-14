use super::{
    csv::{self, trim},
    error::Error,
    zip,
};
use chrono::NaiveDate;
use icu_collator::{Collator, CollatorBorrowed};
use indexmap::IndexMap;
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::LazyLock,
};

pub const MAX_UPLOAD: usize = 10 * 1024 * 1024;
const MAX_COUNT: i64 = 1_000_000_000_000;

#[derive(Serialize)]
pub struct Day {
    pub day: String,
    pub pageviews: i64,
    pub visitors: i64,
    pub custom: i64,
}
#[derive(Serialize)]
pub struct Breakdown {
    pub day: String,
    pub dimension: String,
    pub value: String,
    pub count: i64,
}
pub struct Parsed {
    pub days: Vec<Day>,
    pub breakdowns: Vec<Breakdown>,
    pub warnings: Vec<String>,
    pub files: Vec<String>,
    pub metrics: Vec<&'static str>,
}

pub fn collator() -> Result<CollatorBorrowed<'static>, Error> {
    // Bun's production default is en-US. Byte ordering changes fingerprints for
    // case, punctuation and non-ASCII labels; use the same Unicode collation.
    Collator::try_new(icu_locale_core::locale!("en-US").into(), Default::default())
        .map_err(|_| crate::error::ApiError::unavailable().into())
}
fn number(s: &str) -> Result<i64, Error> {
    let s = trim(s);
    if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
        // Leading zeroes do not make an otherwise small number overflow.
        if let Ok(n) = s.trim_start_matches('0').parse::<i64>() {
            if n <= MAX_COUNT {
                return Ok(n);
            }
        } else if s.bytes().all(|b| b == b'0') {
            return Ok(0);
        }
    }
    Err(Error::invalid(
        "Imported counts must be whole numbers between 0 and 1 trillion.",
    ))
}
fn day(s: &str, compact: bool) -> Result<String, Error> {
    let mut s = trim(s).to_owned();
    if compact && s.len() == 8 && s.bytes().all(|b| b.is_ascii_digit()) {
        s = format!("{}-{}-{}", &s[..4], &s[4..6], &s[6..]);
    }
    if s.len() != 10
        || s.bytes().enumerate().any(|(i, b)| {
            if i == 4 || i == 7 {
                b != b'-'
            } else {
                !b.is_ascii_digit()
            }
        })
        || NaiveDate::parse_from_str(&s, "%Y-%m-%d").is_err()
    {
        return Err(Error::invalid(
            "Every imported row must have a complete calendar date.",
        ));
    }
    Ok(s)
}
fn label(dimension: &str, s: &str) -> Result<String, Error> {
    let s = trim(s);
    if s.encode_utf16().count() > 2048 || s.chars().any(|c| matches!(c, '\0'..='\u{1f}' | '\u{7f}'))
    {
        return Err(Error::invalid("Invalid imported label."));
    }
    Ok(match dimension {
        "path" => {
            let path = if s.starts_with("http:") || s.starts_with("https:") {
                url::Url::parse(s)
                    .map_err(|_| Error::invalid("Invalid imported label."))?
                    .path()
                    .to_owned()
            } else {
                s.split(['?', '#']).next().unwrap_or("").to_owned()
            };
            if !path.is_empty() && !path.starts_with('/') {
                return Err(Error::invalid("Imported paths must start with /."));
            }
            path
        }
        "referrer" if !s.is_empty() => {
            let s = if s.contains("://") {
                s.to_owned()
            } else {
                format!("https://{s}")
            };
            let url = url::Url::parse(&s).map_err(|_| Error::invalid("Invalid referrer URL."))?;
            if !matches!(url.scheme(), "http" | "https") {
                return Err(Error::invalid("Invalid referrer URL."));
            }
            url.host_str()
                .ok_or_else(|| Error::invalid("Invalid referrer URL."))?
                .to_owned()
        }
        "country" => {
            if !s.is_empty() && (s.len() != 2 || !s.bytes().all(|b| b.is_ascii_alphabetic())) {
                return Err(Error::invalid("Countries must be two-letter codes."));
            }
            s.to_ascii_uppercase()
        }
        "device" => {
            if s.to_lowercase() == "laptop" {
                "desktop".into()
            } else {
                s.to_lowercase()
            }
        }
        _ => s.to_owned(),
    })
}

static REPORT: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)(?:^|/)imported_(visitors|pages|sources|devices|locations|custom_events)(?:_([0-9]{8})_([0-9]{8}))?\.csv$").expect("static report pattern")
});
static DASHBOARD: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)(?:^|/)(visitors|pages|sources|devices|locations)(?:_|\.)")
        .expect("static dashboard pattern")
});

pub fn parse(provider: &str, filename: String, bytes: Vec<u8>) -> Result<Parsed, Error> {
    if !matches!(provider, "plausible" | "ga4") {
        return Err(Error::invalid("Choose Plausible or Google Analytics 4."));
    }
    if bytes.is_empty() || bytes.len() > MAX_UPLOAD {
        return Err(Error::invalid("Upload a file no larger than 10 MB."));
    }
    let files = if filename.to_ascii_lowercase().ends_with(".zip") {
        if provider != "plausible" {
            return Err(Error::invalid("Upload a GA4 CSV file."));
        }
        zip::unzip(&bytes)?
    } else {
        vec![(filename, bytes)]
    };
    let mut days = BTreeMap::<String, Day>::new();
    let mut breakdowns = IndexMap::<(String, String, String), Breakdown>::new();
    let mut custom = BTreeMap::<String, i64>::new();
    let mut tables = BTreeSet::new();
    let mut warnings = Vec::new();
    let mut records = 0;
    for (name, bytes) in &files {
        if !name.to_ascii_lowercase().ends_with(".csv") {
            warnings.push(format!("Ignored unsupported file: {name}."));
            continue;
        }
        let text =
            std::str::from_utf8(bytes).map_err(|_| Error::invalid("Invalid UTF-8 CSV file."))?;
        let report = REPORT.captures(name);
        let mut columns: Option<Vec<String>> = None;
        let mut table = String::new();
        let mut dimension = None;
        let (mut di, mut ci, mut vi, mut li) = (0, 0, 0, 0);
        let mut ignored = false;
        csv::visit(text, |row| {
            let Some(header) = columns.as_ref() else {
                let normalized: Vec<_> = row
                    .iter()
                    .map(|s| {
                        if provider == "ga4" {
                            s.to_lowercase()
                                .chars()
                                .filter(|&c| c != '_' && !csv::whitespace(c))
                                .collect::<String>()
                        } else {
                            trim(s).to_owned()
                        }
                    })
                    .collect();
                if normalized.iter().collect::<BTreeSet<_>>().len() != normalized.len()
                    || normalized.iter().any(String::is_empty)
                {
                    return Err(Error::invalid(
                        "CSV column names must be nonempty and unique.",
                    ));
                }
                let header: Vec<_> = normalized
                    .into_iter()
                    .map(|s| {
                        if provider == "ga4" && s == "screenpageviews" {
                            "views".into()
                        } else {
                            s
                        }
                    })
                    .collect();
                if provider == "ga4"
                    && (header.len() != 3
                        || header
                            .iter()
                            .any(|s| !matches!(s.as_str(), "date" | "views" | "totalusers")))
                {
                    return Err(Error::invalid(
                        "The GA4 CSV must contain only Date, Views and Total users.",
                    ));
                }
                if provider == "plausible" && report.is_none() {
                    if DASHBOARD.is_match(name) {
                        return Err(Error::invalid(
                            "Upload imported_visitors.csv or the full Plausible export ZIP from site settings. Dashboard exports are not supported.",
                        ));
                    }
                    warnings.push(format!("Ignored unsupported file: {name}."));
                    ignored = true;
                    columns = Some(header);
                    return Ok(());
                }
                table = if provider == "ga4" {
                    "visitors".into()
                } else {
                    report
                        .as_ref()
                        .map(|r| r[1].to_ascii_lowercase())
                        .unwrap_or_default()
                };
                if !tables.insert(table.clone()) {
                    return Err(Error::invalid("Only one CSV per report is allowed."));
                }
                dimension = match table.as_str() {
                    "pages" => Some(("path", "page")),
                    "sources" => Some(("referrer", "referrer")),
                    "devices" => Some(("device", "device")),
                    "locations" => Some(("country", "country")),
                    "custom_events" => Some(("event", "name")),
                    _ => None,
                };
                let required = |key: &str| {
                    header.iter().position(|s| s == key).ok_or_else(|| {
                        Error::invalid(format!("The CSV is missing its {key} column."))
                    })
                };
                di = required("date")?;
                ci = required(if provider == "ga4" {
                    "views"
                } else if table == "custom_events" {
                    "events"
                } else {
                    "pageviews"
                })?;
                if table == "visitors" {
                    vi = required(if provider == "ga4" {
                        "totalusers"
                    } else {
                        "visitors"
                    })?;
                }
                if let Some((_, label)) = dimension {
                    li = required(label)?;
                }
                columns = Some(header);
                return Ok(());
            };
            records += 1;
            if records > 100_000 {
                return Err(Error::invalid(
                    "An import may contain at most 100,000 CSV records.",
                ));
            }
            if ignored {
                return Ok(());
            }
            if row.len() != header.len() {
                return Err(Error::invalid(
                    "CSV rows must have the same number of columns as the header.",
                ));
            }
            if provider == "ga4"
                && matches!(
                    trim(&row[di]).to_ascii_lowercase().as_str(),
                    "total" | "totals" | "grand total"
                )
            {
                return Ok(());
            }
            let date = day(&row[di], provider == "ga4")?;
            if let Some(report) = &report
                && let (Some(from), Some(to)) = (report.get(2), report.get(3))
                && (date < day(from.as_str(), true)? || date > day(to.as_str(), true)?)
            {
                return Err(Error::invalid(
                    "A CSV date falls outside its filename range.",
                ));
            }
            if provider == "plausible" {
                for key in [
                    "visitors",
                    "visits",
                    "pageviews",
                    "bounces",
                    "visit_duration",
                    "entrances",
                    "exits",
                    "events",
                ] {
                    if let Some(index) = header.iter().position(|s| s == key) {
                        number(&row[index])?;
                    }
                }
            }
            let count = number(&row[ci])?;
            if table == "visitors" {
                if days.contains_key(&date) {
                    return Err(Error::invalid("Each date must occur once in daily totals."));
                }
                days.insert(
                    date.clone(),
                    Day {
                        day: date,
                        pageviews: count,
                        visitors: number(&row[vi])?,
                        custom: 0,
                    },
                );
            } else if let Some((dimension, _)) = dimension {
                let value = label(dimension, &row[li])?;
                let entry = breakdowns
                    .entry((date.clone(), dimension.into(), value.clone()))
                    .or_insert_with(|| Breakdown {
                        day: date.clone(),
                        dimension: dimension.into(),
                        value,
                        count: 0,
                    });
                entry.count += count;
                if entry.count > MAX_COUNT {
                    return Err(Error::invalid(
                        "An imported daily count exceeds 1 trillion.",
                    ));
                }
                if table == "custom_events" {
                    *custom.entry(date).or_default() += count;
                }
            }
            Ok(())
        })?;
        if columns.is_none() {
            return Err(Error::invalid("The CSV is empty."));
        }
    }
    if days.is_empty() || days.len() > 730 {
        return Err(Error::invalid("Import 1–730 daily totals."));
    }
    for row in breakdowns.values() {
        if !days.contains_key(&row.day) {
            return Err(Error::invalid("A breakdown date has no daily total."));
        }
    }
    for row in days.values_mut() {
        row.custom = custom.get(&row.day).copied().unwrap_or(0);
        if row.custom > MAX_COUNT {
            return Err(Error::invalid(
                "An imported daily count exceeds 1 trillion.",
            ));
        }
    }
    let collator = collator()?;
    let mut sorted: Vec<_> = breakdowns
        .into_values()
        .map(|row| {
            (
                serde_json::json!([row.day, row.dimension, row.value]).to_string(),
                row,
            )
        })
        .collect();
    // Stable sorting retains input order for canonically equivalent labels.
    sorted.sort_by(|a, b| collator.compare(&a.0, &b.0));
    let mut metrics = vec!["dailyUniqueVisitors", "pageviews"];
    if tables.contains("custom_events") {
        metrics.insert(0, "customEvents");
    }
    Ok(Parsed {
        days: days.into_values().collect(),
        breakdowns: sorted.into_iter().map(|(_, row)| row).collect(),
        warnings,
        files: files.into_iter().map(|(name, _)| name).collect(),
        metrics,
    })
}

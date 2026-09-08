use analytics_core::{Error, Result};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Cursor, Read},
};

pub const MAX_UPLOAD_BYTES: usize = 10 * 1024 * 1024;
const MAX_EXPANDED_BYTES: usize = 32 * 1024 * 1024;
const MAX_FILES: usize = 20;
const MAX_RECORDS: usize = 100_000;
const MAX_FIELD_BYTES: usize = 4096;
const MAX_VALUE_BYTES: usize = 2048;
const MAX_COUNT: i64 = 1_000_000_000_000;
const DASHBOARD_EXPORT: &str = "Upload imported_visitors.csv or the full Plausible export ZIP from site settings. Dashboard exports are not supported.";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Plausible,
    Ga4,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Plausible => "plausible",
            Self::Ga4 => "ga4",
        }
    }

    pub fn visitor_metric(self) -> &'static str {
        match self {
            Self::Plausible => "plausible_daily_visitors",
            Self::Ga4 => "ga4_daily_total_users",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ImportData {
    pub provider: Provider,
    pub timezone: String,
    pub days: Vec<ImportedDay>,
    pub breakdowns: Vec<ImportedBreakdown>,
    pub warnings: Vec<String>,
    pub files: Vec<String>,
    pub metrics: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ImportedDay {
    pub day: NaiveDate,
    pub pageviews: i64,
    pub visitors: i64,
    pub custom_events: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ImportedBreakdown {
    pub day: NaiveDate,
    pub dimension: String,
    pub value: String,
    pub count: i64,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum Table {
    Visitors,
    Pages,
    Sources,
    Devices,
    Locations,
    CustomEvents,
    Browsers,
    OperatingSystems,
    EntryPages,
    ExitPages,
}

impl Table {
    fn name(self) -> &'static str {
        match self {
            Self::Visitors => "imported_visitors",
            Self::Pages => "imported_pages",
            Self::Sources => "imported_sources",
            Self::Devices => "imported_devices",
            Self::Locations => "imported_locations",
            Self::CustomEvents => "imported_custom_events",
            Self::Browsers => "imported_browsers",
            Self::OperatingSystems => "imported_operating_systems",
            Self::EntryPages => "imported_entry_pages",
            Self::ExitPages => "imported_exit_pages",
        }
    }

    fn imported(self) -> bool {
        !matches!(
            self,
            Self::Browsers | Self::OperatingSystems | Self::EntryPages | Self::ExitPages
        )
    }

    fn dimension(self) -> Option<(&'static str, &'static str)> {
        match self {
            Self::Pages => Some(("path", "page")),
            Self::Sources => Some(("referrer", "referrer")),
            Self::Devices => Some(("device", "device")),
            Self::Locations => Some(("country", "country")),
            Self::CustomEvents => Some(("event", "name")),
            _ => None,
        }
    }
}

type Bounds = Option<(NaiveDate, NaiveDate)>;

struct SourceFile {
    name: String,
    bytes: Vec<u8>,
}

#[derive(Default)]
struct Parsed {
    days: BTreeMap<NaiveDate, ImportedDay>,
    breakdowns: BTreeMap<(NaiveDate, String, String), i64>,
    custom_events: BTreeMap<NaiveDate, i64>,
    warnings: BTreeSet<String>,
    tables: BTreeSet<Table>,
    records: usize,
}

/// Parse historical aggregates without creating visitor identities or native events.
/// All resource limits apply across the entire archive, including ignored files.
pub fn parse(provider: &str, timezone: &str, filename: &str, bytes: &[u8]) -> Result<ImportData> {
    let provider = match provider {
        "plausible" => Provider::Plausible,
        "ga4" => Provider::Ga4,
        _ => return Err(Error::invalid("Choose Plausible or Google Analytics 4.")),
    };
    let timezone = timezone
        .parse::<chrono_tz::Tz>()
        .map_err(|_| Error::invalid("Choose a valid IANA reporting timezone."))?
        .to_string();
    if bytes.is_empty() {
        return Err(Error::invalid("The import file is empty."));
    }
    if bytes.len() > MAX_UPLOAD_BYTES {
        return Err(too_large("Import uploads must be 10 MiB or smaller."));
    }
    safe_name(filename, false)?;
    let extension = filename.rsplit('.').next().unwrap_or_default();
    let files = if extension.eq_ignore_ascii_case("zip") {
        if provider != Provider::Plausible {
            return Err(Error::invalid("Upload a daily GA4 CSV, not a ZIP archive."));
        }
        read_zip(bytes)?
    } else if extension.eq_ignore_ascii_case("csv") {
        vec![SourceFile {
            name: filename.to_owned(),
            bytes: bytes.to_vec(),
        }]
    } else {
        return Err(Error::invalid(
            "Upload a CSV file or a Plausible export ZIP.",
        ));
    };

    let mut parsed = Parsed::default();
    if provider == Provider::Plausible
        && files.len() == 1
        && extension.eq_ignore_ascii_case("csv")
        && classify(&files[0].name)?.map(|(table, _)| table) != Some(Table::Visitors)
    {
        return Err(Error::invalid(DASHBOARD_EXPORT));
    }
    for file in &files {
        match provider {
            Provider::Plausible => parse_plausible_file(file, &mut parsed)?,
            Provider::Ga4 => parse_ga4(file, &mut parsed)?,
        }
    }
    if parsed.days.is_empty() {
        return Err(Error::invalid(match provider {
            Provider::Plausible => {
                "The export must contain one nonempty imported_visitors CSV. Use the full export from Plausible site settings."
            }
            Provider::Ga4 => "The GA4 CSV must contain daily Date, Views and Total users rows.",
        }));
    }

    // Dimension rows never contribute to the daily pageview or visitor totals.
    // Their dates must be represented in the authoritative daily file.
    for (day, _, _) in parsed.breakdowns.keys() {
        if !parsed.days.contains_key(day) {
            return Err(Error::invalid(
                "A breakdown date is missing from imported_visitors. Upload files from the same complete export.",
            ));
        }
    }
    for (day, count) in &parsed.custom_events {
        let daily = parsed.days.get_mut(day).ok_or_else(|| {
            Error::invalid("A custom-event date is missing from imported_visitors.")
        })?;
        daily.custom_events = *count;
    }
    let mut metrics = vec!["pageviews".into(), "dailyUniqueVisitors".into()];
    if parsed.tables.contains(&Table::CustomEvents) {
        metrics.push("customEvents".into());
    }
    parsed.warnings.insert(
        "Daily visitor counts are added across days; they are not unique people across the full period."
            .into(),
    );
    if provider == Provider::Ga4 {
        parsed.warnings.insert(
            "GA4 Views can include app screens. Import a web-only property or a report filtered to your website's web stream."
                .into(),
        );
    }
    Ok(ImportData {
        provider,
        timezone,
        days: parsed.days.into_values().collect(),
        breakdowns: parsed
            .breakdowns
            .into_iter()
            .map(|((day, dimension, value), count)| ImportedBreakdown {
                day,
                dimension,
                value,
                count,
            })
            .collect(),
        warnings: parsed.warnings.into_iter().collect(),
        files: files.into_iter().map(|file| file.name).collect(),
        metrics,
    })
}

fn too_large(message: &str) -> Error {
    Error::new(413, "import_too_large", message)
}

fn safe_name(name: &str, nested: bool) -> Result<()> {
    if name.is_empty()
        || name.len() > 255
        || name.starts_with('/')
        || name.contains(['\\', ':'])
        || name.chars().any(char::is_control)
        || (!nested && name.contains('/'))
        || name.split('/').any(|part| part == "." || part == "..")
    {
        return Err(Error::invalid("The archive contains an unsafe filename."));
    }
    Ok(())
}

fn dashboard_export_file(name: &str) -> bool {
    let basename = name.rsplit('/').next().unwrap_or(name);
    let Some((stem, extension)) = basename.rsplit_once('.') else {
        return false;
    };
    if !extension.eq_ignore_ascii_case("csv") {
        return false;
    }
    matches!(
        stem.to_ascii_lowercase().as_str(),
        "visitors"
            | "sources"
            | "channels"
            | "utm_mediums"
            | "utm_sources"
            | "utm_campaigns"
            | "utm_contents"
            | "utm_terms"
            | "pages"
            | "entry_pages"
            | "exit_pages"
            | "countries"
            | "regions"
            | "cities"
            | "browsers"
            | "browser_versions"
            | "operating_systems"
            | "operating_system_versions"
            | "devices"
            | "conversions"
            | "referrers"
            | "custom_props"
    )
}

fn read_zip(bytes: &[u8]) -> Result<Vec<SourceFile>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| Error::invalid("The ZIP archive is invalid or unsupported."))?;
    // Allow benign directory entries without permitting an unbounded directory list.
    if archive.len() > MAX_FILES * 2 {
        for index in 0..MAX_FILES * 2 {
            let raw = archive
                .by_index_raw(index)
                .map_err(|_| Error::invalid("The ZIP archive contains an invalid entry."))?;
            if let Ok(name) = std::str::from_utf8(raw.name_raw())
                && dashboard_export_file(name)
            {
                return Err(Error::invalid(DASHBOARD_EXPORT));
            }
        }
        return Err(too_large("The ZIP archive contains too many entries."));
    }
    let mut files = Vec::new();
    let mut names = BTreeSet::new();
    let mut expanded = 0usize;
    for index in 0..archive.len() {
        let raw = archive
            .by_index_raw(index)
            .map_err(|_| Error::invalid("The ZIP archive contains an invalid entry."))?;
        if raw.encrypted() {
            return Err(Error::invalid("Encrypted ZIP entries are not supported."));
        }
        let name = std::str::from_utf8(raw.name_raw())
            .map_err(|_| Error::invalid("ZIP filenames must use UTF-8."))?
            .to_owned();
        safe_name(&name, true)?;
        if raw.enclosed_name().is_none() {
            return Err(Error::invalid("The archive contains an unsafe filename."));
        }
        let kind = raw.unix_mode().unwrap_or(0) & 0o170000;
        if !([0, 0o100000].contains(&kind) || kind == 0o040000 && raw.is_dir()) {
            return Err(Error::invalid(
                "ZIP links and special files are not supported.",
            ));
        }
        if !names.insert(name.clone()) {
            return Err(Error::invalid("The ZIP contains duplicate filenames."));
        }
        if raw.is_dir() {
            if raw.size() != 0 {
                return Err(Error::invalid("ZIP directory entries must be empty."));
            }
            continue;
        }
        if dashboard_export_file(&name) {
            return Err(Error::invalid(DASHBOARD_EXPORT));
        }
        if files.len() >= MAX_FILES {
            return Err(too_large("Import archives may contain at most 20 files."));
        }
        let remaining = MAX_EXPANDED_BYTES - expanded;
        if raw.size() > remaining as u64 {
            return Err(too_large("The expanded import exceeds 32 MiB."));
        }
        drop(raw);
        let file = archive.by_index(index).map_err(|_| {
            Error::invalid("A ZIP entry uses unsupported encryption or compression.")
        })?;
        let mut contents = Vec::new();
        file.take((remaining + 1) as u64)
            .read_to_end(&mut contents)
            .map_err(|_| Error::invalid("A ZIP entry is damaged or failed its checksum."))?;
        if contents.len() > remaining {
            return Err(too_large("The expanded import exceeds 32 MiB."));
        }
        expanded += contents.len();
        files.push(SourceFile {
            name,
            bytes: contents,
        });
    }
    Ok(files)
}

fn classify(name: &str) -> Result<Option<(Table, Bounds)>> {
    let basename = name.rsplit('/').next().unwrap_or(name);
    let Some((stem, extension)) = basename.rsplit_once('.') else {
        return Ok(None);
    };
    if !extension.eq_ignore_ascii_case("csv") {
        return Ok(None);
    }
    for table in [
        Table::Visitors,
        Table::Pages,
        Table::Sources,
        Table::Devices,
        Table::Locations,
        Table::CustomEvents,
        Table::Browsers,
        Table::OperatingSystems,
        Table::EntryPages,
        Table::ExitPages,
    ] {
        if stem == table.name() {
            return Ok(Some((table, None)));
        }
        if let Some(suffix) = stem.strip_prefix(&format!("{}_", table.name())) {
            if suffix.len() != 17 || suffix.as_bytes()[8] != b'_' {
                return Err(Error::invalid(
                    "A Plausible CSV filename has an invalid date range.",
                ));
            }
            let from = parse_day(&suffix[..8], true)?;
            let to = parse_day(&suffix[9..], true)?;
            if from > to {
                return Err(Error::invalid(
                    "A Plausible CSV filename has a reversed date range.",
                ));
            }
            return Ok(Some((table, Some((from, to)))));
        }
    }
    Ok(None)
}

fn parse_plausible_file(file: &SourceFile, parsed: &mut Parsed) -> Result<()> {
    let kind = classify(&file.name)?;
    // Even ignored CSV tables are decoded and bounded. Other benign archive files
    // have already been counted against the expanded-byte and file limits.
    let is_csv = file
        .name
        .rsplit('.')
        .next()
        .is_some_and(|s| s.eq_ignore_ascii_case("csv"));
    let records = if is_csv {
        csv_records(file, parsed)?
    } else {
        Vec::new()
    };
    let Some((table, bounds)) = kind else {
        parsed
            .warnings
            .insert(format!("Ignored unsupported file: {}.", file.name));
        return Ok(());
    };
    if !table.imported() {
        parsed.warnings.insert(format!(
            "{} was not imported; this report is not supported yet.",
            table.name()
        ));
        return Ok(());
    }
    if !parsed.tables.insert(table) {
        return Err(Error::invalid(format!(
            "Only one {} CSV is allowed in each import.",
            table.name()
        )));
    }
    let header = records
        .first()
        .ok_or_else(|| Error::invalid("A required Plausible CSV is empty."))?;
    let columns = plausible_columns(header)?;
    let day_index = required(&columns, "date")?;
    let count_name = if table == Table::CustomEvents {
        "events"
    } else {
        "pageviews"
    };
    let count_index = required(&columns, count_name)?;
    let visitors_index = if table == Table::Visitors {
        Some(required(&columns, "visitors")?)
    } else {
        None
    };
    let dimension = table
        .dimension()
        .map(|(dimension, column)| required(&columns, column).map(|index| (dimension, index)))
        .transpose()?;
    for row in records.iter().skip(1) {
        check_width(row, header.len())?;
        let day = parse_day(&row[day_index], false)?;
        if bounds.is_some_and(|(from, to)| day < from || day > to) {
            return Err(Error::invalid(
                "A CSV date falls outside its filename's date range.",
            ));
        }
        // Validate documented numeric columns even when a metric is not imported.
        for name in [
            "visitors",
            "visits",
            "pageviews",
            "bounces",
            "visit_duration",
            "entrances",
            "exits",
            "events",
        ] {
            if let Some(index) = columns.get(name) {
                count(&row[*index])?;
            }
        }
        let value = count(&row[count_index])?;
        if let Some(visitors_index) = visitors_index {
            if parsed
                .days
                .insert(
                    day,
                    ImportedDay {
                        day,
                        pageviews: value,
                        visitors: count(&row[visitors_index])?,
                        custom_events: 0,
                    },
                )
                .is_some()
            {
                return Err(Error::invalid(
                    "Daily dates must occur exactly once in imported_visitors.",
                ));
            }
        } else if let Some((dimension, index)) = dimension {
            let label = normalize_dimension(dimension, &row[index], &mut parsed.warnings)?;
            let total = parsed
                .breakdowns
                .entry((day, dimension.into(), label))
                .or_default();
            *total = add_count(*total, value)?;
            if table == Table::CustomEvents {
                let events = parsed.custom_events.entry(day).or_default();
                *events = add_count(*events, value)?;
            }
        }
    }
    Ok(())
}

fn plausible_columns(header: &csv::StringRecord) -> Result<BTreeMap<String, usize>> {
    let mut columns = BTreeMap::new();
    for (index, name) in header.iter().enumerate() {
        let name = name.trim();
        if name.is_empty() || columns.insert(name.to_owned(), index).is_some() {
            return Err(Error::invalid(
                "CSV column names must be nonempty and unique.",
            ));
        }
    }
    Ok(columns)
}

fn required(columns: &BTreeMap<String, usize>, name: &str) -> Result<usize> {
    columns
        .get(name)
        .copied()
        .ok_or_else(|| Error::invalid(format!("The CSV is missing its {name} column.")))
}

fn parse_ga4(file: &SourceFile, parsed: &mut Parsed) -> Result<()> {
    let records = csv_records(file, parsed)?;
    let header = records
        .first()
        .ok_or_else(|| Error::invalid("The GA4 CSV is empty."))?;
    let mut columns = BTreeMap::new();
    for (index, name) in header.iter().enumerate() {
        let normalized: String = name
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '_')
            .flat_map(char::to_lowercase)
            .collect();
        let name = match normalized.as_str() {
            "date" => "date",
            "views" | "screenpageviews" => "views",
            "totalusers" => "total_users",
            "activeusers" | "users" => {
                return Err(Error::invalid(
                    "Export Total users, not Users or Active users, from GA4.",
                ));
            }
            _ => {
                return Err(Error::invalid(
                    "The GA4 CSV must contain only Date, Views and Total users. Remove other dimensions, segments and metrics.",
                ));
            }
        };
        if columns.insert(name.to_owned(), index).is_some() {
            return Err(Error::invalid("GA4 column names must be unique."));
        }
    }
    let date_index = required(&columns, "date")?;
    let views_index = required(&columns, "views")?;
    let users_index = required(&columns, "total_users")?;
    for row in records.iter().skip(1) {
        check_width(row, header.len())?;
        let date = row[date_index].trim();
        if ["total", "totals", "grand total"]
            .iter()
            .any(|label| date.eq_ignore_ascii_case(label))
        {
            continue;
        }
        let day = parse_day(date, true)?;
        if parsed
            .days
            .insert(
                day,
                ImportedDay {
                    day,
                    pageviews: count(&row[views_index])?,
                    visitors: count(&row[users_index])?,
                    custom_events: 0,
                },
            )
            .is_some()
        {
            return Err(Error::invalid(
                "Each GA4 date must occur once. Export Date as the only dimension without comparisons or segments.",
            ));
        }
    }
    Ok(())
}

fn normalize_dimension(
    dimension: &str,
    raw: &str,
    warnings: &mut BTreeSet<String>,
) -> Result<String> {
    let value = raw.trim();
    let normalized = match dimension {
        "path" => {
            let path = if value.starts_with("http://") || value.starts_with("https://") {
                url::Url::parse(value)
                    .map_err(|_| Error::invalid("An imported page URL is invalid."))?
                    .path()
                    .to_owned()
            } else {
                value
                    .split(['?', '#'])
                    .next()
                    .unwrap_or_default()
                    .to_owned()
            };
            if !path.is_empty() && (!path.starts_with('/') || path.chars().any(char::is_control)) {
                return Err(Error::invalid(
                    "Imported page paths must start with / and contain no control characters.",
                ));
            }
            if path != value {
                warnings.insert("Imported page URLs were reduced to paths; query strings and fragments were removed.".into());
            }
            path
        }
        "referrer" => {
            if value.is_empty() {
                String::new()
            } else {
                let candidate = if value.contains("://") {
                    value.to_owned()
                } else {
                    format!("https://{value}")
                };
                let url = url::Url::parse(&candidate).map_err(|_| {
                    Error::invalid("An imported referrer is not a valid hostname or URL.")
                })?;
                if !["http", "https"].contains(&url.scheme()) {
                    return Err(Error::invalid(
                        "Imported referrer URLs must use HTTP or HTTPS.",
                    ));
                }
                let hostname = url
                    .host_str()
                    .ok_or_else(|| Error::invalid("An imported referrer has no hostname."))?
                    .to_owned();
                if hostname != value {
                    warnings.insert("Imported referrers were reduced to hostnames; URL paths, query strings and fragments were removed.".into());
                }
                hostname
            }
        }
        "country" => {
            if !value.is_empty()
                && (value.len() != 2 || !value.bytes().all(|b| b.is_ascii_alphabetic()))
            {
                return Err(Error::invalid(
                    "Imported countries must be two-letter codes or empty.",
                ));
            }
            value.to_ascii_uppercase()
        }
        "device" => match value.to_ascii_lowercase().as_str() {
            "laptop" => "desktop".into(),
            other => other.into(),
        },
        _ => value.to_owned(),
    };
    if normalized.len() > MAX_VALUE_BYTES {
        return Err(Error::invalid(
            "An imported report label exceeds 2048 bytes.",
        ));
    }
    Ok(normalized)
}

fn count(value: &str) -> Result<i64> {
    let value = value.trim();
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Error::invalid(
            "Imported counts must be nonnegative whole numbers without separators.",
        ));
    }
    let value = value
        .parse::<i64>()
        .map_err(|_| Error::invalid("An imported count is too large."))?;
    if value > MAX_COUNT {
        return Err(Error::invalid(
            "An imported count exceeds 1 trillion per day.",
        ));
    }
    Ok(value)
}

fn add_count(left: i64, right: i64) -> Result<i64> {
    left.checked_add(right)
        .filter(|value| *value <= MAX_COUNT)
        .ok_or_else(|| Error::invalid("An imported daily count exceeds 1 trillion."))
}

fn parse_day(value: &str, compact_allowed: bool) -> Result<NaiveDate> {
    let value = value.trim();
    let format = if compact_allowed && value.len() == 8 && value.bytes().all(|b| b.is_ascii_digit())
    {
        "%Y%m%d"
    } else if value.len() == 10
        && value.as_bytes()[4] == b'-'
        && value.as_bytes()[7] == b'-'
        && value
            .bytes()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
    {
        "%Y-%m-%d"
    } else {
        return Err(Error::invalid(
            "Every imported row must have a complete calendar date.",
        ));
    };
    NaiveDate::parse_from_str(value, format)
        .map_err(|_| Error::invalid("The CSV contains an invalid calendar date."))
}

fn check_width(row: &csv::StringRecord, columns: usize) -> Result<()> {
    if row.len() != columns {
        return Err(Error::invalid(
            "CSV rows must have the same number of columns as the header.",
        ));
    }
    Ok(())
}

fn csv_records(file: &SourceFile, parsed: &mut Parsed) -> Result<Vec<csv::StringRecord>> {
    let text = std::str::from_utf8(&file.bytes)
        .map_err(|_| Error::invalid("CSV files must use UTF-8 encoding."))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    validate_quotes(text)?;
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .comment(Some(b'#'))
        .from_reader(text.as_bytes());
    let mut records = Vec::new();
    for row in reader.records() {
        let row = row.map_err(|_| Error::invalid("The CSV contains a malformed record."))?;
        if row.iter().all(|field| field.trim().is_empty()) {
            continue;
        }
        // Headers are not data records. There is one header per file at most.
        if !records.is_empty() {
            parsed.records += 1;
            if parsed.records > MAX_RECORDS {
                return Err(too_large(
                    "An import may contain at most 100,000 CSV records.",
                ));
            }
        }
        if row.len() > 64
            || row
                .iter()
                .any(|field| field.len() > MAX_FIELD_BYTES || field.contains('\0'))
        {
            return Err(Error::invalid(
                "A CSV record has too many columns or an oversized field.",
            ));
        }
        records.push(row);
    }
    Ok(records)
}

/// The CSV crate tolerates malformed quoting. Validate the RFC-style quote
/// boundaries first, while allowing quoted commas/newlines and metadata comments.
fn validate_quotes(text: &str) -> Result<()> {
    #[derive(Clone, Copy)]
    enum Quote {
        Start,
        Bare,
        Quoted,
        Closed,
    }
    let mut state = Quote::Start;
    let mut record_start = true;
    let mut comment = false;
    for byte in text.bytes() {
        if comment {
            if byte == b'\n' || byte == b'\r' {
                comment = false;
            }
            continue;
        }
        state = match (state, byte) {
            (Quote::Start, b'#') if record_start => {
                comment = true;
                Quote::Start
            }
            (Quote::Start, b'"') => {
                record_start = false;
                Quote::Quoted
            }
            (Quote::Start, b',') => {
                record_start = false;
                Quote::Start
            }
            (Quote::Start | Quote::Bare | Quote::Closed, b'\n' | b'\r') => {
                record_start = true;
                Quote::Start
            }
            (Quote::Start, _) => {
                record_start = false;
                Quote::Bare
            }
            (Quote::Bare | Quote::Closed, b',') => Quote::Start,
            (Quote::Quoted, b'"') => Quote::Closed,
            (Quote::Closed, b'"') => Quote::Quoted,
            (Quote::Bare, b'"') | (Quote::Closed, _) => {
                return Err(Error::invalid("The CSV contains malformed quoting."));
            }
            (other, _) => other,
        };
    }
    if matches!(state, Quote::Quoted) {
        return Err(Error::invalid("The CSV ends inside a quoted field."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

    const DAILY: &str = "date,visitors,pageviews,bounces,visits,visit_duration\n2026-08-01,17,30,5,20,1200\n2026-08-02,12,25,3,14,800\n";

    fn archive(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, data) in files {
            zip.start_file(
                *name,
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
            )
            .unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    fn plausible_csv(text: &str) -> Result<ImportData> {
        parse(
            "plausible",
            "Europe/Copenhagen",
            "imported_visitors.csv",
            text.as_bytes(),
        )
    }

    #[test]
    fn plausible_daily_preserves_zeroes_and_metadata() {
        let data = plausible_csv(
            "\u{feff}pageviews,date,visitors\r\n0,2026-08-01,5\r\n30,2026-08-02,17\r\n",
        )
        .unwrap();
        assert_eq!(data.days.len(), 2);
        assert_eq!(data.days[0].pageviews, 0);
        assert_eq!(data.days[0].visitors, 5);
        assert_eq!(data.timezone, "Europe/Copenhagen");
        assert_eq!(data.provider.visitor_metric(), "plausible_daily_visitors");
        assert_eq!(data.metrics, ["pageviews", "dailyUniqueVisitors"]);
        assert!(data.breakdowns.is_empty());
    }

    #[test]
    fn zip_groups_real_pageviews_without_summing_dimension_visitors() {
        let bytes = archive(&[
            ("imported_pages_20260801_20260802.csv", b"date,hostname,page,visits,visitors,pageviews\n2026-08-01,example.com,/docs?email=private#part,2,100,3\n2026-08-01,example.com,/docs?other=private,3,100,7\n"),
            ("imported_sources.csv", b"date,source,referrer,utm_campaign,pageviews,visitors\n2026-08-01,\"News, weekly\",https://example.org/path?token=private,\"two\nlines\",4,100\n2026-08-01,News,example.org/second,other,6,100\n"),
            ("imported_devices.csv", b"date,device,pageviews\n2026-08-01,Laptop,2\n2026-08-01,Desktop,3\n"),
            ("imported_locations.csv", b"date,country,region,city,pageviews\n2026-08-01,dk,DK-81,123,4\n2026-08-01,DK,DK-82,456,2\n2026-08-02,,,0,0\n"),
            ("imported_custom_events.csv", b"date,name,link_url,path,visitors,events\n2026-08-01,Download,https://example.com/private?key=secret,,2,3\n2026-08-01,Download,https://example.com/other,,2,4\n"),
            ("imported_browsers.csv", b"date,browser,pageviews\n2026-08-01,Chrome,30\n"),
            ("README.txt", b"A harmless export note."),
            ("imported_visitors_20260801_20260802.csv", DAILY.as_bytes()),
        ]);
        let data = parse("plausible", "UTC", "export.zip", &bytes).unwrap();
        assert_eq!(data.days[0].pageviews, 30);
        assert_eq!(data.days[0].visitors, 17);
        assert_eq!(data.days[0].custom_events, 7);
        assert_eq!(data.days[1].custom_events, 0);
        let value = |dimension: &str, label: &str| {
            data.breakdowns
                .iter()
                .find(|row| row.dimension == dimension && row.value == label)
                .unwrap()
                .count
        };
        assert_eq!(value("path", "/docs"), 10);
        assert_eq!(value("referrer", "example.org"), 10);
        assert_eq!(value("device", "desktop"), 5);
        assert_eq!(value("country", "DK"), 6);
        assert_eq!(value("event", "Download"), 7);
        assert_eq!(data.files.len(), 8);
        assert!(
            data.warnings
                .iter()
                .any(|s| s.contains("imported_browsers"))
        );
        assert!(data.warnings.iter().any(|s| s.contains("README.txt")));
        assert!(data.warnings.iter().any(|s| s.contains("query strings")));
        assert!(!serde_json::to_string(&data).unwrap().contains("private"));
    }

    #[test]
    fn rejects_dashboard_exports_and_multiple_daily_files() {
        assert_eq!(
            parse("plausible", "UTC", "visitors.csv", DAILY.as_bytes())
                .unwrap_err()
                .message,
            DASHBOARD_EXPORT
        );
        let dashboard = archive(&[("visitors.csv", DAILY.as_bytes())]);
        assert_eq!(
            parse("plausible", "UTC", "export.zip", &dashboard)
                .unwrap_err()
                .message,
            DASHBOARD_EXPORT
        );
        let nested = archive(&[("export/countries.csv", b"name,visitors\nDenmark,1\n")]);
        assert_eq!(
            parse("plausible", "UTC", "export.zip", &nested)
                .unwrap_err()
                .message,
            DASHBOARD_EXPORT
        );
        let stems = [
            "visitors",
            "sources",
            "channels",
            "utm_mediums",
            "utm_sources",
            "utm_campaigns",
            "utm_contents",
            "utm_terms",
            "pages",
            "entry_pages",
            "exit_pages",
            "countries",
            "regions",
            "cities",
            "browsers",
            "browser_versions",
            "operating_systems",
            "operating_system_versions",
            "devices",
            "conversions",
            "referrers",
            "custom_props",
        ];
        let names: Vec<_> = stems.iter().map(|stem| format!("{stem}.csv")).collect();
        let entries: Vec<_> = names
            .iter()
            .map(|name| (name.as_str(), b"name,visitors\nDirect,1\n".as_slice()))
            .collect();
        assert_eq!(
            parse("plausible", "UTC", "export.zip", &archive(&entries))
                .unwrap_err()
                .message,
            DASHBOARD_EXPORT
        );
        let oversized: Vec<_> = (0..=MAX_FILES * 2)
            .map(|i| format!("part-{i}/visitors.csv"))
            .collect();
        let oversized_entries: Vec<_> = oversized
            .iter()
            .map(|name| (name.as_str(), b"name,visitors\nDirect,1\n".as_slice()))
            .collect();
        assert_eq!(
            parse(
                "plausible",
                "UTC",
                "export.zip",
                &archive(&oversized_entries)
            )
            .unwrap_err()
            .message,
            DASHBOARD_EXPORT
        );
        let duplicate = archive(&[
            ("imported_visitors.csv", DAILY.as_bytes()),
            ("imported_visitors_20260801_20260802.csv", DAILY.as_bytes()),
        ]);
        assert!(parse("plausible", "UTC", "export.zip", &duplicate).is_err());
    }

    #[test]
    fn rejects_bad_numbers_dates_width_and_quotes() {
        for row in [
            "2026-08-01,-1,30",
            "2026-08-01,1.2,30",
            "2026-08-01,1e3,30",
            "2026-08-01,1000000000001,30",
            "2026-08-01,999999999999999999999999,30",
            "2026-02-30,1,30",
            "2026-08-01,1",
            "2026-08-01,1,30,extra",
            "2026-08-01,\"1,30",
            "2026-08-01,1,3\"0",
            "2026-08-01,1,\"30\"garbage",
        ] {
            assert!(
                plausible_csv(&format!("date,visitors,pageviews\n{row}\n")).is_err(),
                "{row}"
            );
        }
        assert!(
            plausible_csv("date,visitors,pageviews\n2026-08-01,1,2\n2026-08-01,1,2\n").is_err()
        );
        assert!(plausible_csv("date,visitors,visitors,pageviews\n2026-08-01,1,1,2\n").is_err());
    }

    #[test]
    fn rejects_mismatched_optional_dates_and_filename_bounds() {
        let bytes = archive(&[
            ("imported_visitors.csv", DAILY.as_bytes()),
            (
                "imported_pages.csv",
                b"date,page,pageviews\n2026-08-03,/,1\n",
            ),
        ]);
        assert!(parse("plausible", "UTC", "export.zip", &bytes).is_err());
        assert!(
            parse(
                "plausible",
                "UTC",
                "imported_visitors_20260802_20260803.csv",
                DAILY.as_bytes()
            )
            .is_err()
        );
        assert!(
            parse(
                "plausible",
                "UTC",
                "imported_visitors_20260803_20260801.csv",
                DAILY.as_bytes()
            )
            .is_err()
        );
    }

    #[test]
    fn bounds_aggregated_counts_after_normalization() {
        let bytes = archive(&[("imported_visitors.csv", DAILY.as_bytes()), ("imported_pages.csv", b"date,page,pageviews\n2026-08-01,/?a=1,600000000000\n2026-08-01,/?a=2,600000000000\n")]);
        assert!(parse("plausible", "UTC", "export.zip", &bytes).is_err());
        let bytes = archive(&[("imported_visitors.csv", DAILY.as_bytes()), ("imported_custom_events.csv", b"date,name,events\n2026-08-01,first,600000000000\n2026-08-01,second,600000000000\n")]);
        assert!(parse("plausible", "UTC", "export.zip", &bytes).is_err());
    }

    #[test]
    fn ga4_named_columns_comments_totals_and_zeroes() {
        let text = "\u{feff}# Analytics export \"metadata\n# a second comment\r\n\r\nTotal users,Date,Views\r\n17,20260801,30\r\n5,2026-08-02,0\r\n22,Totals,30\r\n";
        let data = parse("ga4", "UTC", "ga4.csv", text.as_bytes()).unwrap();
        assert_eq!(data.days.len(), 2);
        assert_eq!(data.days[0].visitors, 17);
        assert_eq!(data.days[1].visitors, 5);
        assert_eq!(data.days[1].pageviews, 0);
        assert_eq!(data.provider.visitor_metric(), "ga4_daily_total_users");
        assert!(data.breakdowns.is_empty());
    }

    #[test]
    fn ga4_accepts_documented_api_names() {
        let data = parse(
            "ga4",
            "UTC",
            "ga4.csv",
            b"date,screenPageViews,totalUsers\n20260801,30,17\n",
        )
        .unwrap();
        assert_eq!(data.days[0].pageviews, 30);
    }

    #[test]
    fn ga4_rejects_ambiguous_users_segmentation_and_multiple_tables() {
        for text in [
            "Date,Views,Active users\n20260801,30,17\n",
            "Date,Views,Users\n20260801,30,17\n",
            "Date,Views,Total users,Country\n20260801,30,17,Denmark\n",
            "Date,Views,Total users\n20260801,30,17\n20260801,20,12\n",
            "Date,Views,Total users\n20260801,30,17\nDate,Views,Total users\n20260802,20,12\n",
            "Date,Views\n20260801,30\n",
            "Date,Views,Total users\n,30,17\n",
        ] {
            assert!(
                parse("ga4", "UTC", "ga4.csv", text.as_bytes()).is_err(),
                "{text}"
            );
        }
    }

    #[test]
    fn rejects_encoding_timezone_and_oversized_fields() {
        assert!(parse("ga4", "UTC", "ga4.csv", &[0xff, 0xfe, 0]).is_err());
        assert!(
            parse(
                "plausible",
                "Europe/Unknown",
                "imported_visitors.csv",
                DAILY.as_bytes()
            )
            .is_err()
        );
        assert!(
            plausible_csv(&format!(
                "date,visitors,pageviews,extra\n2026-08-01,1,2,{}\n",
                "a".repeat(MAX_FIELD_BYTES + 1)
            ))
            .is_err()
        );
    }

    #[test]
    fn rejects_unsafe_zip_paths_and_encryption() {
        let bytes = archive(&[("../imported_visitors.csv", DAILY.as_bytes())]);
        assert!(parse("plausible", "UTC", "export.zip", &bytes).is_err());
        let bytes = archive(&[("folder\\imported_visitors.csv", DAILY.as_bytes())]);
        assert!(parse("plausible", "UTC", "export.zip", &bytes).is_err());
        let mut bytes = archive(&[("imported_visitors.csv", DAILY.as_bytes())]);
        bytes[6] |= 1;
        let central = bytes.windows(4).position(|w| w == b"PK\x01\x02").unwrap();
        bytes[central + 8] |= 1;
        assert!(
            parse("plausible", "UTC", "export.zip", &bytes)
                .unwrap_err()
                .message
                .contains("Encrypted")
        );
    }

    #[test]
    fn rejects_zip_symlinks_and_accepts_benign_directories() {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        zip.add_symlink(
            "imported_visitors.csv",
            "elsewhere",
            SimpleFileOptions::default(),
        )
        .unwrap();
        assert!(
            parse(
                "plausible",
                "UTC",
                "export.zip",
                &zip.finish().unwrap().into_inner()
            )
            .is_err()
        );
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        zip.add_directory("export/", SimpleFileOptions::default())
            .unwrap();
        zip.start_file("export/imported_visitors.csv", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(DAILY.as_bytes()).unwrap();
        assert_eq!(
            parse(
                "plausible",
                "UTC",
                "export.zip",
                &zip.finish().unwrap().into_inner()
            )
            .unwrap()
            .days
            .len(),
            2
        );
    }

    #[test]
    fn enforces_upload_file_and_expansion_limits() {
        assert!(parse("ga4", "UTC", "ga4.csv", &vec![b'a'; MAX_UPLOAD_BYTES + 1]).is_err());
        let names: Vec<_> = (0..=MAX_FILES).map(|i| format!("notes-{i}.txt")).collect();
        let entries: Vec<_> = names
            .iter()
            .map(|name| (name.as_str(), b"note".as_slice()))
            .collect();
        let bytes = archive(&entries);
        assert!(parse("plausible", "UTC", "export.zip", &bytes).is_err());
        let expanded = vec![b'x'; MAX_EXPANDED_BYTES + 1];
        let bytes = archive(&[("README.txt", &expanded)]);
        assert!(bytes.len() < MAX_UPLOAD_BYTES);
        assert!(
            parse("plausible", "UTC", "export.zip", &bytes)
                .unwrap_err()
                .message
                .contains("32 MiB")
        );
    }

    #[test]
    fn records_are_bounded_even_in_ignored_csv_tables() {
        let ignored = format!("browser\n{}", "Chrome\n".repeat(MAX_RECORDS));
        let bytes = archive(&[
            ("imported_visitors.csv", DAILY.as_bytes()),
            ("imported_browsers.csv", ignored.as_bytes()),
        ]);
        assert!(
            parse("plausible", "UTC", "export.zip", &bytes)
                .unwrap_err()
                .message
                .contains("100,000")
        );
    }
}

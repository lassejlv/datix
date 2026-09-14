use super::error::Error;

pub fn whitespace(c: char) -> bool {
    matches!(c, '\t'..='\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
pub fn trim(s: &str) -> &str {
    s.trim_matches(whitespace)
}

#[derive(PartialEq)]
enum State {
    Start,
    Bare,
    Quoted,
    Closed,
}

/// Visit one row at a time; limits use UTF-16 units to match the existing parser.
pub fn visit(
    text: &str,
    mut visit: impl FnMut(Vec<String>) -> Result<(), Error>,
) -> Result<(), Error> {
    let mut row = Vec::new();
    let mut field = String::new();
    let mut units = 0;
    let mut state = State::Start;
    let mut comment = false;
    let mut records = 0;
    for c in text.strip_prefix('\u{feff}').unwrap_or(text).chars() {
        if comment {
            if matches!(c, '\n' | '\r') {
                comment = false;
            }
            continue;
        }
        if state == State::Start && row.is_empty() && field.is_empty() && c == '#' {
            comment = true;
            continue;
        }
        if state == State::Quoted {
            if c == '"' {
                state = State::Closed;
            } else {
                append(&mut field, &mut units, c)?;
            }
            continue;
        }
        if state == State::Closed && c == '"' {
            append(&mut field, &mut units, c)?;
            state = State::Quoted;
            continue;
        }
        if c == ',' {
            finish_field(&mut row, &mut field)?;
            units = 0;
            state = State::Start;
            continue;
        }
        if matches!(c, '\n' | '\r') {
            if !row.is_empty() || !field.is_empty() || state == State::Closed {
                finish_row(&mut row, &mut field, &mut records, &mut visit)?;
                units = 0;
                state = State::Start;
            }
            continue;
        }
        if state == State::Closed || (c == '"' && state != State::Start) {
            return Err(Error::invalid("The CSV contains malformed quotes."));
        }
        if c == '"' {
            state = State::Quoted;
        } else {
            state = State::Bare;
            append(&mut field, &mut units, c)?;
        }
    }
    if state == State::Quoted {
        return Err(Error::invalid("The CSV contains malformed quotes."));
    }
    if !row.is_empty() || !field.is_empty() || state == State::Closed {
        finish_row(&mut row, &mut field, &mut records, &mut visit)?;
    }
    Ok(())
}
fn append(field: &mut String, units: &mut usize, c: char) -> Result<(), Error> {
    *units += c.len_utf16();
    if *units > 4096 || c == '\0' {
        return Err(Error::invalid("Invalid CSV field."));
    }
    field.push(c);
    Ok(())
}
fn finish_field(row: &mut Vec<String>, field: &mut String) -> Result<(), Error> {
    row.push(std::mem::take(field));
    if row.len() > 64 {
        return Err(Error::invalid("Too many CSV columns."));
    }
    Ok(())
}
fn finish_row(
    row: &mut Vec<String>,
    field: &mut String,
    records: &mut usize,
    visit: &mut impl FnMut(Vec<String>) -> Result<(), Error>,
) -> Result<(), Error> {
    finish_field(row, field)?;
    let row = std::mem::take(row);
    if row.iter().any(|s| !trim(s).is_empty()) {
        *records += 1;
        if *records > 100_001 {
            return Err(Error::invalid(
                "An import may contain at most 100,000 CSV records.",
            ));
        }
        visit(row)?;
    }
    Ok(())
}

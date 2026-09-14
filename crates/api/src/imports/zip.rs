use super::error::Error;
use std::{collections::HashSet, io::Read};

fn invalid() -> Error {
    Error::invalid("Invalid or unsupported ZIP file.")
}
fn slice(bytes: &[u8], at: usize, len: usize) -> Result<&[u8], Error> {
    bytes
        .get(at..at.checked_add(len).ok_or_else(invalid)?)
        .ok_or_else(invalid)
}
fn word(bytes: &[u8], at: usize) -> Result<usize, Error> {
    let b = slice(bytes, at, 2)?;
    Ok(u16::from_le_bytes([b[0], b[1]]) as usize)
}
fn dword(bytes: &[u8], at: usize) -> Result<usize, Error> {
    let b = slice(bytes, at, 4)?;
    Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize)
}
fn extras(bytes: &[u8]) -> Result<(), Error> {
    let mut at = 0;
    while at < bytes.len() {
        // ZIP64 is not part of this deliberately bounded upload format.
        if word(bytes, at)? == 1 {
            return Err(invalid());
        }
        let len = word(bytes, at + 2)?;
        slice(bytes, at + 4, len)?;
        at += 4 + len;
    }
    Ok(())
}

/// In-memory, bounded extraction. Never use entry names as filesystem paths.
pub fn unzip(bytes: &[u8]) -> Result<Vec<(String, Vec<u8>)>, Error> {
    let end = (bytes.len().saturating_sub(65557)..=bytes.len().saturating_sub(22))
        .rev()
        .find(|&at| {
            dword(bytes, at).ok() == Some(0x06054b50)
                && word(bytes, at + 20)
                    .ok()
                    .is_some_and(|len| at + 22 + len == bytes.len())
        })
        .ok_or_else(invalid)?;
    let count = word(bytes, end + 10)?;
    let offset = dword(bytes, end + 16)?;
    if word(bytes, end + 4)? != 0
        || word(bytes, end + 6)? != 0
        || word(bytes, end + 8)? != count
        || count > 20
        || offset.checked_add(dword(bytes, end + 12)?) != Some(end)
    {
        return Err(invalid());
    }
    let mut cursor = offset;
    let mut expanded_total = 0;
    let mut names = HashSet::new();
    let mut ranges = Vec::new();
    let mut files = Vec::new();
    for _ in 0..count {
        if dword(bytes, cursor)? != 0x02014b50 {
            return Err(invalid());
        }
        let flags = word(bytes, cursor + 8)?;
        let compression = word(bytes, cursor + 10)?;
        let crc = dword(bytes, cursor + 16)? as u32;
        let compressed = dword(bytes, cursor + 20)?;
        let expanded = dword(bytes, cursor + 24)?;
        let name_len = word(bytes, cursor + 28)?;
        let extra_len = word(bytes, cursor + 30)?;
        let comment_len = word(bytes, cursor + 32)?;
        let local = dword(bytes, cursor + 42)?;
        let name_bytes = slice(bytes, cursor + 46, name_len)?;
        let name = std::str::from_utf8(name_bytes).map_err(|_| invalid())?;
        expanded_total += expanded;
        if flags & (1 | 64 | 8192) != 0
            || !matches!(compression, 0 | 8)
            || [compressed, expanded, local].contains(&(u32::MAX as usize))
            || word(bytes, cursor + 34)? != 0
            || expanded_total > 32 * 1024 * 1024
            || name.is_empty()
            || name.starts_with('/')
            || name.contains(['\\', '\0'])
            || name.split('/').any(|p| p == "..")
            || !names.insert(name.to_owned())
        {
            return Err(invalid());
        }
        extras(slice(bytes, cursor + 46 + name_len, extra_len)?)?;
        cursor += 46 + name_len + extra_len + comment_len;
        if cursor > end
            || dword(bytes, local)? != 0x04034b50
            || word(bytes, local + 6)? != flags
            || word(bytes, local + 8)? != compression
            || word(bytes, local + 26)? != name_len
            || slice(bytes, local + 30, name_len)? != name_bytes
        {
            return Err(invalid());
        }
        let local_extra = word(bytes, local + 28)?;
        extras(slice(bytes, local + 30 + name_len, local_extra)?)?;
        let start = local + 30 + name_len + local_extra;
        let finish = start.checked_add(compressed).ok_or_else(invalid)?;
        if finish > offset || ranges.iter().any(|&(a, b)| local < b && finish > a) {
            return Err(invalid());
        }
        ranges.push((local, finish));
        if flags & 8 == 0
            && (dword(bytes, local + 14)? as u32 != crc
                || dword(bytes, local + 18)? != compressed
                || dword(bytes, local + 22)? != expanded)
        {
            return Err(invalid());
        }
        let payload = slice(bytes, start, compressed)?;
        let data = if compression == 0 {
            if compressed != expanded {
                return Err(invalid());
            }
            payload.to_vec()
        } else {
            let mut decoder = flate2::read::DeflateDecoder::new(payload);
            let mut data = Vec::with_capacity(expanded.min(64 * 1024));
            (&mut decoder)
                .take(expanded as u64 + 1)
                .read_to_end(&mut data)
                .map_err(|_| invalid())?;
            if decoder.total_in() != compressed as u64 {
                return Err(invalid());
            }
            data
        };
        if data.len() != expanded || crc32fast::hash(&data) != crc {
            return Err(Error::invalid(
                "ZIP contents failed integrity verification.",
            ));
        }
        files.push((name.to_owned(), data));
    }
    if cursor != end {
        return Err(Error::invalid("Invalid ZIP directory length."));
    }
    Ok(files)
}

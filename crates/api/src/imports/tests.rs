use super::*;
use std::io::Write;

fn zip_files(files: &[(&str, &str)], deflated: bool) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut directory = Vec::new();
    for (name, text) in files {
        let raw = text.as_bytes();
        let data = if deflated {
            let mut encoder =
                flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
            encoder.write_all(raw).unwrap();
            encoder.finish().unwrap()
        } else {
            raw.to_vec()
        };
        let offset = bytes.len() as u32;
        let crc = crc32fast::hash(raw);
        let mut local = vec![0_u8; 30];
        local[..4].copy_from_slice(&0x04034b50_u32.to_le_bytes());
        local[4..6].copy_from_slice(&20_u16.to_le_bytes());
        local[8..10].copy_from_slice(&(if deflated { 8_u16 } else { 0 }).to_le_bytes());
        local[14..18].copy_from_slice(&crc.to_le_bytes());
        local[18..22].copy_from_slice(&(data.len() as u32).to_le_bytes());
        local[22..26].copy_from_slice(&(raw.len() as u32).to_le_bytes());
        local[26..28].copy_from_slice(&(name.len() as u16).to_le_bytes());
        let mut central = vec![0_u8; 46];
        central[..4].copy_from_slice(&0x02014b50_u32.to_le_bytes());
        central[6..12].copy_from_slice(&local[4..10]);
        central[16..28].copy_from_slice(&local[14..26]);
        central[28..30].copy_from_slice(&local[26..28]);
        central[42..46].copy_from_slice(&offset.to_le_bytes());
        directory.extend(central);
        directory.extend(name.as_bytes());
        bytes.extend(local);
        bytes.extend(name.as_bytes());
        bytes.extend(data);
    }
    let mut end = vec![0_u8; 22];
    end[..4].copy_from_slice(&0x06054b50_u32.to_le_bytes());
    end[8..10].copy_from_slice(&(files.len() as u16).to_le_bytes());
    end[10..12].copy_from_slice(&(files.len() as u16).to_le_bytes());
    end[12..16].copy_from_slice(&(directory.len() as u32).to_le_bytes());
    end[16..20].copy_from_slice(&(bytes.len() as u32).to_le_bytes());
    bytes.extend(directory);
    bytes.extend(end);
    bytes
}

#[test]
fn canonical_imports_match_the_bun_fingerprint_with_unicode_and_dst() {
    let labels = [
        "/Z", "/a", "/A", "/á", "/á", "/æ", "/ø", "/😀", "/a-b", "/a_b", "/a b", "/中",
    ];
    let pages = format!(
        "date,page,pageviews\n{}",
        labels
            .iter()
            .map(|p| format!("2025-03-30,{p},1"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    for deflated in [false, true] {
        let bytes = zip_files(
            &[
                (
                    "imported_visitors.csv",
                    "date,visitors,pageviews\n2025-03-30,3,12\n",
                ),
                ("imported_pages.csv", &pages),
            ],
            deflated,
        );
        let data = parse::parse("plausible", "fixture.zip".into(), bytes).unwrap();
        // Obtained by running the original Bun parser + canonicalFingerprint.
        assert_eq!(
            data.breakdowns
                .iter()
                .map(|d| d.value.as_str())
                .collect::<Vec<_>>(),
            [
                "/😀", "/a b", "/a_b", "/a-b", "/a", "/A", "/á", "/á", "/æ", "/ø", "/Z", "/中"
            ]
        );
        let days: Vec<_> = data
            .days
            .iter()
            .map(|d| {
                let mut d = json!(d);
                d["starts"] = json!("2025-03-29T23:00:00.000Z");
                d["ends"] = json!("2025-03-30T22:00:00.000Z");
                d
            })
            .collect();
        assert_eq!(fingerprint::fingerprint(&json!({"provider":"plausible","timeZone":"Europe/Copenhagen","days":days,"breakdowns":data.breakdowns,"metrics":data.metrics})).unwrap(), "aae49254c46b67f4d24e079a85b8160e1d999957fae23f8f5c792aae841778d8");
    }
}

#[test]
fn csv_and_provider_validation_preserve_privacy_and_limits() {
    let mut rows = Vec::new();
    csv::visit(
        "\u{feff}# comment\r\na,b\r\n\"one, two\",\"three\n\"\"four\"\"\"\r\n",
        |r| {
            rows.push(r);
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(
        rows,
        vec![vec!["a", "b"], vec!["one, two", "three\n\"four\""]]
    );
    for bad in ["a,\"b", "a\"b", "\"a\" b", "a\0", &"😀".repeat(2049)] {
        assert!(csv::visit(bad, |_| Ok(())).is_err());
    }
    let parsed = parse::parse(
        "ga4",
        "Export.csv".into(),
        b"# source\nDate,Screen page views,Total users\n20250330,000012,3\nGrand total,12,3"
            .to_vec(),
    )
    .unwrap();
    assert_eq!(
        (parsed.days[0].day.as_str(), parsed.days[0].pageviews),
        ("2025-03-30", 12)
    );
    for bad in [
        "Date,Views,Total users,Country\n20250330,1,1,DK",
        "Date,Views,Total users\n20250230,1,1",
        "Date,Views,Total users\n20250330,1.5,1",
        "Date,Views,Total users\n20250330,1000000000001,1",
    ] {
        assert!(parse::parse("ga4", "Export.csv".into(), bad.as_bytes().to_vec()).is_err());
    }
    let bytes = zip_files(
        &[
            (
                "imported_visitors.csv",
                "date,visitors,pageviews\n2025-03-30,3,4",
            ),
            (
                "imported_pages.csv",
                "date,page,pageviews\n2025-03-30,https://example.test/a?secret=x#fragment,1\n2025-03-30,/a?other=x,2",
            ),
            (
                "imported_sources.csv",
                "date,referrer,pageviews\n2025-03-30,https://user:password@SOURCE.test/path?token=secret,1",
            ),
            (
                "imported_devices.csv",
                "date,device,pageviews\n2025-03-30,Laptop,1",
            ),
            (
                "imported_custom_events.csv",
                "date,name,events\n2025-03-30,Purchase,2",
            ),
            ("notes.txt", "ignored"),
        ],
        true,
    );
    let data = parse::parse("plausible", "export.zip".into(), bytes).unwrap();
    assert_eq!(data.days[0].custom, 2);
    assert!(
        data.breakdowns
            .iter()
            .any(|r| r.dimension == "path" && r.value == "/a" && r.count == 3)
    );
    assert!(
        data.breakdowns
            .iter()
            .any(|r| r.dimension == "referrer" && r.value == "source.test")
    );
    assert!(
        data.breakdowns
            .iter()
            .any(|r| r.dimension == "device" && r.value == "desktop")
    );
    assert_eq!(
        data.metrics,
        ["customEvents", "dailyUniqueVisitors", "pageviews"]
    );
    assert_eq!(data.warnings, ["Ignored unsupported file: notes.txt."]);
}

#[test]
fn zip_rejects_traversal_crc_truncation_and_dishonest_expanded_sizes() {
    for name in [
        "../imported_visitors.csv",
        "/imported_visitors.csv",
        "folder\\imported_visitors.csv",
    ] {
        assert!(zip::unzip(&zip_files(&[(name, "test")], false)).is_err());
    }
    let valid = zip_files(&[("file.csv", "a,b\n1,2")], true);
    for n in 0..valid.len() {
        assert!(zip::unzip(&valid[..n]).is_err());
    }
    let mut crc = valid.clone();
    crc[14] ^= 1;
    assert!(zip::unzip(&crc).is_err());
    let mut bomb = zip_files(&[("file.csv", &"x".repeat(1024 * 1024))], true);
    let end = bomb.len() - 22;
    let central = u32::from_le_bytes(bomb[end + 16..end + 20].try_into().unwrap()) as usize;
    bomb[22..26].copy_from_slice(&1_u32.to_le_bytes());
    bomb[central + 24..central + 28].copy_from_slice(&1_u32.to_le_bytes());
    assert!(zip::unzip(&bomb).is_err());
    assert!(zip::unzip(&zip_files(&[("same.csv", "a"), ("same.csv", "b")], false)).is_err());
}

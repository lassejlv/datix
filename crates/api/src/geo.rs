use flate2::read::GzDecoder;
use maxminddb::{Reader, geoip2};
use std::{
    io::Read,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
};

/// DB-IP IP to Country Lite, September 2026. IP geolocation by DB-IP, https://db-ip.com/
const DATABASE: &[u8] = include_bytes!("../data/dbip-country-lite.mmdb.gz");

pub struct Geo {
    reader: Reader<Vec<u8>>,
}

impl Geo {
    pub fn load() -> anyhow::Result<Self> {
        let mut raw = Vec::new();
        GzDecoder::new(DATABASE).read_to_end(&mut raw)?;
        Ok(Self {
            reader: Reader::from_source(raw)?,
        })
    }

    pub fn country(&self, ip: &str) -> String {
        let Ok(ip) = ip.parse::<IpAddr>() else {
            return String::new();
        };
        if unusable(ip) {
            return String::new();
        }
        let Ok(result) = self.reader.lookup(ip) else {
            return String::new();
        };
        let code = result
            .decode::<geoip2::Country>()
            .ok()
            .flatten()
            .and_then(|record| record.country.iso_code)
            .unwrap_or("");
        let region = code.trim().to_ascii_uppercase();
        if region.len() == 2
            && region.bytes().all(|b| b.is_ascii_uppercase())
            && !matches!(region.as_str(), "XX" | "ZZ")
        {
            region
        } else {
            String::new()
        }
    }
}

fn unusable(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => v4_unusable(ip),
        IpAddr::V6(ip) => v6_unusable(ip),
    }
}

fn v4_unusable(ip: Ipv4Addr) -> bool {
    ip.is_loopback()
        || ip.is_private()
        || ip.is_unspecified()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_multicast()
}

fn v6_unusable(ip: Ipv6Addr) -> bool {
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_unique_local()
        || ip.is_unicast_link_local()
        || ip.to_ipv4_mapped().is_some_and(v4_unusable)
}

#[cfg(test)]
mod tests {
    use super::Geo;

    fn geo() -> Geo {
        Geo::load().unwrap()
    }

    #[test]
    fn public_addresses_resolve_to_iso_countries() {
        let geo = geo();
        assert_eq!(geo.country("8.8.8.8"), "US");
        assert_eq!(geo.country("2.109.64.1"), "DK");
    }

    #[test]
    fn local_and_garbage_addresses_are_unknown() {
        let geo = geo();
        assert_eq!(geo.country("127.0.0.1"), "");
        assert_eq!(geo.country("10.0.0.1"), "");
        assert_eq!(geo.country("::1"), "");
        assert_eq!(geo.country("unknown"), "");
        assert_eq!(geo.country(""), "");
    }
}

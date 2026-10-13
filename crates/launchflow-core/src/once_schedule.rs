//! A single local wall-clock appointment, with strict, shared UI/save validation.
use crate::{Error, Result};
use chrono::{DateTime, Datelike, Local, NaiveDateTime, TimeZone, Timelike};

pub fn parse(value: &str) -> Result<DateTime<Local>> {
    const FORMAT: &str = "%Y-%m-%d %H:%M:%S";
    let invalid = || {
        Error::Validation(
            "请输入合法时间，格式为 yyyy-MM-dd HH:mm:ss，例如 2026-12-31 09:30:00。".into(),
        )
    };
    if value.len() != 19 || !value.is_ascii() {
        return Err(invalid());
    }
    let date = NaiveDateTime::parse_from_str(value, FORMAT).map_err(|_| invalid())?;
    if date.year() < 1 || date.nanosecond() != 0 || date.format(FORMAT).to_string() != value {
        return Err(invalid());
    }
    Local.from_local_datetime(&date).single().ok_or_else(|| {
        Error::Validation(
            "该时间受本机夏令时切换影响，不存在或对应两个时刻，请选择其他时间。".into(),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_calendar_and_seconds_validation() {
        for good in ["2026-10-13 09:30:00", "2028-02-29 23:59:59"] {
            assert!(parse(good).is_ok(), "{good}");
        }
        for bad in [
            "",
            "2026-2-03 09:30:00",
            "2026-02-29 09:30:00",
            "2026-04-31 09:30:00",
            "2026-13-01 09:30:00",
            "2026-10-13 24:00:00",
            "2026-10-13 09:60:00",
            "2026-10-13 09:30:60",
            "2026-10-13 09:30",
            "2026-10-13T09:30:00",
            "2026-10-13 09:30:00Z",
            " 2026-10-13 09:30:00",
            "0000-01-01 00:00:00",
        ] {
            assert!(parse(bad).is_err(), "{bad}");
        }
    }
}

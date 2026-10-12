//! Five-field POSIX cron, or six fields with seconds. All dates use the device timezone.
use crate::{Error, Result};
use chrono::{DateTime, Local, Timelike};
use croner::{
    parser::{CronParser, Seconds, Year},
    Cron,
};

pub fn parse(expression: &str) -> Result<Cron> {
    if expression.len() > 256 || !matches!(expression.split_whitespace().count(), 5 | 6) {
        return Err(Error::Validation(
            "Cron 表达式需为 5 段（分 时 日 月 星期）或 6 段（秒 分 时 日 月 星期）。".into(),
        ));
    }
    CronParser::builder()
        .seconds(Seconds::Optional)
        .year(Year::Disallowed)
        .build()
        .parse(expression)
        .map_err(|e| Error::Validation(format!("Cron 表达式无效：{e}")))
}

pub fn observation(expression: &str, clock: DateTime<Local>) -> Result<(String, bool)> {
    let seconds = expression.split_whitespace().count() == 6;
    // A minute expression remains eligible throughout its minute, including a late polling tick.
    let time = if seconds {
        clock
    } else {
        clock.with_second(0).expect("valid second")
    };
    let matches = parse(expression)?
        .is_time_matching(&time)
        .map_err(|e| Error::Validation(format!("Cron 匹配失败：{e}")))?;
    // Repeated polls, restarts and clock rollback cannot fire the same local slot twice.
    Ok((
        time.format(if seconds {
            "%Y-%m-%d %H:%M:%S"
        } else {
            "%Y-%m-%d %H:%M"
        })
        .to_string(),
        matches,
    ))
}

pub fn preview(expression: &str) -> Result<Vec<String>> {
    let cron = parse(expression)?;
    let mut from = Local::now();
    let mut next = Vec::new();
    for _ in 0..3 {
        from = cron.find_next_occurrence(&from, false).map_err(|_| {
            Error::Validation("此 Cron 表达式没有可用的后续执行时间，请检查日期范围。".into())
        })?;
        next.push(from.to_rfc3339());
    }
    Ok(next)
}

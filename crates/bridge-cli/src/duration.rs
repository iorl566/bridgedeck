//! 时长解析（与 Node CLI `cli/lib/args.mjs` 的 `parseDurationMs` 同口径）。
//!
//! 支持的写法：纯整数毫秒（`1500`）、带单位（`500ms` / `20s` / `2m` / `1h` / `30d`），
//! 也接受小数（`1.5s`）。无单位默认毫秒。非法输入返回 `E_ARG_TYPE` 并由 CLI 渲染成
//! 参数错误（退出码 2），不在 `session`/`observe` 各命令里各写一份长度校验。
//!
//! 为什么单独成模块：`--min-interval`、`--timeout` 之外后续的等待类开关（`--wait-timeout`
//! 等）都要复用同一份解析；重复实现会出现"有的命令接受 `1s`、有的只接受 `1000`"的漂移。

use crate::cli::CliError;
use crate::errors::ErrorCode;

/// 一天毫秒（`30d` 等大单位的上界计算用）。
pub const DAY_MS: u64 = 86_400_000;

/// 解析时长 → 毫秒；`text` 为空返回 `fallback`。
///
/// 错误码：格式不符 → `E_ARG_TYPE`；解析结果超出 `u64` → `E_ARG_RANGE`。
pub fn parse_duration_ms(text: &str, fallback: Option<u64>, flag: &str) -> Result<u64, CliError> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return fallback.ok_or_else(|| {
            CliError::new(ErrorCode::ArgMissing, format!("--{flag} 需要一个时长，例如 --{flag} 1500 或 --{flag} 1s"))
        });
    }
    let (number_text, unit) = match trimmed.char_indices().rev().find(|(_, ch)| ch.is_ascii_digit()) {
        Some((index, _)) => {
            let split = index + 1;
            let unit = trimmed[split..].trim();
            (&trimmed[..split], unit)
        }
        None => {
            return Err(type_error(flag, trimmed));
        }
    };
    let factor = match unit {
        "" | "ms" => 1u64,
        "s" => 1_000,
        "m" => 60_000,
        "h" => 3_600_000,
        "d" => DAY_MS,
        other => {
            return Err(CliError::new(
                ErrorCode::ArgEnum,
                format!("--{flag} 的单位只支持 ms/s/m/h/d，收到 {other:?}（示例：--{flag} 1s）"),
            ))
        }
    };
    // 小数只在毫秒级有意义：`1.5s` → 1500ms；用整数部分 + 小数部分拼装，避免浮点误差。
    let (whole_text, fraction_text) = match number_text.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (number_text, None),
    };
    let whole: u64 = match whole_text.parse() {
        Ok(value) => value,
        // 纯数字但超出 u64：是范围问题，不是格式问题（CLI 用不同错误码提示）。
        Err(_) if !whole_text.is_empty() && whole_text.bytes().all(|byte| byte.is_ascii_digit()) => {
            return Err(range_error(flag, trimmed));
        }
        Err(_) => return Err(type_error(flag, trimmed)),
    };
    let mut millis = whole.checked_mul(factor).ok_or_else(|| range_error(flag, trimmed))?;
    if let Some(fraction) = fraction_text {
        if fraction.is_empty() || !fraction.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(type_error(flag, trimmed));
        }
        // 小数位数按毫秒精度截断（最多 3 位参与计算）。
        let digits: String = fraction.chars().take(3).collect();
        let value: u64 = digits.parse().map_err(|_| type_error(flag, trimmed))?;
        let scale = 10u64.pow(digits.len() as u32);
        let scaled = value.checked_mul(factor).ok_or_else(|| range_error(flag, trimmed))?;
        millis = millis.checked_add(scaled / scale).ok_or_else(|| range_error(flag, trimmed))?;
    }
    Ok(millis)
}

fn type_error(flag: &str, text: &str) -> CliError {
    CliError::new(
        ErrorCode::ArgType,
        format!(
            "--{flag} 的时长格式应为 1500 / 500ms / 20s / 2m / 1h / 30d，收到 {text:?}"
        ),
    )
}

fn range_error(flag: &str, text: &str) -> CliError {
    CliError::new(ErrorCode::ArgRange, format!("--{flag} 的时长过大，收到 {text:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> u64 {
        parse_duration_ms(text, None, "min-interval").expect("合法时长")
    }

    #[test]
    fn parses_integer_milliseconds() {
        assert_eq!(parse("0"), 0);
        assert_eq!(parse("1500"), 1_500);
        assert_eq!(parse(" 250 "), 250);
    }

    #[test]
    fn parses_units_like_node_cli() {
        assert_eq!(parse("500ms"), 500);
        assert_eq!(parse("20s"), 20_000);
        assert_eq!(parse("2m"), 120_000);
        assert_eq!(parse("1h"), 3_600_000);
        assert_eq!(parse("30d"), 30 * DAY_MS);
    }

    #[test]
    fn parses_fractional_units_without_float_error() {
        assert_eq!(parse("1.5s"), 1_500);
        assert_eq!(parse("0.25s"), 250);
        assert_eq!(parse("20.5ms"), 20);
        assert_eq!(parse("1.001s"), 1_001);
    }

    #[test]
    fn empty_uses_fallback_and_missing_without_fallback_is_arg_missing() {
        assert_eq!(parse_duration_ms("", Some(42), "min-interval").expect("回退"), 42);
        let error = parse_duration_ms("", None, "min-interval").expect_err("缺值");
        assert_eq!(error.code, ErrorCode::ArgMissing);
        assert!(error.message.contains("--min-interval"), "{}", error.message);
    }

    #[test]
    fn invalid_texts_are_structured_type_errors() {
        for text in ["abc", "s", "-5", ".5", "1..2s", "1s2"] {
            let error = parse_duration_ms(text, None, "min-interval").expect_err("非法");
            assert_eq!(error.code, ErrorCode::ArgType, "夹具 {text}");
            assert!(error.message.contains("min-interval"), "{}", error.message);
        }
    }

    #[test]
    fn unknown_unit_is_arg_enum() {
        let error = parse_duration_ms("5w", None, "min-interval").expect_err("未知单位");
        assert_eq!(error.code, ErrorCode::ArgEnum);
        assert!(error.message.contains("ms/s/m/h/d"), "{}", error.message);
    }

    #[test]
    fn huge_values_are_range_errors_not_panics() {
        let error = parse_duration_ms(&"9".repeat(30), None, "min-interval").expect_err("溢出");
        assert_eq!(error.code, ErrorCode::ArgRange);
        let huge_unit = format!("{}d", "9".repeat(30));
        let error = parse_duration_ms(&huge_unit, None, "min-interval").expect_err("溢出");
        assert_eq!(error.code, ErrorCode::ArgRange);
    }
}

//! 错误码门面：生成枚举（`crate::generated::error_codes`）+ 归一化 + JSON 序列化。
//!
//! `lib/error-codes.mjs` 是唯一真源（158 码 + 恢复建议）；本文件**不维护任何码表**，
//! 只提供 CLI/协议层需要的查询与序列化，避免 Rust 侧再手写一份清单产生漂移。

use crate::json::Json;

pub use crate::generated::error_codes::{ErrorCode, ErrorRecovery};

/// 协议错误码总数（生成时固定，供 `protocol codes` 与门禁断言使用）。
pub const ERROR_CODE_COUNT: usize = crate::generated::error_codes::ERROR_CODE_COUNT;
/// 登记了恢复建议的错误码数量。
pub const ERROR_RECOVERY_COUNT: usize = crate::generated::error_codes::ERROR_RECOVERY_COUNT;

/// 按声明顺序迭代全部错误码。
pub fn all() -> impl Iterator<Item = ErrorCode> {
    ErrorCode::ALL.into_iter()
}

/// 字符串码是否登记在单源里。
pub fn is_known(code: &str) -> bool {
    ErrorCode::from_code(code).is_some()
}

/// 未知码统一落到 `E_INTERNAL`（与 JS `normalizeErrorCode` 同口径）。
pub fn normalize_code(code: &str) -> &'static str {
    match ErrorCode::from_code(code) {
        Some(known) => known.as_str(),
        None => ErrorCode::Internal.as_str(),
    }
}

/// 字符串码 → 枚举；未知码落到 `E_INTERNAL`。
pub fn resolve(code: &str) -> ErrorCode {
    ErrorCode::from_code(code).unwrap_or(ErrorCode::Internal)
}

/// 一句话含义。
pub fn describe(code: ErrorCode) -> &'static str {
    code.description()
}

/// 恢复建议（未登记返回 `None`）。
pub fn recovery(code: ErrorCode) -> Option<ErrorRecovery> {
    code.recovery()
}

/// 单个错误码的诊断 JSON：`{code, description, recovery: {retry, hint} | null}`。
pub fn to_json(code: ErrorCode) -> Json {
    let recovery = match code.recovery() {
        Some(entry) => crate::json_obj! {
            "retry" => Json::string(entry.retry),
            "hint" => Json::string(entry.hint),
        },
        None => Json::Null,
    };
    crate::json_obj! {
        "code" => Json::string(code.as_str()),
        "description" => Json::string(code.description()),
        "recovery" => recovery,
    }
}

/// 全部错误码的诊断 JSON 数组（`protocol codes --json`）。
pub fn list_json() -> Json {
    Json::Array(all().map(to_json).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frozen_counts_match_canonical_js_source() {
        // 冻结口径：lib/error-codes.mjs 当前 158 码 / 48 条恢复建议。
        // 单源新增错误码时，生成器重跑后本断言需要同步更新（有意为之的漂移门禁）。
        assert_eq!(ERROR_CODE_COUNT, 158);
        assert_eq!(ERROR_RECOVERY_COUNT, 48);
        assert_eq!(ErrorCode::ALL.len(), ERROR_CODE_COUNT);
    }

    #[test]
    fn every_code_round_trips_and_has_shape() {
        let mut seen = std::collections::BTreeSet::new();
        for code in all() {
            let text = code.as_str();
            assert!(text.starts_with("E_"), "错误码必须 E_ 前缀：{text}");
            assert!(!text[2..].is_empty(), "错误码前缀后不能为空：{text}");
            assert!(seen.insert(text.to_string()), "错误码重复：{text}");
            assert_eq!(ErrorCode::from_code(text), Some(code), "字符串码无法回解析：{text}");
            assert!(!code.description().trim().is_empty(), "错误码缺少说明：{text}");
        }
        assert_eq!(seen.len(), ERROR_CODE_COUNT);
    }

    #[test]
    fn unknown_codes_normalize_to_internal() {
        assert_eq!(normalize_code("E_THIS_DOES_NOT_EXIST"), "E_INTERNAL");
        assert_eq!(resolve("E_THIS_DOES_NOT_EXIST"), ErrorCode::Internal);
        assert!(!is_known(""));
        assert_eq!(normalize_code("E_BAD_ARG"), "E_BAD_ARG");
    }

    #[test]
    fn legacy_cli_code_is_not_in_single_source() {
        // 0.3.0 Rust 骨架曾自造 E_NOT_IMPLEMENTED；生成化后统一改用单源里的
        // E_UNSUPPORTED_CAPABILITY（语义：当前版本不支持该能力 / 未接线）。
        assert!(!is_known("E_NOT_IMPLEMENTED"));
        assert!(is_known("E_UNSUPPORTED_CAPABILITY"));
        assert!(is_known("E_SESSION_TRANSITION"));
        assert!(is_known("E_PROTOCOL_UNSUPPORTED"));
    }

    #[test]
    fn recovery_entries_come_from_single_source() {
        let timeout = recovery(ErrorCode::Timeout).expect("E_TIMEOUT 应登记恢复建议");
        assert_eq!(timeout.retry, "after-action");
        assert!(timeout.hint.contains("--timeout"));
        assert!(recovery(ErrorCode::BadArg).is_some());
        assert!(recovery(ErrorCode::Internal).is_none());
    }

    #[test]
    fn diagnostic_json_contains_code_and_recovery() {
        let value = to_json(ErrorCode::Timeout);
        assert_eq!(value.get("code").and_then(Json::as_str), Some("E_TIMEOUT"));
        let recovery = value.get("recovery").expect("recovery 字段");
        assert_eq!(recovery.get("retry").and_then(Json::as_str), Some("after-action"));
        let encoded = value.to_compact_string();
        assert!(encoded.starts_with('{') && encoded.ends_with('}'));
        assert!(encoded.contains("\"code\":\"E_TIMEOUT\""));
    }

    #[test]
    fn diagnostic_json_recovery_is_null_when_unregistered() {
        let value = to_json(ErrorCode::Internal);
        assert_eq!(value.get("recovery"), Some(&Json::Null));
    }

    #[test]
    fn list_json_covers_every_code_in_order() {
        let list = list_json();
        let items = list.as_array().expect("数组");
        assert_eq!(items.len(), ERROR_CODE_COUNT);
        assert_eq!(items[0].get("code").and_then(Json::as_str), Some(ErrorCode::BadArg.as_str()));
        let last = items.last().expect("非空");
        assert_eq!(last.get("code").and_then(Json::as_str), Some(ErrorCode::Internal.as_str()));
    }
}

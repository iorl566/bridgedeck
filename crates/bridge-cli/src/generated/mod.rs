//! 机器生成模块（见 `crates/bridge-cli/scripts/gen-error-codes.mjs`）。
//!
//! 这里的文件全部由脚本从 JS 单源（`lib/error-codes.mjs` / `lib/method-catalog.mjs`）
//! 产出，**禁止手改**；`--check` 是 CI 漂移门禁。

pub mod error_codes;
pub mod protocol_catalog;

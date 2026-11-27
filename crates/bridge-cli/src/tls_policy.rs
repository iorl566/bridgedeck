//! TLS 策略：**明确不支持**，绝不假装支持。
//!
//! 背景：本 crate 是 std-only（`[dependencies]` 必须为空），没有 TLS 客户端实现，
//! 因此无法完成 `wss://` 或 `https://` 握手。`daemon.json` 里 `tls:true` 的 daemon
//! 意味着 daemon 只监听 TLS 端点；此时 bridge-rs 的选择只有两种：
//!
//! 1. **明确拒绝**：返回单源错误码 `E_UNSUPPORTED_CAPABILITY`，`data` 里带上端点、发现文件、
//!    能力位快照与**可执行的替代命令**（Node CLI 或去掉 `--tls-pfx` 重启 daemon）；
//! 2. ~~静默降级明文~~ / ~~伪造握手成功~~：**禁止**。前者会把 token 明文发到 TLS 端口
//!    （连接必然失败，还可能把 token 写进 wss 端点的日志），后者是"看起来成功"的伪证据。
//!
//! 因此本模块只做三件事：
//! - [`guard`]：所有 daemon 命令入口在**发起任何网络请求之前**调用（`rpc_client` 与
//!   `command_io` 都接在运行时路径上）；
//! - [`unsupported_error`]：构造带替代方案的结构化错误（CLI `--json` 会原样输出 `data`）；
//! - [`replacements`]：替代命令的唯一清单，README 的「TLS 策略」小节与本清单一一对应，
//!   并有单测用 `include_str!` 校验 README 真的写了（文档漂移门禁）。
//!
//! 同一份策略也写进 `crates/bridge-cli/README.md` 的「TLS 策略（不支持 wss）」小节。

use crate::discovery::DaemonMetadata;
use crate::envelope::RpcError;
use crate::errors::ErrorCode;
use crate::json::Json;

/// 本构建是否实现 TLS 客户端（恒 `false`；改动它需要先引入 TLS 栈并更新 README/门禁）。
pub const TLS_CLIENT_SUPPORTED: bool = false;
/// 本构建是否支持 `wss://`（恒 `false`）。
pub const WSS_SUPPORTED: bool = false;

/// README 中的策略小节标题（单测按它校验文档存在）。
pub const README_SECTION: &str = "TLS 策略（不支持 wss）";
/// README 相对路径（错误 `data.docs` 与单测共用）。
pub const README_PATH: &str = "crates/bridge-cli/README.md";

/// 一条可执行替代：`command` 是可直接粘贴运行的命令，`purpose` 说明它能做什么。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Replacement {
    pub command: &'static str,
    pub purpose: &'static str,
}

/// 替代方案清单（单一来源；README 与之对应，测试逐条校验命令前缀可执行）。
pub const REPLACEMENTS: [Replacement; 4] = [
    Replacement {
        command: "node cli/bridge.mjs status --json",
        purpose: "用 Node CLI 连接 TLS daemon 并读取状态（Node 侧有 TLS 支持）",
    },
    Replacement {
        command: "node cli/bridge.mjs session list",
        purpose: "用 Node CLI 列出会话（bridge-rs session list 在 TLS daemon 上不可用）",
    },
    Replacement {
        command: "bridge daemon stop && bridge daemon start",
        purpose: "以非 TLS 方式重启 daemon（去掉 --tls-pfx），之后 bridge-rs 可直连明文端点",
    },
    Replacement {
        command: "bridge-rs help",
        purpose: "查看 bridge-rs 当前支持的命令（TLS 相关命令不会出现在这里）",
    },
];

/// 全部替代方案（只读）。
pub fn replacements() -> &'static [Replacement] {
    &REPLACEMENTS
}

/// `daemon.json` 是否声明了 TLS。
pub fn is_tls(metadata: &DaemonMetadata) -> bool {
    metadata.tls
}

/// TLS 守卫：`tls:true` → `E_UNSUPPORTED_CAPABILITY`；否则放行。
///
/// 命名里显式带 `plaintext`：本客户端只接受**明文** HTTP 端点，不做任何协议降级。
pub fn guard(metadata: &DaemonMetadata) -> Result<(), RpcError> {
    if !is_tls(metadata) {
        return Ok(());
    }
    Err(unsupported_error(metadata))
}

/// 构造 TLS 拒绝错误：错误码固定 `E_UNSUPPORTED_CAPABILITY`，`data` 含可执行替代。
pub fn unsupported_error(metadata: &DaemonMetadata) -> RpcError {
    RpcError::new(ErrorCode::UnsupportedCapability, unsupported_message(metadata))
        .with_data(refusal_data(metadata))
}

/// 人类可读的拒绝说明（文本模式 stderr 会原样打印 `错误 E_UNSUPPORTED_CAPABILITY：<这段>`）。
pub fn unsupported_message(metadata: &DaemonMetadata) -> String {
    format!(
        "daemon.json 声明 tls:true（{}），但 bridge-rs 是 std-only 构建、没有 TLS 客户端：\
         不会以明文连接，也不会假装支持 wss。可执行替代：① 用 Node CLI 连接该 daemon（node cli/bridge.mjs status）；\
         ② 去掉 --tls-pfx 以非 TLS 方式重启 daemon。详见 {README_PATH}「{README_SECTION}」",
        metadata.endpoint_label()
    )
}

/// 结构化拒绝数据（`--json` 的 `error.data`；不含 token）。
pub fn refusal_data(metadata: &DaemonMetadata) -> Json {
    crate::json_obj! {
        "tls" => Json::Bool(true),
        "endpoint" => Json::string(metadata.endpoint_label()),
        "discoveryFile" => Json::string(metadata.path.display().to_string()),
        "home" => Json::string(metadata.home.display().to_string()),
        "docs" => Json::string(README_PATH),
        "section" => Json::string(README_SECTION),
        "capabilities" => crate::json_obj! {
            "tlsClient" => Json::Bool(TLS_CLIENT_SUPPORTED),
            "wss" => Json::Bool(WSS_SUPPORTED),
            "plaintextFallback" => Json::string("refused"),
        },
        "replacements" => Json::Array(
            REPLACEMENTS
                .iter()
                .map(|replacement| crate::json_obj! {
                    "command" => Json::string(replacement.command),
                    "purpose" => Json::string(replacement.purpose),
                })
                .collect()
        ),
    }
}

/// 策略摘要（诊断/测试用；不含端点与 token）。
pub fn policy_json() -> Json {
    crate::json_obj! {
        "tlsClient" => Json::Bool(TLS_CLIENT_SUPPORTED),
        "wss" => Json::Bool(WSS_SUPPORTED),
        "plaintextFallback" => Json::string("refused"),
        "docs" => Json::string(README_PATH),
        "section" => Json::string(README_SECTION),
        "replacements" => Json::Array(
            REPLACEMENTS
                .iter()
                .map(|replacement| Json::string(replacement.command))
                .collect()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::HomeSource;
    use std::path::PathBuf;

    fn metadata(tls: bool) -> DaemonMetadata {
        DaemonMetadata {
            pid: Some(4242),
            port: 52900,
            token: "secret-token-value".to_string(),
            version: Some("0.3.0".to_string()),
            started_at: Some(1),
            tls,
            path: PathBuf::from(r"C:\h\daemon.json"),
            home: PathBuf::from(r"C:\h"),
            home_source: HomeSource::Env,
        }
    }

    #[test]
    fn plaintext_daemon_is_allowed() {
        assert!(guard(&metadata(false)).is_ok());
        assert!(!is_tls(&metadata(false)));
    }

    #[test]
    fn tls_daemon_is_refused_with_unsupported_capability() {
        let error = guard(&metadata(true)).expect_err("TLS daemon 必须被拒绝");
        assert_eq!(error.code, ErrorCode::UnsupportedCapability);
        assert_eq!(error.code.as_str(), "E_UNSUPPORTED_CAPABILITY");
        // 消息必须说明"不支持"与"替代方案"，而不是含糊的连接失败。
        assert!(error.message.contains("tls:true"), "{}", error.message);
        assert!(error.message.contains("假装支持 wss"), "{}", error.message);
        assert!(error.message.contains("node cli/bridge.mjs"), "{}", error.message);
        assert!(error.message.contains(README_SECTION), "{}", error.message);
    }

    #[test]
    fn refusal_data_documents_capabilities_and_replacements() {
        let data = refusal_data(&metadata(true));
        assert_eq!(data.get("tls").and_then(Json::as_bool), Some(true));
        assert_eq!(data.get("endpoint").and_then(Json::as_str), Some("127.0.0.1:52900"));
        assert_eq!(data.get("section").and_then(Json::as_str), Some(README_SECTION));
        let capabilities = data.get("capabilities").expect("capabilities");
        assert_eq!(capabilities.get("tlsClient").and_then(Json::as_bool), Some(false));
        assert_eq!(capabilities.get("wss").and_then(Json::as_bool), Some(false));
        assert_eq!(capabilities.get("plaintextFallback").and_then(Json::as_str), Some("refused"));
        let replacements = data.get("replacements").and_then(Json::as_array).expect("replacements");
        assert_eq!(replacements.len(), REPLACEMENTS.len());
        for (index, item) in replacements.iter().enumerate() {
            assert_eq!(item.get("command").and_then(Json::as_str), Some(REPLACEMENTS[index].command));
            assert!(item.get("purpose").and_then(Json::as_str).is_some_and(|text| !text.is_empty()));
        }
        // 绝不泄漏 token。
        assert!(!data.to_compact_string().contains("secret-token-value"));
    }

    #[test]
    fn replacement_commands_are_runnable_and_documented() {
        // 每条替代命令必须指向仓库里真实存在的入口，不能写"看起来像命令"的伪命令。
        for replacement in replacements() {
            assert!(
                replacement.command.starts_with("node cli/bridge.mjs ")
                    || replacement.command.starts_with("bridge daemon ")
                    || replacement.command.starts_with("bridge-rs "),
                "替代命令必须指向真实入口：{}",
                replacement.command
            );
            assert!(!replacement.purpose.is_empty());
        }
        assert!(replacements().iter().any(|item| item.command.contains("status")));
        assert!(replacements().iter().any(|item| item.command.contains("--tls-pfx") == false));
    }

    #[test]
    fn policy_is_honest_about_missing_tls() {
        assert!(!TLS_CLIENT_SUPPORTED);
        assert!(!WSS_SUPPORTED);
        let json = policy_json();
        assert_eq!(json.get("tlsClient").and_then(Json::as_bool), Some(false));
        assert_eq!(json.get("wss").and_then(Json::as_bool), Some(false));
        assert_eq!(json.get("docs").and_then(Json::as_str), Some(README_PATH));
    }

    #[test]
    fn readme_documents_the_same_policy() {
        // 文档漂移门禁：README 必须真的写了策略小节与错误码，而不只是本模块注释里写。
        let readme = include_str!("../README.md");
        assert!(readme.contains(README_SECTION), "README 缺少「{README_SECTION}」小节");
        assert!(readme.contains("E_UNSUPPORTED_CAPABILITY"), "README 必须写明错误码");
        assert!(readme.contains("node cli/bridge.mjs"), "README 必须给出 Node CLI 替代命令");
        assert!(readme.contains("--tls-pfx"), "README 必须给出关闭 TLS 的具体开关");
        assert!(readme.contains("不假装"), "README 必须声明不假装支持");
        for replacement in replacements() {
            assert!(
                readme.contains(replacement.command),
                "README 的替代命令与 REPLACEMENTS 漂移：{}",
                replacement.command
            );
        }
    }
}

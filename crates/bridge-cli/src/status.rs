//! `bridge-rs status` / `health` / `ws-hello` 的真实接线（M-D 第三批）。
//!
//! 数据来源分三层，全部来自真实 daemon，不做任何"看起来成功"的伪造：
//! 1. **发现**：`daemon.json`（端口 + token）→ 文件缺失 `E_NO_DAEMON`、坏内容 `E_CONFIG_INVALID`；
//! 2. **可达性**：`GET /health`（无需 token）→ 连接拒绝/超时映射 `E_NO_DAEMON` / `E_DAEMON_TIMEOUT`；
//! 3. **摘要**：`POST /rpc status`（带 `x-bridge-token`）→ 会话/浏览器/inflight 归一视图。
//!
//! 输出契约：
//! - `--json` 成功：`{ok:true,status:{...},exitCode:0}`；失败：`{ok:false,error:{code,message,data?},exitCode:3}`；
//! - 文本成功：人读摘要；文本失败：`错误 E_CODE：消息` 写 stderr + 退出码 3；
//! - 退出码：0 成功 / 2 参数错误（由 `cli` 层给出）/ 3 daemon 不可达或调用失败。
//!
//! 与旧第二批的差异：不再输出 `E_UNSUPPORTED_CAPABILITY` 的"未接线"占位结构，而是真实数据；
//! `daemon.json` 里的 **token 永不输出**（只给 `tokenPresent` / `tokenLength`）。

use std::time::{Duration, Instant};

use crate::discovery::{DaemonHome, DaemonMetadata, HomeSource, DAEMON_FILE_NAME, HEALTH_PATH, RPC_PATH, WS_PATH};
use crate::envelope::RpcError;
use crate::errors::ErrorCode;
use crate::generated::protocol_catalog::{PROTOCOL_BASELINE, PROTOCOL_CURRENT, PRODUCT_VERSION};
use crate::handshake::{negotiate, Hello, ProtocolVersion};
use crate::json::Json;
use crate::rpc_client::{self, DaemonClient, HealthReport, SERVICE_NAME};
use crate::ws::{WsClient, DEFAULT_HANDSHAKE_TIMEOUT_MS};

/// 成功退出码。
pub const EXIT_CODE_OK: u8 = 0;
/// 通用失败（为将来保留；当前 daemon 相关失败统一 3）。
pub const EXIT_CODE_ERROR: u8 = 1;
/// 参数/命令错误（与 `cli::parse` 一致）。
pub const EXIT_CODE_USAGE: u8 = 2;
/// daemon 不可达 / 调用失败。
pub const EXIT_CODE_DAEMON: u8 = 3;

/// 一条浏览器实例摘要（daemon `status.browsers[]`）。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BrowserEntry {
    pub instance_id: String,
    pub browser: String,
    pub browser_version: String,
    pub ext_version: String,
    pub label: String,
    pub protocol: String,
    pub protocol_skew: Option<String>,
    pub local_auth: String,
    pub capabilities: Vec<String>,
    pub connected_at: Option<u64>,
}

impl BrowserEntry {
    fn from_json(value: &Json) -> Option<Self> {
        let object = value.as_object()?;
        let text = |key: &str| {
            object
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value)
                .and_then(Json::as_str)
                .unwrap_or("")
                .to_string()
        };
        let number = |key: &str| object.iter().find(|(name, _)| name == key).map(|(_, value)| value).and_then(Json::as_u64);
        let capabilities = object
            .iter()
            .find(|(name, _)| name == "capabilities")
            .map(|(_, value)| value)
            .and_then(Json::as_array)
            .map(|items| items.iter().filter_map(Json::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        Some(Self {
            instance_id: text("instanceId"),
            browser: text("browser"),
            browser_version: text("browserVersion"),
            ext_version: text("extVersion"),
            label: text("label"),
            protocol: match object.iter().find(|(name, _)| name == "protocol").map(|(_, value)| value) {
                Some(Json::String(text)) => text.clone(),
                Some(Json::Number(number)) if number.fract() == 0.0 => format!("{number}"),
                _ => String::new(),
            },
            protocol_skew: {
                let value = object.iter().find(|(name, _)| name == "protocolSkew").map(|(_, value)| value);
                value.and_then(Json::as_str).map(str::to_string)
            },
            local_auth: text("localAuth"),
            capabilities,
            connected_at: number("connectedAt"),
        })
    }

    fn to_json(&self) -> Json {
        crate::json_obj! {
            "instanceId" => Json::string(self.instance_id.clone()),
            "browser" => Json::string(self.browser.clone()),
            "browserVersion" => Json::string(self.browser_version.clone()),
            "extVersion" => Json::string(self.ext_version.clone()),
            "label" => Json::string(self.label.clone()),
            "protocol" => Json::string(self.protocol.clone()),
            "protocolSkew" => self.protocol_skew.as_deref().map(Json::string).unwrap_or(Json::Null),
            "localAuth" => Json::string(self.local_auth.clone()),
            "capabilities" => Json::Array(self.capabilities.iter().map(|cap| Json::string(cap.clone())).collect()),
            "connectedAt" => self.connected_at.map(|ms| Json::Number(ms as f64)).unwrap_or(Json::Null),
        }
    }
}

/// 一条活动会话摘要（daemon `status.sessions[]`）。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SessionEntry {
    pub session_id: String,
    pub instance_id: String,
    pub tab_id: Option<u64>,
    pub window_id: Option<u64>,
    pub url: String,
    pub title: String,
    pub phase: Option<String>,
    pub started_at: Option<u64>,
}

impl SessionEntry {
    fn from_json(value: &Json) -> Option<Self> {
        let object = value.as_object()?;
        let text = |key: &str| {
            object
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value)
                .and_then(Json::as_str)
                .unwrap_or("")
                .to_string()
        };
        let number = |key: &str| object.iter().find(|(name, _)| name == key).map(|(_, value)| value).and_then(Json::as_u64);
        Some(Self {
            session_id: text("sessionId"),
            instance_id: text("instanceId"),
            tab_id: number("tabId"),
            window_id: number("windowId"),
            url: text("url"),
            title: text("title"),
            phase: {
                let value = object.iter().find(|(name, _)| name == "phase").map(|(_, value)| value);
                value.and_then(Json::as_str).map(str::to_string)
            },
            started_at: number("startedAt"),
        })
    }

    fn to_json(&self) -> Json {
        crate::json_obj! {
            "sessionId" => Json::string(self.session_id.clone()),
            "instanceId" => Json::string(self.instance_id.clone()),
            "tabId" => self.tab_id.map(|id| Json::Number(id as f64)).unwrap_or(Json::Null),
            "windowId" => self.window_id.map(|id| Json::Number(id as f64)).unwrap_or(Json::Null),
            "url" => Json::string(self.url.clone()),
            "title" => Json::string(self.title.clone()),
            "phase" => self.phase.as_deref().map(Json::string).unwrap_or(Json::Null),
            "startedAt" => self.started_at.map(|ms| Json::Number(ms as f64)).unwrap_or(Json::Null),
        }
    }
}

/// 一条进行中命令摘要（daemon `status.inflight[]`）。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct InflightEntry {
    pub method: String,
    pub instance_id: String,
    pub tab_id: Option<u64>,
    pub elapsed_ms: Option<u64>,
}

impl InflightEntry {
    fn from_json(value: &Json) -> Option<Self> {
        let object = value.as_object()?;
        let text = |key: &str| {
            object
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value)
                .and_then(Json::as_str)
                .unwrap_or("")
                .to_string()
        };
        let number = |key: &str| object.iter().find(|(name, _)| name == key).map(|(_, value)| value).and_then(Json::as_u64);
        Some(Self {
            method: text("method"),
            instance_id: text("instanceId"),
            tab_id: number("tabId"),
            elapsed_ms: number("elapsedMs"),
        })
    }

    fn to_json(&self) -> Json {
        crate::json_obj! {
            "method" => Json::string(self.method.clone()),
            "instanceId" => Json::string(self.instance_id.clone()),
            "tabId" => self.tab_id.map(|id| Json::Number(id as f64)).unwrap_or(Json::Null),
            "elapsedMs" => self.elapsed_ms.map(|ms| Json::Number(ms as f64)).unwrap_or(Json::Null),
        }
    }
}

/// `status` RPC 结果的归一视图。
#[derive(Debug, Clone, PartialEq)]
pub struct StatusSnapshot {
    pub service: String,
    pub version: String,
    pub protocol: String,
    pub pid: Option<u64>,
    pub port: Option<u16>,
    pub uptime_ms: Option<u64>,
    pub browsers: Vec<BrowserEntry>,
    pub sessions: Vec<SessionEntry>,
    pub inflight: Vec<InflightEntry>,
    pub queues: Option<Json>,
    pub auth: Option<Json>,
    pub compatibility: Option<Json>,
    pub recovery: Option<Json>,
    pub raw: Json,
}

impl StatusSnapshot {
    /// 解析 `POST /rpc status` 的 `result`；缺 `service` 说明对端不是预期 daemon。
    pub fn from_result(value: &Json) -> Result<Self, RpcError> {
        if !matches!(value, Json::Object(_)) {
            return Err(RpcError::new(ErrorCode::Rpc, "status 结果不是 JSON 对象"));
        }
        let service = value.get("service").and_then(Json::as_str).unwrap_or("");
        if service != SERVICE_NAME {
            return Err(RpcError::new(
                ErrorCode::Rpc,
                format!("status 的 service 是 {service:?}，不是 {SERVICE_NAME:?}（对端不是 BridgeDeck daemon？）"),
            )
            .with_data(crate::json_obj! {
                "service" => Json::string(service),
                "expected" => Json::string(SERVICE_NAME),
            }));
        }
        let list = |key: &str| value.get(key).and_then(Json::as_array).map(<[Json]>::to_vec).unwrap_or_default();
        let browsers = list("browsers").iter().filter_map(BrowserEntry::from_json).collect();
        let sessions = list("sessions").iter().filter_map(SessionEntry::from_json).collect();
        let inflight = list("inflight").iter().filter_map(InflightEntry::from_json).collect();
        let optional = |key: &str| value.get(key).filter(|value| !value.is_null()).cloned();
        Ok(Self {
            service: service.to_string(),
            version: value.get("version").and_then(Json::as_str).unwrap_or("").to_string(),
            protocol: value.get("protocol").and_then(Json::as_str).unwrap_or("").to_string(),
            pid: value.get("pid").and_then(Json::as_u64),
            port: value.get("port").and_then(Json::as_u64).and_then(|port| u16::try_from(port).ok()),
            uptime_ms: value.get("uptimeMs").and_then(Json::as_u64),
            browsers,
            sessions,
            inflight,
            queues: optional("queues"),
            auth: optional("auth"),
            compatibility: optional("compatibility"),
            recovery: optional("recovery"),
            raw: value.clone(),
        })
    }

    /// 用 `/health` 补齐 `status` 里缺的顶层字段（两者应一致；取 health 的权威值）。
    pub fn merge_health(&mut self, health: &HealthReport) {
        if self.version.is_empty() {
            self.version = health.version.clone();
        }
        if self.protocol.is_empty() {
            self.protocol = health.protocol.clone();
        }
        self.pid = self.pid.or(health.pid);
        self.port = self.port.or(health.port);
        self.uptime_ms = self.uptime_ms.or(health.uptime_ms);
    }

    /// 与本地协议版本的一致性（复用握手协商，避免两套判断）。
    pub fn protocol_alignment(&self) -> Json {
        let negotiation = negotiate(Some(self.protocol.as_str()), PROTOCOL_CURRENT);
        crate::json_obj! {
            "client" => Json::string(PROTOCOL_CURRENT),
            "baseline" => Json::string(PROTOCOL_BASELINE),
            "daemon" => Json::string(self.protocol.clone()),
            "accepted" => Json::Bool(negotiation.accepted),
            "peerLabel" => Json::string(negotiation.peer_label.clone()),
            "skew" => negotiation.skew.map(|skew| Json::string(skew.as_str())).unwrap_or(Json::Null),
            "message" => Json::string(negotiation.message.clone()),
        }
    }
}

/// CLI 命令输出（stdout / stderr / 退出码），由 `main` 统一打印。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: u8,
}

impl CommandOutput {
    pub fn success(stdout: String) -> Self {
        Self { stdout, stderr: String::new(), exit_code: EXIT_CODE_OK }
    }

    pub fn failure(stderr: String, exit_code: u8) -> Self {
        Self { stdout: String::new(), stderr, exit_code }
    }
}

/// 统一错误渲染：JSON 模式把结构化错误写到 stdout，文本模式写 stderr；退出码 3。
pub fn error_output(error: &RpcError, json: bool) -> CommandOutput {
    error_output_with_context(error, json, None)
}

/// 带上下文的错误渲染（例如"health 通了但 /rpc status 失败"，附带已取得的发现/健康信息）。
pub fn error_output_with_context(error: &RpcError, json: bool, context: Option<Json>) -> CommandOutput {
    if json {
        let mut entries = vec![
            ("ok".to_string(), Json::Bool(false)),
            ("error".to_string(), error_body(error)),
        ];
        if let Some(context) = context {
            entries.push(("context".to_string(), context));
        }
        entries.push(("exitCode".to_string(), Json::Number(f64::from(EXIT_CODE_DAEMON))));
        CommandOutput { stdout: Json::Object(entries).to_compact_string(), stderr: String::new(), exit_code: EXIT_CODE_DAEMON }
    } else {
        CommandOutput {
            stdout: String::new(),
            stderr: format!("错误 {}：{}", error.code.as_str(), error.message),
            exit_code: EXIT_CODE_DAEMON,
        }
    }
}

fn error_body(error: &RpcError) -> Json {
    let mut entries = vec![
        ("code".to_string(), Json::string(error.code.as_str())),
        ("message".to_string(), Json::string(error.message.clone())),
    ];
    if let Some(data) = &error.data {
        entries.push(("data".to_string(), data.clone()));
    }
    if let Some(original) = &error.original_code {
        entries.push(("originalCode".to_string(), Json::string(original.clone())));
    }
    Json::Object(entries)
}

/// `status` 的 daemon 段：发现信息 + health + endpoint。
pub fn daemon_json(metadata: &DaemonMetadata, health: &HealthReport) -> Json {
    let mut base = match metadata.to_json() {
        Json::Object(entries) => entries,
        other => vec![("discovery".to_string(), other)],
    };
    base.push(("health".to_string(), health.to_json()));
    base.push(("rpcPath".to_string(), Json::string(RPC_PATH)));
    base.push(("wsPath".to_string(), Json::string(WS_PATH)));
    Json::Object(base)
}

/// 渲染 `status --json` 成功输出。
pub fn status_json(snapshot: &StatusSnapshot, metadata: &DaemonMetadata, health: &HealthReport) -> Json {
    let status = crate::json_obj! {
        "service" => Json::string(snapshot.service.clone()),
        "version" => Json::string(snapshot.version.clone()),
        "protocol" => Json::string(snapshot.protocol.clone()),
        "pid" => snapshot.pid.map(|pid| Json::Number(pid as f64)).unwrap_or(Json::Null),
        "port" => snapshot.port.map(|port| Json::Number(f64::from(port))).unwrap_or(Json::Null),
        "uptimeMs" => snapshot.uptime_ms.map(|ms| Json::Number(ms as f64)).unwrap_or(Json::Null),
        "daemon" => daemon_json(metadata, health),
        "browsers" => crate::json_obj! {
            "count" => Json::Number(snapshot.browsers.len() as f64),
            "items" => Json::Array(snapshot.browsers.iter().map(BrowserEntry::to_json).collect()),
        },
        "sessions" => crate::json_obj! {
            "count" => Json::Number(snapshot.sessions.len() as f64),
            "items" => Json::Array(snapshot.sessions.iter().map(SessionEntry::to_json).collect()),
        },
        "inflight" => crate::json_obj! {
            "count" => Json::Number(snapshot.inflight.len() as f64),
            "items" => Json::Array(snapshot.inflight.iter().map(InflightEntry::to_json).collect()),
        },
        "queues" => snapshot.queues.clone().unwrap_or(Json::Null),
        "auth" => snapshot.auth.clone().unwrap_or(Json::Null),
        "compatibility" => snapshot.compatibility.clone().unwrap_or(Json::Null),
        "recovery" => snapshot.recovery.clone().unwrap_or(Json::Null),
        "protocolAlignment" => snapshot.protocol_alignment(),
    };
    // 成功/失败的 `exitCode` 统一在顶层（与 `error_output` 的同名字段对称）。
    crate::json_obj! {
        "ok" => Json::Bool(true),
        "status" => status,
        "exitCode" => Json::Number(f64::from(EXIT_CODE_OK)),
    }
}

/// 渲染 `status` 文本成功输出。
pub fn status_text(snapshot: &StatusSnapshot, metadata: &DaemonMetadata, health: &HealthReport) -> String {
    let uptime = snapshot.uptime_ms.map(format_uptime_ms).unwrap_or_else(|| "?".to_string());
    let mut lines = vec![format!(
        "{} v{}（protocol {} / pid {} / port {} / uptime {uptime}）",
        snapshot.service,
        display_or(&snapshot.version, health.version.as_str(), &PRODUCT_VERSION),
        display_or(&snapshot.protocol, health.protocol.as_str(), PROTOCOL_CURRENT),
        snapshot.pid.map(|pid| pid.to_string()).unwrap_or_else(|| "?".to_string()),
        snapshot
            .port
            .or(health.port)
            .map(|port| port.to_string())
            .unwrap_or_else(|| metadata.port.to_string()),
    )];
    lines.push(format!(
        "daemon：{} ← {}（token 存在，{} 位；tls {}）",
        metadata.endpoint_label(),
        metadata.path.display(),
        metadata.token_len(),
        if metadata.tls { "on" } else { "off" }
    ));
    lines.push(format!(
        "discovery：home={}（{}）/ {DAEMON_FILE_NAME} / {HEALTH_PATH} / {RPC_PATH} / {WS_PATH}",
        metadata.home.display(),
        match metadata.home_source {
            HomeSource::Env => "BB_HOME",
            HomeSource::UserProfile => "USERPROFILE",
            HomeSource::Home => "HOME",
        }
    ));
    lines.push(String::new());
    lines.push(format!("browsers（{}）：", snapshot.browsers.len()));
    if snapshot.browsers.is_empty() {
        lines.push("  （无已连接浏览器）".to_string());
    } else {
        for browser in &snapshot.browsers {
            lines.push(format!(
                "  {} {} {}{} ext={} protocol={}{} localAuth={} caps={}",
                browser.instance_id,
                if browser.browser.is_empty() { "?" } else { &browser.browser },
                browser.browser_version,
                if browser.label.is_empty() { String::new() } else { format!(" [{}]", browser.label) },
                display_or(&browser.ext_version, "", "-"),
                display_or(&browser.protocol, "", "?"),
                browser.protocol_skew.as_deref().map(|skew| format!("（{skew}）")).unwrap_or_default(),
                display_or(&browser.local_auth, "", "?"),
                browser.capabilities.len(),
            ));
        }
    }
    lines.push(String::new());
    lines.push(format!("sessions（{}）：", snapshot.sessions.len()));
    if snapshot.sessions.is_empty() {
        lines.push("  （无活动 session）".to_string());
    } else {
        for session in &snapshot.sessions {
            lines.push(format!(
                "  {} tab={} instance={} phase={} url={} title={}",
                display_or(&session.session_id, "", "?"),
                session.tab_id.map(|id| id.to_string()).unwrap_or_else(|| "-".to_string()),
                display_or(&session.instance_id, "", "-"),
                session.phase.as_deref().unwrap_or("-"),
                truncate_text(&session.url, 48),
                truncate_text(&session.title, 32),
            ));
        }
    }
    lines.push(String::new());
    lines.push(format!("inflight（{}）", snapshot.inflight.len()));
    for entry in &snapshot.inflight {
        lines.push(format!(
            "  {} instance={} tab={} elapsed={}ms",
            entry.method,
            display_or(&entry.instance_id, "", "-"),
            entry.tab_id.map(|id| id.to_string()).unwrap_or_else(|| "-".to_string()),
            entry.elapsed_ms.map(|ms| ms.to_string()).unwrap_or_else(|| "?".to_string()),
        ));
    }
    let alignment = snapshot.protocol_alignment();
    lines.push(String::new());
    lines.push(format!(
        "protocol：bridge-rs {} / daemon {} → {}（{}）",
        PROTOCOL_CURRENT,
        display_or(&snapshot.protocol, "", "?"),
        if alignment.get("accepted").and_then(Json::as_bool) == Some(true) { "accepted" } else { "rejected" },
        display_or(&snapshot.protocol, "", "?"),
    ));
    lines.join("\n")
}

/// 渲染 `health --json` 成功输出。
pub fn health_json(metadata: &DaemonMetadata, health: &HealthReport) -> Json {
    crate::json_obj! {
        "ok" => Json::Bool(true),
        "daemon" => daemon_json(metadata, health),
        "health" => health.to_json(),
        "exitCode" => Json::Number(f64::from(EXIT_CODE_OK)),
    }
}

/// 渲染 `health` 文本成功输出。
pub fn health_text(metadata: &DaemonMetadata, health: &HealthReport) -> String {
    format!(
        "{} v{}（protocol {} / pid {} / port {} / uptime {} / browsers {} / sessions {} / tls {}）\n\
         endpoint：{} ← {}（token 存在，{} 位）",
        health.service,
        health.version,
        health.protocol,
        health.pid.map(|pid| pid.to_string()).unwrap_or_else(|| "?".to_string()),
        health.port.map(|port| port.to_string()).unwrap_or_else(|| metadata.port.to_string()),
        health.uptime_ms.map(format_uptime_ms).unwrap_or_else(|| "?".to_string()),
        health.browsers,
        health.sessions,
        if health.tls { "on" } else { "off" },
        metadata.endpoint_label(),
        metadata.path.display(),
        metadata.token_len(),
    )
}

fn display_or<'a>(primary: &'a str, fallback: &'a str, default: &'a str) -> &'a str {
    if !primary.is_empty() {
        primary
    } else if !fallback.is_empty() {
        fallback
    } else {
        default
    }
}

fn truncate_text(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut out: String = text.chars().take(limit).collect();
    out.push('…');
    out
}

/// 毫秒 → 人读 uptime。
pub fn format_uptime_ms(uptime_ms: u64) -> String {
    let seconds = uptime_ms / 1000;
    let days = seconds / 86_400;
    let hours = seconds % 86_400 / 3_600;
    let minutes = seconds % 3_600 / 60;
    let secs = seconds % 60;
    if days > 0 {
        format!("{days}d{hours}h{minutes}m{secs}s")
    } else if hours > 0 {
        format!("{hours}h{minutes}m{secs}s")
    } else if minutes > 0 {
        format!("{minutes}m{secs}s")
    } else if uptime_ms < 1000 {
        format!("{uptime_ms}ms")
    } else {
        format!("{secs}s")
    }
}

/// `bridge-rs status` 入口。
pub fn status_command(json: bool, timeout_ms: Option<u64>) -> CommandOutput {
    let timeout = rpc_client::normalize_timeout_ms(timeout_ms);
    let (home, metadata) = match discover() {
        Ok(pair) => pair,
        Err(error) => return error_output(&error, json),
    };
    let _ = home;
    let client = DaemonClient::new(metadata.clone());
    let health = match client.health() {
        Ok(health) => health,
        Err(error) => return error_output(&enrich_discovery(error, &metadata), json),
    };
    let result = match client.status(timeout) {
        Ok(result) => result,
        Err(error) => {
            return error_output_with_context(
                &enrich_discovery(error, &metadata),
                json,
                Some(crate::json_obj! {
                    "healthReachable" => Json::Bool(true),
                    "health" => health.to_json(),
                }),
            );
        }
    };
    let mut snapshot = match StatusSnapshot::from_result(&result) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            return error_output_with_context(&error, json, Some(health.to_json()));
        }
    };
    snapshot.merge_health(&health);
    if json {
        CommandOutput::success(status_json(&snapshot, &metadata, &health).to_compact_string())
    } else {
        CommandOutput::success(status_text(&snapshot, &metadata, &health))
    }
}

/// `bridge-rs health` 入口（只做 `GET /health`，不需要 token）。
pub fn health_command(json: bool, _timeout_ms: Option<u64>) -> CommandOutput {
    let (_, metadata) = match discover() {
        Ok(pair) => pair,
        Err(error) => return error_output(&error, json),
    };
    let client = DaemonClient::new(metadata.clone());
    match client.health() {
        Ok(health) => {
            if json {
                CommandOutput::success(health_json(&metadata, &health).to_compact_string())
            } else {
                CommandOutput::success(health_text(&metadata, &health))
            }
        }
        Err(error) => error_output(&enrich_discovery(error, &metadata), json),
    }
}

/// `bridge-rs ws-hello` 入口：真实 WebSocket 握手 + hello/hello-ack。
pub fn ws_hello_command(json: bool, timeout_ms: Option<u64>) -> CommandOutput {
    let timeout = Duration::from_millis(
        timeout_ms
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_HANDSHAKE_TIMEOUT_MS)
            .min(rpc_client::MAX_RPC_TIMEOUT_MS),
    );
    let (_, metadata) = match discover() {
        Ok(pair) => pair,
        Err(error) => return error_output(&error, json),
    };
    let client = DaemonClient::new(metadata.clone());
    if let Err(error) = client.ensure_plaintext() {
        return error_output(&error, json);
    }
    let started = Instant::now();
    let mut ws = match WsClient::connect(metadata.port, timeout) {
        Ok(ws) => ws,
        Err(error) => return error_output(&enrich_discovery(error, &metadata), json),
    };
    let hello = build_client_hello();
    let ack = match ws.hello_exchange(&hello) {
        Ok(ack) => ack,
        Err(error) => {
            return error_output(&enrich_discovery(error, &metadata), json);
        }
    };
    let elapsed_ms = started.elapsed().as_millis() as u64;
    // 立刻关闭：我们只是验证 hello-ack，不接管实例（daemon 会移除该实例）。
    let _ = ws.close(1000, "bridge-rs hello probe");
    ws.shutdown();
    let payload = crate::json_obj! {
        "ok" => Json::Bool(true),
        "ws" => crate::json_obj! {
            "path" => Json::string(crate::ws::WS_EXTENSION_PATH),
            "endpoint" => Json::string(format!("ws://{}{}", metadata.endpoint_label(), crate::ws::WS_EXTENSION_PATH)),
            "status" => Json::Number(f64::from(ws.handshake.status)),
            "acceptVerified" => Json::Bool(ws.handshake.accept == ws.handshake.expected_accept),
            "handshakeVersion" => Json::string(ws.handshake.upgrade.clone()),
            "hello" => hello.to_json(),
            "helloAck" => ack.to_json(),
            "instanceId" => Json::string(ack.instance_id.clone()),
            "daemonVersion" => Json::string(ack.daemon_version.clone()),
            "protocol" => Json::string(ack.protocol.clone()),
            "clientProtocol" => Json::string(PROTOCOL_CURRENT),
            "capabilities" => Json::Number(ack.capabilities.len() as f64),
            "localAuth" => ack.local_auth.to_json(),
            "elapsedMs" => Json::Number(elapsed_ms as f64),
            "closeCode" => Json::Number(1000.0),
        },
        "daemon" => metadata.to_json(),
        "exitCode" => Json::Number(f64::from(EXIT_CODE_OK)),
    };
    if json {
        CommandOutput::success(payload.to_compact_string())
    } else {
        let text = format!(
            "WebSocket hello/hello-ack 成功（{}ms）\n\
             endpoint：ws://{}{}（HTTP {} / accept 校验通过）\n\
             hello：browser={} ext={} protocol={}\n\
             hello-ack：instanceId={} daemon={} protocol={} capabilities={} localAuth={}（strict={}）\n\
             已发送 close(1000)，实例未被接管",
            elapsed_ms,
            metadata.endpoint_label(),
            crate::ws::WS_EXTENSION_PATH,
            ws.handshake.status,
            hello.browser,
            hello.ext_version,
            hello.protocol.as_deref().unwrap_or("?"),
            ack.instance_id,
            ack.daemon_version,
            ack.protocol,
            ack.capabilities.len(),
            ack.local_auth.state,
            ack.local_auth.strict,
        );
        CommandOutput::success(text)
    }
}

/// 本 crate 作为 WS 客户端时发送的 hello（browser 明确标 `bridge-rs`，不伪装扩展）。
pub fn build_client_hello() -> Hello {
    let mut hello = Hello::new(env!("CARGO_PKG_VERSION"), "bridge-rs", env!("CARGO_PKG_VERSION"));
    hello.protocol = Some(PROTOCOL_CURRENT.to_string());
    hello.user_agent = format!("bridge-rs/{} (std-only)", env!("CARGO_PKG_VERSION"));
    hello.label = "bridge-rs".to_string();
    hello
}

fn discover() -> Result<(DaemonHome, DaemonMetadata), RpcError> {
    let home = DaemonHome::from_env()?;
    let metadata = home.read_metadata()?;
    Ok((home, metadata))
}

/// 给发现/传输错误补上 daemon 来源信息，避免"连不上但不知道连的哪个文件"。
///
/// 会话/观察命令（`command_io`）复用同一份富化逻辑，避免两套错误上下文。
pub(crate) fn enrich_discovery(mut error: RpcError, metadata: &DaemonMetadata) -> RpcError {
    let extra = metadata.to_json();
    let extra = match extra {
        Json::Object(entries) => Json::Object(entries.into_iter().filter(|(key, _)| key != "reachable").collect()),
        other => other,
    };
    let data = match error.data.take() {
        Some(Json::Object(mut entries)) => {
            entries.push(("daemon".to_string(), extra));
            Json::Object(entries)
        }
        Some(other) => crate::json_obj! { "detail" => other, "daemon" => extra },
        None => crate::json_obj! { "daemon" => extra },
    };
    error.data = Some(data);
    error
}

/// 兼容性别名：旧版 `status` 的"未接线"入口，保留给调用方迁移期引用（现在返回真实查询）。
pub fn query_status(json: bool, timeout_ms: Option<u64>) -> CommandOutput {
    status_command(json, timeout_ms)
}

/// 客户端协议版本（诊断输出用）。
pub fn client_protocol() -> Option<ProtocolVersion> {
    ProtocolVersion::parse(PROTOCOL_CURRENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::HomeSource;
    use crate::json::Json;
    use std::path::PathBuf;

    fn obj(text: &str) -> Json {
        Json::parse(text).expect("合法 JSON 夹具")
    }

    fn metadata() -> DaemonMetadata {
        DaemonMetadata {
            pid: Some(4242),
            port: 52900,
            token: "f357544091f6998cbdb61fcd02b6e5d9".to_string(),
            version: Some("0.3.0".to_string()),
            started_at: Some(1_795_598_248_515),
            tls: false,
            path: PathBuf::from(r"C:\Users\CFT\.browser-bridge\daemon.json"),
            home: PathBuf::from(r"C:\Users\CFT\.browser-bridge"),
            home_source: HomeSource::UserProfile,
        }
    }

    fn health() -> HealthReport {
        HealthReport::from_json(&obj(
            r#"{"ok":true,"service":"browser-bridge","protocol":"1.9","version":"0.3.0","pid":4242,
                "uptimeMs":73452,"port":52900,"tls":false,"bind":"127.0.0.1","publicUrl":null,
                "browsers":1,"sessions":1}"#,
        ))
        .expect("health")
    }

    fn status_fixture() -> Json {
        obj(
            r#"{"service":"browser-bridge","version":"0.3.0","protocol":"1.9","pid":4242,"port":52900,
                "uptimeMs":73452,
                "browsers":[{"instanceId":"a1b2c3d4","browser":"edge","browserVersion":"156.0.4314.58",
                             "extVersion":"0.3.0","protocol":"1.9","protocolSkew":null,
                             "capabilities":["observe","frames"],"label":"工作实例","localAuth":"unpaired",
                             "connectedAt":1795598248515}],
                "sessions":[{"sessionId":"s-1","instanceId":"a1b2c3d4","tabId":7,"windowId":1,
                             "url":"https://example.com/path","title":"Example","phase":"ready",
                             "startedAt":1795598249000}],
                "inflight":[{"method":"observe","instanceId":"a1b2c3d4","tabId":7,"elapsedMs":42}],
                "queues":{"s-1":0},
                "auth":{"strict":false,"devices":0},
                "compatibility":{"daemon":{"protocol":"1.9","features":[]},"browsers":[]},
                "recovery":{"pending":0,"unknown":0}}"#,
        )
    }

    #[test]
    fn snapshot_parses_real_status_shape() {
        let snapshot = StatusSnapshot::from_result(&status_fixture()).expect("解析 status");
        assert_eq!(snapshot.service, SERVICE_NAME);
        assert_eq!(snapshot.version, "0.3.0");
        assert_eq!(snapshot.protocol, "1.9");
        assert_eq!(snapshot.pid, Some(4242));
        assert_eq!(snapshot.port, Some(52900));
        assert_eq!(snapshot.uptime_ms, Some(73452));
        assert_eq!(snapshot.browsers.len(), 1);
        let browser = &snapshot.browsers[0];
        assert_eq!(browser.instance_id, "a1b2c3d4");
        assert_eq!(browser.browser, "edge");
        assert_eq!(browser.ext_version, "0.3.0");
        assert_eq!(browser.label, "工作实例");
        assert_eq!(browser.local_auth, "unpaired");
        assert_eq!(browser.capabilities.len(), 2);
        assert_eq!(browser.protocol_skew, None);
        assert_eq!(snapshot.sessions.len(), 1);
        let session = &snapshot.sessions[0];
        assert_eq!(session.session_id, "s-1");
        assert_eq!(session.tab_id, Some(7));
        assert_eq!(session.url, "https://example.com/path");
        assert_eq!(session.phase.as_deref(), Some("ready"));
        assert_eq!(snapshot.inflight.len(), 1);
        assert_eq!(snapshot.inflight[0].method, "observe");
        assert_eq!(snapshot.inflight[0].elapsed_ms, Some(42));
        assert!(snapshot.queues.is_some());
        assert!(snapshot.auth.is_some());
        assert!(snapshot.compatibility.is_some());
        assert!(snapshot.recovery.is_some());
    }

    #[test]
    fn snapshot_tolerates_missing_and_odd_fields() {
        let snapshot = StatusSnapshot::from_result(&obj(r#"{"service":"browser-bridge"}"#)).expect("最小 status");
        assert_eq!(snapshot.version, "");
        assert_eq!(snapshot.pid, None);
        assert!(snapshot.browsers.is_empty());
        assert!(snapshot.sessions.is_empty());
        assert!(snapshot.inflight.is_empty());
        assert!(snapshot.queues.is_none());
        // 非对象条目被跳过而不是让整个 status 失败（对端新增/改形状时不炸）。
        let snapshot = StatusSnapshot::from_result(&obj(
            r#"{"service":"browser-bridge","browsers":[null,7,"x",{"instanceId":"ok"}],"sessions":{}}"#,
        ))
        .expect("容忍坏条目");
        assert_eq!(snapshot.browsers.len(), 1);
        assert_eq!(snapshot.browsers[0].instance_id, "ok");
        assert!(snapshot.sessions.is_empty());
    }

    #[test]
    fn snapshot_rejects_foreign_daemon() {
        for text in [r#"{"service":"other"}"#, "[]", "null"] {
            let error = StatusSnapshot::from_result(&obj(text)).expect_err("必须拒绝");
            assert_eq!(error.code, ErrorCode::Rpc, "夹具 {text}");
        }
    }

    #[test]
    fn merge_health_fills_missing_fields() {
        let mut snapshot = StatusSnapshot::from_result(&obj(r#"{"service":"browser-bridge"}"#)).expect("snapshot");
        snapshot.merge_health(&health());
        assert_eq!(snapshot.version, "0.3.0");
        assert_eq!(snapshot.protocol, "1.9");
        assert_eq!(snapshot.pid, Some(4242));
        assert_eq!(snapshot.port, Some(52900));
        assert_eq!(snapshot.uptime_ms, Some(73452));
        // status 已有值时不被 health 覆盖。
        let mut snapshot = StatusSnapshot::from_result(&status_fixture()).expect("snapshot");
        snapshot.merge_health(&health());
        assert_eq!(snapshot.pid, Some(4242));
    }

    #[test]
    fn protocol_alignment_uses_handshake_negotiation() {
        let snapshot = StatusSnapshot::from_result(&status_fixture()).expect("snapshot");
        let alignment = snapshot.protocol_alignment();
        assert_eq!(alignment.get("client").and_then(Json::as_str), Some("1.9"));
        assert_eq!(alignment.get("daemon").and_then(Json::as_str), Some("1.9"));
        assert_eq!(alignment.get("accepted").and_then(Json::as_bool), Some(true));
        assert_eq!(alignment.get("skew"), Some(&Json::Null));
        assert_eq!(alignment.get("baseline").and_then(Json::as_str), Some("1.8"));
        // 1.8 daemon：accepted=true 但 skew=older。
        let mut old = snapshot.clone();
        old.protocol = "1.8".to_string();
        let alignment = old.protocol_alignment();
        assert_eq!(alignment.get("accepted").and_then(Json::as_bool), Some(true));
        assert_eq!(alignment.get("skew").and_then(Json::as_str), Some("older"));
        // 2.0 daemon：major 不兼容，拒绝。
        let mut future = snapshot;
        future.protocol = "2.0".to_string();
        assert_eq!(future.protocol_alignment().get("accepted").and_then(Json::as_bool), Some(false));
    }

    #[test]
    fn status_json_shape_is_stable_and_token_free() {
        let snapshot = StatusSnapshot::from_result(&status_fixture()).expect("snapshot");
        let json = status_json(&snapshot, &metadata(), &health());
        let encoded = json.to_compact_string();
        assert_eq!(json.get("ok").and_then(Json::as_bool), Some(true));
        let status = json.get("status").expect("status");
        assert_eq!(status.get("service").and_then(Json::as_str), Some(SERVICE_NAME));
        assert_eq!(status.get("version").and_then(Json::as_str), Some("0.3.0"));
        assert_eq!(status.get("protocol").and_then(Json::as_str), Some("1.9"));
        assert_eq!(status.get("pid").and_then(Json::as_u64), Some(4242));
        assert_eq!(status.get("port").and_then(Json::as_u64), Some(52900));
        assert_eq!(json.get("exitCode").and_then(Json::as_u64), Some(0), "exitCode 在顶层");
        let daemon = status.get("daemon").expect("daemon");
        assert_eq!(daemon.get("reachable").and_then(Json::as_bool), Some(true));
        assert_eq!(daemon.get("endpoint").and_then(Json::as_str), Some("127.0.0.1:52900"));
        assert_eq!(daemon.get("tls").and_then(Json::as_bool), Some(false));
        assert_eq!(daemon.get("tokenPresent").and_then(Json::as_bool), Some(true));
        assert_eq!(daemon.get("tokenLength").and_then(Json::as_u64), Some(32));
        assert_eq!(daemon.get("healthPath").and_then(Json::as_str), Some("/health"));
        assert_eq!(daemon.get("rpcPath").and_then(Json::as_str), Some("/rpc"));
        assert!(daemon.get("health").is_some());
        assert!(!encoded.contains("f357544091f6998cbdb61fcd02b6e5d9"), "绝不能输出 token：{encoded}");
        let browsers = status.get("browsers").expect("browsers");
        assert_eq!(browsers.get("count").and_then(Json::as_u64), Some(1));
        assert_eq!(
            browsers.get("items").and_then(Json::as_array).and_then(|items| items.first()).and_then(|item| item.get("browser")).and_then(Json::as_str),
            Some("edge")
        );
        assert_eq!(status.get("sessions").and_then(|sessions| sessions.get("count")).and_then(Json::as_u64), Some(1));
        assert_eq!(status.get("inflight").and_then(|inflight| inflight.get("count")).and_then(Json::as_u64), Some(1));
        assert_eq!(
            status.get("protocolAlignment").and_then(|alignment| alignment.get("accepted")).and_then(Json::as_bool),
            Some(true)
        );
    }

    #[test]
    fn status_text_mentions_every_section() {
        let snapshot = StatusSnapshot::from_result(&status_fixture()).expect("snapshot");
        let text = status_text(&snapshot, &metadata(), &health());
        assert!(text.contains("browser-bridge v0.3.0"));
        assert!(text.contains("protocol 1.9"));
        assert!(text.contains("pid 4242"));
        assert!(text.contains("port 52900"));
        assert!(text.contains("uptime 1m13s"));
        assert!(text.contains("daemon：127.0.0.1:52900"), "{text}");
        assert!(text.contains("browsers（1）"));
        assert!(text.contains("a1b2c3d4 edge 156.0.4314.58"));
        assert!(text.contains("sessions（1）"));
        assert!(text.contains("s-1 tab=7"));
        assert!(text.contains("inflight（1）"));
        assert!(text.contains("observe"));
        assert!(text.contains("accepted"));
        // 文本输出同样不能泄漏 token。
        assert!(!text.contains("f357544091f6998cbdb61fcd02b6e5d9"));
    }

    #[test]
    fn empty_status_text_is_explicit() {
        let snapshot = StatusSnapshot::from_result(&obj(r#"{"service":"browser-bridge","version":"0.3.0","protocol":"1.9"}"#))
            .expect("snapshot");
        let text = status_text(&snapshot, &metadata(), &health());
        assert!(text.contains("（无已连接浏览器）"));
        assert!(text.contains("（无活动 session）"));
        assert!(text.contains("inflight（0）"));
    }

    #[test]
    fn health_outputs_are_consistent() {
        let json = health_json(&metadata(), &health());
        assert_eq!(json.get("ok").and_then(Json::as_bool), Some(true));
        assert_eq!(json.get("exitCode").and_then(Json::as_u64), Some(0));
        assert_eq!(
            json.get("health").and_then(|health| health.get("sessions")).and_then(Json::as_u64),
            Some(1)
        );
        let text = health_text(&metadata(), &health());
        assert!(text.contains("browser-bridge v0.3.0"));
        assert!(text.contains("protocol 1.9"));
        assert!(text.contains("uptime 1m13s"));
        assert!(text.contains("endpoint：127.0.0.1:52900"));
        assert!(!text.contains("f357544091f6998cbdb61fcd02b6e5d9"));
    }

    #[test]
    fn error_output_json_keeps_structured_code() {
        let error = RpcError::new(ErrorCode::NoDaemon, "找不到 daemon 发现文件")
            .with_data(crate::json_obj! { "discoveryFile" => Json::string(r"C:\h\daemon.json") });
        let output = error_output(&error, true);
        assert_eq!(output.exit_code, EXIT_CODE_DAEMON);
        assert_eq!(output.exit_code, 3);
        assert!(output.stderr.is_empty());
        let json = Json::parse(&output.stdout).expect("错误输出必须是 JSON");
        assert_eq!(json.get("ok").and_then(Json::as_bool), Some(false));
        assert_eq!(json.get("exitCode").and_then(Json::as_u64), Some(3));
        let body = json.get("error").expect("error");
        assert_eq!(body.get("code").and_then(Json::as_str), Some("E_NO_DAEMON"));
        assert_eq!(body.get("message").and_then(Json::as_str), Some("找不到 daemon 发现文件"));
        assert!(body.get("data").expect("data").get("discoveryFile").is_some());
    }

    #[test]
    fn error_output_text_goes_to_stderr() {
        let error = RpcError::new(ErrorCode::DaemonTimeout, "读响应头失败");
        let output = error_output(&error, false);
        assert_eq!(output.exit_code, 3);
        assert!(output.stdout.is_empty());
        assert_eq!(output.stderr, "错误 E_DAEMON_TIMEOUT：读响应头失败");
    }

    #[test]
    fn error_output_with_context_carries_health() {
        let error = RpcError::new(ErrorCode::Auth, "invalid token");
        let output = error_output_with_context(&error, true, Some(health().to_json()));
        let json = Json::parse(&output.stdout).expect("JSON");
        assert_eq!(json.get("context").and_then(|context| context.get("sessions")).and_then(Json::as_u64), Some(1));
        assert_eq!(json.get("exitCode").and_then(Json::as_u64), Some(3));
    }

    #[test]
    fn enrich_discovery_attaches_file_without_token() {
        let error = RpcError::new(ErrorCode::NoDaemon, "connect refused");
        let enriched = enrich_discovery(error, &metadata());
        let data = enriched.data.clone().expect("data");
        let daemon = data.get("daemon").expect("daemon");
        assert_eq!(daemon.get("endpoint").and_then(Json::as_str), Some("127.0.0.1:52900"));
        assert_eq!(daemon.get("tokenPresent").and_then(Json::as_bool), Some(true));
        assert!(daemon.get("reachable").is_none(), "错误上下文不应伪造可达");
        assert!(!enriched.to_json().to_compact_string().contains("f357544091f6998cbdb61fcd02b6e5d9"));
    }

    #[test]
    fn ws_client_hello_is_honest_about_identity() {
        let hello = build_client_hello();
        assert_eq!(hello.browser, "bridge-rs");
        assert_eq!(hello.ext_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(hello.protocol.as_deref(), Some(PROTOCOL_CURRENT));
        assert_eq!(hello.label, "bridge-rs");
        assert!(hello.capabilities.is_empty(), "不伪装扩展能力位");
        let json = hello.to_json();
        assert_eq!(json.get("type").and_then(Json::as_str), Some("hello"));
        assert_eq!(json.get("protocol").and_then(Json::as_str), Some("1.9"));
    }

    #[test]
    fn uptime_formatting_is_human_readable() {
        assert_eq!(format_uptime_ms(0), "0ms");
        assert_eq!(format_uptime_ms(999), "999ms");
        assert_eq!(format_uptime_ms(1_000), "1s");
        assert_eq!(format_uptime_ms(60_500), "1m0s");
        assert_eq!(format_uptime_ms(3_661_000), "1h1m1s");
        assert_eq!(format_uptime_ms(90_061_000), "1d1h1m1s");
        assert_eq!(format_uptime_ms(73_452), "1m13s");
    }

    #[test]
    fn truncate_text_uses_char_boundary() {
        assert_eq!(truncate_text("short", 10), "short");
        assert_eq!(truncate_text("中文中文", 2), "中文…");
        assert_eq!(truncate_text("abcdef", 3), "abc…");
    }

    #[test]
    fn exit_codes_are_frozen() {
        assert_eq!(EXIT_CODE_OK, 0);
        assert_eq!(EXIT_CODE_USAGE, 2);
        assert_eq!(EXIT_CODE_DAEMON, 3);
        assert_eq!(client_protocol().map(|version| version.label()), Some(PROTOCOL_CURRENT.to_string()));
    }
}

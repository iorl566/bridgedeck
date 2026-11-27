//! hello / hello-ack 握手编解码 + 协议版本协商（1.8 / 1.9 / 2.0）。
//!
//! 形状只读对齐 `daemon/server.mjs`（`normalizeHello` / `registerInstance` / `protocolSupported`）
//! 与 `docs/PROTOCOL.md` §3.1 / §52：
//! - 同一 major（1）内允许 minor 偏斜：1.8 老扩展可连接，但缺 1.9 的 9 个 feature floor；
//! - major ≠ 1（如 2.0）拒绝，错误码 `E_PROTOCOL_UNSUPPORTED`；
//! - 不带 `protocol` 的旧客户端按 1.0 处理（同 daemon 注释）；
//! - daemon 的 `protocolSkew` 返回 `"older"` / `"newer"` / `null`。

use std::cmp::Ordering;
use std::fmt;

use crate::envelope::RpcError;
use crate::errors::ErrorCode;
use crate::generated::protocol_catalog::{FeatureSpec, FEATURE_FLOORS, PROTOCOL_CURRENT, PRODUCT_VERSION};
use crate::json::Json;

pub const WS_TYPE_HELLO: &str = "hello";
pub const WS_TYPE_HELLO_ACK: &str = "hello-ack";
pub const WS_TYPE_HELLO_ERROR: &str = "hello-error";

/// capabilities 上限（daemon `normalizeHello` 截断到 32 条）。
pub const MAX_CAPABILITIES: usize = 32;
/// browserId 上限（daemon `slice(0, 64)`）。
pub const MAX_BROWSER_ID_CHARS: usize = 64;
/// 实例名上限（daemon `trim().slice(0, 40)`）。
pub const MAX_LABEL_CHARS: usize = 40;

/// daemon 能力位（只读参考 `daemon/server.mjs` 的 `DAEMON_CAPABILITIES`）。
pub const DAEMON_CAPABILITIES: [&str; 12] = [
    "observe",
    "frames",
    "dialog",
    "screenshot",
    "network",
    "rules",
    "video",
    "recording",
    "pairing",
    "tls",
    "unverified",
    "dom-read",
];

/// 协议版本（major.minor）。与 JS `parseProtocol` 的字符串分支一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProtocolVersion {
    pub major: u32,
    pub minor: u32,
}

impl ProtocolVersion {
    pub const V1_0: ProtocolVersion = ProtocolVersion { major: 1, minor: 0 };
    pub const V1_8: ProtocolVersion = ProtocolVersion { major: 1, minor: 8 };
    pub const V1_9: ProtocolVersion = ProtocolVersion { major: 1, minor: 9 };
    pub const V2_0: ProtocolVersion = ProtocolVersion { major: 2, minor: 0 };

    pub fn new(major: u32, minor: u32) -> Self {
        Self { major, minor }
    }

    /// `"1.9"` / `"1"` → 版本；无法解析返回 `None`。
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        if text.is_empty() {
            return None;
        }
        let mut parts = text.split('.');
        let major = parse_u32(parts.next()?)?;
        let minor = match parts.next() {
            Some(part) => parse_u32(part)?,
            None => 0,
        };
        if parts.next().is_some() {
            return None;
        }
        Some(Self { major, minor })
    }

    /// daemon `parseProtocol` 的 JSON 分支：字符串走 [`Self::parse`]；数字只认整数 major
    /// （`daemon/server.mjs` 把数字的 minor 固定为 0，非整数 major 会被兼容检查拒绝）。
    pub fn from_json(value: &Json) -> Option<Self> {
        match value {
            Json::String(text) => Self::parse(text),
            Json::Number(number) if number.is_finite() && *number >= 0.0 && number.fract() == 0.0 => {
                Some(Self { major: *number as u32, minor: 0 })
            }
            _ => None,
        }
    }

    pub fn label(self) -> String {
        format!("{}.{}", self.major, self.minor)
    }

    pub fn is_compatible_major(self) -> bool {
        self.major == 1
    }

    pub fn at_least(self, required: ProtocolVersion) -> bool {
        self >= required
    }
}

impl fmt::Display for ProtocolVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.label())
    }
}

fn parse_u32(text: &str) -> Option<u32> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// 同 major 下的 minor 偏斜方向。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolSkew {
    Older,
    Newer,
}

impl ProtocolSkew {
    pub fn as_str(self) -> &'static str {
        match self {
            ProtocolSkew::Older => "older",
            ProtocolSkew::Newer => "newer",
        }
    }
}

/// 协商结果：是否接受、偏斜方向、拒绝原因。
#[derive(Debug, Clone, PartialEq)]
pub struct Negotiation {
    pub peer: Option<ProtocolVersion>,
    pub peer_label: String,
    pub accepted: bool,
    pub skew: Option<ProtocolSkew>,
    pub code: Option<ErrorCode>,
    pub message: String,
}

impl Negotiation {
    pub fn is_accepted(&self) -> bool {
        self.accepted
    }

    pub fn to_json(&self) -> Json {
        crate::json_obj! {
            "peer" => Json::string(self.peer_label.clone()),
            "major" => self.peer.map(|peer| Json::Number(peer.major as f64)).unwrap_or(Json::Null),
            "minor" => self.peer.map(|peer| Json::Number(peer.minor as f64)).unwrap_or(Json::Null),
            "accepted" => Json::Bool(self.accepted),
            "skew" => match self.skew {
                Some(skew) => Json::string(skew.as_str()),
                None => Json::Null,
            },
            "code" => match self.code {
                Some(code) => Json::string(code.as_str()),
                None => Json::Null,
            },
            "message" => Json::string(self.message.clone()),
        }
    }
}

/// 协商入口（纯函数，便于用 1.8/2.0 构造负例）。
///
/// `peer` 为 `None` 表示旧客户端没有上报协议版本 → 按 1.0 处理（daemon 注释）。
pub fn negotiate(peer: Option<&str>, current: &str) -> Negotiation {
    let current = ProtocolVersion::parse(current).unwrap_or(ProtocolVersion::V1_9);
    let (peer_version, peer_label) = match peer.map(str::trim).filter(|text| !text.is_empty()) {
        None => (Some(ProtocolVersion::V1_0), "1.0".to_string()),
        Some(text) => match ProtocolVersion::parse(text) {
            Some(version) => (Some(version), version.label()),
            None => (None, text.to_string()),
        },
    };
    let Some(version) = peer_version else {
        return Negotiation {
            peer: None,
            peer_label,
            accepted: false,
            skew: None,
            code: Some(ErrorCode::ProtocolUnsupported),
            message: format!("无法解析对端协议版本（当前 daemon 协议 {}）", current.label()),
        };
    };
    if !version.is_compatible_major() {
        return Negotiation {
            peer: Some(version),
            peer_label: version.label(),
            accepted: false,
            skew: None,
            code: Some(ErrorCode::ProtocolUnsupported),
            message: format!(
                "扩展协议版本 {} 与 daemon（{}）不兼容：major 必须为 1",
                version.label(),
                current.label()
            ),
        };
    }
    let skew = match version.cmp(&current) {
        Ordering::Less => Some(ProtocolSkew::Older),
        Ordering::Greater => Some(ProtocolSkew::Newer),
        Ordering::Equal => None,
    };
    let message = match (version.cmp(&current), peer.is_some()) {
        (Ordering::Equal, _) => "协议版本一致".to_string(),
        (Ordering::Less, false) => format!("旧客户端未上报 protocol，按 1.0 处理（当前 {}）", current.label()),
        (Ordering::Less, true) => {
            format!("同 major minor 偏斜：对端 {} 旧于 daemon {}", version.label(), current.label())
        }
        (Ordering::Greater, _) => {
            format!("同 major minor 偏斜：对端 {} 新于 daemon {}", version.label(), current.label())
        }
    };
    Negotiation { peer: Some(version), peer_label: version.label(), accepted: true, skew, code: None, message }
}

/// 单个 feature floor 在对端协议下的可用性。
#[derive(Debug, Clone, PartialEq)]
pub struct FeatureAvailability {
    pub feature: &'static str,
    pub floor: &'static str,
    pub label: &'static str,
    pub kind: &'static str,
    pub available: bool,
}

impl FeatureAvailability {
    pub fn to_json(&self) -> Json {
        crate::json_obj! {
            "feature" => Json::string(self.feature),
            "required" => Json::string(self.floor),
            "label" => Json::string(self.label),
            "kind" => Json::string(self.kind),
            "available" => Json::Bool(self.available),
        }
    }
}

fn peer_version(peer: Option<&str>) -> ProtocolVersion {
    peer.map(str::trim)
        .filter(|text| !text.is_empty())
        .and_then(ProtocolVersion::parse)
        .unwrap_or(ProtocolVersion::V1_0)
}

/// 对端协议下 9 个 feature floor 的可用性快照（`status` / `protocol` 展示用）。
pub fn feature_availability(peer: Option<&str>) -> Vec<FeatureAvailability> {
    let version = peer_version(peer);
    FEATURE_FLOORS
        .iter()
        .map(|spec: &FeatureSpec| FeatureAvailability {
            feature: spec.feature,
            floor: spec.floor,
            label: spec.label,
            kind: spec.kind,
            available: ProtocolVersion::parse(spec.floor).is_some_and(|floor| version.at_least(floor)),
        })
        .collect()
}

/// 缺失的 feature 名（1.8 对端 = 全部 9 个；1.9 = 空）。
pub fn missing_features(peer: Option<&str>) -> Vec<&'static str> {
    feature_availability(peer)
        .into_iter()
        .filter(|feature| !feature.available)
        .map(|feature| feature.feature)
        .collect()
}

/// 派发前 feature 门：对端缺能力位时返回 `E_PROTOCOL_UNSUPPORTED`（与 `lib/protocol-features.mjs` 同码）。
pub fn gate_feature(peer: Option<&str>, feature: &str) -> Result<(), RpcError> {
    let Some(spec) = FEATURE_FLOORS.iter().find(|spec| spec.feature == feature) else {
        // 未登记的 feature 不设门（与 JS featuresForCall 忽略未知 feature 一致）。
        return Ok(());
    };
    let version = peer_version(peer);
    let Some(floor) = ProtocolVersion::parse(spec.floor) else {
        return Ok(());
    };
    if version.at_least(floor) {
        return Ok(());
    }
    let actual = peer.map(str::to_string).unwrap_or_else(|| "1.0".to_string());
    let message = format!(
        "浏览器扩展协议版本过低，缺少特性：{}（需要 {}，当前 {}）",
        spec.feature, spec.floor, actual
    );
    Err(RpcError::new(ErrorCode::ProtocolUnsupported, message).with_data(crate::json_obj! {
        "feature" => Json::string(spec.feature),
        "required" => Json::string(spec.floor),
        "actual" => Json::string(actual),
        "label" => Json::string(spec.label),
    }))
}

/// hello.settings 归一（daemon `normalizeSettings`：缺省 true、`longShotMode` 只认 manual）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelloSettings {
    pub borrow_confirm: bool,
    pub allow_help: bool,
    pub page_guard: bool,
    pub long_shot_mode: String,
}

impl Default for HelloSettings {
    fn default() -> Self {
        Self { borrow_confirm: true, allow_help: true, page_guard: true, long_shot_mode: "auto".to_string() }
    }
}

impl HelloSettings {
    pub fn from_json(value: Option<&Json>) -> Self {
        let Some(Json::Object(entries)) = value else {
            return Self::default();
        };
        let get = |key: &str| entries.iter().find(|(name, _)| name == key).map(|(_, value)| value);
        let borrow_confirm = get("borrowConfirm").and_then(Json::as_bool) != Some(false);
        let allow_help = get("allowHelp").and_then(Json::as_bool) != Some(false);
        let page_guard = get("pageGuard").and_then(Json::as_bool) != Some(false);
        let long_shot_mode = match get("longShotMode").and_then(Json::as_str) {
            Some("manual") => "manual".to_string(),
            _ => "auto".to_string(),
        };
        Self { borrow_confirm, allow_help, page_guard, long_shot_mode }
    }

    pub fn to_json(&self) -> Json {
        crate::json_obj! {
            "borrowConfirm" => Json::Bool(self.borrow_confirm),
            "allowHelp" => Json::Bool(self.allow_help),
            "pageGuard" => Json::Bool(self.page_guard),
            "longShotMode" => Json::string(self.long_shot_mode.clone()),
        }
    }
}

/// 扩展 → daemon 的 hello（服务端解码时按 `normalizeHello` 归一）。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Hello {
    pub ext_version: String,
    pub browser: String,
    pub browser_version: String,
    pub user_agent: String,
    /// 原始协议字段（数字会归一为 `"1.0"`；非法形态记 `"invalid"`）。
    pub protocol: Option<String>,
    pub capabilities: Vec<String>,
    /// 重连提示（8 位 hex；daemon 只认合法提示，实际 instanceId 由 daemon 决定）。
    pub instance_id: Option<String>,
    pub browser_id: String,
    pub label: String,
    pub settings: HelloSettings,
    pub pair_token: Option<String>,
    pub pair_code: Option<String>,
    pub auth_challenge: bool,
    pub auth_key_id: Option<String>,
    pub local_verified: bool,
}

impl Hello {
    pub fn new(ext_version: impl Into<String>, browser: impl Into<String>, browser_version: impl Into<String>) -> Self {
        let ext_version = ext_version.into();
        let browser = browser.into();
        let browser_version = browser_version.into();
        Self {
            ext_version,
            browser: browser_or_unknown(&browser),
            browser_version,
            ..Self::default()
        }
    }

    /// daemon normalizeHello 的 `protocol` 字段（无法解析 → `"0"`）。
    pub fn protocol_label(&self) -> String {
        self.protocol_version().map(|version| version.label()).unwrap_or_else(|| "0".to_string())
    }

    pub fn protocol_version(&self) -> Option<ProtocolVersion> {
        self.protocol.as_deref().and_then(ProtocolVersion::parse)
    }

    pub fn requested_instance_id(&self) -> Option<&str> {
        self.instance_id.as_deref().filter(|hint| is_instance_id(hint))
    }

    pub fn to_json(&self) -> Json {
        let mut entries = vec![
            ("type".to_string(), Json::string(WS_TYPE_HELLO)),
            ("extVersion".to_string(), Json::string(self.ext_version.clone())),
            ("browser".to_string(), Json::string(self.browser.clone())),
            ("browserVersion".to_string(), Json::string(self.browser_version.clone())),
            ("userAgent".to_string(), Json::string(self.user_agent.clone())),
        ];
        if let Some(protocol) = &self.protocol {
            entries.push(("protocol".to_string(), Json::string(protocol.clone())));
        }
        entries.push((
            "capabilities".to_string(),
            Json::Array(self.capabilities.iter().map(|cap| Json::string(cap.clone())).collect()),
        ));
        entries.push(("settings".to_string(), self.settings.to_json()));
        if let Some(instance_id) = &self.instance_id {
            entries.push(("instanceId".to_string(), Json::string(instance_id.clone())));
        }
        if !self.browser_id.is_empty() {
            entries.push(("browserId".to_string(), Json::string(self.browser_id.clone())));
        }
        if !self.label.is_empty() {
            entries.push(("label".to_string(), Json::string(self.label.clone())));
        }
        if let Some(token) = &self.pair_token {
            entries.push(("pairToken".to_string(), Json::string(token.clone())));
        }
        if let Some(code) = &self.pair_code {
            entries.push(("pairCode".to_string(), Json::string(code.clone())));
        }
        if self.auth_challenge {
            entries.push(("authChallenge".to_string(), Json::Bool(true)));
        }
        if let Some(key_id) = &self.auth_key_id {
            entries.push(("authKeyId".to_string(), Json::string(key_id.clone())));
        }
        if self.local_verified {
            entries.push(("localVerified".to_string(), Json::Bool(true)));
        }
        Json::Object(entries)
    }

    pub fn from_json(value: &Json) -> Result<Self, RpcError> {
        if value.get("type").and_then(Json::as_str) != Some(WS_TYPE_HELLO) {
            return Err(RpcError::bad_request("hello 帧 type 必须为 \"hello\""));
        }
        let settings = HelloSettings::from_json(value.get("settings"));
        let ext_version = string_field(value, "extVersion");
        let browser = browser_or_unknown(&string_field(value, "browser"));
        let browser_version = string_field(value, "browserVersion");
        let user_agent = string_field(value, "userAgent");
        let protocol = match value.get("protocol") {
            None | Some(Json::Null) => None,
            Some(Json::String(text)) => Some(text.clone()),
            Some(Json::Number(number)) if number.is_finite() && *number >= 0.0 && number.fract() == 0.0 => {
                Some(format!("{}.0", *number as u64))
            }
            Some(_) => Some("invalid".to_string()),
        };
        let capabilities = value
            .get("capabilities")
            .and_then(Json::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Json::as_str)
                    .take(MAX_CAPABILITIES)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let instance_id = value
            .get("instanceId")
            .and_then(Json::as_str)
            .map(str::to_lowercase)
            .filter(|hint| is_instance_id(hint));
        let browser_id = truncate_chars(&string_field(value, "browserId"), MAX_BROWSER_ID_CHARS);
        let label = truncate_chars(string_field(value, "label").trim(), MAX_LABEL_CHARS);
        Ok(Self {
            ext_version,
            browser,
            browser_version,
            user_agent,
            protocol,
            capabilities,
            instance_id,
            browser_id,
            label,
            settings,
            pair_token: non_empty(string_field(value, "pairToken")),
            pair_code: non_empty(string_field(value, "pairCode")),
            auth_challenge: value.get("authChallenge").and_then(Json::as_bool) == Some(true),
            auth_key_id: non_empty(string_field(value, "authKeyId")),
            local_verified: value.get("localVerified").and_then(Json::as_bool) == Some(true),
        })
    }

    pub fn from_text(text: &str) -> Result<Self, RpcError> {
        let value = Json::parse(text).map_err(|error| RpcError::bad_json(&error))?;
        Self::from_json(&value)
    }
}

/// hello-ack 的 localAuth 子对象。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalAuth {
    /// `verified` / `unpaired`。
    pub state: String,
    pub strict: bool,
}

impl LocalAuth {
    pub fn verified(strict: bool) -> Self {
        Self { state: "verified".to_string(), strict }
    }

    pub fn unpaired(strict: bool) -> Self {
        Self { state: "unpaired".to_string(), strict }
    }

    pub fn is_verified(&self) -> bool {
        self.state == "verified"
    }

    pub fn to_json(&self) -> Json {
        crate::json_obj! {
            "state" => Json::string(self.state.clone()),
            "strict" => Json::Bool(self.strict),
        }
    }

    pub fn from_json(value: Option<&Json>) -> Self {
        let Some(Json::Object(entries)) = value else {
            return Self::unpaired(false);
        };
        let get = |key: &str| entries.iter().find(|(name, _)| name == key).map(|(_, value)| value);
        let state = match get("state").and_then(Json::as_str) {
            Some("verified") => "verified".to_string(),
            _ => "unpaired".to_string(),
        };
        Self { state, strict: get("strict").and_then(Json::as_bool) == Some(true) }
    }
}

/// daemon → 扩展的 hello-ack。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelloAck {
    pub instance_id: String,
    pub daemon_version: String,
    pub protocol: String,
    pub capabilities: Vec<String>,
    pub local_auth: LocalAuth,
    pub server_proof: Option<String>,
    pub device_token: Option<String>,
    /// 首次激活为 `pending`。
    pub device_status: Option<String>,
    pub commit_txn: Option<String>,
    pub commit_proof: Option<String>,
}

impl HelloAck {
    pub fn new(instance_id: impl Into<String>, daemon_version: impl Into<String>, protocol: impl Into<String>) -> Self {
        Self {
            instance_id: instance_id.into(),
            daemon_version: daemon_version.into(),
            protocol: protocol.into(),
            capabilities: Vec::new(),
            local_auth: LocalAuth::unpaired(false),
            server_proof: None,
            device_token: None,
            device_status: None,
            commit_txn: None,
            commit_proof: None,
        }
    }

    pub fn to_json(&self) -> Json {
        let mut entries = vec![
            ("type".to_string(), Json::string(WS_TYPE_HELLO_ACK)),
            ("instanceId".to_string(), Json::string(self.instance_id.clone())),
            ("daemonVersion".to_string(), Json::string(self.daemon_version.clone())),
            ("protocol".to_string(), Json::string(self.protocol.clone())),
            (
                "capabilities".to_string(),
                Json::Array(self.capabilities.iter().map(|cap| Json::string(cap.clone())).collect()),
            ),
            ("localAuth".to_string(), self.local_auth.to_json()),
        ];
        if let Some(proof) = &self.server_proof {
            entries.push(("serverProof".to_string(), Json::string(proof.clone())));
        }
        if let Some(token) = &self.device_token {
            entries.push(("deviceToken".to_string(), Json::string(token.clone())));
        }
        if let Some(status) = &self.device_status {
            entries.push(("deviceStatus".to_string(), Json::string(status.clone())));
        }
        if let Some(txn) = &self.commit_txn {
            entries.push(("commitTxn".to_string(), Json::string(txn.clone())));
        }
        if let Some(proof) = &self.commit_proof {
            entries.push(("commitProof".to_string(), Json::string(proof.clone())));
        }
        Json::Object(entries)
    }

    pub fn from_json(value: &Json) -> Result<Self, RpcError> {
        if value.get("type").and_then(Json::as_str) != Some(WS_TYPE_HELLO_ACK) {
            return Err(RpcError::bad_request("hello-ack 帧 type 必须为 \"hello-ack\""));
        }
        let instance_id = string_field(value, "instanceId");
        if instance_id.is_empty() {
            return Err(RpcError::bad_request("hello-ack 缺少字符串 instanceId"));
        }
        let capabilities = value
            .get("capabilities")
            .and_then(Json::as_array)
            .map(|items| items.iter().filter_map(Json::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        Ok(Self {
            instance_id,
            daemon_version: string_field(value, "daemonVersion"),
            protocol: match non_empty(string_field(value, "protocol")) {
                Some(protocol) => protocol,
                None => PROTOCOL_CURRENT.to_string(),
            },
            capabilities,
            local_auth: LocalAuth::from_json(value.get("localAuth")),
            server_proof: non_empty(string_field(value, "serverProof")),
            device_token: non_empty(string_field(value, "deviceToken")),
            device_status: non_empty(string_field(value, "deviceStatus")),
            commit_txn: non_empty(string_field(value, "commitTxn")),
            commit_proof: non_empty(string_field(value, "commitProof")),
        })
    }

    pub fn from_text(text: &str) -> Result<Self, RpcError> {
        let value = Json::parse(text).map_err(|error| RpcError::bad_json(&error))?;
        Self::from_json(&value)
    }
}

/// daemon → 扩展的握手错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelloError {
    pub code: ErrorCode,
    pub message: String,
}

impl HelloError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn to_json(&self) -> Json {
        crate::json_obj! {
            "type" => Json::string(WS_TYPE_HELLO_ERROR),
            "code" => Json::string(self.code.as_str()),
            "message" => Json::string(self.message.clone()),
        }
    }

    pub fn from_json(value: &Json) -> Result<Self, RpcError> {
        if value.get("type").and_then(Json::as_str) != Some(WS_TYPE_HELLO_ERROR) {
            return Err(RpcError::bad_request("hello-error 帧 type 必须为 \"hello-error\""));
        }
        let code = value
            .get("code")
            .and_then(Json::as_str)
            .ok_or_else(|| RpcError::bad_request("hello-error 缺少字符串 code"))?;
        Ok(Self {
            code: crate::errors::resolve(code),
            message: string_field(value, "message"),
        })
    }
}

/// daemon 身份（hello-ack / status 展示共用）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DaemonProfile {
    pub daemon_version: String,
    pub protocol: String,
    pub capabilities: Vec<String>,
    pub strict_local: bool,
}

impl Default for DaemonProfile {
    fn default() -> Self {
        Self::current()
    }
}

impl DaemonProfile {
    pub fn current() -> Self {
        Self {
            daemon_version: PRODUCT_VERSION.to_string(),
            protocol: PROTOCOL_CURRENT.to_string(),
            capabilities: DAEMON_CAPABILITIES.iter().map(|cap| cap.to_string()).collect(),
            strict_local: false,
        }
    }

    pub fn to_json(&self) -> Json {
        crate::json_obj! {
            "daemonVersion" => Json::string(self.daemon_version.clone()),
            "protocol" => Json::string(self.protocol.clone()),
            "capabilities" => Json::Array(self.capabilities.iter().map(|cap| Json::string(cap.clone())).collect()),
            "strictLocal" => Json::Bool(self.strict_local),
        }
    }
}

/// 服务端握手结果。
#[derive(Debug, Clone, PartialEq)]
pub enum HelloOutcome {
    Ack(HelloAck),
    Rejected(HelloError),
}

impl HelloOutcome {
    pub fn is_ack(&self) -> bool {
        matches!(self, HelloOutcome::Ack(_))
    }

    pub fn to_json(&self) -> Json {
        match self {
            HelloOutcome::Ack(ack) => ack.to_json(),
            HelloOutcome::Rejected(error) => error.to_json(),
        }
    }
}

/// 服务端握手状态机：hello 只接受一次；完成后重复 hello 报 `E_AUTH_STATE`。
#[derive(Debug, Clone)]
pub struct ServerHandshake {
    pub instance_id: String,
    complete: bool,
}

impl Default for ServerHandshake {
    fn default() -> Self {
        Self::new()
    }
}

impl ServerHandshake {
    pub fn new() -> Self {
        Self { instance_id: generate_instance_id(), complete: false }
    }

    pub fn with_instance_id(instance_id: impl Into<String>) -> Self {
        Self { instance_id: instance_id.into(), complete: false }
    }

    pub fn is_complete(&self) -> bool {
        self.complete
    }

    pub fn reset(&mut self) {
        self.complete = false;
    }

    /// 处理一帧 hello，成功返回 hello-ack，失败返回 hello-error（不关闭连接由调用方决定）。
    pub fn handle_hello(&mut self, value: &Json, daemon: &DaemonProfile) -> HelloOutcome {
        if self.complete {
            return HelloOutcome::Rejected(HelloError::new(ErrorCode::AuthState, "握手已完成后又收到 hello"));
        }
        let hello = match Hello::from_json(value) {
            Ok(hello) => hello,
            Err(error) => return HelloOutcome::Rejected(HelloError::new(error.code, error.message)),
        };
        let negotiation = negotiate(hello.protocol.as_deref(), &daemon.protocol);
        if !negotiation.accepted {
            return HelloOutcome::Rejected(HelloError::new(
                negotiation.code.unwrap_or(ErrorCode::ProtocolUnsupported),
                negotiation.message,
            ));
        }
        let mut ack = HelloAck::new(self.instance_id.clone(), daemon.daemon_version.clone(), daemon.protocol.clone());
        ack.capabilities = daemon.capabilities.clone();
        ack.local_auth = if hello.local_verified {
            LocalAuth::verified(daemon.strict_local)
        } else {
            LocalAuth::unpaired(daemon.strict_local)
        };
        self.complete = true;
        HelloOutcome::Ack(ack)
    }
}

/// 生成 8 位 hex instanceId（std-only：时间 + 进程 id 哈希，不做密码学用途）。
pub fn generate_instance_id() -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    nanos.hash(&mut hasher);
    std::process::id().hash(&mut hasher);
    format!("{:08x}", hasher.finish() as u32)
}

fn is_instance_id(text: &str) -> bool {
    text.len() == 8 && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn browser_or_unknown(browser: &str) -> String {
    if browser.trim().is_empty() {
        "unknown".to_string()
    } else {
        browser.to_string()
    }
}

fn truncate_chars(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

fn non_empty(text: String) -> Option<String> {
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn string_field(value: &Json, key: &str) -> String {
    value.get(key).and_then(Json::as_str).unwrap_or("").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(text: &str) -> Json {
        Json::parse(text).expect("测试夹具必须是合法 JSON")
    }

    fn hello_fixture(protocol: &str) -> Json {
        obj(&format!(
            "{{\"type\":\"hello\",\"extVersion\":\"0.3.0\",\"browser\":\"edge\",\
             \"browserVersion\":\"156.0.4314.58\",\"userAgent\":\"Mozilla/5.0\",\
             \"protocol\":\"{protocol}\",\"capabilities\":[\"observe\",\"frames\"]}}"
        ))
    }

    #[test]
    fn protocol_version_parsing() {
        assert_eq!(ProtocolVersion::parse("1.9"), Some(ProtocolVersion::V1_9));
        assert_eq!(ProtocolVersion::parse("1"), Some(ProtocolVersion::V1_0));
        assert_eq!(ProtocolVersion::parse(" 2.0 "), Some(ProtocolVersion::V2_0));
        assert_eq!(ProtocolVersion::parse("1.9.0"), None);
        assert_eq!(ProtocolVersion::parse("1.x"), None);
        assert_eq!(ProtocolVersion::parse(""), None);
        assert_eq!(ProtocolVersion::V1_9.label(), "1.9");
        assert_eq!(ProtocolVersion::V1_9.to_string(), "1.9");
        assert!(ProtocolVersion::V1_9 > ProtocolVersion::V1_8);
        assert!(ProtocolVersion::V2_0 > ProtocolVersion::V1_9);
        assert!(ProtocolVersion::V1_0.is_compatible_major());
        assert!(!ProtocolVersion::V2_0.is_compatible_major());
        assert_eq!(ProtocolVersion::from_json(&Json::string("1.8")), Some(ProtocolVersion::V1_8));
        assert_eq!(ProtocolVersion::from_json(&Json::Number(1.0)), Some(ProtocolVersion::V1_0));
        assert_eq!(ProtocolVersion::from_json(&Json::Number(1.9)), None);
        assert_eq!(ProtocolVersion::from_json(&Json::Null), None);
    }

    #[test]
    fn negotiation_matrix_covers_18_19_and_20() {
        let current = "1.9";
        let same = negotiate(Some("1.9"), current);
        assert!(same.accepted);
        assert_eq!(same.skew, None);
        assert_eq!(same.code, None);
        assert_eq!(same.peer_label, "1.9");

        let baseline = negotiate(Some("1.8"), current);
        assert!(baseline.accepted, "1.8 老扩展仍可连接");
        assert_eq!(baseline.skew, Some(ProtocolSkew::Older));
        assert_eq!(baseline.peer, Some(ProtocolVersion::V1_8));
        assert!(baseline.message.contains("minor 偏斜"));

        let newer = negotiate(Some("1.10"), current);
        assert!(newer.accepted);
        assert_eq!(newer.skew, Some(ProtocolSkew::Newer));

        let major_two = negotiate(Some("2.0"), current);
        assert!(!major_two.accepted);
        assert_eq!(major_two.code, Some(ErrorCode::ProtocolUnsupported));
        assert_eq!(major_two.skew, None);
        assert!(major_two.message.contains("major 必须为 1"));

        let missing = negotiate(None, current);
        assert!(missing.accepted, "旧客户端不上报 protocol 按 1.0 处理");
        assert_eq!(missing.peer_label, "1.0");
        assert_eq!(missing.skew, Some(ProtocolSkew::Older));

        let invalid = negotiate(Some("one-point-nine"), current);
        assert!(!invalid.accepted);
        assert_eq!(invalid.code, Some(ErrorCode::ProtocolUnsupported));
        assert_eq!(invalid.peer, None);
    }

    #[test]
    fn negotiation_json_shape() {
        let json = negotiate(Some("1.8"), "1.9").to_json();
        assert_eq!(json.get("peer").and_then(Json::as_str), Some("1.8"));
        assert_eq!(json.get("major").and_then(Json::as_u64), Some(1));
        assert_eq!(json.get("accepted").and_then(Json::as_bool), Some(true));
        assert_eq!(json.get("skew").and_then(Json::as_str), Some("older"));
        assert_eq!(json.get("code"), Some(&Json::Null));
        let rejected = negotiate(Some("2.0"), "1.9").to_json();
        assert_eq!(rejected.get("accepted").and_then(Json::as_bool), Some(false));
        assert_eq!(rejected.get("code").and_then(Json::as_str), Some("E_PROTOCOL_UNSUPPORTED"));
    }

    #[test]
    fn feature_matrix_shows_nine_floors_for_18_19() {
        let baseline = feature_availability(Some("1.8"));
        assert_eq!(baseline.len(), 9, "feature floor 应为 9 项");
        assert!(baseline.iter().all(|feature| !feature.available));
        assert_eq!(baseline[0].feature, "unverified");
        assert_eq!(baseline[0].floor, "1.9");
        assert!(!baseline[0].label.is_empty());
        let current = feature_availability(Some("1.9"));
        assert!(current.iter().all(|feature| feature.available));
        let missing = missing_features(Some("1.8"));
        assert_eq!(missing.len(), 9);
        assert!(missing.contains(&"video"));
        assert!(missing.contains(&"capture.stream"));
        assert!(missing.contains(&"har"));
        assert!(missing_features(Some("1.9")).is_empty());
        assert_eq!(missing_features(None).len(), 9, "无 protocol 按 1.0 处理");
        assert!(feature_availability(Some("garbage")).iter().all(|feature| !feature.available));
        let json = current[0].to_json();
        assert_eq!(json.get("feature").and_then(Json::as_str), Some("unverified"));
        assert_eq!(json.get("available").and_then(Json::as_bool), Some(true));
    }

    #[test]
    fn feature_gate_rejects_18_and_allows_19() {
        assert!(gate_feature(Some("1.9"), "video").is_ok());
        assert!(gate_feature(None, "video").is_err(), "1.0 缺 1.9 能力");
        let error = gate_feature(Some("1.8"), "video").expect_err("1.8 必须被拒");
        assert_eq!(error.code, ErrorCode::ProtocolUnsupported);
        let data = error.data.expect("拒绝 data");
        assert_eq!(data.get("feature").and_then(Json::as_str), Some("video"));
        assert_eq!(data.get("required").and_then(Json::as_str), Some("1.9"));
        assert_eq!(data.get("actual").and_then(Json::as_str), Some("1.8"));
        assert!(gate_feature(Some("1.8"), "not-a-feature").is_ok(), "未知 feature 不设门");
        for feature in ["unverified", "expect", "read", "observe-delta", "plan", "video", "capture.stream", "debug.journal", "har"] {
            assert!(gate_feature(Some("1.9"), feature).is_ok(), "1.9 应支持 {feature}");
            assert!(gate_feature(Some("1.8"), feature).is_err(), "1.8 应缺 {feature}");
        }
    }

    #[test]
    fn hello_fixture_from_protocol_md_decodes() {
        let hello = Hello::from_json(&obj(
            "{\"type\":\"hello\",\"extVersion\":\"0.2.0\",\"browser\":\"edge\",\
             \"browserVersion\":\"156.0.4314.58\",\"userAgent\":\"Mozilla/5.0\"}",
        ))
        .expect("PROTOCOL.md §3.1 夹具");
        assert_eq!(hello.ext_version, "0.2.0");
        assert_eq!(hello.browser, "edge");
        assert_eq!(hello.protocol, None);
        assert_eq!(hello.protocol_label(), "0");
        assert!(hello.capabilities.is_empty());
        assert_eq!(hello.settings, HelloSettings::default());
        assert_eq!(hello.label, "");
        assert!(!hello.local_verified);
    }

    #[test]
    fn hello_normalizes_like_daemon() {
        let mut capabilities = vec![Json::string("observe"), Json::Number(7.0)];
        for index in 0..40 {
            capabilities.push(Json::string(format!("cap-{index}")));
        }
        let mut fixture = crate::json_obj! {
            "type" => Json::string("hello"),
            "extVersion" => Json::string("0.3.0"),
            "browser" => Json::string(""),
            "protocol" => Json::Number(1.0),
            "capabilities" => Json::Array(capabilities),
            "instanceId" => Json::string("A1B2C3D4"),
            "browserId" => Json::string("b".repeat(100)),
            "label" => Json::string(format!("  {}  ", "名".repeat(60))),
            "settings" => crate::json_obj! {
                "borrowConfirm" => Json::Bool(false),
                "allowHelp" => Json::Bool(true),
                "pageGuard" => Json::Bool(false),
                "longShotMode" => Json::string("manual"),
            },
            "localVerified" => Json::Bool(true),
        };
        let hello = Hello::from_json(&fixture).expect("hello");
        assert_eq!(hello.browser, "unknown", "空 browser 归一为 unknown");
        assert_eq!(hello.protocol.as_deref(), Some("1.0"));
        assert_eq!(hello.protocol_version(), Some(ProtocolVersion::V1_0));
        assert_eq!(hello.capabilities.len(), MAX_CAPABILITIES);
        assert!(!hello.capabilities.contains(&"cap-39".to_string()));
        assert_eq!(hello.instance_id.as_deref(), Some("a1b2c3d4"));
        assert_eq!(hello.requested_instance_id(), Some("a1b2c3d4"));
        assert_eq!(hello.browser_id.chars().count(), MAX_BROWSER_ID_CHARS);
        assert_eq!(hello.label.chars().count(), MAX_LABEL_CHARS);
        assert!(!hello.label.starts_with(' '));
        assert_eq!(hello.settings.borrow_confirm, false);
        assert_eq!(hello.settings.allow_help, true);
        assert_eq!(hello.settings.page_guard, false);
        assert_eq!(hello.settings.long_shot_mode, "manual");
        assert!(hello.local_verified);
        fixture.insert("instanceId", Json::string("not-hex"));
        let invalid = Hello::from_json(&fixture).expect("hello");
        assert_eq!(invalid.instance_id, None);
        assert_eq!(invalid.requested_instance_id(), None);
    }

    #[test]
    fn hello_protocol_forms_are_normalized() {
        let text = Hello::from_json(&hello_fixture("1")).expect("hello");
        assert_eq!(text.protocol.as_deref(), Some("1"));
        assert_eq!(text.protocol_version(), Some(ProtocolVersion::V1_0));
        assert_eq!(text.protocol_label(), "1.0");
        let numeric = Hello::from_json(&obj(
            "{\"type\":\"hello\",\"extVersion\":\"0.3.0\",\"browser\":\"edge\",\"protocol\":1}",
        ))
        .expect("hello");
        assert_eq!(numeric.protocol.as_deref(), Some("1.0"));
        assert_eq!(numeric.protocol_version(), Some(ProtocolVersion::V1_0));
        let fractional = Hello::from_json(&obj(
            "{\"type\":\"hello\",\"extVersion\":\"0.3.0\",\"browser\":\"edge\",\"protocol\":1.9}",
        ))
        .expect("hello");
        assert_eq!(fractional.protocol.as_deref(), Some("invalid"));
        assert_eq!(fractional.protocol_version(), None);
        let invalid = Hello::from_json(&obj(
            "{\"type\":\"hello\",\"extVersion\":\"0.3.0\",\"browser\":\"edge\",\"protocol\":{}}",
        ))
        .expect("hello");
        assert_eq!(invalid.protocol.as_deref(), Some("invalid"));
    }

    #[test]
    fn hello_rejects_wrong_type() {
        let error = Hello::from_json(&obj("{\"type\":\"cmd\",\"extVersion\":\"0.3.0\"}"))
            .expect_err("类型不符");
        assert_eq!(error.code, ErrorCode::BadRequest);
        let error = Hello::from_text("{oops").expect_err("坏 JSON");
        assert_eq!(error.code, ErrorCode::BadJson);
    }

    #[test]
    fn hello_encodes_client_wire_shape() {
        let mut hello = Hello::new("0.3.0", "edge", "156.0.4314.58");
        hello.protocol = Some("1.9".to_string());
        hello.user_agent = "Mozilla/5.0".to_string();
        hello.capabilities = vec!["observe".to_string(), "frames".to_string()];
        hello.instance_id = Some("a1b2c3d4".to_string());
        hello.browser_id = "browser-1".to_string();
        hello.label = "工作实例".to_string();
        hello.settings = HelloSettings { borrow_confirm: true, allow_help: false, page_guard: true, long_shot_mode: "auto".to_string() };
        hello.local_verified = true;
        let json = hello.to_json();
        assert_eq!(json.get("type").and_then(Json::as_str), Some("hello"));
        assert_eq!(json.get("protocol").and_then(Json::as_str), Some("1.9"));
        assert_eq!(json.get("browser").and_then(Json::as_str), Some("edge"));
        assert_eq!(json.get("instanceId").and_then(Json::as_str), Some("a1b2c3d4"));
        assert_eq!(json.get("label").and_then(Json::as_str), Some("工作实例"));
        assert_eq!(json.get("localVerified").and_then(Json::as_bool), Some(true));
        assert_eq!(json.get("settings").and_then(|settings| settings.get("allowHelp")).and_then(Json::as_bool), Some(false));
        let decoded = Hello::from_json(&json).expect("round trip");
        assert_eq!(decoded.ext_version, "0.3.0");
        assert_eq!(decoded.label, "工作实例");
        assert_eq!(decoded.capabilities, vec!["observe".to_string(), "frames".to_string()]);
    }

    #[test]
    fn hello_ack_round_trips_full_shape() {
        let mut ack = HelloAck::new("a1b2c3d4", "0.3.0", "1.9");
        ack.capabilities = DAEMON_CAPABILITIES.iter().map(|cap| cap.to_string()).collect();
        ack.local_auth = LocalAuth::verified(false);
        ack.server_proof = Some("proof".to_string());
        ack.device_token = Some("token".to_string());
        ack.device_status = Some("pending".to_string());
        ack.commit_txn = Some("txn".to_string());
        ack.commit_proof = Some("commit-proof".to_string());
        let json = ack.to_json();
        assert_eq!(json.get("type").and_then(Json::as_str), Some("hello-ack"));
        assert_eq!(json.get("daemonVersion").and_then(Json::as_str), Some("0.3.0"));
        assert_eq!(json.get("localAuth").and_then(|auth| auth.get("state")).and_then(Json::as_str), Some("verified"));
        assert_eq!(json.get("deviceStatus").and_then(Json::as_str), Some("pending"));
        assert_eq!(HelloAck::from_json(&json), Ok(ack.clone()));
        assert_eq!(HelloAck::from_text(&json.to_compact_string()), Ok(ack));
    }

    #[test]
    fn hello_ack_accepts_legacy_minimal_shape() {
        let ack = HelloAck::from_json(&obj("{\"type\":\"hello-ack\",\"instanceId\":\"a1b2c3d4\",\"daemonVersion\":\"0.2.0\"}"))
            .expect("PROTOCOL.md 旧形状");
        assert_eq!(ack.protocol, "1.9", "缺 protocol 时按当前协议补齐");
        assert!(ack.capabilities.is_empty());
        assert_eq!(ack.local_auth.state, "unpaired");
        assert!(!ack.local_auth.strict);
        assert_eq!(ack.server_proof, None);
        assert_eq!(
            HelloAck::from_json(&obj("{\"type\":\"hello-ack\",\"daemonVersion\":\"0.2.0\"}"))
                .expect_err("缺 instanceId")
                .code,
            ErrorCode::BadRequest
        );
    }

    #[test]
    fn hello_error_round_trips_and_normalizes_code() {
        let error = HelloError::new(ErrorCode::ProtocolUnsupported, "协议不兼容");
        let json = error.to_json();
        assert_eq!(json.get("type").and_then(Json::as_str), Some("hello-error"));
        assert_eq!(json.get("code").and_then(Json::as_str), Some("E_PROTOCOL_UNSUPPORTED"));
        assert_eq!(HelloError::from_json(&json), Ok(error));
        let unknown = HelloError::from_json(&obj(
            "{\"type\":\"hello-error\",\"code\":\"E_FUTURE\",\"message\":\"新码\"}",
        ))
        .expect("未知码归一到 E_INTERNAL");
        assert_eq!(unknown.code, ErrorCode::Internal);
        assert_eq!(unknown.message, "新码");
        assert_eq!(
            HelloError::from_json(&obj("{\"type\":\"hello-error\"}")).expect_err("缺 code").code,
            ErrorCode::BadRequest
        );
    }

    #[test]
    fn daemon_profile_matches_protocol_surface() {
        let profile = DaemonProfile::current();
        assert_eq!(profile.daemon_version, PRODUCT_VERSION);
        assert_eq!(profile.protocol, PROTOCOL_CURRENT);
        assert_eq!(profile.capabilities.len(), DAEMON_CAPABILITIES.len());
        assert!(profile.capabilities.iter().any(|cap| cap == "video"));
        assert!(profile.capabilities.iter().any(|cap| cap == "dom-read"));
        assert!(!profile.strict_local);
        let json = profile.to_json();
        assert_eq!(json.get("protocol").and_then(Json::as_str), Some("1.9"));
    }

    #[test]
    fn generated_instance_id_is_eight_hex_chars() {
        for _ in 0..8 {
            let id = generate_instance_id();
            assert_eq!(id.len(), 8);
            assert!(id.bytes().all(|byte| byte.is_ascii_hexdigit()));
            assert_eq!(id.to_lowercase(), id);
        }
    }

    #[test]
    fn server_handshake_accepts_current_and_baseline() {
        let daemon = DaemonProfile::current();
        let mut handshake = ServerHandshake::with_instance_id("a1b2c3d4");
        let outcome = handshake.handle_hello(&hello_fixture("1.9"), &daemon);
        match &outcome {
            HelloOutcome::Ack(ack) => {
                assert_eq!(ack.instance_id, "a1b2c3d4");
                assert_eq!(ack.protocol, "1.9");
                assert_eq!(ack.capabilities.len(), DAEMON_CAPABILITIES.len());
                assert!(!ack.local_auth.is_verified());
            }
            HelloOutcome::Rejected(error) => panic!("1.9 应握手成功：{}", error.message),
        }
        assert!(handshake.is_complete());
        let duplicate = handshake.handle_hello(&hello_fixture("1.9"), &daemon);
        assert!(!duplicate.is_ack());
        match duplicate {
            HelloOutcome::Rejected(error) => assert_eq!(error.code, ErrorCode::AuthState),
            HelloOutcome::Ack(_) => panic!("重复 hello 应被拒"),
        }

        let mut baseline_handshake = ServerHandshake::with_instance_id("deadbeef");
        let baseline = baseline_handshake.handle_hello(&hello_fixture("1.8"), &daemon);
        assert!(baseline.is_ack(), "1.8 应可连接（握手不拒绝 minor 偏斜）");
        assert_eq!(baseline.to_json().get("protocol").and_then(Json::as_str), Some("1.9"));
    }

    #[test]
    fn server_handshake_rejects_major_two_and_invalid_frames() {
        let daemon = DaemonProfile::current();
        let mut handshake = ServerHandshake::with_instance_id("a1b2c3d4");
        let rejected = handshake.handle_hello(&hello_fixture("2.0"), &daemon);
        match rejected {
            HelloOutcome::Rejected(error) => assert_eq!(error.code, ErrorCode::ProtocolUnsupported),
            HelloOutcome::Ack(_) => panic!("2.0 必须被拒"),
        }
        assert!(!handshake.is_complete(), "拒绝后不应完成握手");
        let invalid = handshake.handle_hello(&obj("{\"type\":\"hello\"}"), &daemon);
        assert!(invalid.is_ack(), "缺 protocol 的旧客户端按 1.0 处理");
        let mut second = ServerHandshake::with_instance_id("a1b2c3d4");
        let bad = second.handle_hello(&obj("{\"type\":\"cmd\",\"id\":\"x\",\"method\":\"status\"}"), &daemon);
        match bad {
            HelloOutcome::Rejected(error) => assert_eq!(error.code, ErrorCode::BadRequest),
            HelloOutcome::Ack(_) => panic!("错误帧必须被拒"),
        }
        assert!(!second.is_complete());
    }

    #[test]
    fn server_handshake_marks_local_verified_and_strict() {
        let daemon = DaemonProfile { strict_local: true, ..DaemonProfile::current() };
        let mut handshake = ServerHandshake::with_instance_id("a1b2c3d4");
        let mut fixture = hello_fixture("1.9");
        fixture.insert("localVerified", Json::Bool(true));
        match handshake.handle_hello(&fixture, &daemon) {
            HelloOutcome::Ack(ack) => {
                assert!(ack.local_auth.is_verified());
                assert!(ack.local_auth.strict);
            }
            HelloOutcome::Rejected(error) => panic!("应成功：{}", error.message),
        }
    }

    #[test]
    fn settings_normalize_unknown_values() {
        let settings = HelloSettings::from_json(Some(&obj("{\"longShotMode\":\"weird\"}")));
        assert_eq!(settings.long_shot_mode, "auto");
        let settings = HelloSettings::from_json(None);
        assert_eq!(settings, HelloSettings::default());
        assert_eq!(settings.to_json().get("longShotMode").and_then(Json::as_str), Some("auto"));
    }

    #[test]
    fn outcome_json_dispatches_by_variant() {
        let ack = HelloOutcome::Ack(HelloAck::new("a1b2c3d4", "0.3.0", "1.9"));
        assert_eq!(ack.to_json().get("type").and_then(Json::as_str), Some("hello-ack"));
        let rejected = HelloOutcome::Rejected(HelloError::new(ErrorCode::RateLimited, "太频繁"));
        assert_eq!(rejected.to_json().get("type").and_then(Json::as_str), Some("hello-error"));
    }
}

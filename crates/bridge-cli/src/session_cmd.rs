//! `bridge-rs session start|stop|list`：真实 `/rpc` 会话命令（M-D 第四批）。
//!
//! 契约只读对齐 `cli/commands/session.mjs` 与 `daemon/server.mjs` 的本地方法：
//! - `session.start` → `startSession`：params `focus/incognito/browser/tab/share/scope/
//!   allowDomains/denyDomains/minIntervalMs/controller/controlMode/requestId`；
//!   结果 `{sessionId, tabId, windowId, instanceId, borrowed, shared, ownerSession, control?, reused?}`；
//! - `session.stop` → `stopSession`：params `{session, keep}`；
//!   结果 `{ok, borrowed, handedOff: {sessionId, tabId} | null, alreadyStopping?}`；
//! - `session.list` → `sessionList`：结果 `{sessions: [...]}`（daemon 返回的 public view）。
//!
//! 与 Node CLI 的差异（有意，且都朝"可诊断"方向）：
//! - 参数错误走 `E_ARG_*` 单源码并退出 2（Node 用通用退出码 1）；
//! - `--min-interval` 超过 5000ms 时按 daemon 语义**钳到 5000**（daemon 自己 `Math.min(…,5000)`）；
//! - `--json` 输出稳定信封 `{ok, session|sessions|stopped, daemon, exitCode}`，
//!   `daemon` 段只给 `tokenPresent`/`tokenLength`，**永不输出明文 token**；
//! - 文本输出是给人读的摘要，不伪造表格宽度。
//!
//! TLS：上下文由 [`command_io::DaemonContext`] 构造，`daemon.json` 的 `tls:true` 会在
//! 任何网络请求之前被 [`crate::tls_policy`] 明确拒绝（`E_UNSUPPORTED_CAPABILITY`）。

use crate::cli::CliError;
use crate::command_io::{self, DaemonContext};
use crate::envelope::RpcError;
use crate::errors::ErrorCode;
use crate::json::Json;
use crate::status::{self, CommandOutput};

/// `session.start`（与 daemon `local-dispatch.js` 一致）。
pub const METHOD_START: &str = "session.start";
/// `session.stop`。
pub const METHOD_STOP: &str = "session.stop";
/// `session.list`。
pub const METHOD_LIST: &str = "session.list";

/// controller.name 上限（daemon `isControllerInfo`：1-80 字符）。
pub const MAX_CONTROLLER_NAME_CHARS: usize = 80;
/// controller.project 上限（1-120 字符）。
pub const MAX_CONTROLLER_PROJECT_CHARS: usize = 120;
/// scope 上限（daemon `slice(0, 80)`）。
pub const MAX_SCOPE_CHARS: usize = 80;
/// `--min-interval` 的 daemon 侧上限（`Math.min(value, 5000)`）。
pub const MAX_MIN_INTERVAL_MS: u64 = 5_000;
/// 域名白/黑名单字符串上限（daemon `normalizeDomains` 会再解析，这里只挡明显滥用）。
pub const MAX_DOMAINS_CHARS: usize = 4_096;
/// 会话 id 上限（daemon 的 id 是 4 位字母，这里给足余量只挡异常输入）。
pub const MAX_SESSION_ID_CHARS: usize = 256;
/// 控制模式枚举（`tab-control.mjs` 只认这两个）。
pub const CONTROL_MODES: [&str; 2] = ["open", "exclusive"];

/// 会话控制器（`--agent-name/--project/--controller-color`）。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Controller {
    pub name: String,
    pub project: Option<String>,
    pub color: Option<String>,
}

impl Controller {
    /// 校验：name 1-80；project 1-120；color 必须是 `#rrggbb`。
    pub fn validate(&self) -> Result<(), CliError> {
        let name = self.name.trim();
        if name.is_empty() {
            return Err(CliError::new(ErrorCode::ArgMissing, "--agent-name 不能为空"));
        }
        if name.chars().count() > MAX_CONTROLLER_NAME_CHARS {
            return Err(CliError::new(
                ErrorCode::ArgRange,
                format!(
                    "--agent-name 最多 {MAX_CONTROLLER_NAME_CHARS} 字符，实际 {}",
                    name.chars().count()
                ),
            ));
        }
        if let Some(project) = &self.project {
            let project = project.trim();
            if project.is_empty() {
                return Err(CliError::new(ErrorCode::ArgRange, "--project 不能为空字符串"));
            }
            if project.chars().count() > MAX_CONTROLLER_PROJECT_CHARS {
                return Err(CliError::new(
                    ErrorCode::ArgRange,
                    format!(
                        "--project 最多 {MAX_CONTROLLER_PROJECT_CHARS} 字符，实际 {}",
                        project.chars().count()
                    ),
                ));
            }
        }
        if let Some(color) = &self.color {
            if !is_hex_color(color.trim()) {
                return Err(CliError::new(
                    ErrorCode::ArgType,
                    format!("--controller-color 必须是 #rrggbb，收到 {color:?}"),
                ));
            }
        }
        Ok(())
    }

    pub fn to_json(&self) -> Json {
        let mut entries = vec![("name".to_string(), Json::string(self.name.trim().to_string()))];
        if let Some(project) = &self.project {
            entries.push(("project".to_string(), Json::string(project.trim().to_string())));
        }
        if let Some(color) = &self.color {
            entries.push(("color".to_string(), Json::string(color.trim().to_string())));
        }
        Json::Object(entries)
    }
}

fn is_hex_color(text: &str) -> bool {
    let Some(hex) = text.strip_prefix('#') else {
        return false;
    };
    hex.len() == 6 && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// `session start` 的参数。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StartOptions {
    pub json: bool,
    pub timeout_ms: Option<u64>,
    pub focus: bool,
    pub incognito: bool,
    pub browser: Option<String>,
    pub tab: Option<u64>,
    pub share: bool,
    pub scope: Option<String>,
    pub allow_domains: Option<String>,
    pub deny_domains: Option<String>,
    /// 已解析的毫秒值；发送时按 daemon 语义钳到 [`MAX_MIN_INTERVAL_MS`]。
    pub min_interval_ms: Option<u64>,
    pub control_mode: Option<String>,
    pub controller: Option<Controller>,
    pub request_id: Option<String>,
}

impl StartOptions {
    /// 参数校验（`E_ARG_*`，由 CLI 以退出码 2 呈现）。
    pub fn validate(&self) -> Result<(), CliError> {
        if self.share && self.tab.is_none() {
            return Err(CliError::new(
                ErrorCode::ArgRequires,
                "--share 需要 --tab <tabId>（共享已有标签页）",
            ));
        }
        if let Some(tab) = self.tab {
            if tab == 0 {
                return Err(CliError::new(ErrorCode::ArgRange, "--tab 必须是 >= 1 的整数 tabId"));
            }
        }
        if let Some(mode) = &self.control_mode {
            if !CONTROL_MODES.contains(&mode.as_str()) {
                return Err(CliError::new(
                    ErrorCode::ArgEnum,
                    format!("--control 只支持 open|exclusive，收到 {mode:?}"),
                ));
            }
        }
        if let Some(scope) = &self.scope {
            let trimmed = scope.trim();
            if trimmed.is_empty() {
                return Err(CliError::new(ErrorCode::ArgRange, "--scope 不能为空字符串"));
            }
            if trimmed.chars().count() > MAX_SCOPE_CHARS {
                return Err(CliError::new(
                    ErrorCode::ArgRange,
                    format!("--scope 最多 {MAX_SCOPE_CHARS} 字符，实际 {}", trimmed.chars().count()),
                ));
            }
        }
        for (flag, value) in [("--allow-domains", &self.allow_domains), ("--deny-domains", &self.deny_domains)] {
            if let Some(text) = value {
                if text.trim().is_empty() {
                    return Err(CliError::new(ErrorCode::ArgRange, format!("{flag} 不能为空字符串")));
                }
                if text.chars().count() > MAX_DOMAINS_CHARS {
                    return Err(CliError::new(
                        ErrorCode::ArgRange,
                        format!("{flag} 最多 {MAX_DOMAINS_CHARS} 字符"),
                    ));
                }
            }
        }
        if let Some(browser) = &self.browser {
            if browser.trim().is_empty() {
                return Err(CliError::new(ErrorCode::ArgRange, "--browser 不能为空字符串"));
            }
        }
        if let Some(controller) = &self.controller {
            controller.validate()?;
        }
        if let Some(request_id) = &self.request_id {
            if request_id.trim().is_empty() {
                return Err(CliError::new(ErrorCode::ArgRange, "--request-id 不能为空字符串"));
            }
        }
        if self.min_interval_ms.is_some() {
            // 解析层保证非负整数；上限按 daemon 语义钳制（见 `to_params`），不在此报错。
        }
        Ok(())
    }

    /// 发送给 daemon 的 `params`（键顺序稳定，便于请求体断言）。
    pub fn to_params(&self) -> Json {
        let mut entries: Vec<(String, Json)> = vec![("focus".to_string(), Json::Bool(self.focus))];
        if self.incognito {
            entries.push(("incognito".to_string(), Json::Bool(true)));
        }
        if let Some(allow) = &self.allow_domains {
            entries.push(("allowDomains".to_string(), Json::string(allow.trim().to_string())));
        }
        if let Some(deny) = &self.deny_domains {
            entries.push(("denyDomains".to_string(), Json::string(deny.trim().to_string())));
        }
        if let Some(ms) = self.min_interval_ms {
            entries.push((
                "minIntervalMs".to_string(),
                Json::Number(ms.min(MAX_MIN_INTERVAL_MS) as f64),
            ));
        }
        if let Some(browser) = &self.browser {
            entries.push(("browser".to_string(), Json::string(browser.trim().to_string())));
        }
        if let Some(scope) = &self.scope {
            entries.push(("scope".to_string(), Json::string(scope.trim().to_string())));
        }
        if let Some(controller) = &self.controller {
            entries.push(("controller".to_string(), controller.to_json()));
        }
        if let Some(tab) = self.tab {
            entries.push(("tab".to_string(), Json::Number(tab as f64)));
        }
        if self.share {
            entries.push(("share".to_string(), Json::Bool(true)));
        }
        if let Some(mode) = &self.control_mode {
            entries.push(("controlMode".to_string(), Json::string(mode.clone())));
        }
        if let Some(request_id) = &self.request_id {
            entries.push(("requestId".to_string(), Json::string(request_id.trim().to_string())));
        }
        Json::Object(entries)
    }
}

/// `session stop` 的参数。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StopOptions {
    pub json: bool,
    pub timeout_ms: Option<u64>,
    pub session: String,
    pub keep: bool,
}

impl StopOptions {
    pub fn validate(&self) -> Result<(), CliError> {
        let session = self.session.trim();
        if session.is_empty() {
            return Err(CliError::new(
                ErrorCode::ArgMissing,
                "session stop 需要 <sessionId> 或 --session <sessionId>",
            ));
        }
        if session.chars().count() > MAX_SESSION_ID_CHARS {
            return Err(CliError::new(
                ErrorCode::ArgRange,
                format!("sessionId 最多 {MAX_SESSION_ID_CHARS} 字符"),
            ));
        }
        Ok(())
    }

    pub fn to_params(&self) -> Json {
        crate::json_obj! {
            "session" => Json::string(self.session.trim().to_string()),
            "keep" => Json::Bool(self.keep),
        }
    }
}

/// `session list` 的参数（只读，无业务参数）。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ListOptions {
    pub json: bool,
    pub timeout_ms: Option<u64>,
}

/// CLI 层的 `session` 子命令。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionCommand {
    Start(StartOptions),
    Stop(StopOptions),
    List(ListOptions),
}

/// `session.start` 结果（daemon `startSession` 返回值）。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct StartResult {
    pub session_id: String,
    pub instance_id: String,
    pub tab_id: Option<u64>,
    pub window_id: Option<u64>,
    pub borrowed: bool,
    pub shared: bool,
    pub owner_session: Option<String>,
    pub reused: bool,
    pub control: Option<Json>,
}

impl StartResult {
    /// 解析 `result`；`sessionId` 缺失说明对端不是预期 daemon（结构化 `E_RPC`）。
    pub fn from_json(value: &Json) -> Result<Self, RpcError> {
        let Some(object) = value.as_object() else {
            return Err(RpcError::new(ErrorCode::Rpc, "session.start 结果不是 JSON 对象"));
        };
        let read = |key: &str| {
            object
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value)
        };
        let session_id = read("sessionId").and_then(Json::as_str).unwrap_or("").trim().to_string();
        if session_id.is_empty() {
            return Err(RpcError::new(
                ErrorCode::Rpc,
                "session.start 结果缺少字符串 sessionId（daemon 版本过旧或端点不是 BridgeDeck daemon）",
            )
            .with_data(crate::json_obj! {
                "result" => value.clone(),
            }));
        }
        Ok(Self {
            session_id,
            instance_id: read("instanceId").and_then(Json::as_str).unwrap_or("").to_string(),
            tab_id: read("tabId").and_then(Json::as_u64),
            window_id: read("windowId").and_then(Json::as_u64),
            borrowed: read("borrowed").and_then(Json::as_bool).unwrap_or(false),
            shared: read("shared").and_then(Json::as_bool).unwrap_or(false),
            owner_session: read("ownerSession").and_then(Json::as_str).map(str::to_string),
            reused: read("reused").and_then(Json::as_bool).unwrap_or(false),
            control: read("control").filter(|value| !value.is_null()).cloned(),
        })
    }

    pub fn to_json(&self) -> Json {
        crate::json_obj! {
            "sessionId" => Json::string(self.session_id.clone()),
            "instanceId" => Json::string(self.instance_id.clone()),
            "tabId" => self.tab_id.map(|id| Json::Number(id as f64)).unwrap_or(Json::Null),
            "windowId" => self.window_id.map(|id| Json::Number(id as f64)).unwrap_or(Json::Null),
            "borrowed" => Json::Bool(self.borrowed),
            "shared" => Json::Bool(self.shared),
            "ownerSession" => self.owner_session.as_deref().map(Json::string).unwrap_or(Json::Null),
            "reused" => Json::Bool(self.reused),
            "control" => self.control.clone().unwrap_or(Json::Null),
        }
    }
}

/// 一条会话的 public view（daemon `sessionPublicView`）。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SessionView {
    pub session_id: String,
    pub instance_id: String,
    pub tab_id: Option<u64>,
    pub window_id: Option<u64>,
    pub url: String,
    pub title: String,
    pub borrowed: bool,
    pub shared: bool,
    pub owner_session: Option<String>,
    pub incognito: bool,
    pub controller: Option<Json>,
    pub scope: String,
    pub allow_domains: Vec<String>,
    pub deny_domains: Vec<String>,
    pub min_interval_ms: u64,
    pub control_mode: String,
    pub control: Option<Json>,
    pub connected: bool,
    pub restored: bool,
    pub phase: String,
    pub lease: Option<Json>,
    pub started_at: Option<u64>,
    pub age_ms: Option<u64>,
}

impl SessionView {
    pub fn from_json(value: &Json) -> Option<Self> {
        let object = value.as_object()?;
        let read = |key: &str| object.iter().find(|(name, _)| name == key).map(|(_, value)| value);
        let text = |key: &str| read(key).and_then(Json::as_str).unwrap_or("").to_string();
        let number = |key: &str| read(key).and_then(Json::as_u64);
        let flag = |key: &str| read(key).and_then(Json::as_bool).unwrap_or(false);
        let strings = |key: &str| {
            read(key)
                .and_then(Json::as_array)
                .map(|items| items.iter().filter_map(Json::as_str).map(str::to_string).collect())
                .unwrap_or_default()
        };
        Some(Self {
            session_id: text("sessionId"),
            instance_id: text("instanceId"),
            tab_id: number("tabId"),
            window_id: number("windowId"),
            url: text("url"),
            title: text("title"),
            borrowed: flag("borrowed"),
            shared: flag("shared"),
            owner_session: read("ownerSession").and_then(Json::as_str).map(str::to_string),
            incognito: flag("incognito"),
            controller: read("controller").filter(|value| !value.is_null()).cloned(),
            scope: text("scope"),
            allow_domains: strings("allowDomains"),
            deny_domains: strings("denyDomains"),
            min_interval_ms: number("minIntervalMs").unwrap_or(0),
            control_mode: text("controlMode"),
            control: read("control").filter(|value| !value.is_null()).cloned(),
            connected: flag("connected"),
            restored: flag("restored"),
            phase: text("phase"),
            lease: read("lease").filter(|value| !value.is_null()).cloned(),
            started_at: number("startedAt"),
            age_ms: number("ageMs"),
        })
    }

    pub fn to_json(&self) -> Json {
        crate::json_obj! {
            "sessionId" => Json::string(self.session_id.clone()),
            "instanceId" => Json::string(self.instance_id.clone()),
            "tabId" => self.tab_id.map(|id| Json::Number(id as f64)).unwrap_or(Json::Null),
            "windowId" => self.window_id.map(|id| Json::Number(id as f64)).unwrap_or(Json::Null),
            "url" => Json::string(self.url.clone()),
            "title" => Json::string(self.title.clone()),
            "borrowed" => Json::Bool(self.borrowed),
            "shared" => Json::Bool(self.shared),
            "ownerSession" => self.owner_session.as_deref().map(Json::string).unwrap_or(Json::Null),
            "incognito" => Json::Bool(self.incognito),
            "controller" => self.controller.clone().unwrap_or(Json::Null),
            "scope" => Json::string(self.scope.clone()),
            "allowDomains" => Json::Array(self.allow_domains.iter().map(|domain| Json::string(domain.clone())).collect()),
            "denyDomains" => Json::Array(self.deny_domains.iter().map(|domain| Json::string(domain.clone())).collect()),
            "minIntervalMs" => Json::Number(self.min_interval_ms as f64),
            "controlMode" => Json::string(self.control_mode.clone()),
            "control" => self.control.clone().unwrap_or(Json::Null),
            "connected" => Json::Bool(self.connected),
            "restored" => Json::Bool(self.restored),
            "phase" => Json::string(self.phase.clone()),
            "lease" => self.lease.clone().unwrap_or(Json::Null),
            "startedAt" => self.started_at.map(|ms| Json::Number(ms as f64)).unwrap_or(Json::Null),
            "startedAtIso" => self
                .started_at
                .map(|ms| Json::string(format_epoch_utc(ms)))
                .unwrap_or(Json::Null),
            "ageMs" => self.age_ms.map(|ms| Json::Number(ms as f64)).unwrap_or(Json::Null),
        }
    }
}

/// `session.list` 结果。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ListResult {
    pub sessions: Vec<SessionView>,
}

impl ListResult {
    /// 解析 `{sessions: [...]}`；非对象/`sessions` 非数组 → `E_RPC`。
    pub fn from_json(value: &Json) -> Result<Self, RpcError> {
        let Some(object) = value.as_object() else {
            return Err(RpcError::new(ErrorCode::Rpc, "session.list 结果不是 JSON 对象"));
        };
        let sessions = match object.iter().find(|(name, _)| name == "sessions").map(|(_, value)| value) {
            None | Some(Json::Null) => Vec::new(),
            Some(Json::Array(items)) => items.iter().filter_map(SessionView::from_json).collect(),
            Some(other) => {
                return Err(RpcError::new(ErrorCode::Rpc, "session.list 的 sessions 不是数组")
                    .with_data(crate::json_obj! { "sessions" => other.clone() }));
            }
        };
        Ok(Self { sessions })
    }
}

/// `session.stop` 结果。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StopResult {
    pub borrowed: bool,
    pub handed_off: Option<HandedOff>,
    pub already_stopping: bool,
}

/// 共享 tab 控制权转交（`stopSession` 的 `handedOff`）。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HandedOff {
    pub session_id: String,
    pub tab_id: Option<u64>,
}

impl StopResult {
    pub fn from_json(value: &Json) -> Result<Self, RpcError> {
        let Some(object) = value.as_object() else {
            return Err(RpcError::new(ErrorCode::Rpc, "session.stop 结果不是 JSON 对象"));
        };
        let read = |key: &str| object.iter().find(|(name, _)| name == key).map(|(_, value)| value);
        let handed_off = match read("handedOff") {
            None | Some(Json::Null) => None,
            Some(Json::Object(_)) => {
                let hand = read("handedOff").expect("已确认存在");
                Some(HandedOff {
                    session_id: hand.get("sessionId").and_then(Json::as_str).unwrap_or("").to_string(),
                    tab_id: hand.get("tabId").and_then(Json::as_u64),
                })
            }
            Some(other) => {
                return Err(RpcError::new(ErrorCode::Rpc, "session.stop 的 handedOff 不是对象/null")
                    .with_data(crate::json_obj! { "handedOff" => other.clone() }));
            }
        };
        Ok(Self {
            borrowed: read("borrowed").and_then(Json::as_bool).unwrap_or(false),
            handed_off,
            already_stopping: read("alreadyStopping").and_then(Json::as_bool).unwrap_or(false),
        })
    }
}

/// 执行 `session` 子命令（发现 → 校验 → `/rpc` → 渲染）。
pub fn execute(command: &SessionCommand) -> CommandOutput {
    match command {
        SessionCommand::Start(options) => execute_start(options),
        SessionCommand::Stop(options) => execute_stop(options),
        SessionCommand::List(options) => execute_list(options),
    }
}

fn execute_start(options: &StartOptions) -> CommandOutput {
    if let Err(error) = options.validate() {
        return usage_failure(&error);
    }
    let context = match DaemonContext::open(options.timeout_ms) {
        Ok(context) => context,
        Err(error) => return command_io::discovery_failure(&error, options.json),
    };
    run_start(options, &context)
}

fn execute_stop(options: &StopOptions) -> CommandOutput {
    if let Err(error) = options.validate() {
        return usage_failure(&error);
    }
    let context = match DaemonContext::open(options.timeout_ms) {
        Ok(context) => context,
        Err(error) => return command_io::discovery_failure(&error, options.json),
    };
    run_stop(options, &context)
}

fn execute_list(options: &ListOptions) -> CommandOutput {
    let context = match DaemonContext::open(options.timeout_ms) {
        Ok(context) => context,
        Err(error) => return command_io::discovery_failure(&error, options.json),
    };
    run_list(options, &context)
}

/// 参数错误 → 退出码 2（与 `main` 的解析错误同形：`错误 E_CODE：消息`）。
pub fn usage_failure(error: &CliError) -> CommandOutput {
    CommandOutput::failure(
        format!("错误 {}：{}", error.code.as_str(), error.message),
        status::EXIT_CODE_USAGE,
    )
}

/// 跑 `session.start`（已构造上下文；测试可直接调用以断言请求体与渲染）。
pub fn run_start(options: &StartOptions, context: &DaemonContext) -> CommandOutput {
    let result = match context.call(METHOD_START, options.to_params()) {
        Ok(result) => result,
        Err(error) => return context.failure(&error, options.json),
    };
    let started = match StartResult::from_json(&result) {
        Ok(started) => started,
        Err(error) => return context.failure(&error, options.json),
    };
    if options.json {
        CommandOutput::success(start_json(&started, context).to_compact_string())
    } else {
        CommandOutput::success(start_text(&started))
    }
}

/// 跑 `session.stop`。
pub fn run_stop(options: &StopOptions, context: &DaemonContext) -> CommandOutput {
    let result = match context.call(METHOD_STOP, options.to_params()) {
        Ok(result) => result,
        Err(error) => return context.failure(&error, options.json),
    };
    let stopped = match StopResult::from_json(&result) {
        Ok(stopped) => stopped,
        Err(error) => return context.failure(&error, options.json),
    };
    if options.json {
        CommandOutput::success(stop_json(options.session.trim(), &stopped, context).to_compact_string())
    } else {
        CommandOutput::success(stop_text(options.session.trim(), options.keep, &stopped))
    }
}

/// 跑 `session.list`。
pub fn run_list(options: &ListOptions, context: &DaemonContext) -> CommandOutput {
    let result = match context.call(METHOD_LIST, Json::Object(Vec::new())) {
        Ok(result) => result,
        Err(error) => return context.failure(&error, options.json),
    };
    let list = match ListResult::from_json(&result) {
        Ok(list) => list,
        Err(error) => return context.failure(&error, options.json),
    };
    if options.json {
        CommandOutput::success(list_json(&list, context).to_compact_string())
    } else {
        CommandOutput::success(list_text(&list))
    }
}

/// `session start --json` 成功信封。
pub fn start_json(started: &StartResult, context: &DaemonContext) -> Json {
    crate::json_obj! {
        "ok" => Json::Bool(true),
        "session" => started.to_json(),
        "daemon" => context.daemon_json(),
        "exitCode" => Json::Number(f64::from(status::EXIT_CODE_OK)),
    }
}

/// `session start` 文本输出。
pub fn start_text(started: &StartResult) -> String {
    let mut line = format!(
        "session {} {}（instance {}，tab {}，window {}）",
        started.session_id,
        if started.reused { "已复用" } else { "已创建" },
        display_or(&started.instance_id, "?"),
        started.tab_id.map(|id| id.to_string()).unwrap_or_else(|| "?".to_string()),
        started.window_id.map(|id| id.to_string()).unwrap_or_else(|| "?".to_string()),
    );
    if started.shared {
        line.push_str(" [shared]");
    }
    if started.borrowed {
        line.push_str(" [borrowed]");
    }
    if let Some(owner) = &started.owner_session {
        line.push_str(&format!("（owner={owner}）"));
    }
    let mut lines = vec![line];
    if let Some(control) = &started.control {
        lines.push(format!("control：{}", control_text(control)));
    }
    lines.join("\n")
}

/// `session list --json` 成功信封。
pub fn list_json(list: &ListResult, context: &DaemonContext) -> Json {
    crate::json_obj! {
        "ok" => Json::Bool(true),
        "sessions" => crate::json_obj! {
            "count" => Json::Number(list.sessions.len() as f64),
            "items" => Json::Array(list.sessions.iter().map(SessionView::to_json).collect()),
        },
        "daemon" => context.daemon_json(),
        "exitCode" => Json::Number(f64::from(status::EXIT_CODE_OK)),
    }
}

/// `session list` 文本输出（空列表也明确说明下一步）。
pub fn list_text(list: &ListResult) -> String {
    if list.sessions.is_empty() {
        return "没有活动 session（先 bridge-rs session start；或在 Node CLI 里 bridge session start）".to_string();
    }
    let mut lines = vec![format!("sessions（{}）：", list.sessions.len())];
    for session in &list.sessions {
        let mut line = format!(
            "  {} tab={} window={} instance={} phase={} connected={}",
            session.session_id,
            session.tab_id.map(|id| id.to_string()).unwrap_or_else(|| "-".to_string()),
            session.window_id.map(|id| id.to_string()).unwrap_or_else(|| "-".to_string()),
            display_or(&session.instance_id, "-"),
            display_or(&session.phase, "-"),
            if session.connected { "yes" } else { "no" },
        );
        if session.shared {
            line.push_str(" [shared]");
        }
        if session.borrowed {
            line.push_str(" [borrowed]");
        }
        lines.push(line);
        lines.push(format!(
            "    url={} title={} started={}",
            truncate_text(display_or(&session.url, "-"), 64),
            truncate_text(display_or(&session.title, "-"), 40),
            session.started_at.map(format_epoch_utc).unwrap_or_else(|| "?".to_string()),
        ));
        if let Some(controller) = &session.controller {
            lines.push(format!("    agent={}", controller_text(controller)));
        }
        if let Some(control) = &session.control {
            lines.push(format!("    control={}", control_text(control)));
        }
    }
    lines.join("\n")
}

/// `session stop --json` 成功信封。
pub fn stop_json(session_id: &str, stopped: &StopResult, context: &DaemonContext) -> Json {
    crate::json_obj! {
        "ok" => Json::Bool(true),
        "stopped" => crate::json_obj! {
            "sessionId" => Json::string(session_id),
            "borrowed" => Json::Bool(stopped.borrowed),
            "alreadyStopping" => Json::Bool(stopped.already_stopping),
            "handedOff" => match &stopped.handed_off {
                Some(hand) => crate::json_obj! {
                    "sessionId" => Json::string(hand.session_id.clone()),
                    "tabId" => hand.tab_id.map(|id| Json::Number(id as f64)).unwrap_or(Json::Null),
                },
                None => Json::Null,
            },
        },
        "daemon" => context.daemon_json(),
        "exitCode" => Json::Number(f64::from(status::EXIT_CODE_OK)),
    }
}

/// `session stop` 文本输出。
pub fn stop_text(session_id: &str, keep: bool, stopped: &StopResult) -> String {
    let mut line = format!(
        "session {session_id} 已停止{}{}",
        if keep { "（保留窗口）" } else { "" },
        if stopped.borrowed { "（归还借用标签页）" } else { "" },
    );
    if stopped.already_stopping {
        line.push_str("（此前已在停止中）");
    }
    if let Some(hand) = &stopped.handed_off {
        line.push_str(&format!(
            "；tab {} 的控制权/主会话转交 {}",
            hand.tab_id.map(|id| id.to_string()).unwrap_or_else(|| "?".to_string()),
            display_or(&hand.session_id, "?")
        ));
    }
    line
}

fn controller_text(controller: &Json) -> String {
    let name = controller.get("name").and_then(Json::as_str).unwrap_or("?");
    match controller.get("project").and_then(Json::as_str) {
        Some(project) if !project.is_empty() => format!("{name} / {project}"),
        _ => name.to_string(),
    }
}

fn control_text(control: &Json) -> String {
    let text = |key: &str, fallback: &str| {
        control
            .get(key)
            .and_then(Json::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| fallback.to_string())
    };
    let mut parts = vec![format!(
        "mode={} holder={} epoch={} sessions={}",
        text("mode", "open"),
        text("holder", "(空闲)"),
        control.get("epoch").and_then(Json::as_u64).unwrap_or(0),
        control.get("sessionCount").and_then(Json::as_u64).unwrap_or(0),
    )];
    if let Some(ms) = control.get("leaseRemainingMs").and_then(Json::as_u64) {
        parts.push(format!("租约={ms}ms"));
    }
    parts.join(" ")
}

fn display_or<'a>(text: &'a str, default: &'a str) -> &'a str {
    if text.is_empty() {
        default
    } else {
        text
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

/// 毫秒时间戳 → UTC ISO-8601（`YYYY-MM-DDTHH:MM:SSZ`）。
///
/// std 没有日期类型；用 Howard Hinnant 的 civil-from-days 算法手写（纯整数、无时区库），
/// 单测覆盖 1970/闰年/闰秒边界与 0.3.0 的真实 `startedAt` 样例。
pub fn format_epoch_utc(epoch_ms: u64) -> String {
    let seconds = (epoch_ms / 1_000) as i64;
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = seconds_of_day % 3_600 / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// 1970-01-01 起的天数 → (year, month, day)（Howard Hinnant `civil_from_days`）。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::{DaemonMetadata, HomeSource};
    use crate::rpc_client::DaemonClient;
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::thread;
    use std::time::Duration;

    fn metadata(port: u16) -> DaemonMetadata {
        DaemonMetadata {
            pid: Some(4242),
            port,
            token: "test-token-value".to_string(),
            version: Some("0.3.0".to_string()),
            started_at: Some(1),
            tls: false,
            path: PathBuf::from(r"C:\h\daemon.json"),
            home: PathBuf::from(r"C:\h"),
            home_source: HomeSource::Env,
        }
    }

    fn context(port: u16) -> DaemonContext {
        let metadata = metadata(port);
        DaemonContext {
            client: DaemonClient::with_timeouts(metadata.clone(), Duration::from_millis(500), Duration::from_secs(2)),
            metadata,
            timeout_ms: 1_000,
        }
    }

    /// 单次请求的假 daemon：返回固定响应，并把收到的原始请求带回。
    fn serve_once(status_line: &'static str, body: &'static str) -> (u16, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("绑定");
        let port = listener.local_addr().expect("地址").port();
        let handle = thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept");
            socket.set_read_timeout(Some(Duration::from_secs(2))).expect("超时");
            let mut raw = Vec::new();
            let mut chunk = [0u8; 1024];
            loop {
                let count = socket.read(&mut chunk).unwrap_or(0);
                if count == 0 {
                    break;
                }
                raw.extend_from_slice(&chunk[..count]);
                if let Some(head_end) = crate::http::find_head_end(&raw) {
                    let text = String::from_utf8_lossy(&raw).to_string();
                    let length = text
                        .to_ascii_lowercase()
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:").and_then(|value| value.trim().parse::<usize>().ok()))
                        .unwrap_or(0);
                    if raw.len() >= head_end + length {
                        break;
                    }
                }
            }
            let response = format!(
                "{status_line}\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: {}\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes());
            let _ = socket.flush();
            let _ = socket.shutdown(std::net::Shutdown::Both);
            String::from_utf8_lossy(&raw).to_string()
        });
        (port, handle)
    }

    fn start_fixture() -> &'static str {
        r#"{"ok":true,"result":{"sessionId":"abcd","instanceId":"a1b2c3d4","tabId":7,"windowId":3,"borrowed":false,"shared":false,"ownerSession":null}}"#
    }

    #[test]
    fn start_sends_expected_params_and_renders_json() {
        let (port, capture) = serve_once("HTTP/1.1 200 OK", start_fixture());
        let options = StartOptions { json: true, focus: true, ..StartOptions::default() };
        let output = run_start(&options, &context(port));
        assert_eq!(output.exit_code, 0, "stderr={}", output.stderr);
        let json = Json::parse(&output.stdout).expect("JSON 输出");
        assert_eq!(json.get("ok").and_then(Json::as_bool), Some(true));
        assert_eq!(json.get("exitCode").and_then(Json::as_u64), Some(0));
        let session = json.get("session").expect("session 段");
        assert_eq!(session.get("sessionId").and_then(Json::as_str), Some("abcd"));
        assert_eq!(session.get("instanceId").and_then(Json::as_str), Some("a1b2c3d4"));
        assert_eq!(session.get("tabId").and_then(Json::as_u64), Some(7));
        assert_eq!(session.get("windowId").and_then(Json::as_u64), Some(3));
        assert_eq!(json.get("daemon").and_then(|daemon| daemon.get("endpoint")).and_then(Json::as_str), Some(format!("127.0.0.1:{port}").as_str()));
        assert!(!output.stdout.contains("test-token-value"), "不能输出 token");
        let raw = capture.join().expect("线程");
        assert!(raw.starts_with("POST /rpc HTTP/1.1\r\n"), "实际请求：{raw}");
        assert!(raw.contains("x-bridge-token: test-token-value\r\n"));
        assert!(raw.contains(r#""method":"session.start""#), "请求体：{raw}");
        assert!(raw.contains(r#""focus":true"#), "请求体：{raw}");
        assert!(raw.contains(r#""timeoutMs":1000"#), "请求体：{raw}");
    }

    #[test]
    fn start_params_encode_every_option() {
        let (port, capture) = serve_once("HTTP/1.1 200 OK", start_fixture());
        let options = StartOptions {
            json: false,
            focus: false,
            incognito: true,
            browser: Some("edge".to_string()),
            tab: Some(9),
            share: true,
            scope: Some("proj-a".to_string()),
            allow_domains: Some("example.com".to_string()),
            deny_domains: Some("evil.test".to_string()),
            min_interval_ms: Some(9_000),
            control_mode: Some("exclusive".to_string()),
            controller: Some(Controller {
                name: "agent-1".to_string(),
                project: Some("proj".to_string()),
                color: Some("#1a2b3c".to_string()),
            }),
            request_id: Some("1795598250:abc".to_string()),
            ..StartOptions::default()
        };
        let output = run_start(&options, &context(port));
        assert_eq!(output.exit_code, 0, "stderr={}", output.stderr);
        let raw = capture.join().expect("线程");
        for needle in [
            r#""incognito":true"#,
            r#""allowDomains":"example.com""#,
            r#""denyDomains":"evil.test""#,
            r#""minIntervalMs":5000"#,
            r#""browser":"edge""#,
            r#""scope":"proj-a""#,
            r##""controller":{"name":"agent-1","project":"proj","color":"#1a2b3c"}"##,
            r#""tab":9"#,
            r#""share":true"#,
            r#""controlMode":"exclusive""#,
            r#""requestId":"1795598250:abc""#,
        ] {
            assert!(raw.contains(needle), "缺少 {needle}：{raw}");
        }
        // 文本模式：人读摘要。
        assert!(output.stdout.contains("session abcd 已创建"), "{}", output.stdout);
        assert!(output.stdout.contains("instance a1b2c3d4"), "{}", output.stdout);
    }

    #[test]
    fn start_requires_session_id_from_daemon() {
        let (port, _) = serve_once("HTTP/1.1 200 OK", r#"{"ok":true,"result":{"instanceId":"x"}}"#);
        let options = StartOptions { json: true, ..StartOptions::default() };
        let output = run_start(&options, &context(port));
        assert_eq!(output.exit_code, 3);
        let json = Json::parse(&output.stdout).expect("错误 JSON");
        assert_eq!(json.get("ok").and_then(Json::as_bool), Some(false));
        let error = json.get("error").expect("error");
        assert_eq!(error.get("code").and_then(Json::as_str), Some("E_RPC"));
        assert!(error.get("message").and_then(Json::as_str).unwrap_or("").contains("sessionId"));
    }

    #[test]
    fn list_parses_views_and_renders_both_modes() {
        let body = r#"{"ok":true,"result":{"sessions":[
            {"sessionId":"abcd","instanceId":"a1b2c3d4","tabId":7,"windowId":3,"url":"https://example.com/x",
             "title":"Example","borrowed":false,"shared":true,"ownerSession":"zzzz","incognito":false,
             "controller":{"name":"agent-1","project":"proj"},"scope":"s","allowDomains":["a.test"],
             "denyDomains":[],"minIntervalMs":0,"controlMode":"open",
             "control":{"mode":"open","epoch":2,"holder":"abcd","primary":"abcd","shared":true,"sessionCount":2},
             "connected":true,"restored":false,"phase":"ready","startedAt":1795598249000,"ageMs":1234},
            null, 7, {"sessionId":"efgh","instanceId":"i2","phase":"active"}
        ]}}"#;
        let (port, _) = serve_once("HTTP/1.1 200 OK", body);
        let json = run_list(&ListOptions { json: true, ..ListOptions::default() }, &context(port));
        assert_eq!(json.exit_code, 0, "stderr={}", json.stderr);
        let value = Json::parse(&json.stdout).expect("JSON");
        let sessions = value.get("sessions").expect("sessions");
        assert_eq!(sessions.get("count").and_then(Json::as_u64), Some(2), "非对象条目应被跳过");
        let items = sessions.get("items").and_then(Json::as_array).expect("items");
        assert_eq!(items[0].get("sessionId").and_then(Json::as_str), Some("abcd"));
        assert_eq!(items[0].get("shared").and_then(Json::as_bool), Some(true));
        assert_eq!(items[0].get("tabId").and_then(Json::as_u64), Some(7));
        assert_eq!(items[0].get("connected").and_then(Json::as_bool), Some(true));
        assert_eq!(items[0].get("phase").and_then(Json::as_str), Some("ready"));
        assert_eq!(items[0].get("startedAtIso").and_then(Json::as_str), Some(format_epoch_utc(1_795_598_249_000).as_str()));
        assert!(items[0].get("control").is_some());

        let (port, _) = serve_once("HTTP/1.1 200 OK", body);
        let text = run_list(&ListOptions::default(), &context(port));
        assert_eq!(text.exit_code, 0, "stderr={}", text.stderr);
        assert!(text.stdout.contains("sessions（2）"), "{}", text.stdout);
        assert!(text.stdout.contains("abcd tab=7 window=3"), "{}", text.stdout);
        assert!(text.stdout.contains("agent=agent-1 / proj"), "{}", text.stdout);
        assert!(text.stdout.contains("control=mode=open"), "{}", text.stdout);
    }

    #[test]
    fn list_empty_is_explicit_about_next_step() {
        let (port, _) = serve_once("HTTP/1.1 200 OK", r#"{"ok":true,"result":{"sessions":[]}}"#);
        let output = run_list(&ListOptions::default(), &context(port));
        assert_eq!(output.exit_code, 0);
        assert!(output.stdout.contains("没有活动 session"), "{}", output.stdout);
        assert!(output.stdout.contains("bridge-rs session start"), "{}", output.stdout);

        let (port, _) = serve_once("HTTP/1.1 200 OK", r#"{"ok":true,"result":{}}"#);
        let output = run_list(&ListOptions::default(), &context(port));
        assert_eq!(output.exit_code, 0, "缺 sessions 视作空列表");
        assert!(output.stdout.contains("没有活动 session"));
    }

    #[test]
    fn stop_sends_session_and_keep_and_renders_handoff() {
        let body = r#"{"ok":true,"result":{"ok":true,"borrowed":false,"handedOff":{"sessionId":"zzzz","tabId":7}}}"#;
        let (port, capture) = serve_once("HTTP/1.1 200 OK", body);
        let options = StopOptions { session: "abcd".to_string(), keep: true, ..StopOptions::default() };
        let output = run_stop(&options, &context(port));
        assert_eq!(output.exit_code, 0, "stderr={}", output.stderr);
        assert!(output.stdout.contains("session abcd 已停止（保留窗口）"), "{}", output.stdout);
        assert!(output.stdout.contains("tab 7 的控制权/主会话转交 zzzz"), "{}", output.stdout);
        let raw = capture.join().expect("线程");
        assert!(raw.contains(r#""method":"session.stop""#), "{raw}");
        assert!(raw.contains(r#""params":{"session":"abcd","keep":true}"#), "{raw}");
    }

    #[test]
    fn stop_json_includes_handoff_and_daemon_context() {
        let body = r#"{"ok":true,"result":{"ok":true,"borrowed":true,"handedOff":null}}"#;
        let (port, _) = serve_once("HTTP/1.1 200 OK", body);
        let options = StopOptions { session: "abcd".to_string(), json: true, ..StopOptions::default() };
        let output = run_stop(&options, &context(port));
        assert_eq!(output.exit_code, 0);
        let json = Json::parse(&output.stdout).expect("JSON");
        let stopped = json.get("stopped").expect("stopped");
        assert_eq!(stopped.get("sessionId").and_then(Json::as_str), Some("abcd"));
        assert_eq!(stopped.get("borrowed").and_then(Json::as_bool), Some(true));
        assert_eq!(stopped.get("handedOff"), Some(&Json::Null));
        assert!(json.get("daemon").and_then(|daemon| daemon.get("tokenPresent")).is_some());
        assert!(!output.stdout.contains("test-token-value"));
    }

    #[test]
    fn business_errors_keep_daemon_code_and_exit_3() {
        let body = r#"{"ok":false,"error":{"code":"E_NO_SESSION","message":"当前没有活动 session；先运行 bridge session start"}}"#;
        let (port, _) = serve_once("HTTP/1.1 200 OK", body);
        let options = StopOptions { session: "abcd".to_string(), json: true, ..StopOptions::default() };
        let output = run_stop(&options, &context(port));
        assert_eq!(output.exit_code, 3);
        let json = Json::parse(&output.stdout).expect("JSON");
        let error = json.get("error").expect("error");
        assert_eq!(error.get("code").and_then(Json::as_str), Some("E_NO_SESSION"));
        // 错误富化必须带 daemon 发现上下文。
        let data = error.get("data").expect("data");
        assert!(data.get("daemon").is_some(), "缺少 daemon 上下文：{data:?}");
    }

    #[test]
    fn validation_errors_are_structured_arg_codes() {
        let share_without_tab = StartOptions { share: true, ..StartOptions::default() };
        let error = share_without_tab.validate().expect_err("--share 需要 --tab");
        assert_eq!(error.code, ErrorCode::ArgRequires);
        assert!(error.message.contains("--tab"), "{}", error.message);

        let bad_mode = StartOptions { control_mode: Some("shared".to_string()), ..StartOptions::default() };
        assert_eq!(bad_mode.validate().expect_err("非法模式").code, ErrorCode::ArgEnum);

        let empty_scope = StartOptions { scope: Some("  ".to_string()), ..StartOptions::default() };
        assert_eq!(empty_scope.validate().expect_err("空 scope").code, ErrorCode::ArgRange);

        let long_scope = StartOptions { scope: Some("x".repeat(MAX_SCOPE_CHARS + 1)), ..StartOptions::default() };
        assert_eq!(long_scope.validate().expect_err("超长 scope").code, ErrorCode::ArgRange);

        let bad_color = StartOptions {
            controller: Some(Controller { name: "a".to_string(), project: None, color: Some("#12345".to_string()) }),
            ..StartOptions::default()
        };
        assert_eq!(bad_color.validate().expect_err("非法颜色").code, ErrorCode::ArgType);

        let long_name = StartOptions {
            controller: Some(Controller { name: "n".repeat(MAX_CONTROLLER_NAME_CHARS + 1), project: None, color: None }),
            ..StartOptions::default()
        };
        assert_eq!(long_name.validate().expect_err("超长名称").code, ErrorCode::ArgRange);

        let empty_request = StartOptions { request_id: Some(" ".to_string()), ..StartOptions::default() };
        assert_eq!(empty_request.validate().expect_err("空 requestId").code, ErrorCode::ArgRange);

        let empty_stop = StopOptions { session: "  ".to_string(), ..StopOptions::default() };
        assert_eq!(empty_stop.validate().expect_err("空 session").code, ErrorCode::ArgMissing);
    }

    #[test]
    fn invalid_options_return_exit_2_without_touching_daemon() {
        let options = StartOptions { share: true, ..StartOptions::default() };
        let output = execute(&SessionCommand::Start(options));
        assert_eq!(output.exit_code, status::EXIT_CODE_USAGE);
        assert!(output.stdout.is_empty());
        assert!(output.stderr.contains("E_ARG_REQUIRES"), "{}", output.stderr);
    }

    #[test]
    fn controller_json_and_validation_round_trip() {
        let controller = Controller {
            name: " agent ".to_string(),
            project: Some(" proj ".to_string()),
            color: Some("#AABBCC".to_string()),
        };
        assert!(controller.validate().is_ok());
        assert_eq!(
            controller.to_json().to_compact_string(),
            r##"{"name":"agent","project":"proj","color":"#AABBCC"}"##
        );
        let missing = Controller { name: " ".to_string(), ..Controller::default() };
        assert_eq!(missing.validate().expect_err("空名称").code, ErrorCode::ArgMissing);
        // 颜色大小写不敏感（`#AABBCC` 合法），但必须 6 位。
        for color in ["#1234567", "red", "123456", "#12345g"] {
            let controller = Controller { name: "a".to_string(), color: Some(color.to_string()), ..Controller::default() };
            assert!(controller.validate().is_err(), "夹具 {color}");
        }
    }

    #[test]
    fn epoch_millis_format_is_utc_iso() {
        assert_eq!(format_epoch_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_epoch_utc(999), "1970-01-01T00:00:00Z");
        assert_eq!(format_epoch_utc(1_000), "1970-01-01T00:00:01Z");
        assert_eq!(format_epoch_utc(1_795_598_248_515), "2026-11-25T09:17:28Z");
        // 闰年 2024-02-29（UTC）。
        assert_eq!(format_epoch_utc(1_709_164_800_000), "2024-02-29T00:00:00Z");
        // 2000-03-01（百年闰规则）。
        assert_eq!(format_epoch_utc(951_868_800_000), "2000-03-01T00:00:00Z");
    }

    #[test]
    fn start_result_tolerates_optional_fields() {
        let started = StartResult::from_json(&Json::parse(r#"{"sessionId":"a","reused":true}"#).expect("夹具")).expect("最小结果");
        assert_eq!(started.session_id, "a");
        assert_eq!(started.tab_id, None);
        assert_eq!(started.window_id, None);
        assert!(started.reused);
        assert!(!started.shared);
        // 非对象 / 缺 sessionId → E_RPC。
        for text in ["[]", "null", r#"{"instanceId":"x"}"#] {
            let error = StartResult::from_json(&Json::parse(text).expect("夹具")).expect_err("必须拒绝");
            assert_eq!(error.code, ErrorCode::Rpc, "夹具 {text}");
        }
    }

    #[test]
    fn list_result_rejects_non_array_sessions() {
        let error = ListResult::from_json(&Json::parse(r#"{"sessions":{}}"#).expect("夹具")).expect_err("必须拒绝");
        assert_eq!(error.code, ErrorCode::Rpc);
        let error = ListResult::from_json(&Json::Null).expect_err("非对象");
        assert_eq!(error.code, ErrorCode::Rpc);
    }

    #[test]
    fn stop_result_parses_handed_off_shapes() {
        let stopped = StopResult::from_json(
            &Json::parse(r#"{"ok":true,"borrowed":true,"alreadyStopping":true}"#).expect("夹具"),
        )
        .expect("解析");
        assert!(stopped.borrowed);
        assert!(stopped.already_stopping);
        assert_eq!(stopped.handed_off, None);
        let stopped = StopResult::from_json(
            &Json::parse(r#"{"handedOff":{"sessionId":"zzzz","tabId":12}}"#).expect("夹具"),
        )
        .expect("解析");
        assert_eq!(stopped.handed_off.expect("转交").session_id, "zzzz");
        let error = StopResult::from_json(&Json::parse(r#"{"handedOff":7}"#).expect("夹具")).expect_err("必须拒绝");
        assert_eq!(error.code, ErrorCode::Rpc);
    }

    #[test]
    fn method_constants_match_protocol_catalog() {
        for method in [METHOD_START, METHOD_STOP, METHOD_LIST] {
            let spec = crate::protocol::method_spec(method).unwrap_or_else(|| panic!("目录缺少 {method}"));
            assert_eq!(spec.owner, "local", "{method} 应为本地方法");
            assert_eq!(spec.effect, "control_plane", "{method} 的效果位");
        }
    }

    #[test]
    fn min_interval_is_clamped_like_daemon() {
        let options = StartOptions { min_interval_ms: Some(MAX_MIN_INTERVAL_MS + 1), ..StartOptions::default() };
        let json = options.to_params();
        assert_eq!(json.get("minIntervalMs").and_then(Json::as_u64), Some(MAX_MIN_INTERVAL_MS));
        let options = StartOptions { min_interval_ms: Some(1_500), ..StartOptions::default() };
        assert_eq!(options.to_params().get("minIntervalMs").and_then(Json::as_u64), Some(1_500));
    }

    #[test]
    fn duration_helper_is_wired_for_min_interval() {
        // CLI 解析层用同一个 duration 解析器：这里验证 1s → 1000ms 的语义可达。
        let parsed = crate::duration::parse_duration_ms("1s", None, "min-interval").expect("解析");
        let options = StartOptions { min_interval_ms: Some(parsed), ..StartOptions::default() };
        assert_eq!(options.to_params().get("minIntervalMs").and_then(Json::as_u64), Some(1_000));
    }
}

//! 命令解析（std-only，无第三方依赖）。
//!
//! 子命令风格与 Node CLI 对齐（`bridge status --json`、`bridge session start`）。Rust 侧当前覆盖：
//! 协议视图（`protocol`）、真实 daemon 查询（`status` / `health` / `ws-hello`）、
//! **会话命令（`session start|stop|list`）**、**只读观察（`observe`）**、版本与帮助。
//!
//! 参数错误使用单源错误码：
//! - 未知子命令/视图 → `E_BAD_SUBCOMMAND`
//! - 未知选项 → `E_UNKNOWN_FLAG`
//! - 多余参数/互斥视图 → `E_ARG_UNEXPECTED`
//! - `--timeout` 缺值/非整数/越界 → `E_ARG_MISSING` / `E_ARG_TYPE` / `E_ARG_RANGE`
//! - 会话/观察参数（`--tab`/`--share`/`--control`/`--max-tokens`…）→ `E_ARG_*` 单源码，
//!   校验在解析期完成，退出码 2（与 Node CLI 的通用退出码 1 不同，这里给脚本更精确的语义）。
//!
//! TLS：`daemon.json` 的 `tls:true` 由 `tls_policy` 在任何网络请求前拒绝
//! （`E_UNSUPPORTED_CAPABILITY` + 可执行替代），不会假装支持 wss。

use crate::duration::parse_duration_ms;
use crate::errors::ErrorCode;
use crate::observe_cmd::{ObserveOptions, MAX_CURSOR_CHARS, MAX_DEPTH, MAX_TOKENS, MAX_VOM_NODES, MAX_VOM_TOKENS, MAX_VOM_TOP};
use crate::rpc_client::MAX_RPC_TIMEOUT_MS;
use crate::session_cmd::{Controller, ListOptions, SessionCommand, StartOptions, StopOptions};

/// `protocol` 子视图。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolView {
    /// 协议摘要（默认）：方法/错误码/feature floor/兼容矩阵/会话状态/握手示例。
    Summary,
    /// 158 个错误码 + 恢复建议。
    Codes,
    /// 9 个 feature floor + 1.8/1.9/2.0 可用性。
    Features,
    /// hello / hello-ack 示例 + 版本协商。
    Handshake,
}

impl ProtocolView {
    pub fn as_str(self) -> &'static str {
        match self {
            ProtocolView::Summary => "summary",
            ProtocolView::Codes => "codes",
            ProtocolView::Features => "features",
            ProtocolView::Handshake => "handshake",
        }
    }

    pub fn parse(text: &str) -> Option<ProtocolView> {
        match text {
            "summary" => Some(ProtocolView::Summary),
            "codes" => Some(ProtocolView::Codes),
            "features" => Some(ProtocolView::Features),
            "handshake" => Some(ProtocolView::Handshake),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Help,
    Version,
    Protocol { view: ProtocolView, json: bool },
    /// 真实 daemon 摘要（发现 + /health + /rpc status）。
    Status { json: bool, timeout_ms: Option<u64> },
    /// 只做 `GET /health`（不需要 token），排查 daemon 是否活着。
    Health { json: bool, timeout_ms: Option<u64> },
    /// 真实 WebSocket 握手 + hello/hello-ack 探测。
    WsHello { json: bool, timeout_ms: Option<u64> },
    /// 会话命令：`session start|stop|list`（真实 `/rpc`）。
    Session(SessionCommand),
    /// 只读观察：`observe`。
    Observe(ObserveOptions),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliError {
    pub code: ErrorCode,
    pub message: String,
}

impl CliError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    fn unknown_command(name: &str) -> Self {
        Self::new(ErrorCode::BadSubcommand, format!("未知命令：{name}"))
    }

    fn unknown_flag(flag: &str) -> Self {
        Self::new(ErrorCode::UnknownFlag, format!("未知选项：{flag}"))
    }

    fn unexpected(arg: &str) -> Self {
        Self::new(ErrorCode::ArgUnexpected, format!("该命令不接受参数：{arg}"))
    }

    fn unknown_view(view: &str) -> Self {
        Self::new(ErrorCode::BadSubcommand, format!("未知 protocol 视图：{view}（可选 summary/codes/features/handshake）"))
    }

    fn timeout_missing() -> Self {
        Self::new(ErrorCode::ArgMissing, "--timeout 需要一个毫秒整数，例如 --timeout 3000")
    }

    fn timeout_not_integer(text: &str) -> Self {
        Self::new(ErrorCode::ArgType, format!("--timeout 必须是整数毫秒：{text}"))
    }

    fn timeout_out_of_range(value: u64) -> Self {
        Self::new(
            ErrorCode::ArgRange,
            format!("--timeout 必须在 1..={MAX_RPC_TIMEOUT_MS} 毫秒之间，实际 {value}"),
        )
    }
}

pub const HELP: &str = "\
bridge-rs —— BridgeDeck CLI（Rust 架构路线）

用法：
  bridge-rs version                     crate / 产品 / 协议版本
  bridge-rs protocol [--json]           协议摘要（165 方法 / 158 错误码 / 9 feature floors）
  bridge-rs protocol codes [--json]     错误码清单（含恢复建议）
  bridge-rs protocol features [--json]  feature floor 与 1.8/1.9/2.0 兼容矩阵
  bridge-rs protocol handshake [--json] hello / hello-ack 示例与版本协商
  bridge-rs status [--json]             真实 daemon 摘要（发现 + GET /health + POST /rpc status）
  bridge-rs health [--json]             只探测 GET /health（不需要 token）
  bridge-rs ws-hello [--json]           WebSocket 握手 + hello/hello-ack 真实探测
  bridge-rs session start [--json]      新建/共享/借用标签页会话（POST /rpc session.start）
  bridge-rs session stop <id> [--keep]  停止会话（POST /rpc session.stop）
  bridge-rs session list [--json]       列出活动会话（POST /rpc session.list）
  bridge-rs observe [--json]            只读观察当前页面（POST /rpc observe）
  bridge-rs help                        显示本帮助

公共选项：--json 输出紧凑 JSON；--timeout <ms> 覆盖 RPC/握手超时（1..=600000）。
session start 选项：--focus --incognito --browser <b> --tab <n> --share
  --scope <s> --allow-domains <d> --deny-domains <d> --min-interval <ms>
  --control open|exclusive --agent-name <n> --project <p> --controller-color <#rrggbb>
  --request-id <id>
observe 选项：--session <id> --tab-id <n> --max-tokens <n> --max-depth <n> --probe-hover
  --closed-shadow --debug-surfaces --vom --vom-deep --vom-tree --vom-rank --vom-top <n>
  --vom-max-nodes <n> --vom-max-tokens <n> --vom-explain --vom-exclude-hidden
  --vom-profile balanced|compact|all --ax --facts --force --cursor <c> --delta [--baseline <b>]
数据来源：daemon.json（BB_HOME 或 %USERPROFILE%\\.browser-bridge）→ 127.0.0.1:<port>；
token 走 x-bridge-token 头，绝不打印到输出。错误码/方法目录/协议版本均由 JS 单源生成，不手写。
TLS：daemon.json 声明 tls:true 时明确 E_UNSUPPORTED_CAPABILITY（std-only 无 TLS 栈，不假装支持），
可执行替代见 crates/bridge-cli/README.md「TLS 策略（不支持 wss）」。
退出码：0 成功；2 参数/命令错误；3 daemon 不可达或调用失败。";

pub fn parse(argv: &[String]) -> Result<Command, CliError> {
    let mut rest = argv.iter().map(String::as_str);
    let Some(first) = rest.next() else {
        return Ok(Command::Help);
    };
    match first {
        "help" | "--help" | "-h" => Ok(Command::Help),
        "version" | "--version" | "-V" => Ok(Command::Version),
        "protocol" => parse_protocol(rest),
        "status" => parse_status(rest),
        "health" => parse_health(rest),
        "ws-hello" | "ws_hello" => parse_ws_hello(rest),
        "session" => parse_session(rest),
        "observe" => parse_observe(rest),
        other if other.starts_with('-') => Err(CliError::unknown_flag(other)),
        other => Err(CliError::unknown_command(other)),
    }
}

/// 解析 `--json` / `--timeout <ms>` / `--timeout=<ms>`；位置参数由 `allow_positional` 决定。
struct CommonArgs {
    json: bool,
    timeout_ms: Option<u64>,
    help: bool,
}

fn parse_common<'a>(
    mut rest: impl Iterator<Item = &'a str>,
    allow_positional: impl Fn(&str) -> Result<(), CliError>,
) -> Result<CommonArgs, CliError> {
    let mut json = false;
    let mut timeout_ms: Option<u64> = None;
    let mut pending_timeout = false;
    let mut help = false;
    for arg in rest.by_ref() {
        if pending_timeout {
            pending_timeout = false;
            timeout_ms = Some(parse_timeout_value(arg)?);
            continue;
        }
        match arg {
            "--json" => json = true,
            "-h" | "--help" => help = true,
            "--timeout" => pending_timeout = true,
            other if other.starts_with("--timeout=") => {
                let value = other.trim_start_matches("--timeout=");
                timeout_ms = Some(parse_timeout_value(value)?);
            }
            other if other.starts_with('-') => return Err(CliError::unknown_flag(other)),
            other => allow_positional(other)?,
        }
    }
    if pending_timeout {
        return Err(CliError::timeout_missing());
    }
    Ok(CommonArgs { json, timeout_ms, help })
}

fn parse_timeout_value(text: &str) -> Result<u64, CliError> {
    if text.is_empty() {
        return Err(CliError::timeout_missing());
    }
    let value = text.parse::<u64>().map_err(|_| CliError::timeout_not_integer(text))?;
    if value == 0 || value > MAX_RPC_TIMEOUT_MS {
        return Err(CliError::timeout_out_of_range(value));
    }
    Ok(value)
}

fn parse_protocol<'a>(mut rest: impl Iterator<Item = &'a str>) -> Result<Command, CliError> {
    let mut view = ProtocolView::Summary;
    let mut view_set = false;
    let mut json = false;
    for arg in rest.by_ref() {
        match arg {
            "--json" => json = true,
            "-h" | "--help" => return Ok(Command::Help),
            other if other.starts_with('-') => return Err(CliError::unknown_flag(other)),
            other => {
                let Some(parsed) = ProtocolView::parse(other) else {
                    return Err(CliError::unknown_view(other));
                };
                if view_set {
                    return Err(CliError::unexpected(other));
                }
                view = parsed;
                view_set = true;
            }
        }
    }
    Ok(Command::Protocol { view, json })
}

fn parse_status<'a>(rest: impl Iterator<Item = &'a str>) -> Result<Command, CliError> {
    let args = parse_common(rest, |arg| Err(CliError::unexpected(arg)))?;
    if args.help {
        return Ok(Command::Help);
    }
    Ok(Command::Status { json: args.json, timeout_ms: args.timeout_ms })
}

fn parse_health<'a>(rest: impl Iterator<Item = &'a str>) -> Result<Command, CliError> {
    let args = parse_common(rest, |arg| Err(CliError::unexpected(arg)))?;
    if args.help {
        return Ok(Command::Help);
    }
    Ok(Command::Health { json: args.json, timeout_ms: args.timeout_ms })
}

fn parse_ws_hello<'a>(rest: impl Iterator<Item = &'a str>) -> Result<Command, CliError> {
    let args = parse_common(rest, |arg| Err(CliError::unexpected(arg)))?;
    if args.help {
        return Ok(Command::Help);
    }
    Ok(Command::WsHello { json: args.json, timeout_ms: args.timeout_ms })
}

// ---------------------------------------------------------------------------
// `session start|stop|list`（M-D 第四批）
// ---------------------------------------------------------------------------

/// 游标式参数读取：支持 `--flag value` 与 `--flag=value` 两种写法。
struct FlagCursor<'a> {
    items: &'a [&'a str],
    index: usize,
}

impl<'a> FlagCursor<'a> {
    fn new(items: &'a [&'a str]) -> Self {
        Self { items, index: 0 }
    }

    fn next(&mut self) -> Option<&'a str> {
        let item = self.items.get(self.index).copied();
        if item.is_some() {
            self.index += 1;
        }
        item
    }

    /// 取 `--flag` 的值（内联 `=value` 优先，否则吃下一个 token）。
    fn value(&mut self, flag: &str, inline: Option<&str>) -> Result<String, CliError> {
        match inline {
            Some(value) if !value.is_empty() => Ok(value.to_string()),
            Some(_) => Err(CliError::new(ErrorCode::ArgMissing, format!("{flag} 需要一个值"))),
            None => match self.next() {
                Some(value) if !value.is_empty() => Ok(value.to_string()),
                _ => Err(CliError::new(
                    ErrorCode::ArgMissing,
                    format!("{flag} 需要一个值（示例：{flag} <value>）"),
                )),
            },
        }
    }
}

/// `--flag=value` → `(flag, value)`；非内联形式返回 `None`。
fn split_inline(arg: &str) -> Option<(&str, &str)> {
    if !arg.starts_with("--") {
        return None;
    }
    arg.split_once('=')
}

/// 布尔开关不接受 `=value` 形式（避免 `--json=false` 被静默当成 true）。
fn require_switch(flag: &str, inline: Option<&str>) -> Result<(), CliError> {
    if inline.is_some() {
        return Err(CliError::new(
            ErrorCode::ArgUnexpected,
            format!("{flag} 是开关，不接受值（要关闭就不写这个开关）"),
        ));
    }
    Ok(())
}

/// 整数参数：`E_ARG_TYPE`（非整数）/ `E_ARG_RANGE`（越界）。
fn parse_u64_value(flag: &str, text: &str, min: u64, max: u64) -> Result<u64, CliError> {
    let value: u64 = text
        .trim()
        .parse()
        .map_err(|_| CliError::new(ErrorCode::ArgType, format!("{flag} 需要整数，收到 {text:?}")))?;
    if value < min || value > max {
        return Err(CliError::new(
            ErrorCode::ArgRange,
            format!("{flag} 必须在 {min}..={max} 之间，实际 {value}"),
        ));
    }
    Ok(value)
}

fn controller_from_parts(
    name: Option<String>,
    project: Option<String>,
    color: Option<String>,
) -> Result<Option<Controller>, CliError> {
    match name {
        Some(name) => Ok(Some(Controller { name, project, color })),
        None if project.is_some() || color.is_some() => Err(CliError::new(
            ErrorCode::ArgRequires,
            "--project / --controller-color 需要同时给 --agent-name（否则没有控制器可归属）",
        )),
        None => Ok(None),
    }
}

fn parse_session<'a>(rest: impl Iterator<Item = &'a str>) -> Result<Command, CliError> {
    let items: Vec<&str> = rest.collect();
    let Some(first) = items.first().copied() else {
        return Err(CliError::new(ErrorCode::BadSubcommand, "session 需要一个子命令：start|stop|list"));
    };
    match first {
        "-h" | "--help" => Ok(Command::Help),
        "start" => match parse_session_start(&items[1..])? {
            Some(options) => Ok(Command::Session(SessionCommand::Start(options))),
            None => Ok(Command::Help),
        },
        "stop" => match parse_session_stop(&items[1..])? {
            Some(options) => Ok(Command::Session(SessionCommand::Stop(options))),
            None => Ok(Command::Help),
        },
        "list" => match parse_session_list(&items[1..])? {
            Some(options) => Ok(Command::Session(SessionCommand::List(options))),
            None => Ok(Command::Help),
        },
        other if other.starts_with('-') => Err(CliError::unknown_flag(other)),
        other => Err(CliError::new(
            ErrorCode::BadSubcommand,
            format!("未知 session 子命令：{other}（可选 start/stop/list）"),
        )),
    }
}

fn parse_session_start(items: &[&str]) -> Result<Option<StartOptions>, CliError> {
    let mut options = StartOptions::default();
    let mut agent_name: Option<String> = None;
    let mut project: Option<String> = None;
    let mut color: Option<String> = None;
    let mut cursor = FlagCursor::new(items);
    while let Some(arg) = cursor.next() {
        let (flag, inline) = match split_inline(arg) {
            Some((flag, value)) => (flag, Some(value)),
            None => (arg, None),
        };
        match flag {
            "-h" | "--help" => return Ok(None),
            "--json" => {
                require_switch(flag, inline)?;
                options.json = true;
            }
            "--timeout" => {
                let value = cursor.value(flag, inline)?;
                options.timeout_ms = Some(parse_timeout_value(&value)?);
            }
            "--focus" => {
                require_switch(flag, inline)?;
                options.focus = true;
            }
            "--incognito" => {
                require_switch(flag, inline)?;
                options.incognito = true;
            }
            "--share" => {
                require_switch(flag, inline)?;
                options.share = true;
            }
            "--browser" => options.browser = Some(cursor.value(flag, inline)?),
            "--tab" => {
                let value = cursor.value(flag, inline)?;
                options.tab = Some(parse_u64_value(flag, &value, 1, u64::from(u32::MAX))?);
            }
            "--scope" => options.scope = Some(cursor.value(flag, inline)?),
            "--allow-domains" => options.allow_domains = Some(cursor.value(flag, inline)?),
            "--deny-domains" => options.deny_domains = Some(cursor.value(flag, inline)?),
            "--min-interval" => {
                let value = cursor.value(flag, inline)?;
                options.min_interval_ms = Some(parse_duration_ms(&value, None, "min-interval")?);
            }
            "--control" => options.control_mode = Some(cursor.value(flag, inline)?),
            "--agent-name" => agent_name = Some(cursor.value(flag, inline)?),
            "--project" => project = Some(cursor.value(flag, inline)?),
            "--controller-color" => color = Some(cursor.value(flag, inline)?),
            "--request-id" => options.request_id = Some(cursor.value(flag, inline)?),
            other if other.starts_with('-') => return Err(CliError::unknown_flag(other)),
            other => return Err(CliError::unexpected(other)),
        }
    }
    options.controller = controller_from_parts(agent_name, project, color)?;
    options.validate()?;
    Ok(Some(options))
}

fn parse_session_stop(items: &[&str]) -> Result<Option<StopOptions>, CliError> {
    let mut options = StopOptions::default();
    let mut positional: Option<String> = None;
    let mut flagged: Option<String> = None;
    let mut cursor = FlagCursor::new(items);
    while let Some(arg) = cursor.next() {
        let (flag, inline) = match split_inline(arg) {
            Some((flag, value)) => (flag, Some(value)),
            None => (arg, None),
        };
        match flag {
            "-h" | "--help" => return Ok(None),
            "--json" => {
                require_switch(flag, inline)?;
                options.json = true;
            }
            "--keep" => {
                require_switch(flag, inline)?;
                options.keep = true;
            }
            "--timeout" => {
                let value = cursor.value(flag, inline)?;
                options.timeout_ms = Some(parse_timeout_value(&value)?);
            }
            "--session" => flagged = Some(cursor.value(flag, inline)?),
            other if other.starts_with('-') => return Err(CliError::unknown_flag(other)),
            other => {
                if positional.is_some() {
                    return Err(CliError::unexpected(other));
                }
                positional = Some(other.to_string());
            }
        }
    }
    options.session = match (positional, flagged) {
        (Some(positional), Some(flagged)) if positional != flagged => {
            return Err(CliError::new(
                ErrorCode::ArgConflict,
                "session stop 不接受同时给位置参数与 --session（且取值不同）",
            ))
        }
        (Some(positional), _) => positional,
        (None, Some(flagged)) => flagged,
        (None, None) => {
            return Err(CliError::new(
                ErrorCode::ArgMissing,
                "用法：bridge-rs session stop <sessionId> [--keep]",
            ))
        }
    };
    options.validate()?;
    Ok(Some(options))
}

fn parse_session_list(items: &[&str]) -> Result<Option<ListOptions>, CliError> {
    let mut options = ListOptions::default();
    let mut cursor = FlagCursor::new(items);
    while let Some(arg) = cursor.next() {
        let (flag, inline) = match split_inline(arg) {
            Some((flag, value)) => (flag, Some(value)),
            None => (arg, None),
        };
        match flag {
            "-h" | "--help" => return Ok(None),
            "--json" => {
                require_switch(flag, inline)?;
                options.json = true;
            }
            "--timeout" => {
                let value = cursor.value(flag, inline)?;
                options.timeout_ms = Some(parse_timeout_value(&value)?);
            }
            other if other.starts_with('-') => return Err(CliError::unknown_flag(other)),
            other => return Err(CliError::unexpected(other)),
        }
    }
    Ok(Some(options))
}

// ---------------------------------------------------------------------------
// `observe`（只读）
// ---------------------------------------------------------------------------

fn parse_observe<'a>(rest: impl Iterator<Item = &'a str>) -> Result<Command, CliError> {
    let items: Vec<&str> = rest.collect();
    let mut options = ObserveOptions::default();
    let mut cursor = FlagCursor::new(&items);
    while let Some(arg) = cursor.next() {
        let (flag, inline) = match split_inline(arg) {
            Some((flag, value)) => (flag, Some(value)),
            None => (arg, None),
        };
        match flag {
            "-h" | "--help" => return Ok(Command::Help),
            "--json" => {
                require_switch(flag, inline)?;
                options.json = true;
            }
            "--timeout" => {
                let value = cursor.value(flag, inline)?;
                options.timeout_ms = Some(parse_timeout_value(&value)?);
            }
            "--session" => options.session = Some(cursor.value(flag, inline)?),
            "--tab-id" => {
                let value = cursor.value(flag, inline)?;
                options.tab_id = Some(parse_u64_value(flag, &value, 0, u64::from(u32::MAX))?);
            }
            "--max-tokens" => {
                let value = cursor.value(flag, inline)?;
                options.max_tokens = Some(parse_u64_value(flag, &value, 1, MAX_TOKENS)?);
            }
            "--max-depth" => {
                let value = cursor.value(flag, inline)?;
                options.max_depth = Some(parse_u64_value(flag, &value, 1, MAX_DEPTH)?);
            }
            "--probe-hover" => {
                require_switch(flag, inline)?;
                options.probe_hover = true;
            }
            "--closed-shadow" => {
                require_switch(flag, inline)?;
                options.closed_shadow = true;
            }
            "--debug-surfaces" => {
                require_switch(flag, inline)?;
                options.debug_surfaces = true;
            }
            "--vom" => {
                require_switch(flag, inline)?;
                options.vom = true;
            }
            "--vom-deep" => {
                require_switch(flag, inline)?;
                options.vom_deep = true;
            }
            "--vom-tree" => {
                require_switch(flag, inline)?;
                options.vom_tree = true;
            }
            "--vom-rank" => {
                require_switch(flag, inline)?;
                options.vom_rank = true;
            }
            "--vom-top" => {
                let value = cursor.value(flag, inline)?;
                options.vom_top = Some(parse_u64_value(flag, &value, 1, MAX_VOM_TOP)?);
            }
            "--vom-max-nodes" => {
                let value = cursor.value(flag, inline)?;
                options.vom_max_nodes = Some(parse_u64_value(flag, &value, 1, MAX_VOM_NODES)?);
            }
            "--vom-max-tokens" => {
                let value = cursor.value(flag, inline)?;
                options.vom_max_tokens = Some(parse_u64_value(flag, &value, 1, MAX_VOM_TOKENS)?);
            }
            "--vom-explain" => {
                require_switch(flag, inline)?;
                options.vom_explain = true;
            }
            "--vom-exclude-hidden" => {
                require_switch(flag, inline)?;
                options.vom_exclude_hidden = true;
            }
            "--vom-profile" => options.vom_profile = Some(cursor.value(flag, inline)?),
            "--ax" => {
                require_switch(flag, inline)?;
                options.ax = true;
            }
            "--facts" => {
                require_switch(flag, inline)?;
                options.facts = true;
            }
            "--force" => {
                require_switch(flag, inline)?;
                options.force = true;
            }
            "--cursor" => {
                let value = cursor.value(flag, inline)?;
                if value.chars().count() > MAX_CURSOR_CHARS {
                    return Err(CliError::new(
                        ErrorCode::ArgRange,
                        format!("--cursor 最多 {MAX_CURSOR_CHARS} 字符"),
                    ));
                }
                options.cursor = Some(value);
            }
            "--delta" => {
                require_switch(flag, inline)?;
                options.delta = true;
            }
            "--baseline" => options.baseline = Some(cursor.value(flag, inline)?),
            other if other.starts_with('-') => return Err(CliError::unknown_flag(other)),
            other => return Err(CliError::unexpected(other)),
        }
    }
    options.validate()?;
    Ok(Command::Observe(options))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn empty_args_show_help() {
        assert_eq!(parse(&args(&[])), Ok(Command::Help));
    }

    #[test]
    fn help_and_version_aliases() {
        for flag in ["help", "--help", "-h"] {
            assert_eq!(parse(&args(&[flag])), Ok(Command::Help));
        }
        for flag in ["version", "--version", "-V"] {
            assert_eq!(parse(&args(&[flag])), Ok(Command::Version));
        }
    }

    #[test]
    fn protocol_defaults_to_summary_and_parses_json() {
        assert_eq!(
            parse(&args(&["protocol"])),
            Ok(Command::Protocol { view: ProtocolView::Summary, json: false })
        );
        assert_eq!(
            parse(&args(&["protocol", "--json"])),
            Ok(Command::Protocol { view: ProtocolView::Summary, json: true })
        );
        assert_eq!(
            parse(&args(&["protocol", "--json", "codes"])),
            Ok(Command::Protocol { view: ProtocolView::Codes, json: true })
        );
        assert_eq!(
            parse(&args(&["protocol", "handshake", "--json"])),
            Ok(Command::Protocol { view: ProtocolView::Handshake, json: true })
        );
    }

    #[test]
    fn protocol_views_are_parsed() {
        for (text, view) in [
            ("summary", ProtocolView::Summary),
            ("codes", ProtocolView::Codes),
            ("features", ProtocolView::Features),
            ("handshake", ProtocolView::Handshake),
        ] {
            assert_eq!(parse(&args(&["protocol", text])), Ok(Command::Protocol { view, json: false }));
            assert_eq!(view.as_str(), text);
        }
        assert_eq!(ProtocolView::parse("codes"), Some(ProtocolView::Codes));
        assert_eq!(ProtocolView::parse("nope"), None);
    }

    #[test]
    fn status_parses_json_and_timeout() {
        assert_eq!(
            parse(&args(&["status"])),
            Ok(Command::Status { json: false, timeout_ms: None })
        );
        assert_eq!(
            parse(&args(&["status", "--json"])),
            Ok(Command::Status { json: true, timeout_ms: None })
        );
        assert_eq!(
            parse(&args(&["status", "--timeout", "1500"])),
            Ok(Command::Status { json: false, timeout_ms: Some(1500) })
        );
        assert_eq!(
            parse(&args(&["status", "--json", "--timeout=3000"])),
            Ok(Command::Status { json: true, timeout_ms: Some(3000) })
        );
        // 选项顺序无关。
        assert_eq!(
            parse(&args(&["status", "--timeout", "900", "--json"])),
            Ok(Command::Status { json: true, timeout_ms: Some(900) })
        );
    }

    #[test]
    fn health_and_ws_hello_are_parsed() {
        assert_eq!(
            parse(&args(&["health"])),
            Ok(Command::Health { json: false, timeout_ms: None })
        );
        assert_eq!(
            parse(&args(&["health", "--json"])),
            Ok(Command::Health { json: true, timeout_ms: None })
        );
        for name in ["ws-hello", "ws_hello"] {
            assert_eq!(
                parse(&args(&[name, "--json", "--timeout", "2000"])),
                Ok(Command::WsHello { json: true, timeout_ms: Some(2000) })
            );
        }
    }

    #[test]
    fn timeout_validation_is_structured() {
        let error = parse(&args(&["status", "--timeout"])).expect_err("缺值");
        assert_eq!(error.code, ErrorCode::ArgMissing);
        assert!(error.message.contains("--timeout"), "{}", error.message);
        for text in ["abc", "1.5", "-1"] {
            let error = parse(&args(&["status", "--timeout", text])).expect_err("非整数");
            assert_eq!(error.code, ErrorCode::ArgType, "夹具 {text}");
        }
        for text in ["0", "600001", "999999999"] {
            let error = parse(&args(&["status", "--timeout", text])).expect_err("越界");
            assert_eq!(error.code, ErrorCode::ArgRange, "夹具 {text}");
            assert!(error.message.contains("600000"), "{}", error.message);
        }
        assert_eq!(MAX_RPC_TIMEOUT_MS, 600_000);
    }

    #[test]
    fn daemon_commands_reject_extra_args_and_flags() {
        for command in ["status", "health", "ws-hello"] {
            assert_eq!(
                parse(&args(&[command, "extra"])).expect_err("多余参数").code,
                ErrorCode::ArgUnexpected
            );
            assert_eq!(
                parse(&args(&[command, "--bogus"])).expect_err("未知选项").code,
                ErrorCode::UnknownFlag
            );
        }
    }

    #[test]
    fn subcommand_help_short_circuits() {
        assert_eq!(parse(&args(&["protocol", "--help"])), Ok(Command::Help));
        assert_eq!(parse(&args(&["status", "-h"])), Ok(Command::Help));
        assert_eq!(parse(&args(&["health", "--help"])), Ok(Command::Help));
        assert_eq!(parse(&args(&["ws-hello", "-h"])), Ok(Command::Help));
        for argv in [
            &["session", "--help"][..],
            &["session", "start", "--help"][..],
            &["session", "start", "-h"][..],
            &["session", "stop", "--help"][..],
            &["session", "list", "-h"][..],
            &["observe", "--help"][..],
            &["observe", "-h"][..],
        ] {
            assert_eq!(parse(&args(argv)), Ok(Command::Help), "夹具 {argv:?}");
        }
    }

    #[test]
    fn unknown_command_and_view_are_bad_subcommands() {
        for name in ["nope", "sessions", "daemon"] {
            let error = parse(&args(&[name])).expect_err("未知命令必须报错");
            assert_eq!(error.code, ErrorCode::BadSubcommand);
            assert!(error.message.contains(name));
        }
        let error = parse(&args(&["protocol", "bogus"])).expect_err("未知视图必须报错");
        assert_eq!(error.code, ErrorCode::BadSubcommand);
        assert!(error.message.contains("bogus"));
    }

    #[test]
    fn unknown_flags_and_extra_args_are_structured() {
        assert_eq!(parse(&args(&["--bogus"])).unwrap_err().code, ErrorCode::UnknownFlag);
        assert_eq!(parse(&args(&["protocol", "--bogus"])).unwrap_err().code, ErrorCode::UnknownFlag);
        assert_eq!(parse(&args(&["protocol", "extra"])).unwrap_err().code, ErrorCode::BadSubcommand);
        assert_eq!(parse(&args(&["protocol", "codes", "features"])).unwrap_err().code, ErrorCode::ArgUnexpected);
    }

    #[test]
    fn help_text_documents_real_wiring_and_exit_codes() {
        assert!(HELP.contains("protocol codes"));
        assert!(HELP.contains("protocol handshake"));
        assert!(HELP.contains("bridge-rs status [--json]"));
        assert!(HELP.contains("bridge-rs health [--json]"));
        assert!(HELP.contains("bridge-rs ws-hello [--json]"));
        assert!(HELP.contains("bridge-rs session start"));
        assert!(HELP.contains("bridge-rs session stop"));
        assert!(HELP.contains("bridge-rs session list"));
        assert!(HELP.contains("bridge-rs observe"));
        assert!(HELP.contains("POST /rpc session.start"));
        assert!(HELP.contains("POST /rpc observe"));
        assert!(HELP.contains("POST /rpc status"));
        assert!(HELP.contains("x-bridge-token"));
        assert!(HELP.contains("158 错误码"));
        assert!(HELP.contains("TLS 策略（不支持 wss）"));
        assert!(HELP.contains("E_UNSUPPORTED_CAPABILITY"));
        assert!(HELP.contains("退出码：0 成功；2 参数/命令错误；3 daemon 不可达或调用失败"));
        // 帮助不能再宣称"未接线"。
        assert!(!HELP.contains("未接线"));
    }

    // ------------------------------------------------------------------
    // session start|stop|list
    // ------------------------------------------------------------------

    #[test]
    fn session_start_parses_all_options() {
        let command = parse(&args(&[
            "session",
            "start",
            "--json",
            "--focus",
            "--incognito",
            "--browser",
            "edge",
            "--tab",
            "7",
            "--share",
            "--scope=s1",
            "--allow-domains",
            "a.test,b.test",
            "--deny-domains=evil.test",
            "--min-interval",
            "1.5s",
            "--control",
            "exclusive",
            "--agent-name",
            "agent-1",
            "--project",
            "proj",
            "--controller-color",
            "#102030",
            "--request-id",
            "1795598250:abc",
            "--timeout",
            "2500",
        ]))
        .expect("合法参数");
        let Command::Session(SessionCommand::Start(options)) = command else {
            panic!("应解析为 session start：{command:?}");
        };
        assert!(options.json);
        assert!(options.focus);
        assert!(options.incognito);
        assert_eq!(options.browser.as_deref(), Some("edge"));
        assert_eq!(options.tab, Some(7));
        assert!(options.share);
        assert_eq!(options.scope.as_deref(), Some("s1"));
        assert_eq!(options.allow_domains.as_deref(), Some("a.test,b.test"));
        assert_eq!(options.deny_domains.as_deref(), Some("evil.test"));
        assert_eq!(options.min_interval_ms, Some(1_500));
        assert_eq!(options.control_mode.as_deref(), Some("exclusive"));
        let controller = options.controller.expect("controller");
        assert_eq!(controller.name, "agent-1");
        assert_eq!(controller.project.as_deref(), Some("proj"));
        assert_eq!(controller.color.as_deref(), Some("#102030"));
        assert_eq!(options.request_id.as_deref(), Some("1795598250:abc"));
        assert_eq!(options.timeout_ms, Some(2_500));
    }

    #[test]
    fn session_start_defaults_and_minimal_form() {
        let command = parse(&args(&["session", "start"])).expect("最小参数");
        let Command::Session(SessionCommand::Start(options)) = command else {
            panic!("应解析为 session start");
        };
        assert_eq!(options, StartOptions::default());
        // 默认 focus=false（Node 侧 `focus: flags.focus === true`），参数里仍显式带 focus。
        assert_eq!(options.to_params().to_compact_string(), r#"{"focus":false}"#);
    }

    #[test]
    fn session_start_rejects_bad_arguments() {
        assert_eq!(
            parse(&args(&["session", "start", "--share"])).expect_err("--share 需要 --tab").code,
            ErrorCode::ArgRequires
        );
        assert_eq!(
            parse(&args(&["session", "start", "--tab", "x"])).expect_err("tab 非整数").code,
            ErrorCode::ArgType
        );
        assert_eq!(
            parse(&args(&["session", "start", "--tab", "0"])).expect_err("tab 越界").code,
            ErrorCode::ArgRange
        );
        assert_eq!(
            parse(&args(&["session", "start", "--control", "shared"])).expect_err("control 枚举").code,
            ErrorCode::ArgEnum
        );
        assert_eq!(
            parse(&args(&["session", "start", "--project", "p"])).expect_err("缺少 agent-name").code,
            ErrorCode::ArgRequires
        );
        assert_eq!(
            parse(&args(&["session", "start", "--controller-color", "#12345"])).expect_err("缺少 agent-name").code,
            ErrorCode::ArgRequires
        );
        assert_eq!(
            parse(&args(&[
                "session",
                "start",
                "--agent-name",
                "a",
                "--controller-color",
                "#12345"
            ]))
            .expect_err("颜色格式")
            .code,
            ErrorCode::ArgType
        );
        assert_eq!(
            parse(&args(&["session", "start", "--min-interval", "abc"])).expect_err("时长").code,
            ErrorCode::ArgType
        );
        assert_eq!(
            parse(&args(&["session", "start", "--json=false"])).expect_err("开关不接受值").code,
            ErrorCode::ArgUnexpected
        );
        assert_eq!(
            parse(&args(&["session", "start", "extra"])).expect_err("多余位置参数").code,
            ErrorCode::ArgUnexpected
        );
        assert_eq!(
            parse(&args(&["session", "start", "--bogus"])).expect_err("未知选项").code,
            ErrorCode::UnknownFlag
        );
        assert_eq!(
            parse(&args(&["session", "bogus"])).expect_err("未知子命令").code,
            ErrorCode::BadSubcommand
        );
        assert_eq!(
            parse(&args(&["session"])).expect_err("缺子命令").code,
            ErrorCode::BadSubcommand
        );
    }

    #[test]
    fn session_stop_parses_positional_and_flag_and_rejects_conflicts() {
        let command = parse(&args(&["session", "stop", "abcd", "--keep", "--json"])).expect("位置参数");
        let Command::Session(SessionCommand::Stop(options)) = command else {
            panic!("应解析为 session stop");
        };
        assert_eq!(options.session, "abcd");
        assert!(options.keep);
        assert!(options.json);

        let command = parse(&args(&["session", "stop", "--session=abcd"])).expect("--session");
        let Command::Session(SessionCommand::Stop(options)) = command else {
            panic!("应解析为 session stop");
        };
        assert_eq!(options.session, "abcd");
        assert!(!options.keep);

        // 位置参数与 --session 相同取值：允许（等价写法）；不同取值：冲突。
        assert!(parse(&args(&["session", "stop", "abcd", "--session", "abcd"])).is_ok());
        assert_eq!(
            parse(&args(&["session", "stop", "abcd", "--session", "efgh"])).expect_err("冲突").code,
            ErrorCode::ArgConflict
        );
        assert_eq!(
            parse(&args(&["session", "stop"])).expect_err("缺 sessionId").code,
            ErrorCode::ArgMissing
        );
        assert_eq!(
            parse(&args(&["session", "stop", "a", "b"])).expect_err("两个位置参数").code,
            ErrorCode::ArgUnexpected
        );
    }

    #[test]
    fn session_list_parses_and_rejects_positional() {
        let command = parse(&args(&["session", "list", "--json", "--timeout=1200"])).expect("合法");
        let Command::Session(SessionCommand::List(options)) = command else {
            panic!("应解析为 session list");
        };
        assert!(options.json);
        assert_eq!(options.timeout_ms, Some(1_200));
        assert_eq!(
            parse(&args(&["session", "list", "extra"])).expect_err("多余参数").code,
            ErrorCode::ArgUnexpected
        );
        assert_eq!(
            parse(&args(&["session", "list", "--bogus"])).expect_err("未知选项").code,
            ErrorCode::UnknownFlag
        );
    }

    // ------------------------------------------------------------------
    // observe（只读）
    // ------------------------------------------------------------------

    #[test]
    fn observe_parses_read_only_options() {
        let command = parse(&args(&[
            "observe",
            "--json",
            "--session",
            "abcd",
            "--tab-id",
            "7",
            "--max-tokens",
            "4000",
            "--max-depth=12",
            "--probe-hover",
            "--closed-shadow",
            "--debug-surfaces",
            "--vom",
            "--vom-deep",
            "--vom-tree",
            "--vom-rank",
            "--vom-top",
            "50",
            "--vom-max-nodes",
            "800",
            "--vom-max-tokens=9000",
            "--vom-explain",
            "--vom-exclude-hidden",
            "--vom-profile",
            "compact",
            "--ax",
            "--facts",
            "--force",
            "--cursor",
            "c1",
            "--baseline",
            "o1",
            "--delta",
            "--timeout",
            "3000",
        ]))
        .expect("合法参数");
        let Command::Observe(options) = command else {
            panic!("应解析为 observe：{command:?}");
        };
        assert!(options.json);
        assert_eq!(options.session.as_deref(), Some("abcd"));
        assert_eq!(options.tab_id, Some(7));
        assert_eq!(options.max_tokens, Some(4_000));
        assert_eq!(options.max_depth, Some(12));
        assert!(options.probe_hover && options.closed_shadow && options.debug_surfaces);
        assert!(options.vom && options.vom_deep && options.vom_tree && options.vom_rank);
        assert_eq!(options.vom_top, Some(50));
        assert_eq!(options.vom_max_nodes, Some(800));
        assert_eq!(options.vom_max_tokens, Some(9_000));
        assert!(options.vom_explain && options.vom_exclude_hidden);
        assert_eq!(options.vom_profile.as_deref(), Some("compact"));
        assert!(options.ax && options.facts && options.force);
        assert_eq!(options.cursor.as_deref(), Some("c1"));
        assert_eq!(options.baseline.as_deref(), Some("o1"));
        assert!(options.delta);
        assert_eq!(options.timeout_ms, Some(3_000));
        // baseline 隐含 delta（与 Node CLI 一致）。
        let params = options.to_params();
        assert_eq!(params.get("delta").and_then(crate::json::Json::as_bool), Some(true));
    }

    #[test]
    fn observe_defaults_to_no_params() {
        let command = parse(&args(&["observe"])).expect("最小参数");
        let Command::Observe(options) = command else {
            panic!("应解析为 observe");
        };
        assert_eq!(options, ObserveOptions::default());
        assert_eq!(options.to_params().to_compact_string(), "{}");
    }

    #[test]
    fn observe_rejects_bad_arguments() {
        assert_eq!(
            parse(&args(&["observe", "extra"])).expect_err("多余位置参数").code,
            ErrorCode::ArgUnexpected
        );
        assert_eq!(
            parse(&args(&["observe", "--bogus"])).expect_err("未知选项").code,
            ErrorCode::UnknownFlag
        );
        assert_eq!(
            parse(&args(&["observe", "--max-tokens", "abc"])).expect_err("非整数").code,
            ErrorCode::ArgType
        );
        assert_eq!(
            parse(&args(&["observe", "--max-tokens", "0"])).expect_err("下限").code,
            ErrorCode::ArgRange
        );
        assert_eq!(
            parse(&args(&["observe", "--max-tokens", "20001"])).expect_err("上限").code,
            ErrorCode::ArgRange
        );
        assert_eq!(
            parse(&args(&["observe", "--max-depth", "101"])).expect_err("上限").code,
            ErrorCode::ArgRange
        );
        assert_eq!(
            parse(&args(&["observe", "--vom-top", "501"])).expect_err("上限").code,
            ErrorCode::ArgRange
        );
        assert_eq!(
            parse(&args(&["observe", "--vom-profile", "tiny"])).expect_err("枚举").code,
            ErrorCode::ArgEnum
        );
        assert_eq!(
            parse(&args(&["observe", "--ax=1"])).expect_err("开关不接受值").code,
            ErrorCode::ArgUnexpected
        );
        // observe 没有写入口：任何动作类参数都应被当成未知选项拒绝。
        for flag in ["--ref", "--selector", "--url", "--text", "--click"] {
            assert_eq!(
                parse(&args(&["observe", flag, "x"])).expect_err("写入口必须拒绝").code,
                ErrorCode::UnknownFlag,
                "夹具 {flag}"
            );
        }
    }
}

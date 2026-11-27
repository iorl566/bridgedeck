//! `bridge-rs observe`：**只读**观察命令（基础参数 + JSON）。
//!
//! 契约只读对齐 `cli/commands/page.mjs` 的 `observe` 分支与 `lib/schemas.mjs` 的
//! `observe` schema（`maxTokens` 1..=20000、`maxDepth` 1..=100、VOM 各上限、`cursor` ≤4096 等）。
//!
//! 只读保证有两层：
//! 1. **命令层**：本命令只会发出 `observe` 一个方法（常量 [`METHOD_OBSERVE`]），
//!    不接受任何动作/输入参数（没有 `ref`/`text`/`url` 之类的写入口）；
//! 2. **目录层**：发起请求之前调用 [`assert_read_only`]，用生成的单源方法目录
//!    （`protocol::method_spec(...).effect`）校验 `observe` 仍是 `passive_read`；
//!    若目录把 observe 改成写方法（或方法名拼错），命令直接 `E_READ_ONLY` 拒绝，
//!    而不是把写操作伪装成"观察"发出去。
//!
//! 输出：`--json` 给 `{ok, observe:{method,readOnly,...归一字段}, daemon, exitCode}`；
//! 文本直接打印 `observation`（它是给人/Agent 读的观察正文），前后附 url/title 与 refs。
//! daemon token 永不输出。

use crate::cli::CliError;
use crate::command_io::{self, DaemonContext};
use crate::envelope::RpcError;
use crate::errors::ErrorCode;
use crate::json::Json;
use crate::status::{self, CommandOutput};

/// 唯一的观察方法（只读）。
pub const METHOD_OBSERVE: &str = "observe";
/// `maxTokens` 上限（`lib/schemas.mjs`）。
pub const MAX_TOKENS: u64 = 20_000;
/// `maxDepth` 上限。
pub const MAX_DEPTH: u64 = 100;
/// `vomTop` 上限。
pub const MAX_VOM_TOP: u64 = 500;
/// `vomMaxNodes` 上限。
pub const MAX_VOM_NODES: u64 = 5_000;
/// `vomMaxTokens` 上限。
pub const MAX_VOM_TOKENS: u64 = 200_000;
/// `deepMaxTokens` 上限。
pub const MAX_DEEP_TOKENS: u64 = 20_000;
/// `cursor` 上限（schema maxLength）。
pub const MAX_CURSOR_CHARS: usize = 4_096;
/// `vomProfile` 枚举。
pub const VOM_PROFILES: [&str; 3] = ["balanced", "compact", "all"];

/// `observe` 的参数。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ObserveOptions {
    pub json: bool,
    pub timeout_ms: Option<u64>,
    pub session: Option<String>,
    pub tab_id: Option<u64>,
    pub max_tokens: Option<u64>,
    pub max_depth: Option<u64>,
    pub probe_hover: bool,
    pub closed_shadow: bool,
    pub debug_surfaces: bool,
    pub vom: bool,
    pub vom_deep: bool,
    pub vom_tree: bool,
    pub vom_rank: bool,
    pub vom_top: Option<u64>,
    pub vom_max_nodes: Option<u64>,
    pub vom_max_tokens: Option<u64>,
    pub vom_explain: bool,
    pub vom_exclude_hidden: bool,
    pub vom_profile: Option<String>,
    pub ax: bool,
    pub facts: bool,
    pub force: bool,
    pub cursor: Option<String>,
    pub delta: bool,
    pub baseline: Option<String>,
}

impl ObserveOptions {
    /// 参数校验（`E_ARG_*`，CLI 以退出码 2 呈现）。
    pub fn validate(&self) -> Result<(), CliError> {
        for (flag, value, max) in [
            ("--max-tokens", self.max_tokens, MAX_TOKENS),
            ("--max-depth", self.max_depth, MAX_DEPTH),
            ("--vom-top", self.vom_top, MAX_VOM_TOP),
            ("--vom-max-nodes", self.vom_max_nodes, MAX_VOM_NODES),
            ("--vom-max-tokens", self.vom_max_tokens, MAX_VOM_TOKENS),
        ] {
            if let Some(value) = value {
                if value == 0 {
                    return Err(CliError::new(ErrorCode::ArgRange, format!("{flag} 必须 >= 1")));
                }
                if value > max {
                    return Err(CliError::new(
                        ErrorCode::ArgRange,
                        format!("{flag} 必须在 1..={max} 之间，实际 {value}"),
                    ));
                }
            }
        }
        if let Some(profile) = &self.vom_profile {
            if !VOM_PROFILES.contains(&profile.as_str()) {
                return Err(CliError::new(
                    ErrorCode::ArgEnum,
                    format!("--vom-profile 只支持 balanced|compact|all，收到 {profile:?}"),
                ));
            }
        }
        if let Some(session) = &self.session {
            if session.trim().is_empty() {
                return Err(CliError::new(ErrorCode::ArgRange, "--session 不能为空字符串"));
            }
        }
        if let Some(cursor) = &self.cursor {
            let cursor = cursor.trim();
            if cursor.is_empty() {
                return Err(CliError::new(ErrorCode::ArgRange, "--cursor 不能为空字符串"));
            }
            if cursor.chars().count() > MAX_CURSOR_CHARS {
                return Err(CliError::new(
                    ErrorCode::ArgRange,
                    format!("--cursor 最多 {MAX_CURSOR_CHARS} 字符，实际 {}", cursor.chars().count()),
                ));
            }
        }
        if let Some(baseline) = &self.baseline {
            if baseline.trim().is_empty() {
                return Err(CliError::new(ErrorCode::ArgRange, "--baseline 不能为空字符串（省略即用上一版）"));
            }
        }
        if self.delta && self.baseline.is_none() {
            // Node CLI 允许 `--delta` 单独使用（对比上一版缓存）；daemon 也接受 delta=true。
            return Ok(());
        }
        Ok(())
    }

    /// 发送给 daemon 的 `params`（键顺序稳定；只包含显式给出的参数）。
    pub fn to_params(&self) -> Json {
        let mut entries: Vec<(String, Json)> = Vec::new();
        if let Some(session) = &self.session {
            entries.push(("session".to_string(), Json::string(session.trim().to_string())));
        }
        if let Some(tab_id) = self.tab_id {
            entries.push(("tabId".to_string(), Json::Number(tab_id as f64)));
        }
        if self.probe_hover {
            entries.push(("probeHover".to_string(), Json::Bool(true)));
        }
        if self.closed_shadow {
            entries.push(("closedShadow".to_string(), Json::Bool(true)));
        }
        if let Some(max_tokens) = self.max_tokens {
            entries.push(("maxTokens".to_string(), Json::Number(max_tokens as f64)));
        }
        if let Some(max_depth) = self.max_depth {
            entries.push(("maxDepth".to_string(), Json::Number(max_depth as f64)));
        }
        if self.debug_surfaces {
            entries.push(("debugSurfaces".to_string(), Json::Bool(true)));
        }
        if self.vom {
            entries.push(("vom".to_string(), Json::Bool(true)));
        }
        if self.vom_deep {
            entries.push(("vomDeep".to_string(), Json::Bool(true)));
        }
        if self.vom_tree {
            entries.push(("vomTree".to_string(), Json::Bool(true)));
        }
        if self.vom_rank {
            entries.push(("vomRank".to_string(), Json::Bool(true)));
        }
        if let Some(top) = self.vom_top {
            entries.push(("vomTop".to_string(), Json::Number(top as f64)));
        }
        if let Some(nodes) = self.vom_max_nodes {
            entries.push(("vomMaxNodes".to_string(), Json::Number(nodes as f64)));
        }
        if let Some(tokens) = self.vom_max_tokens {
            entries.push(("vomMaxTokens".to_string(), Json::Number(tokens as f64)));
        }
        if self.vom_explain {
            entries.push(("vomExplain".to_string(), Json::Bool(true)));
        }
        if self.vom_exclude_hidden {
            entries.push(("vomExcludeHidden".to_string(), Json::Bool(true)));
        }
        if let Some(profile) = &self.vom_profile {
            entries.push(("vomProfile".to_string(), Json::string(profile.clone())));
        }
        if self.ax {
            entries.push(("ax".to_string(), Json::Bool(true)));
        }
        if self.facts {
            entries.push(("facts".to_string(), Json::Bool(true)));
        }
        if self.force {
            entries.push(("force".to_string(), Json::Bool(true)));
        }
        if let Some(cursor) = &self.cursor {
            entries.push(("cursor".to_string(), Json::string(cursor.trim().to_string())));
        }
        if self.delta || self.baseline.is_some() {
            entries.push(("delta".to_string(), Json::Bool(true)));
        }
        if let Some(baseline) = &self.baseline {
            entries.push(("baseline".to_string(), Json::string(baseline.trim().to_string())));
        }
        Json::Object(entries)
    }
}

/// 归一后的观察结果（只保留 CLI 展示/JSON 契约需要的字段）。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Observation {
    pub url: String,
    pub title: String,
    pub observation: String,
    pub refs: Option<u64>,
    pub observation_id: Option<String>,
    pub nodes: Option<u64>,
    pub frames: Option<u64>,
    pub unchanged: bool,
    pub delta: bool,
    pub changes: Option<u64>,
    pub truncated: bool,
    pub pipeline: Option<String>,
}

impl Observation {
    pub fn from_json(value: &Json) -> Result<Self, RpcError> {
        let Some(object) = value.as_object() else {
            return Err(RpcError::new(ErrorCode::Rpc, "observe 结果不是 JSON 对象")
                .with_data(crate::json_obj! { "result" => value.clone() }));
        };
        let read = |key: &str| object.iter().find(|(name, _)| name == key).map(|(_, value)| value);
        let text = |key: &str| read(key).and_then(Json::as_str).unwrap_or("").to_string();
        Ok(Self {
            url: text("url"),
            title: text("title"),
            observation: text("observation"),
            refs: read("refs").and_then(Json::as_u64),
            observation_id: read("observationId").and_then(Json::as_str).map(str::to_string),
            nodes: read("nodes").and_then(Json::as_array).map(<[Json]>::len).map(|count| count as u64),
            frames: read("frames").and_then(Json::as_array).map(<[Json]>::len).map(|count| count as u64),
            unchanged: read("unchanged").and_then(Json::as_bool).unwrap_or(false),
            delta: read("delta").and_then(Json::as_bool).unwrap_or(false),
            changes: read("changes").and_then(Json::as_u64),
            truncated: read("truncated").and_then(Json::as_bool).unwrap_or(false),
            pipeline: read("pipeline").and_then(Json::as_str).map(str::to_string),
        })
    }

    pub fn to_json(&self) -> Json {
        crate::json_obj! {
            "method" => Json::string(METHOD_OBSERVE),
            "readOnly" => Json::Bool(true),
            "url" => Json::string(self.url.clone()),
            "title" => Json::string(self.title.clone()),
            "observation" => Json::string(self.observation.clone()),
            "refs" => self.refs.map(|value| Json::Number(value as f64)).unwrap_or(Json::Null),
            "observationId" => self.observation_id.as_deref().map(Json::string).unwrap_or(Json::Null),
            "nodes" => self.nodes.map(|value| Json::Number(value as f64)).unwrap_or(Json::Null),
            "frames" => self.frames.map(|value| Json::Number(value as f64)).unwrap_or(Json::Null),
            "unchanged" => Json::Bool(self.unchanged),
            "delta" => Json::Bool(self.delta),
            "changes" => self.changes.map(|value| Json::Number(value as f64)).unwrap_or(Json::Null),
            "truncated" => Json::Bool(self.truncated),
            "pipeline" => self.pipeline.as_deref().map(Json::string).unwrap_or(Json::Null),
        }
    }
}

/// 只读门禁：用单源方法目录确认方法效果位是 `passive_read` / `read`。
pub fn assert_read_only(method: &str) -> Result<(), RpcError> {
    match crate::protocol::method_spec(method).map(|spec| spec.effect) {
        Some("passive_read") | Some("read") => Ok(()),
        Some(effect) => Err(RpcError::new(
            ErrorCode::ReadOnly,
            format!("{method} 在协议目录里的效果位是 {effect}，bridge-rs observe 拒绝派发（只读命令不写入）"),
        )
        .with_data(crate::json_obj! {
            "method" => Json::string(method),
            "effect" => Json::string(effect),
            "expected" => Json::string("passive_read"),
        })),
        None => Err(RpcError::new(
            ErrorCode::ReadOnly,
            format!("{method} 未登记在协议方法目录里，拒绝派发（防止方法名漂移把写操作当观察）"),
        )
        .with_data(crate::json_obj! {
            "method" => Json::string(method),
        })),
    }
}

/// 执行 `bridge-rs observe`。
pub fn execute(options: &ObserveOptions) -> CommandOutput {
    if let Err(error) = options.validate() {
        return crate::session_cmd::usage_failure(&error);
    }
    let context = match DaemonContext::open(options.timeout_ms) {
        Ok(context) => context,
        Err(error) => return command_io::discovery_failure(&error, options.json),
    };
    run_observe(options, &context)
}

/// 跑 `observe`（已构造上下文；测试可直接调用）。
pub fn run_observe(options: &ObserveOptions, context: &DaemonContext) -> CommandOutput {
    // 运行时只读门禁：目录若把 observe 标成写方法，这里直接拒绝，不发请求。
    if let Err(error) = assert_read_only(METHOD_OBSERVE) {
        return context.failure(&error, options.json);
    }
    let result = match context.call(METHOD_OBSERVE, options.to_params()) {
        Ok(result) => result,
        Err(error) => return context.failure(&error, options.json),
    };
    let observation = match Observation::from_json(&result) {
        Ok(observation) => observation,
        Err(error) => return context.failure(&error, options.json),
    };
    if options.json {
        CommandOutput::success(observe_json(&observation, context).to_compact_string())
    } else {
        CommandOutput::success(observe_text(&observation))
    }
}

/// `observe --json` 成功信封。
pub fn observe_json(observation: &Observation, context: &DaemonContext) -> Json {
    crate::json_obj! {
        "ok" => Json::Bool(true),
        "observe" => observation.to_json(),
        "daemon" => context.daemon_json(),
        "exitCode" => Json::Number(f64::from(status::EXIT_CODE_OK)),
    }
}

/// `observe` 文本输出：url/title 头 + 观察正文 + refs 脚注。
pub fn observe_text(observation: &Observation) -> String {
    let mut lines = Vec::new();
    if !observation.url.is_empty() || !observation.title.is_empty() {
        lines.push(format!(
            "{}（{}）",
            if observation.url.is_empty() { "(未知 url)" } else { &observation.url },
            if observation.title.is_empty() { "无标题" } else { &observation.title }
        ));
    }
    let body = observation.observation.trim();
    if body.is_empty() {
        lines.push("(空观察：页面没有可观察内容，或扩展返回了空 observation)".to_string());
    } else {
        lines.push(body.to_string());
    }
    let mut footer = Vec::new();
    if let Some(refs) = observation.refs {
        footer.push(format!("refs: {refs}"));
    }
    if let Some(id) = &observation.observation_id {
        footer.push(format!("observation: {id}"));
    }
    if observation.unchanged {
        footer.push("unchanged: 与基线一致".to_string());
    }
    if observation.truncated {
        footer.push("truncated: 已按预算截断".to_string());
    }
    if !footer.is_empty() {
        lines.push(String::new());
        lines.push(footer.join("  "));
    }
    lines.join("\n")
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

    fn observe_fixture() -> &'static str {
        r#"{"ok":true,"result":{"url":"https://example.com/","title":"Example Domain","observation":"- @e1 heading \"Example Domain\"\n- @e2 link \"More information...\"","refs":2,"observationId":"ob_abc123","nodes":[{"ref":"@e1"},{"ref":"@e2"}],"pipeline":"page-lib"}}"#
    }

    #[test]
    fn observe_is_read_only_by_catalog() {
        assert!(assert_read_only(METHOD_OBSERVE).is_ok());
        assert!(assert_read_only("read").is_ok());
        for mutating in ["click", "fill", "navigate", "session.start", "daemon.stop"] {
            let error = assert_read_only(mutating).expect_err("写方法必须被拒绝");
            assert_eq!(error.code, ErrorCode::ReadOnly, "夹具 {mutating}");
        }
        let error = assert_read_only("no.such.method").expect_err("未知方法");
        assert_eq!(error.code, ErrorCode::ReadOnly);
    }

    #[test]
    fn observe_sends_only_documented_params_and_renders_json() {
        let (port, capture) = serve_once("HTTP/1.1 200 OK", observe_fixture());
        let options = ObserveOptions {
            json: true,
            session: Some("abcd".to_string()),
            max_tokens: Some(4_000),
            max_depth: Some(12),
            vom: true,
            vom_tree: true,
            ax: true,
            facts: true,
            ..ObserveOptions::default()
        };
        let output = run_observe(&options, &context(port));
        assert_eq!(output.exit_code, 0, "stderr={}", output.stderr);
        let json = Json::parse(&output.stdout).expect("JSON");
        assert_eq!(json.get("ok").and_then(Json::as_bool), Some(true));
        assert_eq!(json.get("exitCode").and_then(Json::as_u64), Some(0));
        let observe = json.get("observe").expect("observe 段");
        assert_eq!(observe.get("method").and_then(Json::as_str), Some("observe"));
        assert_eq!(observe.get("readOnly").and_then(Json::as_bool), Some(true));
        assert_eq!(observe.get("url").and_then(Json::as_str), Some("https://example.com/"));
        assert_eq!(observe.get("title").and_then(Json::as_str), Some("Example Domain"));
        assert_eq!(observe.get("refs").and_then(Json::as_u64), Some(2));
        assert_eq!(observe.get("nodes").and_then(Json::as_u64), Some(2));
        assert_eq!(observe.get("observationId").and_then(Json::as_str), Some("ob_abc123"));
        assert_eq!(observe.get("pipeline").and_then(Json::as_str), Some("page-lib"));
        assert!(observe.get("observation").and_then(Json::as_str).unwrap_or("").contains("@e1 heading"));
        assert!(!output.stdout.contains("test-token-value"));
        let raw = capture.join().expect("线程");
        assert!(raw.starts_with("POST /rpc HTTP/1.1\r\n"), "{raw}");
        assert!(raw.contains(r#""method":"observe""#), "{raw}");
        assert!(raw.contains(r#""session":"abcd""#), "{raw}");
        assert!(raw.contains(r#""maxTokens":4000"#), "{raw}");
        assert!(raw.contains(r#""vomTree":true"#), "{raw}");
        assert!(raw.contains(r#""ax":true"#), "{raw}");
        // 只读命令不能出现写方法：请求体里 method 只能是 observe。
        for forbidden in ["\"method\":\"click\"", "\"method\":\"navigate\"", "\"method\":\"fill\"", "\"method\":\"session.start\""] {
            assert!(!raw.contains(forbidden), "请求出现写入口 {forbidden}：{raw}");
        }
    }

    #[test]
    fn observe_text_prints_observation_body_and_footer() {
        let (port, _) = serve_once("HTTP/1.1 200 OK", observe_fixture());
        let output = run_observe(&ObserveOptions::default(), &context(port));
        assert_eq!(output.exit_code, 0, "stderr={}", output.stderr);
        assert!(output.stdout.contains("https://example.com/（Example Domain）"), "{}", output.stdout);
        assert!(output.stdout.contains("@e1 heading"), "{}", output.stdout);
        assert!(output.stdout.contains("refs: 2"), "{}", output.stdout);
        assert!(output.stdout.contains("observation: ob_abc123"), "{}", output.stdout);
    }

    #[test]
    fn observe_empty_observation_is_explicit() {
        let (port, _) = serve_once("HTTP/1.1 200 OK", r#"{"ok":true,"result":{"url":"about:blank"}}"#);
        let output = run_observe(&ObserveOptions::default(), &context(port));
        assert_eq!(output.exit_code, 0);
        assert!(output.stdout.contains("空观察"), "{}", output.stdout);
    }

    #[test]
    fn observe_error_passthrough_keeps_daemon_code() {
        let body = r#"{"ok":false,"error":{"code":"E_NO_BROWSER","message":"没有已连接的浏览器；请加载扩展"}}"#;
        let (port, _) = serve_once("HTTP/1.1 200 OK", body);
        let options = ObserveOptions { json: true, ..ObserveOptions::default() };
        let output = run_observe(&options, &context(port));
        assert_eq!(output.exit_code, 3);
        let json = Json::parse(&output.stdout).expect("JSON");
        assert_eq!(
            json.get("error").and_then(|error| error.get("code")).and_then(Json::as_str),
            Some("E_NO_BROWSER")
        );
        assert!(json.get("error").and_then(|error| error.get("data")).is_some());
    }

    #[test]
    fn non_object_result_is_structured_rpc_error() {
        let (port, _) = serve_once("HTTP/1.1 200 OK", r#"{"ok":true,"result":[]}"#);
        let output = run_observe(&ObserveOptions { json: true, ..ObserveOptions::default() }, &context(port));
        assert_eq!(output.exit_code, 3);
        let json = Json::parse(&output.stdout).expect("JSON");
        assert_eq!(
            json.get("error").and_then(|error| error.get("code")).and_then(Json::as_str),
            Some("E_RPC")
        );
    }

    #[test]
    fn observe_validation_errors_are_arg_codes() {
        assert_eq!(
            ObserveOptions { max_tokens: Some(MAX_TOKENS + 1), ..ObserveOptions::default() }
                .validate()
                .expect_err("上限")
                .code,
            ErrorCode::ArgRange
        );
        assert_eq!(
            ObserveOptions { max_depth: Some(0), ..ObserveOptions::default() }
                .validate()
                .expect_err("下限")
                .code,
            ErrorCode::ArgRange
        );
        assert_eq!(
            ObserveOptions { vom_profile: Some("tiny".to_string()), ..ObserveOptions::default() }
                .validate()
                .expect_err("枚举")
                .code,
            ErrorCode::ArgEnum
        );
        assert_eq!(
            ObserveOptions { cursor: Some(" ".to_string()), ..ObserveOptions::default() }
                .validate()
                .expect_err("空 cursor")
                .code,
            ErrorCode::ArgRange
        );
        assert_eq!(
            ObserveOptions { cursor: Some("c".repeat(MAX_CURSOR_CHARS + 1)), ..ObserveOptions::default() }
                .validate()
                .expect_err("超长 cursor")
                .code,
            ErrorCode::ArgRange
        );
        assert_eq!(
            ObserveOptions { session: Some("  ".to_string()), ..ObserveOptions::default() }
                .validate()
                .expect_err("空 session")
                .code,
            ErrorCode::ArgRange
        );
        assert_eq!(
            ObserveOptions { baseline: Some(" ".to_string()), ..ObserveOptions::default() }
                .validate()
                .expect_err("空 baseline")
                .code,
            ErrorCode::ArgRange
        );
        // 合法边界值。
        assert!(ObserveOptions {
            max_tokens: Some(MAX_TOKENS),
            max_depth: Some(MAX_DEPTH),
            vom_top: Some(MAX_VOM_TOP),
            ..ObserveOptions::default()
        }
        .validate()
        .is_ok());
    }

    #[test]
    fn baseline_implies_delta_like_node_cli() {
        let options = ObserveOptions { baseline: Some("o1".to_string()), ..ObserveOptions::default() };
        let params = options.to_params();
        assert_eq!(params.get("delta").and_then(Json::as_bool), Some(true));
        assert_eq!(params.get("baseline").and_then(Json::as_str), Some("o1"));
        let options = ObserveOptions { delta: true, ..ObserveOptions::default() };
        assert_eq!(options.to_params().get("delta").and_then(Json::as_bool), Some(true));
        let options = ObserveOptions::default();
        assert_eq!(options.to_params().get("delta"), None);
    }

    #[test]
    fn invalid_options_return_exit_2_without_network() {
        let options = ObserveOptions { vom_profile: Some("nope".to_string()), ..ObserveOptions::default() };
        let output = execute(&options);
        assert_eq!(output.exit_code, status::EXIT_CODE_USAGE);
        assert!(output.stdout.is_empty());
        assert!(output.stderr.contains("E_ARG_ENUM"), "{}", output.stderr);
    }

    #[test]
    fn observation_tolerates_missing_fields_and_bad_nodes() {
        let observation = Observation::from_json(&Json::parse(r#"{"url":"about:blank","nodes":"nope"}"#).expect("夹具")).expect("宽容");
        assert_eq!(observation.url, "about:blank");
        assert_eq!(observation.title, "");
        assert_eq!(observation.nodes, None);
        assert_eq!(observation.refs, None);
        assert!(!observation.unchanged);
        let error = Observation::from_json(&Json::Null).expect_err("非对象");
        assert_eq!(error.code, ErrorCode::Rpc);
    }

    #[test]
    fn text_mode_is_plain_observation_for_agents() {
        // 文本模式第一行是 url/标题，正文原样保留（Agent 直接读 observation）。
        let observation = Observation {
            url: "https://a.test/".to_string(),
            title: "T".to_string(),
            observation: "@e1 button \"OK\"".to_string(),
            refs: Some(1),
            ..Observation::default()
        };
        let text = observe_text(&observation);
        assert!(text.starts_with("https://a.test/（T）"), "{text}");
        assert!(text.contains("@e1 button \"OK\""));
        let observation = Observation { unchanged: true, truncated: true, ..observation };
        let text = observe_text(&observation);
        assert!(text.contains("unchanged:"));
        assert!(text.contains("truncated:"));
    }
}

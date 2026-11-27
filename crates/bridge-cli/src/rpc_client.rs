//! daemon RPC 客户端：发现 → `/health` 探测 → `POST /rpc` 调用 → 错误码映射。
//!
//! 只读参考 `daemon/http-handler.js`（路由）、`daemon/health.js`（载荷）、`daemon/rpc.js`（鉴权/信封）
//! 与 `cli/bridge.mjs`（`getHealth` / `postRpc` 的错误语义）：
//! - `/health` 不需要 token；`/rpc` 必须带 `x-bridge-token`，否则 401 `E_AUTH`；
//! - 业务失败仍是 HTTP 200 + `{ok:false,error}`，只有鉴权/未知方法用 401/404；
//! - daemon 明确 `tls:true` 时本客户端**不会**假装能连：std-only 没有 TLS 实现，
//!   返回 `E_UNSUPPORTED_CAPABILITY` 并说明改用 Node CLI，而不是产生握手噪声。
//!
//! 所有网络路径都返回 `RpcError`（单源错误码 + 可选 `data`），CLI 只负责渲染与退出码。

use std::time::Duration;

use crate::discovery::{DaemonHome, DaemonMetadata};
use crate::envelope::{RpcError, RpcRequest, RpcResponse};
use crate::errors::ErrorCode;
use crate::http::{self, HttpClient, HttpRequest, HttpResponse};
use crate::json::Json;

/// daemon 服务名（`daemon/health.js` 的 `SERVICE`）。
pub const SERVICE_NAME: &str = "browser-bridge";
/// `/rpc` 默认超时（与 `daemon/rpc.js` DEFAULT_TIMEOUT_MS 一致）。
pub const DEFAULT_RPC_TIMEOUT_MS: u64 = crate::envelope::DEFAULT_TIMEOUT_MS;
/// `--timeout` 允许的最大值（10 分钟，覆盖截图/长任务）。
pub const MAX_RPC_TIMEOUT_MS: u64 = 600_000;

/// `/health` 响应的归一视图。
#[derive(Debug, Clone, PartialEq)]
pub struct HealthReport {
    pub service: String,
    pub version: String,
    pub protocol: String,
    pub pid: Option<u64>,
    pub port: Option<u16>,
    pub uptime_ms: Option<u64>,
    pub browsers: u64,
    pub sessions: u64,
    pub tls: bool,
    pub bind: Option<String>,
    pub public_url: Option<String>,
    pub raw: Json,
}

impl HealthReport {
    /// 解析 `/health` JSON；服务名不符视为"不是 BridgeDeck daemon"（`E_RPC`）。
    pub fn from_json(value: &Json) -> Result<Self, RpcError> {
        if !matches!(value, Json::Object(_)) {
            return Err(RpcError::new(
                ErrorCode::Rpc,
                "/health 响应不是 JSON 对象（对端不是 BridgeDeck daemon，或路由被占用）",
            )
            .with_data(crate::json_obj! { "body" => value.clone() }));
        }
        let service = value.get("service").and_then(Json::as_str).unwrap_or("");
        if service != SERVICE_NAME {
            return Err(RpcError::new(
                ErrorCode::Rpc,
                format!(
                    "/health 的 service 是 {:?}，不是 {SERVICE_NAME:?}：端口可能被别的服务占用",
                    service
                ),
            )
            .with_data(crate::json_obj! {
                "service" => Json::string(service),
                "expected" => Json::string(SERVICE_NAME),
            }));
        }
        let port = value.get("port").and_then(Json::as_u64).and_then(|port| u16::try_from(port).ok());
        Ok(Self {
            service: service.to_string(),
            version: value.get("version").and_then(Json::as_str).unwrap_or("").to_string(),
            protocol: value.get("protocol").and_then(Json::as_str).unwrap_or("").to_string(),
            pid: value.get("pid").and_then(Json::as_u64),
            port,
            uptime_ms: value.get("uptimeMs").and_then(Json::as_u64),
            browsers: value.get("browsers").and_then(Json::as_u64).unwrap_or(0),
            sessions: value.get("sessions").and_then(Json::as_u64).unwrap_or(0),
            tls: value.get("tls").and_then(Json::as_bool).unwrap_or(false),
            bind: value.get("bind").and_then(Json::as_str).map(str::to_string),
            public_url: value.get("publicUrl").and_then(Json::as_str).map(str::to_string),
            raw: value.clone(),
        })
    }

    pub fn to_json(&self) -> Json {
        crate::json_obj! {
            "service" => Json::string(self.service.clone()),
            "version" => Json::string(self.version.clone()),
            "protocol" => Json::string(self.protocol.clone()),
            "pid" => self.pid.map(|pid| Json::Number(pid as f64)).unwrap_or(Json::Null),
            "port" => self.port.map(|port| Json::Number(f64::from(port))).unwrap_or(Json::Null),
            "uptimeMs" => self.uptime_ms.map(|ms| Json::Number(ms as f64)).unwrap_or(Json::Null),
            "browsers" => Json::Number(self.browsers as f64),
            "sessions" => Json::Number(self.sessions as f64),
            "tls" => Json::Bool(self.tls),
            "bind" => self.bind.as_deref().map(Json::string).unwrap_or(Json::Null),
            "publicUrl" => self.public_url.as_deref().map(Json::string).unwrap_or(Json::Null),
        }
    }
}

/// 已发现 daemon 的 HTTP 客户端包装。
#[derive(Debug, Clone)]
pub struct DaemonClient {
    pub metadata: DaemonMetadata,
    pub http: HttpClient,
}

impl DaemonClient {
    pub fn new(metadata: DaemonMetadata) -> Self {
        let io_timeout = Duration::from_millis(DEFAULT_RPC_TIMEOUT_MS);
        Self { metadata, http: HttpClient::new(Duration::from_millis(http::DEFAULT_CONNECT_TIMEOUT_MS), io_timeout) }
    }

    pub fn with_timeouts(metadata: DaemonMetadata, connect: Duration, io: Duration) -> Self {
        Self { metadata, http: HttpClient::new(connect, io) }
    }

    /// 发现 + 构造客户端（不发起网络请求）。
    pub fn discover() -> Result<(DaemonHome, Self), RpcError> {
        let home = DaemonHome::from_env()?;
        let metadata = home.read_metadata()?;
        let client = Self::new(metadata);
        client.ensure_plaintext()?;
        Ok((home, client))
    }

    pub fn host_header(&self) -> String {
        self.metadata.endpoint_label()
    }

    pub fn rpc_path(&self) -> &'static str {
        crate::discovery::RPC_PATH
    }

    pub fn health_path(&self) -> &'static str {
        crate::discovery::HEALTH_PATH
    }

    pub fn ws_path(&self) -> &'static str {
        crate::discovery::WS_PATH
    }

    /// TLS 守卫：std-only 客户端没有 TLS 栈，`daemon.json` 声明 tls 时明确拒绝。
    ///
    /// 具体策略与替代方案在 [`crate::tls_policy`]（README 有同一份说明）；
    /// 这里只是运行时入口，保证 `/health`、`/rpc` 与所有命令在任何网络请求之前就被拦下。
    pub fn ensure_plaintext(&self) -> Result<(), RpcError> {
        crate::tls_policy::guard(&self.metadata)
    }

    /// `GET /health`（无需 token）。
    pub fn health(&self) -> Result<HealthReport, RpcError> {
        self.ensure_plaintext()?;
        let request = HttpRequest::get(self.host_header(), self.health_path());
        let response = self.http.execute_port(self.metadata.port, &request)?;
        health_from_response(&response)
    }

    /// `POST /rpc`：成功返回 `result`，失败返回 daemon 的错误码（未知码归一 `E_INTERNAL`）。
    pub fn call(&self, method: &str, params: Json, timeout_ms: u64) -> Result<Json, RpcError> {
        self.ensure_plaintext()?;
        let body = RpcRequest::new(method, params).with_timeout_ms(timeout_ms).to_http_json();
        let request = HttpRequest::post_json(self.host_header(), self.rpc_path(), body.to_compact_string())
            .header(crate::discovery::TOKEN_HEADER, self.metadata.token.clone());
        // HTTP 读超时 = RPC 超时 + 5s 余量（daemon 可能在回包前做完工作）。
        let mut http = self.http.clone();
        http.io_timeout = Duration::from_millis(timeout_ms.saturating_add(5_000).min(MAX_RPC_TIMEOUT_MS + 5_000));
        let response = http.execute_port(self.metadata.port, &request)?;
        rpc_from_response(method, &response)
    }

    /// `status` 只读方法（daemon 的 `buildStatus`）。
    pub fn status(&self, timeout_ms: u64) -> Result<Json, RpcError> {
        self.call("status", Json::Object(Vec::new()), timeout_ms)
    }

    /// 未鉴权探测：能连上 `/health` 即视为 daemon 可达。
    pub fn probe(&self) -> Result<HealthReport, RpcError> {
        self.health()
    }
}

/// 把 `/health` 响应转成 `HealthReport`（非 200 或非 JSON 都给结构化错误）。
pub fn health_from_response(response: &HttpResponse) -> Result<HealthReport, RpcError> {
    if !response.is_success() {
        let context = "GET /health";
        let rpc_error = response.json().ok().and_then(|json| RpcResponse::from_json(&json).ok()).and_then(|resp| resp.error);
        if let Some(error) = rpc_error {
            return Err(actionable_error(error, Some(response)));
        }
        let error = http::response_error(response, context);
        return Err(actionable_error(error, Some(response)));
    }
    let json = response.json()?;
    HealthReport::from_json(&json)
}

/// 把 `/rpc` 响应转成 `Result<Json, RpcError>`。
pub fn rpc_from_response(method: &str, response: &HttpResponse) -> Result<Json, RpcError> {
    let context = format!("POST /rpc {method}");
    if !response.is_success() {
        // daemon 的 401/404 也带 `{ok:false,error}`：优先透传它的错误码与消息。
        let rpc_error = response.json().ok().and_then(|json| RpcResponse::from_json(&json).ok()).and_then(|resp| resp.error);
        if let Some(error) = rpc_error {
            return Err(actionable_error(error, Some(response)));
        }
        let error = http::response_error(response, &context);
        return Err(actionable_error(error, Some(response)));
    }
    let decoded = match response.json() {
        Ok(json) => RpcResponse::from_json(&json),
        Err(error) => return Err(error),
    };
    let response = match decoded {
        Ok(response) => response,
        Err(error) => {
            // 200 但不是合法 RPC 信封：结构化 E_RPC，保留原始错误说明。
            return Err(RpcError::new(
                ErrorCode::Rpc,
                format!("{context} 响应不是合法 RPC 信封：{error}"),
            ));
        }
    };
    match response.into_result() {
        Ok(result) => Ok(result),
        // 业务失败仍是 HTTP 200：错误码原样透传，但补上单源恢复建议/下一步。
        Err(error) => Err(actionable_error(error, None)),
    }
}

/// 给 daemon 的错误补上可执行的下一步与单源恢复建议，并保留 HTTP 状态诊断。
///
/// 覆盖任务要求的错误映射：401（`E_AUTH`）→ token 过期提示；404（`E_UNKNOWN_METHOD`）→
/// 版本/目录提示；`E_NO_SESSION` → 先 list/start；`E_QUEUE_FULL` → 看 inflight 后重试。
/// 其它码只要有恢复建议（`errors::recovery`）也会补进 `data.recovery`，但**不改**原消息。
///
/// `response` 为 `None` 表示业务失败（HTTP 200）：不写 HTTP 字段，也不改消息。
fn actionable_error(mut error: RpcError, response: Option<&HttpResponse>) -> RpcError {
    let mut entries = match error.data.take() {
        Some(Json::Object(entries)) => entries,
        Some(other) => vec![("detail".to_string(), other)],
        None => Vec::new(),
    };
    if let Some(response) = response {
        let status = response.status();
        push_once(&mut entries, "status", Json::Number(f64::from(status)));
        push_once(&mut entries, "reason", Json::string(response.head.reason.clone()));
        push_once(&mut entries, "httpStatus", Json::Number(f64::from(status)));
    }
    if let Some(next_step) = next_step(error.code) {
        push_once(&mut entries, "nextStep", Json::string(next_step.to_string()));
    }
    if let Some(recovery) = crate::errors::recovery(error.code) {
        push_once(
            &mut entries,
            "recovery",
            crate::json_obj! {
                "retry" => Json::string(recovery.retry),
                "hint" => Json::string(recovery.hint),
            },
        );
    }
    if let Some(response) = response {
        let status = response.status();
        // 鉴权类保留旧契约（消息里带可执行提示 + HTTP 状态），其余只补状态，不篡改 daemon 原话。
        if matches!(error.code, ErrorCode::Auth | ErrorCode::Forbidden) {
            let hint = next_step(error.code).unwrap_or("");
            error.message = format!("{}；{hint}（HTTP {status}）", error.message);
        } else {
            error.message = format!("{}（HTTP {status}）", error.message);
        }
    }
    error.data = if entries.is_empty() { None } else { Some(Json::Object(entries)) };
    error
}

/// 只补一次同名键（daemon 自己的 `data` 优先，不被我们覆盖）。
fn push_once(entries: &mut Vec<(String, Json)>, key: &str, value: Json) {
    if !entries.iter().any(|(name, _)| name == key) {
        entries.push((key.to_string(), value));
    }
}

/// 单源错误码 → 可执行的下一步（只覆盖 CLI 高频且能给出真实操作路径的码）。
fn next_step(code: ErrorCode) -> Option<&'static str> {
    match code {
        ErrorCode::Auth => {
            Some("daemon.json 的 token 可能已过期：先 bridge daemon stop 再重试（bridge-rs 不会自动改 daemon 状态）")
        }
        ErrorCode::AuthExpired | ErrorCode::TokenExpired => Some("凭证已过期：重新配对（bridge pair）或用 bridge daemon start 刷新本机 token"),
        ErrorCode::Forbidden => Some("该 token 没有调用该方法的权限；远程只读授权请在浏览器本机用 Node CLI 执行"),
        ErrorCode::UnknownMethod => {
            Some("daemon 版本可能低于 bridge-rs 的方法目录：bridge-rs protocol 可查看 165 方法；用 bridge update 升级 daemon")
        }
        ErrorCode::NoSession => Some("先 bridge-rs session list 查看活动会话；没有会话时用 bridge-rs session start 新建"),
        ErrorCode::NoBrowser => Some("在 Edge/Chrome 加载并启用 browser-bridge 扩展后重试（bridge-rs status 可看 browsers 数）"),
        ErrorCode::QueueFull => Some("daemon 命令队列已满：bridge-rs status 看 inflight，等当前命令完成或加 --timeout 重试"),
        ErrorCode::RateLimited => Some("被 daemon 限流：稍后重试；本机 CLI 正常不会触发限流"),
        ErrorCode::DaemonTimeout | ErrorCode::Timeout => {
            Some("daemon 在超时内未回包：可加 --timeout（1..=600000）重试；仍超时先 bridge-rs health 确认 daemon 活着")
        }
        ErrorCode::UnsupportedCapability => {
            Some("该能力在当前构建不可用：见 docs/ARCH-TRACK.md 与 crates/bridge-cli/README.md 的已知边界（含 TLS 策略）")
        }
        ErrorCode::ProtocolUnsupported => Some("扩展/daemon 协议版本不兼容：更新并重载扩展，或用 bridge update 升级 daemon"),
        ErrorCode::ControlNotHeld => Some("共享 tab 的控制权不在本会话：用 bridge-rs session list 看 control.holder，必要时 Node CLI bridge session claim-control"),
        ErrorCode::RequestCancelled => Some("该 requestId 已被取消：重新生成 requestId 再启动"),
        ErrorCode::StartPending => Some("同一 requestId 的启动仍在进行：稍后带同一个 --request-id 重试即可取回会话"),
        _ => None,
    }
}

/// 超时毫秒归一：`None` → daemon 默认 60s；`Some(0)` → 默认；过大截到 [`MAX_RPC_TIMEOUT_MS`]。
pub fn normalize_timeout_ms(timeout_ms: Option<u64>) -> u64 {
    match timeout_ms {
        Some(value) if value > 0 => value.min(MAX_RPC_TIMEOUT_MS),
        _ => DEFAULT_RPC_TIMEOUT_MS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::HomeSource;
    use crate::json::Json;
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::thread;

    fn obj(text: &str) -> Json {
        Json::parse(text).expect("合法 JSON 夹具")
    }

    fn real_health_payload() -> String {
        r#"{"ok":true,"service":"browser-bridge","protocol":"1.9","version":"0.3.0","pid":4242,
            "uptimeMs":12345,"port":52900,"tls":false,"bind":"127.0.0.1","publicUrl":null,
            "browsers":1,"sessions":2}"#
            .replace(['\n', ' '], "")
    }

    fn metadata(port: u16) -> DaemonMetadata {
        DaemonMetadata {
            pid: Some(4242),
            port,
            token: "test-token".to_string(),
            version: Some("0.3.0".to_string()),
            started_at: Some(1),
            tls: false,
            path: PathBuf::from(r"C:\h\daemon.json"),
            home: PathBuf::from(r"C:\h"),
            home_source: HomeSource::Env,
        }
    }

    /// 起一个只服务一次的假 daemon（读请求 → 回固定响应）。
    fn serve_daemon(response: Vec<u8>) -> (u16, thread::JoinHandle<String>) {
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
                if let Some(head_end) = http::find_head_end(&raw) {
                    let text = String::from_utf8_lossy(&raw).to_string();
                    let length = text
                        .to_ascii_lowercase()
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:").and_then(|v| v.trim().parse::<usize>().ok()))
                        .unwrap_or(0);
                    if raw.len() >= head_end + length {
                        break;
                    }
                }
            }
            let _ = socket.write_all(&response);
            let _ = socket.flush();
            let _ = socket.shutdown(std::net::Shutdown::Both);
            String::from_utf8_lossy(&raw).to_string()
        });
        (port, handle)
    }

    fn response(status_line: &str, body: &str) -> Vec<u8> {
        format!(
            "{status_line}\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: {}\r\ncache-control: no-store\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    #[test]
    fn parses_real_health_payload() {
        let report = HealthReport::from_json(&obj(&real_health_payload())).expect("解析 /health");
        assert_eq!(report.service, SERVICE_NAME);
        assert_eq!(report.version, "0.3.0");
        assert_eq!(report.protocol, "1.9");
        assert_eq!(report.pid, Some(4242));
        assert_eq!(report.port, Some(52900));
        assert_eq!(report.uptime_ms, Some(12345));
        assert_eq!(report.browsers, 1);
        assert_eq!(report.sessions, 2);
        assert!(!report.tls);
        assert_eq!(report.bind.as_deref(), Some("127.0.0.1"));
        assert_eq!(report.public_url, None);
        let json = report.to_json();
        assert_eq!(json.get("port").and_then(Json::as_u64), Some(52900));
        assert_eq!(json.get("publicUrl"), Some(&Json::Null));
    }

    #[test]
    fn rejects_foreign_service_and_non_object() {
        let error = HealthReport::from_json(&obj(r#"{"service":"something-else","port":1}"#)).expect_err("服务不符");
        assert_eq!(error.code, ErrorCode::Rpc);
        assert!(error.message.contains("service"), "{}", error.message);
        assert_eq!(error.data.expect("data").get("service").and_then(Json::as_str), Some("something-else"));
        for text in ["[]", "null", "42"] {
            let error = HealthReport::from_json(&obj(text)).expect_err("非对象");
            assert_eq!(error.code, ErrorCode::Rpc, "夹具 {text}");
        }
    }

    #[test]
    fn tolerates_missing_optional_health_fields() {
        let report = HealthReport::from_json(&obj(r#"{"ok":true,"service":"browser-bridge"}"#)).expect("最小 /health");
        assert_eq!(report.version, "");
        assert_eq!(report.protocol, "");
        assert_eq!(report.pid, None);
        assert_eq!(report.port, None);
        assert_eq!(report.uptime_ms, None);
        assert_eq!(report.browsers, 0);
        assert_eq!(report.sessions, 0);
        assert!(!report.tls);
    }

    #[test]
    fn health_over_loopback() {
        let (port, capture) = serve_daemon(response("HTTP/1.1 200 OK", &real_health_payload()));
        let client = DaemonClient::with_timeouts(metadata(port), Duration::from_millis(500), Duration::from_secs(2));
        let report = client.health().expect("health 成功");
        assert_eq!(report.service, SERVICE_NAME);
        assert_eq!(report.port, Some(52900), "health 里上报的是 daemon 自己的端口");
        let raw = capture.join().expect("线程");
        assert!(raw.starts_with("GET /health HTTP/1.1\r\n"), "实际请求：{raw}");
        assert!(!raw.to_ascii_lowercase().contains("x-bridge-token"), "/health 不应发送 token");
    }

    #[test]
    fn status_over_loopback_returns_result() {
        let body = r#"{"ok":true,"result":{"service":"browser-bridge","version":"0.3.0","protocol":"1.9","pid":4242,"port":52900,"uptimeMs":9,"browsers":[],"sessions":[],"inflight":[]}}"#;
        let (port, capture) = serve_daemon(response("HTTP/1.1 200 OK", body));
        let client = DaemonClient::with_timeouts(metadata(port), Duration::from_millis(500), Duration::from_secs(2));
        let result = client.status(1000).expect("status 成功");
        assert_eq!(result.get("service").and_then(Json::as_str), Some(SERVICE_NAME));
        let raw = capture.join().expect("线程");
        assert!(raw.starts_with("POST /rpc HTTP/1.1\r\n"), "实际请求：{raw}");
        assert!(raw.contains(&format!("x-bridge-token: {}\r\n", metadata(port).token)), "必须带 token：{raw}");
        assert!(raw.contains(r#""method":"status""#), "请求体：{raw}");
        assert!(raw.contains(r#""timeoutMs":1000"#), "请求体：{raw}");
    }

    #[test]
    fn rpc_business_error_keeps_daemon_code() {
        let body = r#"{"ok":false,"error":{"code":"E_NO_BROWSER","message":"没有已连接的浏览器","data":{"hint":"装扩展"}}}"#;
        let (port, _) = serve_daemon(response("HTTP/1.1 200 OK", body));
        let client = DaemonClient::with_timeouts(metadata(port), Duration::from_millis(500), Duration::from_secs(2));
        let error = client.call("status", Json::Object(Vec::new()), 1000).expect_err("业务失败");
        assert_eq!(error.code, ErrorCode::NoBrowser);
        assert_eq!(error.message, "没有已连接的浏览器");
        assert_eq!(error.data.expect("data").get("hint").and_then(Json::as_str), Some("装扩展"));
    }

    #[test]
    fn auth_401_is_actionable() {
        let body = r#"{"ok":false,"error":{"code":"E_AUTH","message":"invalid token"}}"#;
        let (port, _) = serve_daemon(response("HTTP/1.1 401 Unauthorized", body));
        let client = DaemonClient::with_timeouts(metadata(port), Duration::from_millis(500), Duration::from_secs(2));
        let error = client.call("status", Json::Object(Vec::new()), 1000).expect_err("鉴权失败");
        assert_eq!(error.code, ErrorCode::Auth);
        assert!(error.message.contains("daemon.json"), "必须给过期提示：{}", error.message);
        assert!(error.message.contains("HTTP 401"), "{}", error.message);
        assert_eq!(error.data.expect("data").get("status").and_then(Json::as_u64), Some(401));
    }

    #[test]
    fn unknown_method_404_uses_daemon_code() {
        let body = r#"{"ok":false,"error":{"code":"E_UNKNOWN_METHOD","message":"unknown method: nope"}}"#;
        let (port, _) = serve_daemon(response("HTTP/1.1 404 Not Found", body));
        let client = DaemonClient::with_timeouts(metadata(port), Duration::from_millis(500), Duration::from_secs(2));
        let error = client.call("nope", Json::Object(Vec::new()), 1000).expect_err("未知方法");
        assert_eq!(error.code, ErrorCode::UnknownMethod);
        assert!(error.message.contains("unknown method"), "{}", error.message);
        // 404 也要给出"版本/目录"下一步，而不是只透传 daemon 原话。
        let data = error.data.expect("data");
        assert_eq!(data.get("httpStatus").and_then(Json::as_u64), Some(404));
        assert!(data.get("nextStep").and_then(Json::as_str).unwrap_or("").contains("protocol"));
    }

    #[test]
    fn plain_401_without_json_is_auth_and_actionable() {
        let (port, _) = serve_daemon(response("HTTP/1.1 401 Unauthorized", "unauthorized"));
        let client = DaemonClient::with_timeouts(metadata(port), Duration::from_millis(500), Duration::from_secs(2));
        let error = client.call("status", Json::Object(Vec::new()), 1000).expect_err("鉴权失败");
        assert_eq!(error.code, ErrorCode::Auth);
        assert!(error.message.contains("HTTP 401"), "{}", error.message);
        assert!(error.message.contains("daemon.json"), "{}", error.message);
        let data = error.data.expect("data");
        assert_eq!(data.get("status").and_then(Json::as_u64), Some(401));
        assert!(data.get("nextStep").and_then(Json::as_str).is_some());
    }

    #[test]
    fn plain_404_without_json_is_unknown_method() {
        let (port, _) = serve_daemon(response("HTTP/1.1 404 Not Found", "not found"));
        let client = DaemonClient::with_timeouts(metadata(port), Duration::from_millis(500), Duration::from_secs(2));
        let error = client.call("nope", Json::Object(Vec::new()), 1000).expect_err("404");
        assert_eq!(error.code, ErrorCode::UnknownMethod);
        let data = error.data.expect("data");
        assert_eq!(data.get("httpStatus").and_then(Json::as_u64), Some(404));
        assert!(data.get("nextStep").and_then(Json::as_str).unwrap_or("").contains("daemon"));
    }

    #[test]
    fn no_session_business_error_has_session_next_step() {
        let body = r#"{"ok":false,"error":{"code":"E_NO_SESSION","message":"当前没有活动 session"}}"#;
        let (port, _) = serve_daemon(response("HTTP/1.1 200 OK", body));
        let client = DaemonClient::with_timeouts(metadata(port), Duration::from_millis(500), Duration::from_secs(2));
        let error = client.call("session.stop", Json::Object(Vec::new()), 1000).expect_err("无会话");
        assert_eq!(error.code, ErrorCode::NoSession);
        let data = error.data.expect("data");
        let next_step = data.get("nextStep").and_then(Json::as_str).unwrap_or("");
        assert!(next_step.contains("session list"), "下一步：{next_step}");
        assert!(next_step.contains("session start"), "下一步：{next_step}");
        // 业务失败（HTTP 200）不应伪造 HTTP 状态字段。
        assert!(data.get("httpStatus").is_none());
        assert_eq!(data.get("reason"), None);
    }

    #[test]
    fn queue_full_business_error_has_retry_hint() {
        let body = r#"{"ok":false,"error":{"code":"E_QUEUE_FULL","message":"命令队列已满（64）"}}"#;
        let (port, _) = serve_daemon(response("HTTP/1.1 200 OK", body));
        let client = DaemonClient::with_timeouts(metadata(port), Duration::from_millis(500), Duration::from_secs(2));
        let error = client.call("observe", Json::Object(Vec::new()), 1000).expect_err("队列满");
        assert_eq!(error.code, ErrorCode::QueueFull);
        let data = error.data.expect("data");
        let next_step = data.get("nextStep").and_then(Json::as_str).unwrap_or("");
        assert!(next_step.contains("inflight"), "下一步：{next_step}");
        assert_eq!(data.get("recovery").and_then(|recovery| recovery.get("retry")).and_then(Json::as_str), Some("transient"));
    }

    #[test]
    fn daemon_data_is_preserved_and_not_overwritten() {
        let body = r#"{"ok":false,"error":{"code":"E_NO_SESSION","message":"x","data":{"hint":"自定义","nextStep":"daemon 自己的下一步"}}}"#;
        let (port, _) = serve_daemon(response("HTTP/1.1 200 OK", body));
        let client = DaemonClient::with_timeouts(metadata(port), Duration::from_millis(500), Duration::from_secs(2));
        let error = client.call("session.stop", Json::Object(Vec::new()), 1000).expect_err("业务失败");
        let data = error.data.expect("data");
        assert_eq!(data.get("hint").and_then(Json::as_str), Some("自定义"), "daemon data 不能被覆盖");
        assert_eq!(data.get("nextStep").and_then(Json::as_str), Some("daemon 自己的下一步"));
    }

    #[test]
    fn non_json_success_response_is_rpc_error() {
        let (port, _) = serve_daemon(response("HTTP/1.1 200 OK", "not-json"));
        let client = DaemonClient::with_timeouts(metadata(port), Duration::from_millis(500), Duration::from_secs(2));
        let error = client.health().expect_err("非 JSON");
        assert_eq!(error.code, ErrorCode::Rpc);
        assert!(error.message.contains("JSON"), "{}", error.message);
    }

    #[test]
    fn malformed_rpc_envelope_is_rpc_error() {
        let (port, _) = serve_daemon(response("HTTP/1.1 200 OK", r#"{"result":{"x":1}}"#));
        let client = DaemonClient::with_timeouts(metadata(port), Duration::from_millis(500), Duration::from_secs(2));
        let error = client.call("status", Json::Object(Vec::new()), 1000).expect_err("缺 ok");
        assert_eq!(error.code, ErrorCode::Rpc);
        assert!(error.message.contains("信封"), "{}", error.message);
    }

    #[test]
    fn tls_daemon_is_rejected_without_fake_success() {
        let mut metadata = metadata(1);
        metadata.tls = true;
        let client = DaemonClient::new(metadata);
        let error = client.health().expect_err("TLS 必须明确拒绝");
        assert_eq!(error.code, ErrorCode::UnsupportedCapability);
        assert!(error.message.contains("TLS"), "{}", error.message);
        assert_eq!(error.data.expect("data").get("tls").and_then(Json::as_bool), Some(true));
        let error = client.call("status", Json::Object(Vec::new()), 1000).expect_err("TLS 必须明确拒绝");
        assert_eq!(error.code, ErrorCode::UnsupportedCapability);
    }

    #[test]
    fn timeout_normalization() {
        assert_eq!(normalize_timeout_ms(None), DEFAULT_RPC_TIMEOUT_MS);
        assert_eq!(normalize_timeout_ms(Some(0)), DEFAULT_RPC_TIMEOUT_MS);
        assert_eq!(normalize_timeout_ms(Some(1500)), 1500);
        assert_eq!(normalize_timeout_ms(Some(u64::MAX)), MAX_RPC_TIMEOUT_MS);
        assert_eq!(DEFAULT_RPC_TIMEOUT_MS, 60_000);
    }

    #[test]
    fn endpoint_accessors_use_discovery_contract() {
        let client = DaemonClient::new(metadata(52900));
        assert_eq!(client.host_header(), "127.0.0.1:52900");
        assert_eq!(client.health_path(), "/health");
        assert_eq!(client.rpc_path(), "/rpc");
        assert_eq!(client.ws_path(), "/ws");
        assert!(client.ensure_plaintext().is_ok());
    }
}

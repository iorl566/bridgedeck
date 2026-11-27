//! std-only HTTP/1.1 客户端（手写报文），只覆盖 daemon 需要的两个端点：
//! `GET /health` 与 `POST /rpc`。
//!
//! 设计取舍（都是刻意的，不引入第三方 crate）：
//! - **一次连接一次请求**：请求固定带 `connection: close`，响应读完后关闭 socket。
//!   daemon 的 `sendJson` 用 `content-length` + `res.end()`，因此无需 keep-alive 池化；
//!   M-D 阶段先要正确性，连接复用留给后续里程碑（避免半开连接/幂等语义复杂度）。
//! - **chunked 明确拒绝**：`Transfer-Encoding: chunked` 会返回 `E_UNSUPPORTED_CAPABILITY` 并
//!   说明原因（本客户端未实现分块重组），绝不把分块流当正文解析、产出"看起来成功"的坏数据。
//! - **超时分层**：连接超时 `connect_timeout`、读写超时 `io_timeout`；两者都映射到
//!   `E_DAEMON_TIMEOUT`（连接被拒/主机不可达映射 `E_NO_DAEMON`）。
//! - **状态码映射**：daemon 业务失败仍是 200（`{ok:false,error}`），只有鉴权 401、未知方法 404
//!   等走 HTTP 状态码；映射表见 [`status_to_error_code`]，与 `daemon/rpc.js` + `http-handler.js` 对齐。

use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use crate::envelope::RpcError;
use crate::errors::ErrorCode;
use crate::json::Json;

/// 响应头（含状态行）最大字节数，超出即拒绝（防恶意/异常长头阻塞）。
pub const MAX_HEAD_BYTES: usize = 64 * 1024;
/// 响应正文最大字节数（daemon `BODY_LIMIT` 是 32 MiB，这里对齐）。
pub const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
/// 默认连接超时（毫秒）：daemon 在本机回环，2s 足够区分"未运行"与"慢"。
pub const DEFAULT_CONNECT_TIMEOUT_MS: u64 = 2_000;
/// 默认读写超时（毫秒）：`/rpc status` 是本地只读聚合，5s 足够；更长用 CLI `--timeout`。
pub const DEFAULT_IO_TIMEOUT_MS: u64 = 5_000;

/// HTTP 方法（当前只支持 GET/POST）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
        }
    }
}

/// 一个待发送的 HTTP 请求。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: Method,
    pub path: String,
    pub host: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpRequest {
    pub fn new(method: Method, host: impl Into<String>, path: impl Into<String>) -> Self {
        Self { method, path: path.into(), host: host.into(), headers: Vec::new(), body: Vec::new() }
    }

    pub fn get(host: impl Into<String>, path: impl Into<String>) -> Self {
        Self::new(Method::Get, host, path)
    }

    /// JSON POST：自动补 `content-type` / `content-length` / `accept`。
    pub fn post_json(host: impl Into<String>, path: impl Into<String>, body: impl Into<Vec<u8>>) -> Self {
        let mut request = Self::new(Method::Post, host, path);
        request.body = body.into();
        request.set_header("content-type", "application/json");
        request.set_header("accept", "application/json");
        request
    }

    /// 追加/覆盖同名请求头（名字大小写不敏感，保留调用方给的大小写）。
    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.set_header(name, value);
        self
    }

    pub fn set_header(&mut self, name: impl Into<String>, value: impl Into<String>) {
        let name = name.into();
        let value = value.into();
        if let Some(existing) = self.headers.iter_mut().find(|(key, _)| key.eq_ignore_ascii_case(&name)) {
            existing.1 = value;
        } else {
            self.headers.push((name, value));
        }
    }

    pub fn header_value(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }

    /// 序列化成线格式（含必要的基础头：`host`、`connection: close`、`content-length`）。
    pub fn encode(&self) -> Vec<u8> {
        let mut head = String::with_capacity(256);
        head.push_str(self.method.as_str());
        head.push(' ');
        head.push_str(if self.path.is_empty() { "/" } else { &self.path });
        head.push_str(" HTTP/1.1\r\n");
        head.push_str("host: ");
        head.push_str(&self.host);
        head.push_str("\r\n");
        for (name, value) in &self.headers {
            // 头注入防护：名字/值里出现 CR/LF 一律视为调用方 bug，跳过而绝不写入。
            if name.contains('\r') || name.contains('\n') || value.contains('\r') || value.contains('\n') {
                continue;
            }
            head.push_str(name);
            head.push_str(": ");
            head.push_str(value);
            head.push_str("\r\n");
        }
        if self.header_value("connection").is_none() {
            head.push_str("connection: close\r\n");
        }
        if self.header_value("content-length").is_none() {
            head.push_str("content-length: ");
            head.push_str(&self.body.len().to_string());
            head.push_str("\r\n");
        }
        head.push_str("\r\n");
        let mut out = head.into_bytes();
        out.extend_from_slice(&self.body);
        out
    }
}

/// 解析出的响应头。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpHead {
    pub status: u16,
    pub reason: String,
    pub headers: Vec<(String, String)>,
    /// 整个头块（含结尾空行）的字节数。
    pub head_len: usize,
}

impl HttpHead {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }

    pub fn header_tokens(&self, name: &str) -> Vec<&str> {
        self.header(name)
            .map(|value| value.split(',').map(str::trim).filter(|token| !token.is_empty()).collect())
            .unwrap_or_default()
    }

    pub fn content_length(&self) -> Option<u64> {
        self.header("content-length").and_then(|value| value.trim().parse::<u64>().ok())
    }

    pub fn is_chunked(&self) -> bool {
        self.header_tokens("transfer-encoding").iter().any(|token| token.eq_ignore_ascii_case("chunked"))
    }

    pub fn wants_close(&self) -> bool {
        self.header_tokens("connection").iter().any(|token| token.eq_ignore_ascii_case("close"))
    }

    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// 完整响应（头 + 正文）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub head: HttpHead,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn status(&self) -> u16 {
        self.head.status
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.head.header(name)
    }

    pub fn is_success(&self) -> bool {
        self.head.is_success()
    }

    /// 正文按 UTF-8 解码；失败给 `E_RPC`（响应不是我们期望的 JSON 文本）。
    pub fn body_text(&self) -> Result<&str, RpcError> {
        std::str::from_utf8(&self.body).map_err(|error| {
            RpcError::new(ErrorCode::Rpc, format!("HTTP 响应正文不是合法 UTF-8：{error}"))
                .with_data(crate::json_obj! { "status" => Json::Number(f64::from(self.status())) })
        })
    }

    /// 解析正文 JSON；空正文视为 `null`。
    pub fn json(&self) -> Result<Json, RpcError> {
        let text = self.body_text()?;
        if text.trim().is_empty() {
            return Ok(Json::Null);
        }
        Json::parse(text).map_err(|error| {
            RpcError::new(ErrorCode::Rpc, format!("HTTP 响应不是合法 JSON：{error}"))
                .with_data(crate::json_obj! {
                    "status" => Json::Number(f64::from(self.status())),
                    "bodyPrefix" => Json::string(prefix_of(text, 200)),
                })
        })
    }
}

fn prefix_of(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

/// 从字节流里找到头块结尾（`\r\n\r\n`），返回结尾之后的偏移。
pub fn find_head_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n").map(|index| index + 4)
}

/// 解析头块（必须包含完整头，`head_len` 之前的全部字节）。
pub fn parse_head(bytes: &[u8]) -> Result<HttpHead, RpcError> {
    let head_len = find_head_end(bytes).ok_or_else(|| {
        RpcError::new(ErrorCode::Rpc, "HTTP 响应头未以空行结束（可能被截断）").with_data(crate::json_obj! {
            "received" => Json::Number(bytes.len() as f64),
        })
    })?;
    if head_len > MAX_HEAD_BYTES {
        return Err(RpcError::new(
            ErrorCode::TooLarge,
            format!("HTTP 响应头超过上限 {MAX_HEAD_BYTES} 字节"),
        ));
    }
    let text = std::str::from_utf8(&bytes[..head_len - 4])
        .map_err(|error| RpcError::new(ErrorCode::Rpc, format!("HTTP 响应头不是合法 UTF-8：{error}")))?;
    let mut lines = text.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let (status, reason) = parse_status_line(status_line)?;
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(RpcError::new(ErrorCode::Rpc, format!("HTTP 响应头缺少冒号：{}", prefix_of(line, 120))));
        };
        headers.push((name.trim().to_string(), value.trim().to_string()));
    }
    Ok(HttpHead { status, reason, headers, head_len })
}

/// `HTTP/1.1 200 OK` → `(200, "OK")`。
pub fn parse_status_line(line: &str) -> Result<(u16, String), RpcError> {
    let mut parts = line.splitn(3, ' ');
    let version = parts.next().unwrap_or("");
    if !version.starts_with("HTTP/") {
        return Err(RpcError::new(ErrorCode::Rpc, format!("HTTP 状态行非法：{}", prefix_of(line, 120))));
    }
    let code_text = parts.next().ok_or_else(|| {
        RpcError::new(ErrorCode::Rpc, format!("HTTP 状态行缺少状态码：{}", prefix_of(line, 120)))
    })?;
    if code_text.len() != 3 || !code_text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(RpcError::new(ErrorCode::Rpc, format!("HTTP 状态码非法：{}", prefix_of(line, 120))));
    }
    let status = code_text
        .parse::<u16>()
        .map_err(|_| RpcError::new(ErrorCode::Rpc, format!("HTTP 状态码非法：{}", prefix_of(line, 120))))?;
    Ok((status, parts.next().unwrap_or("").to_string()))
}

/// HTTP 状态码 → 单源错误码（只覆盖 daemon 真实会返回的码；其余归 `E_RPC`）。
pub fn status_to_error_code(status: u16) -> ErrorCode {
    match status {
        200..=299 => ErrorCode::Internal, // 成功码不会被用于错误映射，这里只做兜底
        400 => ErrorCode::BadRequest,
        401 => ErrorCode::Auth,
        403 => ErrorCode::Forbidden,
        404 => ErrorCode::UnknownMethod,
        408 => ErrorCode::Timeout,
        413 => ErrorCode::TooLarge,
        429 => ErrorCode::RateLimited,
        500..=599 => ErrorCode::Internal,
        _ => ErrorCode::Rpc,
    }
}

/// 把非成功响应转成结构化错误（`data` 带 status/正文前缀，便于诊断鉴权/路由问题）。
pub fn response_error(response: &HttpResponse, context: &str) -> RpcError {
    let status = response.status();
    let code = status_to_error_code(status);
    let body = response.body_text().unwrap_or("");
    let message = if body.trim().is_empty() {
        format!("{context} 返回 HTTP {status} {}", response.head.reason)
    } else {
        format!("{context} 返回 HTTP {status}：{}", prefix_of(body.trim(), 200))
    };
    RpcError::new(code, message).with_data(crate::json_obj! {
        "status" => Json::Number(f64::from(status)),
        "reason" => Json::string(response.head.reason.clone()),
        "bodyPrefix" => Json::string(prefix_of(body, 400)),
    })
}

/// 连接错误 → 结构化错误：
/// - 连接被拒/不可达 → `E_NO_DAEMON`（daemon 没跑）；
/// - 连接超时 → `E_DAEMON_TIMEOUT`；
/// - 其余 → `E_DAEMON`。
pub fn connect_error(addr: &SocketAddr, error: &std::io::Error) -> RpcError {
    let code = match error.kind() {
        ErrorKind::ConnectionRefused | ErrorKind::NotFound | ErrorKind::AddrNotAvailable => ErrorCode::NoDaemon,
        ErrorKind::TimedOut => ErrorCode::DaemonTimeout,
        _ => ErrorCode::Daemon,
    };
    let hint = match code {
        ErrorCode::NoDaemon => "（daemon 未运行？执行 node cli/bridge.mjs status 或 bridge daemon start）",
        ErrorCode::DaemonTimeout => "（127.0.0.1 连接超时：daemon 未运行、卡死或被防火墙拦截）",
        _ => "",
    };
    RpcError::new(code, format!("连接 daemon {addr} 失败：{error}{hint}")).with_data(crate::json_obj! {
        "endpoint" => Json::string(addr.to_string()),
        "kind" => Json::string(format!("{:?}", error.kind())),
    })
}

/// 读写错误 → 结构化错误（超时统一 `E_DAEMON_TIMEOUT`，对端关闭 `E_DISCONNECTED`）。
pub fn io_error(addr: &SocketAddr, stage: &str, error: &std::io::Error) -> RpcError {
    let code = match error.kind() {
        ErrorKind::WouldBlock | ErrorKind::TimedOut => ErrorCode::DaemonTimeout,
        ErrorKind::UnexpectedEof | ErrorKind::ConnectionReset | ErrorKind::ConnectionAborted => ErrorCode::Disconnected,
        _ => ErrorCode::Daemon,
    };
    RpcError::new(code, format!("{stage}（daemon {addr}）：{error}")).with_data(crate::json_obj! {
        "endpoint" => Json::string(addr.to_string()),
        "stage" => Json::string(stage),
        "kind" => Json::string(format!("{:?}", error.kind())),
    })
}

/// HTTP 客户端（连接/读/写超时可配）。
#[derive(Debug, Clone)]
pub struct HttpClient {
    pub connect_timeout: Duration,
    pub io_timeout: Duration,
    pub max_body: usize,
}

impl Default for HttpClient {
    fn default() -> Self {
        Self::new(Duration::from_millis(DEFAULT_CONNECT_TIMEOUT_MS), Duration::from_millis(DEFAULT_IO_TIMEOUT_MS))
    }
}

impl HttpClient {
    pub fn new(connect_timeout: Duration, io_timeout: Duration) -> Self {
        Self { connect_timeout, io_timeout, max_body: MAX_BODY_BYTES }
    }

    /// 用同一个超时值构造（CLI `--timeout` 的常见用法）。
    pub fn with_timeout(timeout: Duration) -> Self {
        Self::new(timeout.min(Duration::from_millis(DEFAULT_CONNECT_TIMEOUT_MS)), timeout)
    }

    pub fn max_body(mut self, max_body: usize) -> Self {
        self.max_body = max_body.max(1);
        self
    }

    /// 向 `127.0.0.1:port` 发一个请求。
    pub fn execute_port(&self, port: u16, request: &HttpRequest) -> Result<HttpResponse, RpcError> {
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        self.execute(addr, request)
    }

    /// 向指定地址发一个请求（一次连接一次请求）。
    pub fn execute(&self, addr: SocketAddr, request: &HttpRequest) -> Result<HttpResponse, RpcError> {
        let mut stream = TcpStream::connect_timeout(&addr, self.connect_timeout)
            .map_err(|error| connect_error(&addr, &error))?;
        stream
            .set_read_timeout(Some(self.io_timeout))
            .map_err(|error| io_error(&addr, "设置读超时失败", &error))?;
        stream
            .set_write_timeout(Some(self.io_timeout))
            .map_err(|error| io_error(&addr, "设置写超时失败", &error))?;
        let payload = request.encode();
        stream.write_all(&payload).map_err(|error| io_error(&addr, "写请求失败", &error))?;
        stream.flush().map_err(|error| io_error(&addr, "刷新请求失败", &error))?;
        let response = read_response(&mut stream, &addr, self.max_body)?;
        // 主动关闭写方向；`connection: close` 下服务端会随之关闭。
        let _ = stream.shutdown(std::net::Shutdown::Both);
        Ok(response)
    }
}

/// 读一个完整响应（头 + 正文），`max_body` 为正文上限。
pub fn read_response(stream: &mut TcpStream, addr: &SocketAddr, max_body: usize) -> Result<HttpResponse, RpcError> {
    let mut buffer: Vec<u8> = Vec::with_capacity(1024);
    let head = read_head(stream, addr, &mut buffer)?;
    let body = read_body(stream, addr, &head, &mut buffer, max_body)?;
    Ok(HttpResponse { head, body })
}

/// 读响应头（读到 `\r\n\r\n`；兼容头块与正文在同一 TCP 段到达）。
pub fn read_head(stream: &mut TcpStream, addr: &SocketAddr, buffer: &mut Vec<u8>) -> Result<HttpHead, RpcError> {
    let mut chunk = [0u8; 1024];
    loop {
        if let Some(end) = find_head_end(buffer) {
            if end > MAX_HEAD_BYTES {
                return Err(RpcError::new(
                    ErrorCode::TooLarge,
                    format!("HTTP 响应头超过上限 {MAX_HEAD_BYTES} 字节"),
                ));
            }
            return parse_head(&buffer[..end]);
        }
        if buffer.len() > MAX_HEAD_BYTES {
            return Err(RpcError::new(
                ErrorCode::TooLarge,
                format!("HTTP 响应头超过上限 {MAX_HEAD_BYTES} 字节仍未结束"),
            ));
        }
        match stream.read(&mut chunk) {
            Ok(0) => {
                return Err(RpcError::new(
                    ErrorCode::Disconnected,
                    format!("daemon {addr} 在响应头完成前关闭连接（收到 {} 字节）", buffer.len()),
                )
                .with_data(crate::json_obj! {
                    "endpoint" => Json::string(addr.to_string()),
                    "received" => Json::Number(buffer.len() as f64),
                }));
            }
            Ok(count) => buffer.extend_from_slice(&chunk[..count]),
            Err(error) => return Err(io_error(addr, "读响应头失败", &error)),
        }
    }
}

fn read_body(
    stream: &mut TcpStream,
    addr: &SocketAddr,
    head: &HttpHead,
    buffer: &mut Vec<u8>,
    max_body: usize,
) -> Result<Vec<u8>, RpcError> {
    // 分块传输：不实现，明确拒绝（不是静默截断）。
    if head.is_chunked() {
        return Err(RpcError::new(
            ErrorCode::UnsupportedCapability,
            "HTTP 响应使用 Transfer-Encoding: chunked；本客户端（std-only）未实现分块重组，拒绝解析。\
             daemon 的 /health 与 /rpc 都用 content-length 返回 JSON，出现 chunked 说明对端不是预期 daemon 或中间有代理",
        )
        .with_data(crate::json_obj! {
            "status" => Json::Number(f64::from(head.status)),
            "transferEncoding" => Json::string(head.header("transfer-encoding").unwrap_or("").to_string()),
            "endpoint" => Json::string(addr.to_string()),
        }));
    }

    // 已随头块一起读到的正文前缀。
    let mut body: Vec<u8> = buffer[head.head_len..].to_vec();
    buffer.clear();

    if let Some(length) = head.content_length() {
        if length > max_body as u64 {
            return Err(RpcError::new(
                ErrorCode::TooLarge,
                format!("HTTP 响应正文声明 {length} 字节，超过上限 {max_body}"),
            )
            .with_data(crate::json_obj! {
                "status" => Json::Number(f64::from(head.status)),
                "contentLength" => Json::Number(length as f64),
                "maxBody" => Json::Number(max_body as f64),
            }));
        }
        let want = length as usize;
        read_exact_into(stream, addr, &mut body, want)?;
        return Ok(body);
    }

    // 无 content-length：只有明确会关连接（`connection: close`）才读到 EOF。
    if head.wants_close() {
        let mut chunk = [0u8; 4096];
        loop {
            match stream.read(&mut chunk) {
                Ok(0) => return Ok(body),
                Ok(count) => {
                    if body.len() + count > max_body {
                        return Err(RpcError::new(
                            ErrorCode::TooLarge,
                            format!("HTTP 响应正文超过上限 {max_body} 字节（读至 EOF）"),
                        ));
                    }
                    body.extend_from_slice(&chunk[..count]);
                }
                Err(error) => return Err(io_error(addr, "读响应正文失败", &error)),
            }
        }
    }

    Err(RpcError::new(
        ErrorCode::Rpc,
        "HTTP 响应既没有 content-length，也没有 connection: close；无法确定正文边界（拒绝猜测）",
    )
    .with_data(crate::json_obj! {
        "status" => Json::Number(f64::from(head.status)),
        "endpoint" => Json::string(addr.to_string()),
    }))
}

fn read_exact_into(
    stream: &mut TcpStream,
    addr: &SocketAddr,
    body: &mut Vec<u8>,
    want: usize,
) -> Result<(), RpcError> {
    if body.len() > want {
        body.truncate(want);
        return Ok(());
    }
    let mut chunk = [0u8; 4096];
    while body.len() < want {
        let remaining = want - body.len();
        let limit = remaining.min(chunk.len());
        match stream.read(&mut chunk[..limit]) {
            Ok(0) => {
                return Err(RpcError::new(
                    ErrorCode::Disconnected,
                    format!(
                        "daemon {addr} 在正文读满前关闭连接（已读 {} / 声明 {want} 字节）",
                        body.len()
                    ),
                )
                .with_data(crate::json_obj! {
                    "endpoint" => Json::string(addr.to_string()),
                    "received" => Json::Number(body.len() as f64),
                    "contentLength" => Json::Number(want as f64),
                }));
            }
            Ok(count) => body.extend_from_slice(&chunk[..count]),
            Err(error) => return Err(io_error(addr, "读响应正文失败", &error)),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    /// 起一个只服务一次的假 HTTP 服务端：返回端口 + 线程句柄（捕获到的原始请求字节）。
    fn serve_once(response: Vec<u8>) -> (u16, thread::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("绑定回环端口");
        let port = listener.local_addr().expect("地址").port();
        let handle = thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept");
            socket.set_read_timeout(Some(Duration::from_secs(2))).expect("读超时");
            let mut raw = Vec::new();
            let mut chunk = [0u8; 1024];
            // 读到请求头结束 + 声明正文（本测试请求都很小）。
            loop {
                let count = socket.read(&mut chunk).unwrap_or(0);
                if count == 0 {
                    break;
                }
                raw.extend_from_slice(&chunk[..count]);
                if find_head_end(&raw).is_some() {
                    let text = String::from_utf8_lossy(&raw).to_string();
                    let length = text
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    let head_len = find_head_end(&raw).unwrap_or(0);
                    if raw.len() >= head_len + length {
                        break;
                    }
                }
            }
            let _ = socket.write_all(&response);
            let _ = socket.flush();
            let _ = socket.shutdown(std::net::Shutdown::Both);
            raw
        });
        (port, handle)
    }

    fn http_response(status_line: &str, headers: &[&str], body: &str) -> Vec<u8> {
        let mut text = String::new();
        text.push_str(status_line);
        text.push_str("\r\n");
        for header in headers {
            text.push_str(header);
            text.push_str("\r\n");
        }
        if !headers.iter().any(|header| header.to_ascii_lowercase().starts_with("content-length:")) {
            text.push_str(&format!("content-length: {}\r\n", body.as_bytes().len()));
        }
        text.push_str("\r\n");
        text.push_str(body);
        text.into_bytes()
    }

    #[test]
    fn encodes_get_with_required_headers() {
        let request = HttpRequest::get("127.0.0.1:52900", "/health");
        let bytes = request.encode();
        let text = String::from_utf8(bytes).expect("ASCII");
        assert!(text.starts_with("GET /health HTTP/1.1\r\n"));
        assert!(text.contains("host: 127.0.0.1:52900\r\n"));
        assert!(text.contains("connection: close\r\n"));
        assert!(text.ends_with("content-length: 0\r\n\r\n"));
    }

    #[test]
    fn encodes_post_json_with_body_and_length() {
        let request = HttpRequest::post_json("127.0.0.1:1", "/rpc", r#"{"method":"status","params":{}}"#)
            .header("x-bridge-token", "secret");
        let text = String::from_utf8(request.encode()).expect("ASCII");
        assert!(text.starts_with("POST /rpc HTTP/1.1\r\n"));
        assert!(text.contains("content-type: application/json\r\n"));
        assert!(text.contains("x-bridge-token: secret\r\n"));
        assert!(text.contains(&format!("content-length: {}\r\n", r#"{"method":"status","params":{}}"#.len())));
        assert!(text.contains("\r\n\r\n{\"method\":\"status\",\"params\":{}}"));
        assert_eq!(request.header_value("X-BRIDGE-TOKEN"), Some("secret"));
    }

    #[test]
    fn header_override_is_case_insensitive_and_crlf_is_stripped() {
        let mut request = HttpRequest::get("h", "/");
        request.set_header("Connection", "keep-alive");
        request.set_header("connection", "close");
        assert_eq!(request.headers.len(), 1);
        assert_eq!(request.header_value("connection"), Some("close"));
        request.set_header("x-evil", "a\r\ninjected: 1");
        let text = String::from_utf8(request.encode()).expect("ASCII");
        assert!(!text.contains("injected"), "头注入必须被过滤：{text}");
    }

    #[test]
    fn parses_status_line_and_headers() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\ncontent-length: 12\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
        let head = parse_head(raw).expect("解析头");
        assert_eq!(head.status, 200);
        assert_eq!(head.reason, "OK");
        assert_eq!(head.head_len, raw.len());
        assert_eq!(head.header("content-type"), Some("application/json; charset=utf-8"));
        assert_eq!(head.header("CONTENT-LENGTH"), Some("12"));
        assert_eq!(head.content_length(), Some(12));
        assert!(!head.is_chunked());
        assert!(head.wants_close());
        assert!(head.is_success());
        assert_eq!(head.header_tokens("connection"), vec!["close"]);
    }

    #[test]
    fn rejects_malformed_heads_with_structured_errors() {
        for raw in [
            &b"HTTP/1.1 200 OK\r\nno-colon-here\r\n\r\n"[..],
            &b"HTTP/1.1 20 OK\r\n\r\n"[..],
            &b"HTTP/1.1 abc OK\r\n\r\n"[..],
            &b"NOPE/1.1 200 OK\r\n\r\n"[..],
            &b"HTTP/1.1 200 OK\n\n"[..],
        ] {
            let error = parse_head(raw).expect_err("必须拒绝");
            assert!(!error.message.is_empty());
        }
        // 缺状态码。
        assert!(parse_status_line("HTTP/1.1").is_err());
        assert_eq!(parse_status_line("HTTP/1.1 404 Not Found").expect("合法"), (404, "Not Found".to_string()));
        // chunked 识别。
        let head = parse_head(b"HTTP/1.1 200 OK\r\ntransfer-encoding: gzip, chunked\r\n\r\n").expect("头");
        assert!(head.is_chunked());
    }

    #[test]
    fn loopback_get_reads_health_like_json() {
        let (port, capture) = serve_once(http_response(
            "HTTP/1.1 200 OK",
            &["content-type: application/json; charset=utf-8", "cache-control: no-store"],
            r#"{"ok":true,"service":"browser-bridge","protocol":"1.9"}"#,
        ));
        let client = HttpClient::with_timeout(Duration::from_secs(2));
        let response = client.execute_port(port, &HttpRequest::get("127.0.0.1", "/health")).expect("请求成功");
        assert_eq!(response.status(), 200);
        assert_eq!(response.header("content-type"), Some("application/json; charset=utf-8"));
        let json = response.json().expect("JSON");
        assert_eq!(json.get("service").and_then(Json::as_str), Some("browser-bridge"));
        let request_bytes = capture.join().expect("服务端线程");
        let text = String::from_utf8_lossy(&request_bytes);
        assert!(text.starts_with("GET /health HTTP/1.1\r\n"), "实际请求：{text}");
        assert!(text.contains("connection: close"));
    }

    #[test]
    fn loopback_post_reads_rpc_like_json() {
        let (port, capture) = serve_once(http_response(
            "HTTP/1.1 200 OK",
            &["content-type: application/json; charset=utf-8"],
            r#"{"ok":true,"result":{"service":"browser-bridge","port":1}}"#,
        ));
        let client = HttpClient::with_timeout(Duration::from_secs(2));
        let request = HttpRequest::post_json("127.0.0.1", "/rpc", r#"{"method":"status","params":{}}"#)
            .header("x-bridge-token", "tok");
        let response = client.execute_port(port, &request).expect("请求成功");
        assert!(response.is_success());
        assert_eq!(
            response.json().expect("JSON").get("result").and_then(|result| result.get("service")).and_then(Json::as_str),
            Some("browser-bridge")
        );
        let text = String::from_utf8_lossy(&capture.join().expect("线程")).to_string();
        assert!(text.starts_with("POST /rpc HTTP/1.1\r\n"));
        assert!(text.contains("x-bridge-token: tok"));
        assert!(text.contains("\r\n\r\n{\"method\":\"status\",\"params\":{}}"));
    }

    #[test]
    fn chunked_response_is_rejected_with_explanation() {
        let (port, _) = serve_once(
            b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n4\r\n{\"ok\r\n".to_vec(),
        );
        let client = HttpClient::with_timeout(Duration::from_secs(2));
        let error = client
            .execute_port(port, &HttpRequest::get("127.0.0.1", "/health"))
            .expect_err("chunked 必须拒绝");
        assert_eq!(error.code, ErrorCode::UnsupportedCapability);
        assert!(error.message.contains("chunked"), "{}", error.message);
        assert!(error.message.contains("content-length"), "必须说明替代方案：{}", error.message);
        let data = error.data.expect("data");
        assert_eq!(data.get("transferEncoding").and_then(Json::as_str), Some("chunked"));
    }

    #[test]
    fn connection_close_without_length_reads_to_eof() {
        let (port, _) = serve_once(b"HTTP/1.1 200 OK\r\nconnection: close\r\n\r\n{\"ok\":true}".to_vec());
        let client = HttpClient::with_timeout(Duration::from_secs(2));
        let response = client.execute_port(port, &HttpRequest::get("127.0.0.1", "/health")).expect("读到 EOF");
        assert_eq!(response.body_text().expect("UTF-8"), "{\"ok\":true}");
    }

    #[test]
    fn keepalive_without_length_is_rejected() {
        let (port, _) = serve_once(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"ok\":true}".to_vec());
        let client = HttpClient::with_timeout(Duration::from_millis(800));
        let error = client
            .execute_port(port, &HttpRequest::get("127.0.0.1", "/health"))
            .expect_err("无法确定边界必须拒绝");
        assert_eq!(error.code, ErrorCode::Rpc);
        assert!(error.message.contains("content-length"), "{}", error.message);
    }

    #[test]
    fn truncated_body_is_disconnected() {
        let (port, _) = serve_once(b"HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\nshort".to_vec());
        let client = HttpClient::with_timeout(Duration::from_secs(2));
        let error = client
            .execute_port(port, &HttpRequest::get("127.0.0.1", "/health"))
            .expect_err("正文不完整必须报错");
        assert_eq!(error.code, ErrorCode::Disconnected);
        assert!(error.message.contains("100"), "{}", error.message);
    }

    #[test]
    fn oversized_content_length_is_too_large() {
        let (port, _) = serve_once(b"HTTP/1.1 200 OK\r\ncontent-length: 999999999\r\n\r\n".to_vec());
        let client = HttpClient::with_timeout(Duration::from_secs(2)).max_body(1024);
        let error = client
            .execute_port(port, &HttpRequest::get("127.0.0.1", "/health"))
            .expect_err("超上限必须拒绝");
        assert_eq!(error.code, ErrorCode::TooLarge);
        assert_eq!(error.data.expect("data").get("maxBody").and_then(Json::as_u64), Some(1024));
    }

    #[test]
    fn read_timeout_maps_to_daemon_timeout() {
        // 接受连接但永不回包：读超时必须生效。
        let listener = TcpListener::bind("127.0.0.1:0").expect("绑定");
        let port = listener.local_addr().expect("地址").port();
        let handle = thread::spawn(move || {
            let (socket, _) = listener.accept().expect("accept");
            thread::sleep(Duration::from_millis(600));
            drop(socket);
        });
        let client = HttpClient::new(Duration::from_millis(500), Duration::from_millis(150));
        let error = client
            .execute_port(port, &HttpRequest::get("127.0.0.1", "/health"))
            .expect_err("必须超时");
        assert_eq!(error.code, ErrorCode::DaemonTimeout, "{}", error.message);
        handle.join().expect("线程");
    }

    #[test]
    fn closed_loopback_port_is_structured_daemon_error() {
        // 先占一个端口再释放，确保没有服务监听。Windows 对关闭端口可能回 RST（ConnectionRefused）
        // 也可能直接超时（WSAETIMEDOUT），两者都必须是"daemon 不可达"类结构化错误 + 退出码路径。
        let listener = TcpListener::bind("127.0.0.1:0").expect("绑定");
        let port = listener.local_addr().expect("地址").port();
        drop(listener);
        let client = HttpClient::with_timeout(Duration::from_millis(500));
        let error = client
            .execute_port(port, &HttpRequest::get("127.0.0.1", "/health"))
            .expect_err("连接必须失败");
        assert!(
            matches!(error.code, ErrorCode::NoDaemon | ErrorCode::DaemonTimeout),
            "期望 daemon 不可达类错误，实际 {:?}：{}",
            error.code,
            error.message
        );
        assert!(error.message.contains("daemon"), "{}", error.message);
        assert!(error.data.expect("data").get("endpoint").and_then(Json::as_str).is_some());
    }

    #[test]
    fn connect_error_mapping_is_explicit() {
        let addr = "127.0.0.1:52900".parse().expect("地址");
        let refused = std::io::Error::from(ErrorKind::ConnectionRefused);
        let error = connect_error(&addr, &refused);
        assert_eq!(error.code, ErrorCode::NoDaemon);
        assert!(error.message.contains("daemon 未运行"), "{}", error.message);
        assert_eq!(error.data.expect("data").get("kind").and_then(Json::as_str), Some("ConnectionRefused"));

        let timed_out = std::io::Error::from(ErrorKind::TimedOut);
        let error = connect_error(&addr, &timed_out);
        assert_eq!(error.code, ErrorCode::DaemonTimeout);
        assert!(error.message.contains("超时"), "{}", error.message);

        let other = std::io::Error::other("boom");
        assert_eq!(connect_error(&addr, &other).code, ErrorCode::Daemon);
    }

    #[test]
    fn status_mapping_matches_daemon_contract() {
        assert_eq!(status_to_error_code(400), ErrorCode::BadRequest);
        assert_eq!(status_to_error_code(401), ErrorCode::Auth);
        assert_eq!(status_to_error_code(403), ErrorCode::Forbidden);
        assert_eq!(status_to_error_code(404), ErrorCode::UnknownMethod);
        assert_eq!(status_to_error_code(408), ErrorCode::Timeout);
        assert_eq!(status_to_error_code(413), ErrorCode::TooLarge);
        assert_eq!(status_to_error_code(429), ErrorCode::RateLimited);
        assert_eq!(status_to_error_code(500), ErrorCode::Internal);
        assert_eq!(status_to_error_code(503), ErrorCode::Internal);
        assert_eq!(status_to_error_code(418), ErrorCode::Rpc);
    }

    #[test]
    fn non_success_response_error_carries_status_and_body() {
        let response = HttpResponse {
            head: HttpHead {
                status: 401,
                reason: "Unauthorized".to_string(),
                headers: vec![("content-length".to_string(), "61".to_string())],
                head_len: 0,
            },
            body: br#"{"ok":false,"error":{"code":"E_AUTH","message":"invalid token"}}"#.to_vec(),
        };
        let error = response_error(&response, "POST /rpc");
        assert_eq!(error.code, ErrorCode::Auth);
        assert!(error.message.contains("401"), "{}", error.message);
        let data = error.data.expect("data");
        assert_eq!(data.get("status").and_then(Json::as_u64), Some(401));
        assert!(data.get("bodyPrefix").and_then(Json::as_str).expect("bodyPrefix").contains("E_AUTH"));
    }

    #[test]
    fn body_text_and_json_validate_utf8() {
        let ok = HttpResponse {
            head: HttpHead { status: 200, reason: "OK".to_string(), headers: Vec::new(), head_len: 0 },
            body: b"\xe4\xb8\xad".to_vec(),
        };
        assert_eq!(ok.body_text().expect("UTF-8"), "中");
        let bad = HttpResponse {
            head: HttpHead { status: 200, reason: "OK".to_string(), headers: Vec::new(), head_len: 0 },
            body: vec![0xff, 0xfe],
        };
        assert_eq!(bad.body_text().expect_err("非法 UTF-8").code, ErrorCode::Rpc);
        let empty = HttpResponse {
            head: HttpHead { status: 200, reason: "OK".to_string(), headers: Vec::new(), head_len: 0 },
            body: Vec::new(),
        };
        assert_eq!(empty.json().expect("空正文按 null"), Json::Null);
    }
}

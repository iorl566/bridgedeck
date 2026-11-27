//! std-only WebSocket（RFC 6455）**客户端**：握手 + 帧编解码 + hello/hello-ack 真实交互。
//!
//! 只读对齐 `lib/ws.mjs`（daemon 的零依赖 WS 服务端实现）：
//! - 升级路径 `/ws`，`Sec-WebSocket-Version: 13`；Accept = base64(SHA-1(key + GUID))；
//! - 服务端发往客户端的帧**不加掩码**；客户端发往服务端的帧**必须加掩码**（本实现强制加）；
//! - 文本帧承载 JSON；心跳是文本帧 `{"type":"ping"}` 与 `{"type":"pong"}`（daemon 在
//!   `heartbeatTick` 里发 `{type:'ping'}`），WS 控制帧 ping/pong 也被支持；
//! - 握手超时 5s（daemon `HANDSHAKE_TIMEOUT_MS`），帧大小上限 16 MiB（`lib/transport-frame.mjs`）。
//!
//! 为什么不用现成库：本 crate 硬约束 std-only（不新增依赖），所以握手/掩码/分片/关闭帧都在这里
//! 手写，并用 RFC 6455 §1.3 的固定向量与自建回环服务端做单测。
//!
//! 边界：未实现 permessage-deflate/扩展协商（RSV 位非 0 直接拒绝）、未实现 TLS（`wss://` 由调用方
//! 前置判断并明确报 `E_UNSUPPORTED_CAPABILITY`）、未实现客户端主动分片发送（发送总是 FIN=1）。

use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::base64;
use crate::envelope::RpcError;
use crate::errors::ErrorCode;
use crate::handshake::{Hello, HelloAck};
use crate::http;
use crate::json::Json;
use crate::sha1;
use crate::wire::{WsMessage, TYPE_HELLO_ERROR};

/// RFC 6455 §1.3 固定 GUID。
pub const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/// daemon 的升级路由（`lib/ws.mjs attachWsServer` 默认值）。
pub const WS_PATH: &str = "/ws";
/// 真实升级地址：daemon `onExtensionConnection` 只接受 `role=extension`
/// （`daemon/server.mjs`：其它 role 直接 `close(1008, 'unsupported role')`），
/// 因此客户端默认必须带这个查询参数，否则握手成功后立刻被关闭。
pub const WS_EXTENSION_PATH: &str = "/ws?role=extension";
/// 单条消息（分片重组后）最大字节数（daemon 帧上限 16 MiB）。
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
/// 握手超时（daemon `HANDSHAKE_TIMEOUT_MS`）。
pub const DEFAULT_HANDSHAKE_TIMEOUT_MS: u64 = 5_000;
/// 普通帧读写超时。
pub const DEFAULT_FRAME_TIMEOUT_MS: u64 = 10_000;

/// 帧操作码（RFC 6455 §5.2）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpCode {
    Continuation,
    Text,
    Binary,
    Close,
    Ping,
    Pong,
}

impl OpCode {
    pub fn as_u8(self) -> u8 {
        match self {
            OpCode::Continuation => 0x0,
            OpCode::Text => 0x1,
            OpCode::Binary => 0x2,
            OpCode::Close => 0x8,
            OpCode::Ping => 0x9,
            OpCode::Pong => 0xa,
        }
    }

    pub fn from_u8(value: u8) -> Option<Self> {
        match value & 0x0f {
            0x0 => Some(OpCode::Continuation),
            0x1 => Some(OpCode::Text),
            0x2 => Some(OpCode::Binary),
            0x8 => Some(OpCode::Close),
            0x9 => Some(OpCode::Ping),
            0xa => Some(OpCode::Pong),
            _ => None,
        }
    }

    pub fn is_control(self) -> bool {
        matches!(self, OpCode::Close | OpCode::Ping | OpCode::Pong)
    }

    pub fn name(self) -> &'static str {
        match self {
            OpCode::Continuation => "continuation",
            OpCode::Text => "text",
            OpCode::Binary => "binary",
            OpCode::Close => "close",
            OpCode::Ping => "ping",
            OpCode::Pong => "pong",
        }
    }
}

/// 一条 WS 帧。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WsFrame {
    pub fin: bool,
    pub opcode: OpCode,
    pub payload: Vec<u8>,
}

impl WsFrame {
    pub fn new(opcode: OpCode, payload: Vec<u8>) -> Self {
        Self { fin: true, opcode, payload }
    }

    pub fn text(text: impl AsRef<str>) -> Self {
        Self::new(OpCode::Text, text.as_ref().as_bytes().to_vec())
    }

    pub fn binary(bytes: Vec<u8>) -> Self {
        Self::new(OpCode::Binary, bytes)
    }

    pub fn ping(payload: Vec<u8>) -> Self {
        Self::new(OpCode::Ping, payload)
    }

    pub fn pong(payload: Vec<u8>) -> Self {
        Self::new(OpCode::Pong, payload)
    }

    /// 关闭帧：2 字节大端状态码 + UTF-8 原因（总长 ≤125）。
    pub fn close(code: Option<u16>, reason: &str) -> Self {
        Self::new(OpCode::Close, close_payload(code, reason))
    }

    pub fn is_control(&self) -> bool {
        self.opcode.is_control()
    }

    /// 编码成线格式；`mask` 为 `Some` 时按 RFC 6455 加掩码（客户端 → 服务端必须加）。
    pub fn encode(&self, mask: Option<[u8; 4]>) -> Vec<u8> {
        encode_frame(self.fin, self.opcode, &self.payload, mask)
    }

    pub fn as_text(&self) -> Result<&str, RpcError> {
        std::str::from_utf8(&self.payload).map_err(|error| {
            RpcError::new(ErrorCode::Rpc, format!("WS 文本帧不是合法 UTF-8：{error}"))
                .with_data(crate::json_obj! { "bytes" => Json::Number(self.payload.len() as f64) })
        })
    }
}

/// 低层帧编码（`fin` + opcode + 掩码）。
pub fn encode_frame(fin: bool, opcode: OpCode, payload: &[u8], mask: Option<[u8; 4]>) -> Vec<u8> {
    let length = payload.len();
    let mut out = Vec::with_capacity(length + 14);
    let mut first = opcode.as_u8() & 0x0f;
    if fin {
        first |= 0x80;
    }
    out.push(first);
    let mask_bit = if mask.is_some() { 0x80 } else { 0 };
    if length < 126 {
        out.push(mask_bit | length as u8);
    } else if length <= u16::MAX as usize {
        out.push(mask_bit | 126);
        out.extend_from_slice(&(length as u16).to_be_bytes());
    } else {
        out.push(mask_bit | 127);
        out.extend_from_slice(&(length as u64).to_be_bytes());
    }
    match mask {
        Some(key) => {
            out.extend_from_slice(&key);
            for (index, byte) in payload.iter().enumerate() {
                out.push(byte ^ key[index & 3]);
            }
        }
        None => out.extend_from_slice(payload),
    }
    out
}

/// 一条解码出的帧 + 消耗的字节数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedFrame {
    pub frame: WsFrame,
    pub consumed: usize,
}

/// 尝试从缓冲区头部解出一帧；数据不足返回 `Ok(None)`（继续读）。
pub fn decode_frame(buffer: &[u8]) -> Result<Option<DecodedFrame>, RpcError> {
    if buffer.len() < 2 {
        return Ok(None);
    }
    let first = buffer[0];
    let second = buffer[1];
    let fin = first & 0x80 != 0;
    if first & 0x70 != 0 {
        return Err(RpcError::new(
            ErrorCode::Rpc,
            "WS 帧 RSV1/RSV2/RSV3 非 0：未协商扩展（不支持 permessage-deflate）",
        )
        .with_data(crate::json_obj! { "firstByte" => Json::Number(f64::from(first)) }));
    }
    let Some(opcode) = OpCode::from_u8(first) else {
        return Err(RpcError::new(
            ErrorCode::Rpc,
            format!("WS 帧操作码非法：0x{:x}", first & 0x0f),
        ));
    };
    let masked = second & 0x80 != 0;
    let length7 = second & 0x7f;
    let mut offset = 2usize;
    let payload_len: u64 = match length7 {
        126 => {
            if buffer.len() < offset + 2 {
                return Ok(None);
            }
            let value = u16::from_be_bytes([buffer[offset], buffer[offset + 1]]) as u64;
            offset += 2;
            value
        }
        127 => {
            if buffer.len() < offset + 8 {
                return Ok(None);
            }
            let mut bytes = [0u8; 8];
            bytes.copy_from_slice(&buffer[offset..offset + 8]);
            offset += 8;
            u64::from_be_bytes(bytes)
        }
        other => u64::from(other),
    };
    if payload_len > MAX_MESSAGE_BYTES as u64 {
        return Err(RpcError::new(
            ErrorCode::TooLarge,
            format!("WS 帧声明 {payload_len} 字节，超过上限 {MAX_MESSAGE_BYTES}"),
        )
        .with_data(crate::json_obj! {
            "payloadLength" => Json::Number(payload_len as f64),
            "maxMessageBytes" => Json::Number(MAX_MESSAGE_BYTES as f64),
        }));
    }
    if opcode.is_control() && payload_len > 125 {
        return Err(RpcError::new(
            ErrorCode::Rpc,
            format!("WS 控制帧（{}）载荷超过 125 字节：{payload_len}", opcode.name()),
        ));
    }
    if opcode.is_control() && !fin {
        return Err(RpcError::new(ErrorCode::Rpc, format!("WS 控制帧（{}）不允许分片", opcode.name())));
    }
    let mask_key = if masked {
        if buffer.len() < offset + 4 {
            return Ok(None);
        }
        let key = [buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]];
        offset += 4;
        Some(key)
    } else {
        None
    };
    let payload_len = payload_len as usize;
    if buffer.len() < offset + payload_len {
        return Ok(None);
    }
    let mut payload = buffer[offset..offset + payload_len].to_vec();
    if let Some(key) = mask_key {
        for (index, byte) in payload.iter_mut().enumerate() {
            *byte ^= key[index & 3];
        }
    }
    Ok(Some(DecodedFrame {
        frame: WsFrame { fin, opcode, payload },
        consumed: offset + payload_len,
    }))
}

/// 关闭帧载荷：可选状态码 + 原因（原因按 UTF-8 截断到 123 字节以守住 125 上限）。
pub fn close_payload(code: Option<u16>, reason: &str) -> Vec<u8> {
    let mut payload = Vec::with_capacity(2 + reason.len());
    if let Some(code) = code {
        payload.extend_from_slice(&code.to_be_bytes());
        let mut clipped = String::new();
        for ch in reason.chars() {
            if clipped.len() + ch.len_utf8() > 123 {
                break;
            }
            clipped.push(ch);
        }
        payload.extend_from_slice(clipped.as_bytes());
    }
    payload
}

/// 解析关闭帧载荷 → (状态码, 原因)。
pub fn parse_close_payload(payload: &[u8]) -> (Option<u16>, String) {
    if payload.len() < 2 {
        return (None, String::new());
    }
    let code = u16::from_be_bytes([payload[0], payload[1]]);
    let reason = String::from_utf8_lossy(&payload[2..]).to_string();
    (Some(code), reason)
}

/// `Sec-WebSocket-Accept` = base64(SHA-1(key + GUID))。
pub fn compute_accept(key: &str) -> String {
    let mut input = String::with_capacity(key.len() + WS_GUID.len());
    input.push_str(key);
    input.push_str(WS_GUID);
    base64::encode(&sha1::sha1(input.as_bytes()))
}

/// 生成 16 字节随机 source 的 base64 key（RFC 6455 §4.1）。
///
/// 随机源说明：std-only 没有 OS RNG。这里用时间 + pid + 进程内计数器 + 栈地址做 xorshift 播种，
/// **不是密码学随机**；WS key 只用于防缓存/回显混淆，真正的鉴权在 HTTP token 与 daemon 配对层。
pub fn generate_key() -> String {
    base64::encode(&random_bytes(16))
}

/// 非密码学随机字节（仅用于 WS 掩码 key 与握手 key）。
pub fn random_bytes(count: usize) -> Vec<u8> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_nanos()).unwrap_or(0) as u64;
    let stack_probe = 0u8;
    let address = (&stack_probe as *const u8) as u64;
    let mut state = nanos
        ^ (u64::from(std::process::id()) << 32)
        ^ address.rotate_left(17)
        ^ COUNTER.fetch_add(0x9E37_79B9_7F4A_7C15, Ordering::Relaxed);
    let mut out = Vec::with_capacity(count);
    while out.len() < count {
        // xorshift64*
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        let value = state.wrapping_mul(0x2545_F491_4F6C_DD1D);
        out.extend_from_slice(&value.to_le_bytes());
    }
    out.truncate(count);
    out
}

/// 生成握手请求字节（独立函数便于断言线格式）。
pub fn build_handshake_request(host: &str, path: &str, key: &str) -> Vec<u8> {
    format!(
        "GET {path} HTTP/1.1\r\n\
         Host: {host}\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Key: {key}\r\n\
         Sec-WebSocket-Version: 13\r\n\
         \r\n"
    )
    .into_bytes()
}

/// 握手结果（诊断用：实际收到的头与 key）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandshakeInfo {
    pub status: u16,
    pub key: String,
    pub expected_accept: String,
    pub accept: String,
    pub upgrade: String,
}

/// 已连接的 WS 客户端。
#[derive(Debug)]
pub struct WsClient {
    stream: TcpStream,
    peer: SocketAddr,
    buffer: Vec<u8>,
    pub handshake: HandshakeInfo,
    closed: bool,
}

impl WsClient {
    /// 连接 `127.0.0.1:port` 的 daemon WebSocket（带 `role=extension`，见 [`WS_EXTENSION_PATH`]）。
    pub fn connect(port: u16, timeout: Duration) -> Result<Self, RpcError> {
        Self::connect_path(port, WS_EXTENSION_PATH, timeout)
    }

    pub fn connect_path(port: u16, path: &str, timeout: Duration) -> Result<Self, RpcError> {
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let host = format!("127.0.0.1:{port}");
        Self::connect_addr(addr, &host, path, timeout)
    }

    /// 连接指定地址并完成握手（`host` 用于 Host 头）。
    pub fn connect_addr(addr: SocketAddr, host: &str, path: &str, timeout: Duration) -> Result<Self, RpcError> {
        let mut stream = TcpStream::connect_timeout(&addr, timeout.min(Duration::from_millis(http::DEFAULT_CONNECT_TIMEOUT_MS)))
            .map_err(|error| http::connect_error(&addr, &error))?;
        stream
            .set_read_timeout(Some(timeout))
            .map_err(|error| http::io_error(&addr, "设置 WS 读超时失败", &error))?;
        stream
            .set_write_timeout(Some(timeout))
            .map_err(|error| http::io_error(&addr, "设置 WS 写超时失败", &error))?;
        stream.set_nodelay(true).ok();

        let key = generate_key();
        let expected_accept = compute_accept(&key);
        let request = build_handshake_request(host, if path.is_empty() { WS_PATH } else { path }, &key);
        stream.write_all(&request).map_err(|error| http::io_error(&addr, "写 WS 握手请求失败", &error))?;
        stream.flush().map_err(|error| http::io_error(&addr, "刷新 WS 握手请求失败", &error))?;

        let mut buffer = Vec::new();
        let head = http::read_head(&mut stream, &addr, &mut buffer)?;
        let accept = head.header("sec-websocket-accept").unwrap_or("").to_string();
        let upgrade = head.header("upgrade").unwrap_or("").to_string();
        let connection_ok = head
            .header_tokens("connection")
            .iter()
            .any(|token| token.eq_ignore_ascii_case("upgrade"));
        if head.status != 101 {
            return Err(RpcError::new(
                http::status_to_error_code(head.status),
                format!(
                    "WebSocket 升级被拒绝：HTTP {} {}（daemon /ws 需要 Upgrade: websocket）",
                    head.status, head.reason
                ),
            )
            .with_data(crate::json_obj! {
                "status" => Json::Number(f64::from(head.status)),
                "reason" => Json::string(head.reason.clone()),
                "path" => Json::string(path.to_string()),
            }));
        }
        if !upgrade.eq_ignore_ascii_case("websocket") || !connection_ok {
            return Err(RpcError::new(
                ErrorCode::Rpc,
                format!("WebSocket 升级响应头非法：upgrade={upgrade:?} connection={:?}", head.header("connection")),
            ));
        }
        if accept != expected_accept {
            return Err(RpcError::new(
                ErrorCode::Rpc,
                "WebSocket Sec-WebSocket-Accept 校验失败（对端可能不是 daemon，或中间有代理）",
            )
            .with_data(crate::json_obj! {
                "expected" => Json::string(expected_accept.clone()),
                "actual" => Json::string(accept.clone()),
            }));
        }
        buffer.drain(..head.head_len);
        Ok(Self {
            stream,
            peer: addr,
            buffer,
            handshake: HandshakeInfo { status: head.status, key, expected_accept, accept, upgrade },
            closed: false,
        })
    }

    pub fn peer_addr(&self) -> SocketAddr {
        self.peer
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }

    /// 发送一帧（客户端帧强制加随机掩码）。
    pub fn send_frame(&mut self, frame: &WsFrame) -> Result<(), RpcError> {
        if self.closed {
            return Err(self.closed_error("发送前连接已关闭"));
        }
        let key = random_bytes(4);
        let mut mask = [0u8; 4];
        mask.copy_from_slice(&key);
        let bytes = frame.encode(Some(mask));
        self.stream.write_all(&bytes).map_err(|error| http::io_error(&self.peer, "写 WS 帧失败", &error))?;
        self.stream.flush().map_err(|error| http::io_error(&self.peer, "刷新 WS 帧失败", &error))?;
        Ok(())
    }

    pub fn send_text(&mut self, text: &str) -> Result<(), RpcError> {
        self.send_frame(&WsFrame::text(text))
    }

    pub fn send_json(&mut self, value: &Json) -> Result<(), RpcError> {
        self.send_text(&value.to_compact_string())
    }

    pub fn send_ping(&mut self, payload: Vec<u8>) -> Result<(), RpcError> {
        self.send_frame(&WsFrame::ping(payload))
    }

    pub fn send_pong(&mut self, payload: Vec<u8>) -> Result<(), RpcError> {
        self.send_frame(&WsFrame::pong(payload))
    }

    /// 发送关闭帧（不等待对端回包；对端会回 close 并关闭 socket）。
    pub fn close(&mut self, code: u16, reason: &str) -> Result<(), RpcError> {
        if self.closed {
            return Ok(());
        }
        let result = self.send_frame(&WsFrame::close(Some(code), reason));
        self.closed = true;
        result
    }

    pub fn shutdown(&mut self) {
        self.closed = true;
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
    }

    fn closed_error(&self, context: &str) -> RpcError {
        RpcError::new(ErrorCode::Disconnected, format!("{context}（daemon {}）", self.peer))
    }

    /// 读一帧（数据不足时自动继续读；EOF → `E_DISCONNECTED`）。
    pub fn read_frame(&mut self) -> Result<WsFrame, RpcError> {
        loop {
            if let Some(decoded) = decode_frame(&self.buffer)? {
                self.buffer.drain(..decoded.consumed);
                if decoded.frame.opcode == OpCode::Close {
                    self.closed = true;
                }
                return Ok(decoded.frame);
            }
            let mut chunk = [0u8; 4096];
            match self.stream.read(&mut chunk) {
                Ok(0) => {
                    self.closed = true;
                    return Err(RpcError::new(
                        ErrorCode::Disconnected,
                        format!("daemon {} 关闭了 WebSocket 连接", self.peer),
                    )
                    .with_data(crate::json_obj! {
                        "endpoint" => Json::string(self.peer.to_string()),
                        "buffered" => Json::Number(self.buffer.len() as f64),
                    }));
                }
                Ok(count) => self.buffer.extend_from_slice(&chunk[..count]),
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) => return Err(http::io_error(&self.peer, "读 WS 帧失败", &error)),
            }
        }
    }

    /// 读一条完整消息：自动回 pong、处理关闭帧、聚合分片。
    ///
    /// 返回 `(opcode, payload)`，opcode 为 Text 或 Binary。
    pub fn read_message(&mut self) -> Result<(OpCode, Vec<u8>), RpcError> {
        let mut fragments: Vec<u8> = Vec::new();
        let mut message_opcode: Option<OpCode> = None;
        loop {
            let frame = self.read_frame()?;
            match frame.opcode {
                OpCode::Ping => {
                    // 控制帧可以插在分片中间；回 pong 后继续。
                    self.send_frame(&WsFrame::pong(frame.payload))?;
                    continue;
                }
                OpCode::Pong => continue,
                OpCode::Close => {
                    let (code, reason) = parse_close_payload(&frame.payload);
                    // 回应 close（RFC 6455 §5.5.1），失败也无所谓：对端可能已断开。
                    let _ = self.send_frame(&WsFrame::close(code, ""));
                    self.closed = true;
                    return Err(RpcError::new(
                        ErrorCode::Disconnected,
                        format!(
                            "daemon {} 发送关闭帧：code={} reason={reason:?}",
                            self.peer,
                            code.map(|code| code.to_string()).unwrap_or_else(|| "无".to_string())
                        ),
                    )
                    .with_data(crate::json_obj! {
                        "closeCode" => code.map(|code| Json::Number(f64::from(code))).unwrap_or(Json::Null),
                        "closeReason" => Json::string(reason),
                    }));
                }
                OpCode::Text | OpCode::Binary => {
                    if frame.fin {
                        if frame.payload.len() > MAX_MESSAGE_BYTES {
                            return Err(RpcError::new(ErrorCode::TooLarge, "WS 消息超过上限"));
                        }
                        return Ok((frame.opcode, frame.payload));
                    }
                    message_opcode = Some(frame.opcode);
                    fragments = frame.payload;
                }
                OpCode::Continuation => {
                    if message_opcode.is_none() {
                        return Err(RpcError::new(ErrorCode::Rpc, "WS 收到无起始帧的续帧"));
                    }
                    if fragments.len() + frame.payload.len() > MAX_MESSAGE_BYTES {
                        return Err(RpcError::new(
                            ErrorCode::TooLarge,
                            format!("WS 分片消息超过上限 {MAX_MESSAGE_BYTES} 字节"),
                        ));
                    }
                    fragments.extend_from_slice(&frame.payload);
                    if frame.fin {
                        return Ok((message_opcode.expect("已确认有起始帧"), std::mem::take(&mut fragments)));
                    }
                }
            }
        }
    }

    /// 读一条文本消息（二进制帧视为协议错误）。
    pub fn read_text(&mut self) -> Result<String, RpcError> {
        let (opcode, payload) = self.read_message()?;
        if opcode != OpCode::Text {
            return Err(RpcError::new(
                ErrorCode::Rpc,
                format!("WS 期望文本帧，实际收到 {}", opcode.name()),
            ));
        }
        String::from_utf8(payload)
            .map_err(|error| RpcError::new(ErrorCode::Rpc, format!("WS 文本帧不是合法 UTF-8：{error}")))
    }

    /// 读一条文本消息并解析 JSON。
    pub fn read_json(&mut self) -> Result<Json, RpcError> {
        let text = self.read_text()?;
        Json::parse(&text).map_err(|error| RpcError::new(ErrorCode::BadJson, format!("WS 帧 JSON 非法：{error}")))
    }

    /// 发送 hello 并等待 hello-ack。
    ///
    /// 跳过心跳/事件帧；`hello-error` 转成带单源代码的 `RpcError`；
    /// 收到其它类型帧按协议错误处理（握手阶段 daemon 只说这三种）。
    pub fn hello_exchange(&mut self, hello: &Hello) -> Result<HelloAck, RpcError> {
        self.send_json(&hello.to_json())?;
        loop {
            let value = self.read_json()?;
            match WsMessage::decode(&value) {
                Ok(WsMessage::HelloAck(ack)) => return Ok(ack),
                Ok(WsMessage::HelloError(error)) => {
                    return Err(RpcError::new(error.code, error.message).with_data(crate::json_obj! {
                        "frame" => Json::string(TYPE_HELLO_ERROR),
                        "endpoint" => Json::string(self.peer.to_string()),
                    }));
                }
                Ok(WsMessage::Ping) => {
                    self.send_text("{\"type\":\"pong\"}")?;
                    continue;
                }
                Ok(WsMessage::Pong) => continue,
                Ok(WsMessage::Event(_)) => continue,
                Ok(other) => {
                    return Err(RpcError::new(
                        ErrorCode::Rpc,
                        format!("WebSocket 握手阶段收到非预期帧：{}", other.type_name()),
                    ));
                }
                Err(error) => {
                    return Err(RpcError::new(
                        ErrorCode::Rpc,
                        format!("WebSocket 握手阶段帧无法解码：{error}"),
                    ));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handshake::ProtocolVersion;
    use std::net::TcpListener;
    use std::thread;

    fn obj(text: &str) -> Json {
        Json::parse(text).expect("合法 JSON")
    }

    /// 假 WS 服务端：完成握手后把 socket 交给 `handler`。
    fn fake_server<F>(handler: F) -> (u16, thread::JoinHandle<()>)
    where
        F: FnOnce(&mut TcpStream) + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("绑定");
        let port = listener.local_addr().expect("地址").port();
        let handle = thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept");
            socket.set_read_timeout(Some(Duration::from_secs(3))).expect("超时");
            let mut buffer = Vec::new();
            let head_end = loop {
                if let Some(end) = http::find_head_end(&buffer) {
                    break end;
                }
                let mut chunk = [0u8; 1024];
                let count = socket.read(&mut chunk).unwrap_or(0);
                if count == 0 {
                    return;
                }
                buffer.extend_from_slice(&chunk[..count]);
            };
            let request = String::from_utf8_lossy(&buffer[..head_end]).to_string();
            let key = request
                .lines()
                .find_map(|line| {
                    // 注意：只对头名做大小写比较，值必须保留原样（base64 大小写敏感）。
                    let (name, value) = line.split_once(':')?;
                    if name.trim().eq_ignore_ascii_case("sec-websocket-key") {
                        Some(value.trim().to_string())
                    } else {
                        None
                    }
                })
                .expect("客户端必须带 Sec-WebSocket-Key");
            let accept = compute_accept(&key);
            let response = format!(
                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
            );
            socket.write_all(response.as_bytes()).expect("写握手响应");
            socket.flush().expect("flush");
            // 本夹具假定 hello 不会与握手响应同包到达（客户端 connect 返回后才发 hello）。
            handler(&mut socket);
        });
        (port, handle)
    }

    fn read_client_frame(socket: &mut TcpStream, buffer: &mut Vec<u8>) -> WsFrame {
        loop {
            if let Some(decoded) = decode_frame(buffer).expect("解帧") {
                buffer.drain(..decoded.consumed);
                return decoded.frame;
            }
            let mut chunk = [0u8; 1024];
            let count = socket.read(&mut chunk).expect("读客户端帧");
            assert!(count > 0, "客户端提前关闭");
            buffer.extend_from_slice(&chunk[..count]);
        }
    }

    fn send_server_frame(socket: &mut TcpStream, frame: &WsFrame) {
        socket.write_all(&frame.encode(None)).expect("写服务端帧");
        socket.flush().expect("flush");
    }

    #[test]
    fn accept_matches_rfc6455_vector() {
        assert_eq!(compute_accept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
        // 大小写/内容敏感：不同 key 产生不同 accept。
        assert_ne!(compute_accept("abc"), compute_accept("abd"));
    }

    #[test]
    fn generated_keys_are_16_byte_base64() {
        let key = generate_key();
        assert_eq!(key.len(), 24, "16 字节 base64 应为 24 字符（含 ==）：{key}");
        assert!(key.ends_with("=="));
        let mut seen = std::collections::BTreeSet::new();
        for _ in 0..16 {
            seen.insert(generate_key());
        }
        assert!(seen.len() > 12, "随机 key 不应大量重复：{}", seen.len());
        assert_eq!(random_bytes(16).len(), 16);
        assert_eq!(random_bytes(0).len(), 0);
    }

    #[test]
    fn handshake_request_shape_is_rfc6455() {
        let text = String::from_utf8(build_handshake_request("127.0.0.1:52900", WS_EXTENSION_PATH, "abc")).expect("ASCII");
        assert!(text.starts_with("GET /ws?role=extension HTTP/1.1\r\n"), "{text}");
        assert!(text.contains("Host: 127.0.0.1:52900\r\n"));
        assert!(text.contains("Upgrade: websocket\r\n"));
        assert!(text.contains("Connection: Upgrade\r\n"));
        assert!(text.contains("Sec-WebSocket-Key: abc\r\n"));
        assert!(text.contains("Sec-WebSocket-Version: 13\r\n"));
        assert!(text.ends_with("\r\n\r\n"));
        // 不发送 content-length（升级请求没有正文）。
        assert!(!text.to_ascii_lowercase().contains("content-length"));
        // daemon 只接受 role=extension（其它 role 会被 close 1008 拒绝）。
        assert_eq!(WS_EXTENSION_PATH, "/ws?role=extension");
        assert_eq!(WS_PATH, "/ws");
    }

    #[test]
    fn encodes_small_unmasked_frame() {
        let bytes = WsFrame::text("Hello").encode(None);
        assert_eq!(bytes, b"\x81\x05Hello".to_vec());
        let ping = WsFrame::ping(Vec::new()).encode(None);
        assert_eq!(ping, vec![0x89, 0x00]);
    }

    #[test]
    fn encodes_masked_frame_with_key() {
        let frame = WsFrame::text("Hello");
        let bytes = frame.encode(Some([0x37, 0xfa, 0x21, 0x3d]));
        assert_eq!(bytes.len(), 2 + 4 + 5);
        assert_eq!(bytes[0], 0x81);
        assert_eq!(bytes[1], 0x85, "mask 位 + len 5");
        assert_eq!(&bytes[2..6], &[0x37, 0xfa, 0x21, 0x3d]);
        // RFC 6455 §5.7 示例掩码后的 "Hello"。
        assert_eq!(&bytes[6..], &[0x7f, 0x9f, 0x4d, 0x51, 0x58]);
        assert_eq!(decode_frame(&bytes).expect("解出").expect("完整").frame, frame);
    }

    #[test]
    fn encodes_extended_lengths() {
        let payload = vec![0u8; 200];
        let bytes = WsFrame::binary(payload.clone()).encode(None);
        assert_eq!(bytes[1], 126);
        assert_eq!(u16::from_be_bytes([bytes[2], bytes[3]]), 200);
        assert_eq!(bytes.len(), 4 + 200);

        let big = vec![7u8; 70_000];
        let bytes = WsFrame::binary(big.clone()).encode(None);
        assert_eq!(bytes[1], 127);
        assert_eq!(u64::from_be_bytes(bytes[2..10].try_into().expect("8 字节")), 70_000);
        assert_eq!(bytes.len(), 10 + 70_000);
        assert_eq!(decode_frame(&bytes).expect("解出").expect("完整").frame.payload.len(), 70_000);
    }

    #[test]
    fn decode_returns_none_until_frame_complete() {
        let bytes = WsFrame::text("Hello").encode(None);
        for prefix in 0..bytes.len() {
            assert_eq!(decode_frame(&bytes[..prefix]).expect("不报错"), None, "前缀 {prefix}");
        }
        let decoded = decode_frame(&bytes).expect("完整").expect("有帧");
        assert_eq!(decoded.consumed, bytes.len());
        // 尾部多余字节不消耗。
        let mut extended = bytes.clone();
        extended.extend_from_slice(b"tail");
        assert_eq!(decode_frame(&extended).expect("解出").expect("帧").consumed, bytes.len());
    }

    #[test]
    fn decode_rejects_protocol_violations() {
        // RSV1 置位（未协商扩展）。
        let error = decode_frame(&[0xc1, 0x00]).expect_err("RSV 必须拒绝");
        assert_eq!(error.code, ErrorCode::Rpc);
        assert!(error.message.contains("RSV"), "{}", error.message);
        // 未知操作码。
        let error = decode_frame(&[0x83, 0x00]).expect_err("未知 opcode");
        assert!(error.message.contains("操作码"), "{}", error.message);
        // 控制帧分片。
        let error = decode_frame(&[0x09, 0x00]).expect_err("控制帧不能分片");
        assert!(error.message.contains("分片"), "{}", error.message);
        // 控制帧超长。
        let oversized_ping = WsFrame::ping(vec![0u8; 126]).encode(None);
        let error = decode_frame(&oversized_ping).expect_err("控制帧超长");
        assert!(error.message.contains("125"), "{}", error.message);
    }

    #[test]
    fn decode_rejects_oversized_payload() {
        let mut header = vec![0x82, 127];
        header.extend_from_slice(&(MAX_MESSAGE_BYTES as u64 + 1).to_be_bytes());
        let error = decode_frame(&header).expect_err("超上限");
        assert_eq!(error.code, ErrorCode::TooLarge);
        assert_eq!(error.data.expect("data").get("maxMessageBytes").and_then(Json::as_u64), Some(MAX_MESSAGE_BYTES as u64));
    }

    #[test]
    fn close_payload_round_trips_and_clips_reason() {
        let payload = close_payload(Some(1000), "bye");
        assert_eq!(payload, vec![0x03, 0xe8, b'b', b'y', b'e']);
        assert_eq!(parse_close_payload(&payload), (Some(1000), "bye".to_string()));
        assert_eq!(parse_close_payload(&[]), (None, String::new()));
        assert_eq!(parse_close_payload(&[0x01]), (None, String::new()));
        let long = close_payload(Some(4009), &"长".repeat(100));
        assert!(long.len() <= 125, "关闭帧载荷 ≤125：{}", long.len());
        assert_eq!(parse_close_payload(&long).0, Some(4009));
    }

    #[test]
    fn client_handshake_succeeds_against_fake_server() {
        let (port, handle) = fake_server(|_socket| {});
        let client = WsClient::connect(port, Duration::from_secs(2)).expect("握手成功");
        assert_eq!(client.handshake.status, 101);
        assert_eq!(client.handshake.accept, client.handshake.expected_accept);
        assert_eq!(client.handshake.upgrade.to_ascii_lowercase(), "websocket");
        assert!(!client.is_closed());
        drop(client);
        handle.join().expect("服务端线程");
    }

    #[test]
    fn handshake_rejects_non_101_and_bad_accept() {
        // 404 拒绝。
        let listener = TcpListener::bind("127.0.0.1:0").expect("绑定");
        let port = listener.local_addr().expect("地址").port();
        let handle = thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept");
            let mut chunk = [0u8; 1024];
            let _ = socket.read(&mut chunk);
            let _ = socket.write_all(b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n");
            let _ = socket.flush();
        });
        let error = WsClient::connect_path(port, "/nope", Duration::from_secs(1)).expect_err("404 必须拒绝");
        assert_eq!(error.code, ErrorCode::UnknownMethod);
        assert!(error.message.contains("404"), "{}", error.message);
        handle.join().expect("线程");

        // Accept 不匹配：必须当协议错误，不能放行。
        let listener = TcpListener::bind("127.0.0.1:0").expect("绑定");
        let port = listener.local_addr().expect("地址").port();
        let handle = thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept");
            let mut chunk = [0u8; 1024];
            let _ = socket.read(&mut chunk);
            let _ = socket.write_all(
                b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: wrong\r\n\r\n",
            );
            let _ = socket.flush();
        });
        let error = WsClient::connect(port, Duration::from_secs(1)).expect_err("Accept 必须校验");
        assert_eq!(error.code, ErrorCode::Rpc);
        assert!(error.message.contains("Accept"), "{}", error.message);
        handle.join().expect("线程");
    }

    #[test]
    fn read_message_reassembles_fragments_and_answers_ping() {
        let (port, handle) = fake_server(|socket| {
            let mut buffer = Vec::new();
            // 客户端在握手后会发 hello（本测试用任意文本代替），先读掉。
            let _hello = read_client_frame(socket, &mut buffer);
            // 先 ping，再发两段分片文本 "hel" + "lo, world"。
            send_server_frame(socket, &WsFrame::ping(b"beat".to_vec()));
            send_server_frame(socket, &WsFrame { fin: false, opcode: OpCode::Text, payload: b"hel".to_vec() });
            send_server_frame(socket, &WsFrame {
                fin: true,
                opcode: OpCode::Continuation,
                payload: b"lo, world".to_vec(),
            });
            // 客户端收到 ping 后要回 pong（载荷原样）。
            let pong = read_client_frame(socket, &mut buffer);
            assert_eq!(pong.opcode, OpCode::Pong);
            assert_eq!(pong.payload, b"beat".to_vec());
        });
        let mut client = WsClient::connect(port, Duration::from_secs(2)).expect("握手");
        client.send_text("{\"type\":\"hello\"}").expect("发 hello");
        assert_eq!(client.read_text().expect("分片重组"), "hello, world");
        client.close(1000, "done").expect("关闭");
        drop(client);
        handle.join().expect("线程");
    }

    #[test]
    fn close_frame_from_server_is_structured_disconnect() {
        let (port, handle) = fake_server(|socket| {
            let mut buffer = Vec::new();
            let _ = read_client_frame(socket, &mut buffer);
            send_server_frame(socket, &WsFrame::close(Some(4004), "protocol unsupported"));
        });
        let mut client = WsClient::connect(port, Duration::from_secs(2)).expect("握手");
        client.send_text("{}").expect("发送");
        let error = client.read_text().expect_err("关闭帧必须是错误");
        assert_eq!(error.code, ErrorCode::Disconnected);
        let data = error.data.expect("data");
        assert_eq!(data.get("closeCode").and_then(Json::as_u64), Some(4004));
        assert_eq!(data.get("closeReason").and_then(Json::as_str), Some("protocol unsupported"));
        assert!(client.is_closed());
        drop(client);
        handle.join().expect("线程");
    }

    #[test]
    fn hello_exchange_returns_ack_from_fake_server() {
        let (port, handle) = fake_server(|socket| {
            let mut buffer = Vec::new();
            let hello = read_client_frame(socket, &mut buffer);
            assert!(hello.payload.len() > 2, "hello 帧必须带载荷");
            // 客户端帧必须带掩码：解码后 payload 应是合法 JSON 且 type=hello。
            let text = hello.as_text().expect("UTF-8");
            let value = Json::parse(text).expect("JSON");
            assert_eq!(value.get("type").and_then(Json::as_str), Some("hello"));
            assert_eq!(value.get("protocol").and_then(Json::as_str), Some("1.9"));
            send_server_frame(
                socket,
                &WsFrame::text(
                    r#"{"type":"hello-ack","instanceId":"a1b2c3d4","daemonVersion":"0.3.0","protocol":"1.9","capabilities":["observe"],"localAuth":{"state":"unpaired","strict":false}}"#,
                ),
            );
        });
        let mut client = WsClient::connect(port, Duration::from_secs(2)).expect("握手");
        let mut hello = Hello::new("0.1.0", "bridge-rs", "0.1.0");
        hello.protocol = Some(ProtocolVersion::V1_9.label());
        let ack = client.hello_exchange(&hello).expect("hello-ack");
        assert_eq!(ack.instance_id, "a1b2c3d4");
        assert_eq!(ack.daemon_version, "0.3.0");
        assert_eq!(ack.capabilities, vec!["observe".to_string()]);
        assert!(!ack.local_auth.is_verified());
        handle.join().expect("线程");
    }

    #[test]
    fn hello_error_is_mapped_to_single_source_code() {
        let (port, handle) = fake_server(|socket| {
            let mut buffer = Vec::new();
            let _ = read_client_frame(socket, &mut buffer);
            send_server_frame(
                socket,
                &WsFrame::text(r#"{"type":"hello-error","code":"E_PAIR_REQUIRED","message":"本机严格模式要求配对"}"#),
            );
        });
        let mut client = WsClient::connect(port, Duration::from_secs(2)).expect("握手");
        let error = client.hello_exchange(&Hello::new("0.1.0", "bridge-rs", "0.1.0")).expect_err("hello-error");
        assert_eq!(error.code, ErrorCode::PairRequired);
        assert!(error.message.contains("配对"), "{}", error.message);
        assert_eq!(error.data.expect("data").get("frame").and_then(Json::as_str), Some("hello-error"));
        handle.join().expect("线程");
    }

    #[test]
    fn hello_exchange_skips_heartbeat_frames() {
        let (port, handle) = fake_server(|socket| {
            let mut buffer = Vec::new();
            let _ = read_client_frame(socket, &mut buffer);
            send_server_frame(socket, &WsFrame::text(r#"{"type":"ping"}"#));
            send_server_frame(socket, &WsFrame::text(r#"{"type":"pong"}"#));
            send_server_frame(
                socket,
                &WsFrame::text(r#"{"type":"hello-ack","instanceId":"deadbeef","daemonVersion":"0.3.0","protocol":"1.9"}"#),
            );
            // hello 阶段的 pong 必须回给服务端。
            let reply = read_client_frame(socket, &mut buffer);
            assert_eq!(reply.as_text().expect("UTF-8"), "{\"type\":\"pong\"}");
        });
        let mut client = WsClient::connect(port, Duration::from_secs(2)).expect("握手");
        let ack = client.hello_exchange(&Hello::new("0.1.0", "bridge-rs", "0.1.0")).expect("跳过心跳");
        assert_eq!(ack.instance_id, "deadbeef");
        handle.join().expect("线程");
    }

    #[test]
    fn send_after_close_is_disconnected() {
        let (port, handle) = fake_server(|_socket| {});
        let mut client = WsClient::connect(port, Duration::from_secs(2)).expect("握手");
        client.close(1000, "bye").expect("发送关闭帧");
        assert!(client.is_closed());
        let error = client.send_text("{}").expect_err("已关闭");
        assert_eq!(error.code, ErrorCode::Disconnected);
        // 重复 close 幂等。
        assert!(client.close(1000, "bye").is_ok());
        handle.join().expect("线程");
    }

    #[test]
    fn read_json_reports_bad_json() {
        let (port, handle) = fake_server(|socket| {
            let mut buffer = Vec::new();
            let _ = read_client_frame(socket, &mut buffer);
            send_server_frame(socket, &WsFrame::text("{oops"));
        });
        let mut client = WsClient::connect(port, Duration::from_secs(2)).expect("握手");
        client.send_text("{}").expect("发送");
        let error = client.read_json().expect_err("坏 JSON");
        assert_eq!(error.code, ErrorCode::BadJson);
        handle.join().expect("线程");
    }

    #[test]
    fn binary_message_is_rejected_by_read_text() {
        let (port, handle) = fake_server(|socket| {
            let mut buffer = Vec::new();
            let _ = read_client_frame(socket, &mut buffer);
            send_server_frame(socket, &WsFrame::binary(vec![1, 2, 3]));
        });
        let mut client = WsClient::connect(port, Duration::from_secs(2)).expect("握手");
        client.send_text("{}").expect("发送");
        let error = client.read_text().expect_err("二进制不是文本");
        assert_eq!(error.code, ErrorCode::Rpc);
        assert!(error.message.contains("文本帧"), "{}", error.message);
        handle.join().expect("线程");
    }

    #[test]
    fn opcode_names_and_round_trips() {
        for opcode in [OpCode::Continuation, OpCode::Text, OpCode::Binary, OpCode::Close, OpCode::Ping, OpCode::Pong] {
            assert_eq!(OpCode::from_u8(opcode.as_u8()), Some(opcode));
            assert!(!opcode.name().is_empty());
        }
        assert_eq!(OpCode::from_u8(0x3), None);
        assert_eq!(OpCode::from_u8(0xb), None);
        assert!(OpCode::Close.is_control() && OpCode::Ping.is_control() && OpCode::Pong.is_control());
        assert!(!OpCode::Text.is_control());
        // 帧类型名与 wire 层解码衔接。
        let hello_ack = obj(r#"{"type":"hello-ack","instanceId":"a1b2c3d4"}"#);
        assert!(matches!(WsMessage::decode(&hello_ack), Ok(WsMessage::HelloAck(_))));
    }
}

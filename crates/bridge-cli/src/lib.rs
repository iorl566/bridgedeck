//! BridgeDeck CLI（Rust 架构路线，M-D 第四批：TLS 策略 + 会话命令 + 只读 observe）。
//!
//! 库目标把协议/传输层暴露给 `bridge-rs` 二进制与集成测试共用：
//! - 协议层（第二批）：JSON、RPC 信封、WS 帧分发、hello 握手、8 状态会话状态机、错误码生成物；
//! - 传输层（第三批）：daemon 发现（`daemon.json`）、std-only HTTP/1.1 客户端、std-only
//!   WebSocket 客户端（握手 + 帧）、`/rpc` 客户端、`status`/`health`/`ws-hello` 的真实接线；
//! - 命令层（第四批）：`session start|stop|list`（真实 `/rpc`）、只读 `observe`、
//!   TLS 策略（`tls:true` 明确 `E_UNSUPPORTED_CAPABILITY`，不假装支持）、统一错误富化。
//!
//! 硬约束：**std-only**，`Cargo.toml` 的 `[dependencies]` 必须保持为空；不引入 serde/tokio 等
//! 任何第三方 crate。因此 SHA-1、base64、随机 key、HTTP 报文与 WS 帧全部在本 crate 内手写，
//! 并各自带 RFC 测试向量。

#![allow(dead_code)] // 部分传输层 API（分片重组、chunked 拒绝证据等）先于 CLI 接线落地，由单测消费。

pub mod base64;
pub mod cli;
pub mod command_io;
pub mod discovery;
pub mod duration;
pub mod envelope;
pub mod errors;
pub mod generated;
pub mod handshake;
pub mod http;
pub mod json;
pub mod observe_cmd;
pub mod protocol;
pub mod rpc_client;
pub mod session;
pub mod session_cmd;
pub mod sha1;
pub mod status;
pub mod tls_policy;
pub mod wire;
pub mod ws;

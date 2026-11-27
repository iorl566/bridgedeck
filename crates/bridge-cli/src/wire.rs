//! WebSocket 帧统一编解码：hello / hello-ack / hello-error / cmd / res / event / ping / pong /
//! auth-commit / commit-ack。
//!
//! 帧形状见 `docs/PROTOCOL.md` §3.1–§3.4 与 §52；`hello*` 在 [`crate::handshake`]，
//! `cmd`/`res`/`event` 在 [`crate::envelope`]。本模块只做 `type` 分发，便于 CLI/后续
//! daemon 移植共用同一入口，避免每个调用方各写一遍 match。

use crate::envelope::{EventFrame, RpcError, RpcRequest, RpcResponse};
use crate::errors::ErrorCode;
use crate::handshake::{Hello, HelloAck, HelloError};
use crate::json::Json;

pub const TYPE_HELLO: &str = "hello";
pub const TYPE_HELLO_ACK: &str = "hello-ack";
pub const TYPE_HELLO_ERROR: &str = "hello-error";
pub const TYPE_CMD: &str = "cmd";
pub const TYPE_RES: &str = "res";
pub const TYPE_EVENT: &str = "event";
pub const TYPE_PING: &str = "ping";
pub const TYPE_PONG: &str = "pong";
pub const TYPE_AUTH_COMMIT: &str = "auth-commit";
pub const TYPE_COMMIT_ACK: &str = "commit-ack";

/// 一条 WS 文本帧解码后的语义消息。
#[derive(Debug, Clone, PartialEq)]
pub enum WsMessage {
    Hello(Hello),
    HelloAck(HelloAck),
    HelloError(HelloError),
    Cmd(RpcRequest),
    Res(RpcResponse),
    Event(EventFrame),
    Ping,
    Pong,
    /// 分阶段激活的 commit 证明（扩展 → daemon）。
    AuthCommit { txn: String, proof: String },
    /// commit 确认（daemon → 扩展）。
    CommitAck { txn: String },
}

impl WsMessage {
    pub fn type_name(&self) -> &'static str {
        match self {
            WsMessage::Hello(_) => TYPE_HELLO,
            WsMessage::HelloAck(_) => TYPE_HELLO_ACK,
            WsMessage::HelloError(_) => TYPE_HELLO_ERROR,
            WsMessage::Cmd(_) => TYPE_CMD,
            WsMessage::Res(_) => TYPE_RES,
            WsMessage::Event(_) => TYPE_EVENT,
            WsMessage::Ping => TYPE_PING,
            WsMessage::Pong => TYPE_PONG,
            WsMessage::AuthCommit { .. } => TYPE_AUTH_COMMIT,
            WsMessage::CommitAck { .. } => TYPE_COMMIT_ACK,
        }
    }

    /// 解码一帧 JSON；未知类型/缺 type 报 `E_BAD_REQUEST`。
    pub fn decode(value: &Json) -> Result<Self, RpcError> {
        let kind = value
            .get("type")
            .and_then(Json::as_str)
            .ok_or_else(|| RpcError::bad_request("WS 帧缺少字符串 type"))?;
        match kind {
            TYPE_HELLO => Hello::from_json(value).map(WsMessage::Hello),
            TYPE_HELLO_ACK => HelloAck::from_json(value).map(WsMessage::HelloAck),
            TYPE_HELLO_ERROR => HelloError::from_json(value).map(WsMessage::HelloError),
            TYPE_CMD => RpcRequest::from_ws_cmd_json(value).map(WsMessage::Cmd),
            TYPE_RES => RpcResponse::from_ws_res_json(value).map(WsMessage::Res),
            TYPE_EVENT => EventFrame::from_json(value).map(WsMessage::Event),
            TYPE_PING => Ok(WsMessage::Ping),
            TYPE_PONG => Ok(WsMessage::Pong),
            TYPE_AUTH_COMMIT => Ok(WsMessage::AuthCommit {
                txn: required_string(value, "txn")?,
                proof: required_string(value, "proof")?,
            }),
            TYPE_COMMIT_ACK => Ok(WsMessage::CommitAck { txn: required_string(value, "txn")? }),
            other => Err(RpcError::new(ErrorCode::BadRequest, format!("未知 WS 帧类型：{other}"))),
        }
    }

    /// 文本帧入口（解析失败 → `E_BAD_JSON`）。
    pub fn decode_text(text: &str) -> Result<Self, RpcError> {
        let value = Json::parse(text).map_err(|error| RpcError::bad_json(&error))?;
        Self::decode(&value)
    }

    /// 编码回 JSON；`cmd`/`res` 缺 id 时返回 `E_BAD_REQUEST`。
    pub fn encode(&self) -> Result<Json, RpcError> {
        match self {
            WsMessage::Hello(hello) => Ok(hello.to_json()),
            WsMessage::HelloAck(ack) => Ok(ack.to_json()),
            WsMessage::HelloError(error) => Ok(error.to_json()),
            WsMessage::Cmd(request) => request.to_ws_cmd_json(),
            WsMessage::Res(response) => response.to_ws_res_json(),
            WsMessage::Event(event) => Ok(event.to_json()),
            WsMessage::Ping => Ok(crate::json_obj! { "type" => Json::string(TYPE_PING) }),
            WsMessage::Pong => Ok(crate::json_obj! { "type" => Json::string(TYPE_PONG) }),
            WsMessage::AuthCommit { txn, proof } => Ok(crate::json_obj! {
                "type" => Json::string(TYPE_AUTH_COMMIT),
                "txn" => Json::string(txn.clone()),
                "proof" => Json::string(proof.clone()),
            }),
            WsMessage::CommitAck { txn } => Ok(crate::json_obj! {
                "type" => Json::string(TYPE_COMMIT_ACK),
                "txn" => Json::string(txn.clone()),
            }),
        }
    }
}

fn required_string(value: &Json, key: &str) -> Result<String, RpcError> {
    value
        .get(key)
        .and_then(Json::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .ok_or_else(|| RpcError::bad_request(format!("WS 帧缺少字符串 {key}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_ok(text: &str) -> WsMessage {
        WsMessage::decode_text(text).unwrap_or_else(|error| panic!("应解码成功：{error}（{text}）"))
    }

    #[test]
    fn decodes_documented_hello_frames() {
        let hello = decode_ok(
            "{\"type\":\"hello\",\"extVersion\":\"0.2.0\",\"browser\":\"edge\",\
             \"browserVersion\":\"156.0.4314.58\",\"userAgent\":\"Mozilla/5.0\"}",
        );
        assert_eq!(hello.type_name(), "hello");
        match hello {
            WsMessage::Hello(hello) => {
                assert_eq!(hello.browser, "edge");
                assert_eq!(hello.ext_version, "0.2.0");
            }
            other => panic!("应解出 hello：{other:?}"),
        }
        let ack = decode_ok("{\"type\":\"hello-ack\",\"instanceId\":\"a1b2c3d4\",\"daemonVersion\":\"0.2.0\"}");
        match ack {
            WsMessage::HelloAck(ack) => {
                assert_eq!(ack.instance_id, "a1b2c3d4");
                assert_eq!(ack.protocol, "1.9");
            }
            other => panic!("应解出 hello-ack：{other:?}"),
        }
        let error = decode_ok("{\"type\":\"hello-error\",\"code\":\"E_PAIR_REQUIRED\",\"message\":\"需要配对\"}");
        match error {
            WsMessage::HelloError(error) => {
                assert_eq!(error.code, ErrorCode::PairRequired);
                assert_eq!(error.message, "需要配对");
            }
            other => panic!("应解出 hello-error：{other:?}"),
        }
    }

    #[test]
    fn decodes_documented_cmd_res_event_frames() {
        let cmd = decode_ok("{\"type\":\"cmd\",\"id\":\"<uuid>\",\"method\":\"navigate\",\"params\":{\"tabId\":123,\"url\":\"https://example.com\"}}");
        match cmd {
            WsMessage::Cmd(request) => {
                assert_eq!(request.id.as_deref(), Some("<uuid>"));
                assert_eq!(request.method, "navigate");
                assert_eq!(request.params.get("tabId").and_then(Json::as_u64), Some(123));
            }
            other => panic!("应解出 cmd：{other:?}"),
        }
        let ok = decode_ok("{\"type\":\"res\",\"id\":\"<uuid>\",\"ok\":true,\"result\":{\"x\":1}}");
        match ok {
            WsMessage::Res(response) => {
                assert!(response.is_ok());
                assert_eq!(response.into_result().expect("成功"), crate::json::Json::parse("{\"x\":1}").expect("json"));
            }
            other => panic!("应解出 res：{other:?}"),
        }
        let failure = decode_ok("{\"type\":\"res\",\"id\":\"id-2\",\"ok\":false,\"error\":{\"code\":\"E_STALE_REF\",\"message\":\"失效\"}}");
        match failure {
            WsMessage::Res(response) => {
                let error = response.into_result().expect_err("失败");
                assert_eq!(error.code, ErrorCode::StaleRef);
            }
            other => panic!("应解出失败 res：{other:?}"),
        }
        let event = decode_ok("{\"type\":\"event\",\"event\":\"tab-removed\",\"params\":{\"tabId\":123}}");
        match event {
            WsMessage::Event(event) => {
                assert_eq!(event.event, "tab-removed");
                assert_eq!(event.params.get("tabId").and_then(Json::as_u64), Some(123));
            }
            other => panic!("应解出 event：{other:?}"),
        }
    }

    #[test]
    fn decodes_heartbeat_and_commit_frames() {
        assert_eq!(decode_ok("{\"type\":\"ping\"}"), WsMessage::Ping);
        assert_eq!(decode_ok("{\"type\":\"pong\"}"), WsMessage::Pong);
        assert_eq!(
            decode_ok("{\"type\":\"auth-commit\",\"txn\":\"t1\",\"proof\":\"p1\"}"),
            WsMessage::AuthCommit { txn: "t1".to_string(), proof: "p1".to_string() }
        );
        assert_eq!(
            decode_ok("{\"type\":\"commit-ack\",\"txn\":\"t1\"}"),
            WsMessage::CommitAck { txn: "t1".to_string() }
        );
        assert_eq!(
            WsMessage::decode_text("{\"type\":\"auth-commit\",\"txn\":\"t1\"}").expect_err("缺 proof").code,
            ErrorCode::BadRequest
        );
        assert_eq!(
            WsMessage::decode_text("{\"type\":\"commit-ack\"}").expect_err("缺 txn").code,
            ErrorCode::BadRequest
        );
    }

    #[test]
    fn decode_rejects_unknown_or_missing_type() {
        fn bad(text: &str) -> RpcError {
            WsMessage::decode_text(text).expect_err("必须拒绝")
        }
        assert_eq!(bad("{\"type\":\"future-frame\"}").code, ErrorCode::BadRequest);
        assert_eq!(bad("{}").code, ErrorCode::BadRequest);
        assert_eq!(bad("[]").code, ErrorCode::BadRequest);
        assert_eq!(bad("{oops").code, ErrorCode::BadJson);
    }

    #[test]
    fn every_variant_round_trips_through_text() {
        let messages = vec![
            decode_ok("{\"type\":\"hello\",\"extVersion\":\"0.3.0\",\"browser\":\"edge\",\"protocol\":\"1.9\",\"capabilities\":[\"observe\"]}"),
            decode_ok("{\"type\":\"hello-ack\",\"instanceId\":\"a1b2c3d4\",\"daemonVersion\":\"0.3.0\",\"protocol\":\"1.9\"}"),
            decode_ok("{\"type\":\"hello-error\",\"code\":\"E_TIMEOUT\",\"message\":\"hello 超时\"}"),
            decode_ok("{\"type\":\"cmd\",\"id\":\"id-1\",\"method\":\"observe\",\"params\":{\"tabId\":1}}"),
            decode_ok("{\"type\":\"res\",\"id\":\"id-1\",\"ok\":true,\"result\":{\"refs\":[]}}"),
            decode_ok("{\"type\":\"event\",\"event\":\"tab-removed\",\"params\":{\"tabId\":1}}"),
            WsMessage::Ping,
            WsMessage::Pong,
            WsMessage::AuthCommit { txn: "t".to_string(), proof: "p".to_string() },
            WsMessage::CommitAck { txn: "t".to_string() },
        ];
        for message in messages {
            let json = message.encode().expect("编码");
            let text = json.to_compact_string();
            let decoded = WsMessage::decode_text(&text).expect("回解码");
            assert_eq!(decoded, message, "round trip 不一致：{text}");
            assert_eq!(decoded.type_name(), message.type_name());
        }
    }

    #[test]
    fn encode_requires_ids_for_cmd_and_res() {
        use crate::envelope::{RpcRequest, RpcResponse};
        let request = RpcRequest::new("status", Json::Object(Vec::new()));
        assert_eq!(WsMessage::Cmd(request).encode().expect_err("缺 id").code, ErrorCode::BadRequest);
        let response = RpcResponse::success(Json::Null);
        assert_eq!(WsMessage::Res(response).encode().expect_err("缺 id").code, ErrorCode::BadRequest);
    }

    #[test]
    fn type_names_cover_all_variants() {
        assert_eq!(TYPE_HELLO, "hello");
        assert_eq!(TYPE_HELLO_ACK, "hello-ack");
        assert_eq!(TYPE_HELLO_ERROR, "hello-error");
        assert_eq!(TYPE_CMD, "cmd");
        assert_eq!(TYPE_RES, "res");
        assert_eq!(TYPE_EVENT, "event");
        assert_eq!(TYPE_PING, "ping");
        assert_eq!(TYPE_PONG, "pong");
        assert_eq!(TYPE_AUTH_COMMIT, "auth-commit");
        assert_eq!(TYPE_COMMIT_ACK, "commit-ack");
    }
}

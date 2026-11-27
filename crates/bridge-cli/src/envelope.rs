//! RPC 信封编解码（HTTP `/rpc` 请求/响应、WS `cmd`/`res`/`event`）。
//!
//! 形状只读对齐 `daemon/rpc.js` 与 `docs/PROTOCOL.md` §2/§3：
//! - HTTP 请求：`{ "method": "...", "params": { ... }, "timeoutMs": 60000 }`；
//! - HTTP 响应：`{ "ok": true, "result": ... }` / `{ "ok": false, "error": { code, message, data? } }`；
//! - WS 命令：`{ "type": "cmd", "id": "<uuid>", "method": ..., "params": ... }`；
//! - WS 响应：`{ "type": "res", "id": "<uuid>", "ok": true, "result": ... }`（失败同理带 `error`）；
//! - WS 事件：`{ "type": "event", "event": "...", "params": { ... } }`。
//!
//! daemon 侧细节（只读参考）：
//! - `http` 状态码恒 200，只有鉴权失败 401、方法不存在 404（[`http_status_for`]）；
//! - 请求 `params` 不是对象时按 `{}` 处理（`daemon/rpc.js`）；
//! - 业务错误码未知时统一归一为 `E_INTERNAL`（`lib/error-codes.mjs normalizeErrorCode`）。

use crate::errors::ErrorCode;
use crate::json::{Json, JsonError};

/// daemon 默认 RPC 超时（`daemon/rpc.js` DEFAULT_TIMEOUT_MS）。
pub const DEFAULT_TIMEOUT_MS: u64 = 60_000;
/// WS 命令帧类型。
pub const WS_TYPE_CMD: &str = "cmd";
/// WS 响应帧类型。
pub const WS_TYPE_RES: &str = "res";
/// WS 事件帧类型。
pub const WS_TYPE_EVENT: &str = "event";

/// 协议错误对象；`data` 可选（daemon 在 `err.data !== undefined` 时透传）。
#[derive(Debug, Clone, PartialEq)]
pub struct RpcError {
    pub code: ErrorCode,
    pub message: String,
    pub data: Option<Json>,
    /// 对端发来但本端不认识的原始码（诊断用；归一后 `code` 是 `E_INTERNAL`）。
    pub original_code: Option<String>,
}

impl RpcError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), data: None, original_code: None }
    }

    pub fn with_data(mut self, data: Json) -> Self {
        self.data = Some(data);
        self
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::BadRequest, message)
    }

    pub fn bad_json(error: &JsonError) -> Self {
        Self::new(ErrorCode::BadJson, error.to_string())
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }

    /// 从字符串码构造；未知码归一为 `E_INTERNAL` 并保留 `originalCode`。
    pub fn from_code_text(code: &str, message: impl Into<String>) -> Self {
        match ErrorCode::from_code(code) {
            Some(known) => Self::new(known, message),
            None => Self {
                code: ErrorCode::Internal,
                message: message.into(),
                data: None,
                original_code: Some(code.to_string()),
            },
        }
    }

    /// 序列化错误对象（`/rpc` 响应与 WS `res` 共用）。
    pub fn to_json(&self) -> Json {
        let mut entries = vec![
            ("code".to_string(), Json::string(self.code.as_str())),
            ("message".to_string(), Json::string(self.message.clone())),
        ];
        if let Some(data) = &self.data {
            entries.push(("data".to_string(), data.clone()));
        }
        if let Some(original) = &self.original_code {
            entries.push(("originalCode".to_string(), Json::string(original.clone())));
        }
        Json::Object(entries)
    }

    /// 反序列化错误对象；`code` 缺失/非字符串视为 `E_BAD_REQUEST`。
    pub fn from_json(value: &Json) -> Result<Self, RpcError> {
        let Some(entries) = value.as_object() else {
            return Err(Self::bad_request("error 必须是对象"));
        };
        let code = entries
            .iter()
            .find(|(key, _)| key == "code")
            .and_then(|(_, value)| value.as_str())
            .ok_or_else(|| Self::bad_request("error 缺少字符串 code"))?;
        let message = entries
            .iter()
            .find(|(key, _)| key == "message")
            .and_then(|(_, value)| value.as_str())
            .unwrap_or("")
            .to_string();
        let data = entries.iter().find(|(key, _)| key == "data").map(|(_, value)| value.clone());
        let original = entries
            .iter()
            .find(|(key, _)| key == "originalCode")
            .and_then(|(_, value)| value.as_str())
            .map(str::to_string);
        Ok(Self { code: crate::errors::resolve(code), message, data, original_code: original })
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for RpcError {}

/// 请求公共信封：方法 + 参数 + 可选超时；`id` 只在 WS `cmd`/未来关联 ID 场景出现。
#[derive(Debug, Clone, PartialEq)]
pub struct RpcRequest {
    pub id: Option<String>,
    pub method: String,
    pub params: Json,
    pub timeout_ms: Option<u64>,
}

impl RpcRequest {
    pub fn new(method: impl Into<String>, params: Json) -> Self {
        Self { id: None, method: method.into(), params, timeout_ms: None }
    }

    pub fn with_id(mut self, id: impl Into<String>) -> Self {
        self.id = Some(id.into());
        self
    }

    pub fn with_timeout_ms(mut self, timeout_ms: u64) -> Self {
        self.timeout_ms = Some(timeout_ms);
        self
    }

    /// daemon 实际使用的超时（缺省 60s，与 `daemon/rpc.js` 一致）。
    pub fn effective_timeout_ms(&self) -> u64 {
        self.timeout_ms.filter(|value| *value > 0).unwrap_or(DEFAULT_TIMEOUT_MS)
    }

    /// 信封作用域（`session` / `sessionId` / `tabId`，也接受 snake_case 别名）。
    pub fn scope(&self) -> EnvelopeScope {
        EnvelopeScope::from_params(&self.params)
    }

    pub fn to_http_json(&self) -> Json {
        let mut entries = vec![
            ("method".to_string(), Json::string(self.method.clone())),
            ("params".to_string(), self.params.clone()),
        ];
        if let Some(timeout_ms) = self.timeout_ms {
            entries.push(("timeoutMs".to_string(), Json::Number(timeout_ms as f64)));
        }
        if let Some(id) = &self.id {
            entries.push(("id".to_string(), Json::string(id.clone())));
        }
        Json::Object(entries)
    }

    pub fn to_ws_cmd_json(&self) -> Result<Json, RpcError> {
        let Some(id) = &self.id else {
            return Err(RpcError::bad_request("WS cmd 必须带 id"));
        };
        Ok(crate::json_obj! {
            "type" => Json::string(WS_TYPE_CMD),
            "id" => Json::string(id.clone()),
            "method" => Json::string(self.method.clone()),
            "params" => self.params.clone(),
        })
    }

    pub fn from_json(value: &Json) -> Result<Self, RpcError> {
        let Some(entries) = value.as_object() else {
            return Err(RpcError::bad_request("请求必须是 JSON 对象"));
        };
        let method = entries
            .iter()
            .find(|(key, _)| key == "method")
            .and_then(|(_, value)| value.as_str())
            .filter(|method| !method.is_empty())
            .ok_or_else(|| RpcError::bad_request("请求缺少字符串 method"))?
            .to_string();
        // 与 daemon 一致：params 不是对象/数组时按空对象处理。
        let params = match entries.iter().find(|(key, _)| key == "params").map(|(_, value)| value) {
            Some(Json::Object(_)) | Some(Json::Array(_)) => {
                entries.iter().find(|(key, _)| key == "params").expect("已确认存在").1.clone()
            }
            _ => Json::Object(Vec::new()),
        };
        let timeout_ms = entries
            .iter()
            .find(|(key, _)| key == "timeoutMs")
            .and_then(|(_, value)| value.as_u64());
        let id = entries
            .iter()
            .find(|(key, _)| key == "id")
            .and_then(|(_, value)| value.as_str())
            .filter(|id| !id.is_empty())
            .map(str::to_string);
        Ok(Self { id, method, params, timeout_ms })
    }

    pub fn from_ws_cmd_json(value: &Json) -> Result<Self, RpcError> {
        require_type(value, WS_TYPE_CMD)?;
        let request = Self::from_json(value)?;
        if request.id.is_none() {
            return Err(RpcError::bad_request("WS cmd 必须带字符串 id"));
        }
        Ok(request)
    }

    /// 文本入口（HTTP 请求体 / WS 文本帧）。
    pub fn from_text(text: &str) -> Result<Self, RpcError> {
        let value = Json::parse(text).map_err(|error| RpcError::bad_json(&error))?;
        Self::from_json(&value)
    }
}

/// 响应公共信封：`ok` + `result` 或 `error`（互斥）。
#[derive(Debug, Clone, PartialEq)]
pub struct RpcResponse {
    pub id: Option<String>,
    pub ok: bool,
    pub result: Option<Json>,
    pub error: Option<RpcError>,
}

impl RpcResponse {
    pub fn success(result: Json) -> Self {
        Self { id: None, ok: true, result: Some(result), error: None }
    }

    pub fn failure(error: RpcError) -> Self {
        Self { id: None, ok: false, result: None, error: Some(error) }
    }

    pub fn with_id(mut self, id: impl Into<String>) -> Self {
        self.id = Some(id.into());
        self
    }

    pub fn is_ok(&self) -> bool {
        self.ok
    }

    /// 成功取 result，失败转成 `Err`；不变量被破坏时补一个 `E_INTERNAL`。
    pub fn into_result(self) -> Result<Json, RpcError> {
        if self.ok {
            Ok(self.result.unwrap_or(Json::Null))
        } else {
            Err(self.error.unwrap_or_else(|| RpcError::internal("失败响应缺少 error")))
        }
    }

    fn error_or_internal(&self) -> RpcError {
        self.error.clone().unwrap_or_else(|| RpcError::internal("失败响应缺少 error"))
    }

    pub fn to_http_json(&self) -> Json {
        if self.ok {
            crate::json_obj! {
                "ok" => Json::Bool(true),
                "result" => self.result.clone().unwrap_or(Json::Null),
            }
        } else {
            crate::json_obj! {
                "ok" => Json::Bool(false),
                "error" => self.error_or_internal().to_json(),
            }
        }
    }

    pub fn to_ws_res_json(&self) -> Result<Json, RpcError> {
        let Some(id) = &self.id else {
            return Err(RpcError::bad_request("WS res 必须带 id"));
        };
        if self.ok {
            Ok(crate::json_obj! {
                "type" => Json::string(WS_TYPE_RES),
                "id" => Json::string(id.clone()),
                "ok" => Json::Bool(true),
                "result" => self.result.clone().unwrap_or(Json::Null),
            })
        } else {
            Ok(crate::json_obj! {
                "type" => Json::string(WS_TYPE_RES),
                "id" => Json::string(id.clone()),
                "ok" => Json::Bool(false),
                "error" => self.error_or_internal().to_json(),
            })
        }
    }

    pub fn from_json(value: &Json) -> Result<Self, RpcError> {
        let Some(entries) = value.as_object() else {
            return Err(RpcError::bad_request("响应必须是 JSON 对象"));
        };
        let ok = entries
            .iter()
            .find(|(key, _)| key == "ok")
            .and_then(|(_, value)| value.as_bool())
            .ok_or_else(|| RpcError::bad_request("响应缺少布尔 ok"))?;
        let result = entries.iter().find(|(key, _)| key == "result").map(|(_, value)| value.clone());
        let error = match entries.iter().find(|(key, _)| key == "error").map(|(_, value)| value) {
            Some(error) => Some(RpcError::from_json(error)?),
            None => None,
        };
        if ok && error.is_some() {
            return Err(RpcError::bad_request("成功响应不应带 error"));
        }
        if !ok && error.is_none() {
            return Err(RpcError::bad_request("失败响应缺少 error"));
        }
        let id = entries
            .iter()
            .find(|(key, _)| key == "id")
            .and_then(|(_, value)| value.as_str())
            .filter(|id| !id.is_empty())
            .map(str::to_string);
        Ok(Self { id, ok, result, error })
    }

    pub fn from_ws_res_json(value: &Json) -> Result<Self, RpcError> {
        require_type(value, WS_TYPE_RES)?;
        let response = Self::from_json(value)?;
        if response.id.is_none() {
            return Err(RpcError::bad_request("WS res 必须带字符串 id"));
        }
        Ok(response)
    }

    pub fn from_text(text: &str) -> Result<Self, RpcError> {
        let value = Json::parse(text).map_err(|error| RpcError::bad_json(&error))?;
        Self::from_json(&value)
    }
}

/// 扩展 → daemon 事件帧。
#[derive(Debug, Clone, PartialEq)]
pub struct EventFrame {
    pub event: String,
    pub params: Json,
}

impl EventFrame {
    pub fn new(event: impl Into<String>, params: Json) -> Self {
        Self { event: event.into(), params }
    }

    pub fn to_json(&self) -> Json {
        crate::json_obj! {
            "type" => Json::string(WS_TYPE_EVENT),
            "event" => Json::string(self.event.clone()),
            "params" => self.params.clone(),
        }
    }

    pub fn from_json(value: &Json) -> Result<Self, RpcError> {
        require_type(value, WS_TYPE_EVENT)?;
        let event = value
            .get("event")
            .and_then(Json::as_str)
            .filter(|event| !event.is_empty())
            .ok_or_else(|| RpcError::bad_request("event 帧缺少字符串 event"))?
            .to_string();
        let params = value.get("params").cloned().unwrap_or(Json::Object(Vec::new()));
        Ok(Self { event, params })
    }
}

/// 方法请求的公共信封字段（catalog `REQUEST_ENVELOPE_KEYS`），daemon 注入/CLI 透传。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EnvelopeScope {
    pub session: Option<String>,
    pub session_id: Option<String>,
    pub tab_id: Option<u64>,
}

impl EnvelopeScope {
    pub fn from_params(params: &Json) -> Self {
        Self {
            session: read_string(params, "session"),
            session_id: read_string(params, "sessionId").or_else(|| read_string(params, "session_id")),
            tab_id: params
                .get("tabId")
                .and_then(Json::as_u64)
                .or_else(|| params.get("tab_id").and_then(Json::as_u64)),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.session.is_none() && self.session_id.is_none() && self.tab_id.is_none()
    }

    /// 规范键名写回 params（`session` / `sessionId` / `tabId`）。
    pub fn merge_into(&self, params: &mut Json) -> bool {
        if !matches!(params, Json::Object(_)) {
            return false;
        }
        if let Some(session) = &self.session {
            params.insert("session", Json::string(session.clone()));
        }
        if let Some(session_id) = &self.session_id {
            params.insert("sessionId", Json::string(session_id.clone()));
        }
        if let Some(tab_id) = self.tab_id {
            params.insert("tabId", Json::Number(tab_id as f64));
        }
        true
    }

    pub fn to_json(&self) -> Json {
        let mut entries = Vec::new();
        if let Some(session) = &self.session {
            entries.push(("session".to_string(), Json::string(session.clone())));
        }
        if let Some(session_id) = &self.session_id {
            entries.push(("sessionId".to_string(), Json::string(session_id.clone())));
        }
        if let Some(tab_id) = self.tab_id {
            entries.push(("tabId".to_string(), Json::Number(tab_id as f64)));
        }
        Json::Object(entries)
    }
}

/// daemon HTTP 状态码约定：业务失败仍 200，鉴权 401，未知方法 404。
pub fn http_status_for(error: &RpcError) -> u16 {
    match error.code {
        ErrorCode::Auth => 401,
        ErrorCode::UnknownMethod => 404,
        _ => 200,
    }
}

fn read_string(params: &Json, key: &str) -> Option<String> {
    params.get(key).and_then(Json::as_str).filter(|value| !value.is_empty()).map(str::to_string)
}

fn require_type(value: &Json, expected: &str) -> Result<(), RpcError> {
    let actual = value.get("type").and_then(Json::as_str);
    match actual {
        Some(actual) if actual == expected => Ok(()),
        Some(actual) => Err(RpcError::bad_request(format!("WS 帧类型应为 {expected}，实际 {actual}"))),
        None => Err(RpcError::bad_request("WS 帧缺少字符串 type")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(text: &str) -> Json {
        Json::parse(text).expect("测试夹具必须是合法 JSON")
    }

    #[test]
    fn http_request_round_trips() {
        let request = RpcRequest::new("observe", obj("{\"tabId\":7}")).with_timeout_ms(1500);
        let json = request.to_http_json();
        assert_eq!(
            json.to_compact_string(),
            "{\"method\":\"observe\",\"params\":{\"tabId\":7},\"timeoutMs\":1500}"
        );
        assert_eq!(RpcRequest::from_json(&json), Ok(request));
    }

    #[test]
    fn http_request_text_entry_maps_bad_json() {
        let error = RpcRequest::from_text("{oops").expect_err("坏 JSON 必须报错");
        assert_eq!(error.code, ErrorCode::BadJson);
        let request = RpcRequest::from_text("{\"method\":\"status\"}").expect("合法请求");
        assert_eq!(request.method, "status");
        assert_eq!(request.params, Json::Object(Vec::new()));
        assert_eq!(request.effective_timeout_ms(), DEFAULT_TIMEOUT_MS);
    }

    #[test]
    fn request_defaults_match_daemon_normalization() {
        let request = RpcRequest::from_json(&obj("{\"method\":\"status\",\"params\":\"nope\"}"))
            .expect("params 非对象按空对象处理");
        assert_eq!(request.params, Json::Object(Vec::new()));
        let request = RpcRequest::from_json(&obj("{\"method\":\"status\",\"timeoutMs\":0}"))
            .expect("timeoutMs=0 合法");
        assert_eq!(request.timeout_ms, Some(0));
        assert_eq!(request.effective_timeout_ms(), DEFAULT_TIMEOUT_MS);
        let request = RpcRequest::from_json(&obj("{\"method\":\"status\",\"timeoutMs\":-5}"))
            .expect("负数忽略");
        assert_eq!(request.timeout_ms, None);
    }

    #[test]
    fn request_rejects_missing_or_blank_method() {
        for text in ["{}", "{\"method\":\"\"}", "{\"method\":7}", "[]"] {
            let error = RpcRequest::from_json(&obj(text)).expect_err("必须拒绝");
            assert_eq!(error.code, ErrorCode::BadRequest, "夹具：{text}");
        }
    }

    #[test]
    fn ws_cmd_requires_id_and_type() {
        let request = RpcRequest::new("navigate", obj("{\"tabId\":1,\"url\":\"https://x\"}")).with_id("abc");
        let json = request.to_ws_cmd_json().expect("带 id");
        assert_eq!(
            json.to_compact_string(),
            "{\"type\":\"cmd\",\"id\":\"abc\",\"method\":\"navigate\",\"params\":{\"tabId\":1,\"url\":\"https://x\"}}"
        );
        assert_eq!(RpcRequest::from_ws_cmd_json(&json), Ok(request));
        assert_eq!(
            RpcRequest::new("status", Json::Object(Vec::new())).to_ws_cmd_json().expect_err("缺 id").code,
            ErrorCode::BadRequest
        );
        assert_eq!(
            RpcRequest::from_ws_cmd_json(&obj("{\"type\":\"res\",\"id\":\"a\",\"method\":\"x\"}"))
                .expect_err("类型不符")
                .code,
            ErrorCode::BadRequest
        );
    }

    #[test]
    fn error_round_trips_with_data() {
        let error = RpcError::new(ErrorCode::StaleRef, "ref 失效").with_data(obj("{\"ref\":\"@e1\"}"));
        let json = error.to_json();
        assert_eq!(
            json.to_compact_string(),
            "{\"code\":\"E_STALE_REF\",\"message\":\"ref 失效\",\"data\":{\"ref\":\"@e1\"}}"
        );
        assert_eq!(RpcError::from_json(&json), Ok(error));
    }

    #[test]
    fn unknown_error_code_normalizes_with_original() {
        let error = RpcError::from_code_text("E_MADE_UP", "对端新码");
        assert_eq!(error.code, ErrorCode::Internal);
        assert_eq!(error.original_code.as_deref(), Some("E_MADE_UP"));
        let json = error.to_json();
        assert_eq!(json.get("code").and_then(Json::as_str), Some("E_INTERNAL"));
        assert_eq!(json.get("originalCode").and_then(Json::as_str), Some("E_MADE_UP"));
        let decoded = RpcError::from_json(&json).expect("可回解析");
        assert_eq!(decoded.code, ErrorCode::Internal);
        assert_eq!(decoded.original_code.as_deref(), Some("E_MADE_UP"));
    }

    #[test]
    fn malformed_error_objects_are_bad_requests() {
        for text in ["[]", "{}", "{\"code\":7}"] {
            assert_eq!(RpcError::from_json(&obj(text)).expect_err("必须拒绝").code, ErrorCode::BadRequest);
        }
    }

    #[test]
    fn success_and_failure_http_responses_round_trip() {
        let ok = RpcResponse::success(obj("{\"sessions\":[]}"));
        assert_eq!(ok.to_http_json().to_compact_string(), "{\"ok\":true,\"result\":{\"sessions\":[]}}");
        assert_eq!(RpcResponse::from_json(&ok.to_http_json()), Ok(ok.clone()));
        assert!(ok.into_result().is_ok());

        let failure = RpcResponse::failure(RpcError::new(ErrorCode::NoSession, "没有活动会话"));
        let json = failure.to_http_json();
        assert_eq!(
            json.to_compact_string(),
            "{\"ok\":false,\"error\":{\"code\":\"E_NO_SESSION\",\"message\":\"没有活动会话\"}}"
        );
        assert_eq!(RpcResponse::from_json(&json), Ok(failure.clone()));
        assert_eq!(failure.into_result().expect_err("失败").code, ErrorCode::NoSession);
    }

    #[test]
    fn response_invariants_are_enforced() {
        let text = "{\"ok\":true,\"error\":{\"code\":\"E_INTERNAL\",\"message\":\"x\"}}";
        assert_eq!(RpcResponse::from_json(&obj(text)).expect_err("成功带 error").code, ErrorCode::BadRequest);
        let text = "{\"ok\":false}";
        assert_eq!(RpcResponse::from_json(&obj(text)).expect_err("失败缺 error").code, ErrorCode::BadRequest);
        let text = "{\"result\":1}";
        assert_eq!(RpcResponse::from_json(&obj(text)).expect_err("缺 ok").code, ErrorCode::BadRequest);
        let text = "{\"ok\":true,\"result\":null}";
        assert_eq!(RpcResponse::from_json(&obj(text)).expect("成功 null").result, Some(Json::Null));
    }

    #[test]
    fn ws_res_requires_id_and_type() {
        let response = RpcResponse::success(obj("{\"ok\":true}")).with_id("id-1");
        let json = response.to_ws_res_json().expect("带 id");
        assert_eq!(
            json.to_compact_string(),
            "{\"type\":\"res\",\"id\":\"id-1\",\"ok\":true,\"result\":{\"ok\":true}}"
        );
        assert_eq!(RpcResponse::from_ws_res_json(&json), Ok(response));
        assert_eq!(
            RpcResponse::success(Json::Null).to_ws_res_json().expect_err("缺 id").code,
            ErrorCode::BadRequest
        );
        let failure = RpcResponse::failure(RpcError::new(ErrorCode::Timeout, "超时")).with_id("id-2");
        let json = failure.to_ws_res_json().expect("带 id");
        assert!(json.to_compact_string().contains("\"type\":\"res\",\"id\":\"id-2\",\"ok\":false"));
        assert_eq!(RpcResponse::from_ws_res_json(&json), Ok(failure));
    }

    #[test]
    fn event_frame_round_trips() {
        let event = EventFrame::new("tab-removed", obj("{\"tabId\":123}"));
        let json = event.to_json();
        assert_eq!(
            json.to_compact_string(),
            "{\"type\":\"event\",\"event\":\"tab-removed\",\"params\":{\"tabId\":123}}"
        );
        assert_eq!(EventFrame::from_json(&json), Ok(event));
        assert_eq!(
            EventFrame::from_json(&obj("{\"type\":\"event\"}")).expect_err("缺 event").code,
            ErrorCode::BadRequest
        );
    }

    #[test]
    fn envelope_scope_reads_and_merges() {
        let params = obj("{\"session\":\"s1\",\"session_id\":\"s2\",\"tab_id\":9}");
        let scope = EnvelopeScope::from_params(&params);
        assert_eq!(scope.session.as_deref(), Some("s1"));
        assert_eq!(scope.session_id.as_deref(), Some("s2"));
        assert_eq!(scope.tab_id, Some(9));
        assert!(!scope.is_empty());
        let mut target = obj("{\"url\":\"https://x\"}");
        assert!(scope.merge_into(&mut target));
        assert_eq!(target.get("sessionId").and_then(Json::as_str), Some("s2"));
        assert_eq!(target.get("tabId").and_then(Json::as_u64), Some(9));
        assert_eq!(scope.to_json().to_compact_string(), "{\"session\":\"s1\",\"sessionId\":\"s2\",\"tabId\":9}");
        assert!(EnvelopeScope::from_params(&obj("{}")).is_empty());
    }

    #[test]
    fn http_status_matches_daemon_contract() {
        assert_eq!(http_status_for(&RpcError::new(ErrorCode::Auth, "x")), 401);
        assert_eq!(http_status_for(&RpcError::new(ErrorCode::UnknownMethod, "x")), 404);
        assert_eq!(http_status_for(&RpcError::new(ErrorCode::NoSession, "x")), 200);
        assert_eq!(http_status_for(&RpcError::new(ErrorCode::Timeout, "x")), 200);
    }

    #[test]
    fn error_display_is_code_prefixed() {
        let error = RpcError::new(ErrorCode::Timeout, "等待超时");
        assert_eq!(error.to_string(), "E_TIMEOUT: 等待超时");
        let as_std: &dyn std::error::Error = &error;
        assert!(as_std.to_string().contains("E_TIMEOUT"));
    }
}

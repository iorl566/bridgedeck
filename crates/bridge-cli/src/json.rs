//! 最小 JSON 编解码（std-only，不引入 serde）。
//!
//! 用途：RPC 请求/响应信封、hello/hello-ack、`protocol`/`status` 的 `--json` 输出共用
//! 同一套实现，保证 Rust 侧只依赖标准库。
//!
//! 与 JS `JSON.parse` / `JSON.stringify` 的对齐点：
//! - 对象保留键的插入顺序（`JSON.stringify` 按插入顺序输出）；
//! - 重复键按后者覆盖（最后一次出现的值胜出）；
//! - 数字输出不强制带 `.0`（`1.0` → `1`，`-0` → `0`）；
//! - 非 ASCII 字符原样输出（UTF-8），控制字符转义。
//!
//! 有意收紧的地方（宁可报错也不产生歧义）：
//! - 数字必须是有限值（`1e999` 报错，而不是变成 Infinity）；
//! - 未配对的 UTF-16 surrogate 转义报错（Rust `String` 无法表示孤立代理项）；
//! - 嵌套深度上限 [`MAX_DEPTH`]，防止恶意输入打爆栈。

use std::fmt;

/// JSON 最大嵌套深度（数组/对象累计）。
pub const MAX_DEPTH: usize = 64;

/// 一个 JSON 值。
#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Json>),
    /// 保留键顺序；重复键在解析时归一为“后者覆盖前者”。
    Object(Vec<(String, Json)>),
}

impl Json {
    pub fn null() -> Self {
        Json::Null
    }

    pub fn bool(value: bool) -> Self {
        Json::Bool(value)
    }

    pub fn number(value: f64) -> Self {
        Json::Number(value)
    }

    pub fn string(value: impl Into<String>) -> Self {
        Json::String(value.into())
    }

    pub fn array(values: Vec<Json>) -> Self {
        Json::Array(values)
    }

    pub fn object(entries: Vec<(String, Json)>) -> Self {
        Json::Object(entries)
    }

    /// 便捷入口：`Json::obj(vec![("k", Json::Null)])`。
    pub fn obj(entries: Vec<(&str, Json)>) -> Self {
        Json::Object(entries.into_iter().map(|(key, value)| (key.to_string(), value)).collect())
    }

    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Object(entries) => entries.iter().find(|(name, _)| name == key).map(|(_, value)| value),
            _ => None,
        }
    }

    /// 对象插入：已存在的键原位覆盖，否则追加到末尾；非对象返回 `false`。
    pub fn insert(&mut self, key: impl Into<String>, value: Json) -> bool {
        let key = key.into();
        match self {
            Json::Object(entries) => {
                if let Some(existing) = entries.iter_mut().find(|(name, _)| *name == key) {
                    existing.1 = value;
                } else {
                    entries.push((key, value));
                }
                true
            }
            _ => false,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::String(value) => Some(value),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Json::Bool(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Json::Number(value) => Some(*value),
            _ => None,
        }
    }

    /// 非负整数（协议里的 timeoutMs / tabId / 端口等）。
    pub fn as_u64(&self) -> Option<u64> {
        match self {
            Json::Number(value) if value.is_finite() && *value >= 0.0 && value.fract() == 0.0 => {
                if *value <= u64::MAX as f64 {
                    Some(*value as u64)
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Json]> {
        match self {
            Json::Array(values) => Some(values),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&[(String, Json)]> {
        match self {
            Json::Object(entries) => Some(entries),
            _ => None,
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Json::Null)
    }

    /// 解析 JSON 文本；失败带字节偏移（便于定位协议帧里的坏字段）。
    pub fn parse(input: &str) -> Result<Json, JsonError> {
        let mut parser = Parser { bytes: input.as_bytes(), pos: 0 };
        parser.skip_whitespace();
        let value = parser.parse_value(0)?;
        parser.skip_whitespace();
        if parser.pos != parser.bytes.len() {
            return Err(parser.error("JSON 值之后还有多余内容"));
        }
        Ok(value)
    }

    /// 紧凑序列化（与 JS `JSON.stringify` 同形：无空格、键顺序保留）。
    pub fn to_compact_string(&self) -> String {
        let mut out = String::with_capacity(64);
        self.write_compact(&mut out);
        out
    }

    /// 写入调用方提供的缓冲区（CLI 输出/测试复用）。
    pub fn write_compact(&self, out: &mut String) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(true) => out.push_str("true"),
            Json::Bool(false) => out.push_str("false"),
            Json::Number(value) => write_number(*value, out),
            Json::String(value) => write_string(value, out),
            Json::Array(values) => {
                out.push('[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    value.write_compact(out);
                }
                out.push(']');
            }
            Json::Object(entries) => {
                out.push('{');
                for (index, (key, value)) in entries.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    write_string(key, out);
                    out.push(':');
                    value.write_compact(out);
                }
                out.push('}');
            }
        }
    }
}

impl fmt::Display for Json {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.to_compact_string())
    }
}

/// JSON 解析错误（字节偏移 + 说明）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonError {
    pub offset: usize,
    pub message: String,
}

impl JsonError {
    fn new(offset: usize, message: impl Into<String>) -> Self {
        Self { offset, message: message.into() }
    }
}

impl fmt::Display for JsonError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "JSON 解析失败（偏移 {}）：{}", self.offset, self.message)
    }
}

impl std::error::Error for JsonError {}

/// 对象字面量宏：`json_obj! { "ok" => Json::Bool(true) }`。
#[macro_export]
macro_rules! json_obj {
    ($($key:expr => $value:expr),* $(,)?) => {
        $crate::json::Json::Object(vec![$((String::from($key), $value)),*])
    };
}

/// 数组字面量宏：`json_arr![Json::Null, Json::Bool(true)]`。
#[macro_export]
macro_rules! json_arr {
    ($($value:expr),* $(,)?) => {
        $crate::json::Json::Array(vec![$($value),*])
    };
}

fn write_number(value: f64, out: &mut String) {
    if !value.is_finite() {
        // 解析阶段已拒绝非有限值；这里兜底输出 null，绝不产出非法 JSON。
        out.push_str("null");
    } else if value == 0.0 {
        // 覆盖 -0：JS JSON.stringify(-0) === "0"。
        out.push('0');
    } else if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        out.push_str(&(value as i64).to_string());
    } else {
        // Rust 的 f64 Display 是最短往返表示，语法上合法 JSON。
        out.push_str(&value.to_string());
    }
}

fn write_string(value: &str, out: &mut String) {
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            ch if (ch as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", ch as u32));
            }
            ch => out.push(ch),
        }
    }
    out.push('"');
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn error(&self, message: impl Into<String>) -> JsonError {
        JsonError::new(self.pos, message)
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn skip_whitespace(&mut self) {
        while let Some(byte) = self.peek() {
            if matches!(byte, b' ' | b'\t' | b'\n' | b'\r') {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn parse_value(&mut self, depth: usize) -> Result<Json, JsonError> {
        if depth > MAX_DEPTH {
            return Err(self.error(format!("嵌套深度超过上限 {MAX_DEPTH}")));
        }
        match self.peek() {
            None => Err(self.error("期望 JSON 值，实际已到输入末尾")),
            Some(b'n') => {
                self.expect_literal(b"null")?;
                Ok(Json::Null)
            }
            Some(b't') => {
                self.expect_literal(b"true")?;
                Ok(Json::Bool(true))
            }
            Some(b'f') => {
                self.expect_literal(b"false")?;
                Ok(Json::Bool(false))
            }
            Some(b'"') => {
                self.pos += 1;
                Ok(Json::String(self.parse_string_body()?))
            }
            Some(b'[') => self.parse_array(depth),
            Some(b'{') => self.parse_object(depth),
            Some(byte) if byte == b'-' || byte.is_ascii_digit() => self.parse_number(),
            Some(byte) => Err(self.error(format!("非法 JSON 值起始字节 0x{byte:02x}"))),
        }
    }

    fn expect_literal(&mut self, literal: &[u8]) -> Result<(), JsonError> {
        if self.bytes[self.pos..].starts_with(literal) {
            self.pos += literal.len();
            Ok(())
        } else {
            Err(self.error(format!("期望字面量 {}", String::from_utf8_lossy(literal))))
        }
    }

    fn parse_array(&mut self, depth: usize) -> Result<Json, JsonError> {
        self.pos += 1; // '['
        self.skip_whitespace();
        let mut values = Vec::new();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(Json::Array(values));
        }
        loop {
            self.skip_whitespace();
            values.push(self.parse_value(depth + 1)?);
            self.skip_whitespace();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(b']') => {
                    self.pos += 1;
                    return Ok(Json::Array(values));
                }
                Some(_) => return Err(self.error("数组元素后期望 ',' 或 ']'")),
                None => return Err(self.error("数组未闭合")),
            }
        }
    }

    fn parse_object(&mut self, depth: usize) -> Result<Json, JsonError> {
        self.pos += 1; // '{'
        self.skip_whitespace();
        let mut entries: Vec<(String, Json)> = Vec::new();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(Json::Object(entries));
        }
        loop {
            self.skip_whitespace();
            if self.peek() != Some(b'"') {
                return Err(self.error("对象键必须是带引号的字符串"));
            }
            self.pos += 1;
            let key = self.parse_string_body()?;
            self.skip_whitespace();
            if self.peek() != Some(b':') {
                return Err(self.error("对象键之后期望 ':'"));
            }
            self.pos += 1;
            self.skip_whitespace();
            let value = self.parse_value(depth + 1)?;
            // 与 JSON.parse 一致：重复键后者覆盖前者，且保留首次出现的位置。
            if let Some(existing) = entries.iter_mut().find(|(name, _)| *name == key) {
                existing.1 = value;
            } else {
                entries.push((key, value));
            }
            self.skip_whitespace();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(Json::Object(entries));
                }
                Some(_) => return Err(self.error("对象成员后期望 ',' 或 '}'")),
                None => return Err(self.error("对象未闭合")),
            }
        }
    }

    /// 调用方已消费开引号；返回字符串内容。
    fn parse_string_body(&mut self) -> Result<String, JsonError> {
        let mut out = String::new();
        let mut run_start = self.pos;
        loop {
            let Some(byte) = self.peek() else {
                return Err(self.error("字符串未闭合"));
            };
            match byte {
                b'"' => {
                    out.push_str(self.utf8_run(run_start, self.pos)?);
                    self.pos += 1;
                    return Ok(out);
                }
                b'\\' => {
                    out.push_str(self.utf8_run(run_start, self.pos)?);
                    self.pos += 1; // 跳过反斜杠
                    let escape = self.next_byte("转义符")?;
                    match escape {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{08}'),
                        b'f' => out.push('\u{0c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => out.push(self.parse_unicode_escape()?),
                        other => return Err(self.error(format!("非法转义 \\{}", other as char))),
                    }
                    run_start = self.pos;
                }
                byte if byte < 0x20 => {
                    return Err(self.error(format!("字符串中出现未转义控制字符 0x{byte:02x}")));
                }
                _ => {
                    self.pos += 1;
                }
            }
        }
    }

    fn utf8_run(&self, start: usize, end: usize) -> Result<&'a str, JsonError> {
        let bytes = self.bytes;
        std::str::from_utf8(&bytes[start..end])
            .map_err(|_| JsonError::new(start, "字符串不是合法 UTF-8"))
    }

    fn next_byte(&mut self, what: &str) -> Result<u8, JsonError> {
        match self.peek() {
            Some(byte) => {
                self.pos += 1;
                Ok(byte)
            }
            None => Err(self.error(format!("期望{what}，实际已到输入末尾"))),
        }
    }

    fn parse_hex4(&mut self) -> Result<u16, JsonError> {
        let mut value: u16 = 0;
        for _ in 0..4 {
            let byte = self.next_byte("4 位十六进制转义")?;
            let digit = match byte {
                b'0'..=b'9' => byte - b'0',
                b'a'..=b'f' => byte - b'a' + 10,
                b'A'..=b'F' => byte - b'A' + 10,
                _ => return Err(JsonError::new(self.pos - 1, "非法十六进制数字")),
            };
            value = value * 16 + u16::from(digit);
        }
        Ok(value)
    }

    /// `\uXXXX`（含代理对）；返回可表示的 `char`。
    fn parse_unicode_escape(&mut self) -> Result<char, JsonError> {
        let high = self.parse_hex4()?;
        if (0xD800..=0xDBFF).contains(&high) {
            if self.peek() != Some(b'\\') {
                return Err(self.error("高代理项后缺少低代理项转义"));
            }
            self.pos += 1;
            if self.next_byte("低代理项转义")? != b'u' {
                return Err(self.error("高代理项后必须是 \\u 低代理项"));
            }
            let low = self.parse_hex4()?;
            if !(0xDC00..=0xDFFF).contains(&low) {
                return Err(self.error("低代理项不在 0xDC00-0xDFFF"));
            }
            let code = 0x10000 + ((u32::from(high) - 0xD800) << 10) + (u32::from(low) - 0xDC00);
            return char::from_u32(code).ok_or_else(|| self.error("代理对不是合法 Unicode 标量"));
        }
        if (0xDC00..=0xDFFF).contains(&high) {
            return Err(self.error("孤立低代理项无法表示"));
        }
        char::from_u32(u32::from(high)).ok_or_else(|| self.error("\\u 转义不是合法 Unicode 标量"))
    }

    fn parse_number(&mut self) -> Result<Json, JsonError> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        match self.peek() {
            Some(b'0') => {
                self.pos += 1;
                if self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
                    return Err(JsonError::new(self.pos, "数字前导零非法"));
                }
            }
            Some(byte) if byte.is_ascii_digit() => {
                while self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
                    self.pos += 1;
                }
            }
            _ => return Err(self.error("数字缺少整数部分")),
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            let fraction_start = self.pos;
            while self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
                self.pos += 1;
            }
            if self.pos == fraction_start {
                return Err(self.error("小数点后缺少数字"));
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            let exponent_start = self.pos;
            while self.peek().is_some_and(|byte| byte.is_ascii_digit()) {
                self.pos += 1;
            }
            if self.pos == exponent_start {
                return Err(self.error("指数部分缺少数字"));
            }
        }
        let text = self.utf8_run(start, self.pos)?;
        let value: f64 = text.parse().map_err(|_| JsonError::new(start, "数字格式非法"))?;
        if !value.is_finite() {
            return Err(JsonError::new(start, "数字超出有限范围"));
        }
        Ok(Json::Number(value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_ok(text: &str) -> Json {
        Json::parse(text).unwrap_or_else(|error| panic!("应解析成功 {text}：{error}"))
    }

    fn parse_err(text: &str) -> JsonError {
        Json::parse(text).expect_err(&format!("应解析失败：{text}"))
    }

    #[test]
    fn parses_all_scalar_kinds() {
        assert_eq!(parse_ok("null"), Json::Null);
        assert_eq!(parse_ok("true"), Json::Bool(true));
        assert_eq!(parse_ok("false"), Json::Bool(false));
        assert_eq!(parse_ok("0"), Json::Number(0.0));
        assert_eq!(parse_ok("-12"), Json::Number(-12.0));
        assert_eq!(parse_ok("1.5"), Json::Number(1.5));
        assert_eq!(parse_ok("1e2"), Json::Number(100.0));
        assert_eq!(parse_ok("\"hi\""), Json::String("hi".to_string()));
    }

    #[test]
    fn parses_nested_object_and_array_with_whitespace() {
        let value = parse_ok(" {\n  \"a\" : [1, 2, {\"b\": null}],\n  \"c\": true\n } ");
        assert_eq!(value.get("a").and_then(Json::as_array).map(<[Json]>::len), Some(3));
        let object = value.get("a").and_then(Json::as_array).and_then(|items| items.get(2));
        assert_eq!(object.and_then(|item| item.get("b")), Some(&Json::Null));
        assert_eq!(value.get("c").and_then(Json::as_bool), Some(true));
    }

    #[test]
    fn duplicate_keys_last_wins_at_first_position() {
        let value = parse_ok("{\"a\":1,\"b\":2,\"a\":3}");
        let entries = value.as_object().expect("对象");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].0, "a");
        assert_eq!(entries[0].1.as_f64(), Some(3.0));
        assert_eq!(entries[1].0, "b");
    }

    #[test]
    fn compact_serialization_preserves_key_order() {
        let value = parse_ok("{\"b\":1,\"a\":[true,null,\"x\"]}");
        assert_eq!(value.to_compact_string(), "{\"b\":1,\"a\":[true,null,\"x\"]}");
    }

    #[test]
    fn unicode_escapes_and_surrogate_pairs_decode() {
        assert_eq!(parse_ok("\"\\u4e2d\\u6587\""), Json::String("中文".to_string()));
        assert_eq!(parse_ok("\"\\ud83d\\ude00\""), Json::String("😀".to_string()));
        assert_eq!(parse_ok("\"\\/\\\\\\\"\""), Json::String("/\\\"".to_string()));
    }

    #[test]
    fn escaped_control_characters_round_trip() {
        let value = Json::String("tab\tnl\nret\rquote\"slash\\".to_string());
        let encoded = value.to_compact_string();
        assert_eq!(encoded, "\"tab\\tnl\\nret\\rquote\\\"slash\\\\\"");
        assert_eq!(parse_ok(&encoded), value);
    }

    #[test]
    fn non_ascii_is_emitted_raw_and_round_trips() {
        let value = parse_ok("{\"msg\":\"浏览器桥 — BridgeDeck\"}");
        let encoded = value.to_compact_string();
        assert!(encoded.contains("浏览器桥"));
        assert_eq!(parse_ok(&encoded), value);
    }

    #[test]
    fn number_formatting_matches_js_conventions() {
        assert_eq!(Json::Number(1.0).to_compact_string(), "1");
        assert_eq!(Json::Number(-0.0).to_compact_string(), "0");
        assert_eq!(Json::Number(0.5).to_compact_string(), "0.5");
        assert_eq!(Json::Number(-12.0).to_compact_string(), "-12");
        assert_eq!(Json::Number(1e21).to_compact_string(), "1000000000000000000000");
    }

    #[test]
    fn accessors_enforce_types() {
        let value = parse_ok("{\"s\":\"x\",\"b\":true,\"n\":3,\"f\":1.5,\"a\":[1],\"o\":{}}");
        assert_eq!(value.get("s").and_then(Json::as_str), Some("x"));
        assert_eq!(value.get("b").and_then(Json::as_bool), Some(true));
        assert_eq!(value.get("n").and_then(Json::as_u64), Some(3));
        assert_eq!(value.get("n").and_then(Json::as_u64), Some(3));
        assert_eq!(value.get("f").and_then(Json::as_u64), None);
        assert_eq!(value.get("a").and_then(Json::as_array).map(<[Json]>::len), Some(1));
        assert_eq!(value.get("o").and_then(Json::as_object).map(<[(String, Json)]>::len), Some(0));
        assert_eq!(value.get("s").and_then(Json::as_bool), None);
        assert_eq!(value.get("missing"), None);
    }

    #[test]
    fn insert_replaces_in_place_or_appends() {
        let mut value = parse_ok("{\"a\":1}");
        assert!(value.insert("a", Json::Bool(true)));
        assert!(value.insert("b", Json::Null));
        assert_eq!(value.to_compact_string(), "{\"a\":true,\"b\":null}");
        let mut scalar = Json::Null;
        assert!(!scalar.insert("a", Json::Null));
    }

    #[test]
    fn rejects_malformed_documents_with_offsets() {
        for text in [
            "",
            " ",
            "{",
            "[1,",
            "{\"a\" 1}",
            "{\"a\":1}extra",
            "[1 2]",
            "\"unterminated",
            "\"bad \\q escape\"",
            "tru",
            "nul",
            "-",
            "1.",
            "1e",
            "01",
            "{\"a\":}",
            "[,]",
            "{\"a\":1,}",
        ] {
            let error = parse_err(text);
            assert!(!error.message.is_empty(), "错误必须有说明：{text}");
        }
    }

    #[test]
    fn rejects_control_characters_and_lone_surrogates() {
        assert!(parse_err("\"line\nbreak\"").message.contains("控制字符"));
        assert!(parse_err("\"\\ud800\"").message.contains("低代理项"));
        assert!(parse_err("\"\\udc00\"").message.contains("孤立低代理项"));
        assert!(parse_err("\"\\ud800\\u0041\"").message.contains("低代理项"));
    }

    #[test]
    fn rejects_non_finite_numbers() {
        assert!(parse_err("1e999").message.contains("有限范围"));
    }

    #[test]
    fn rejects_excessive_nesting() {
        let deep = format!("{}0{}", "[".repeat(MAX_DEPTH + 2), "]".repeat(MAX_DEPTH + 2));
        assert!(parse_err(&deep).message.contains("嵌套深度"));
    }

    #[test]
    fn macros_build_expected_shapes() {
        let value = json_obj! {
            "ok" => Json::Bool(true),
            "items" => json_arr![Json::Number(1.0), Json::string("二")],
        };
        assert_eq!(value.to_compact_string(), "{\"ok\":true,\"items\":[1,\"二\"]}");
    }

    #[test]
    fn display_matches_compact_serialization() {
        let value = parse_ok("{\"a\":1}");
        assert_eq!(format!("{value}"), value.to_compact_string());
    }

    #[test]
    fn errors_have_display_and_std_error_impl() {
        let error = parse_err("{");
        let text = error.to_string();
        assert!(text.starts_with("JSON 解析失败（偏移 "));
        let as_std: &dyn std::error::Error = &error;
        assert!(!as_std.to_string().is_empty());
    }
}

//! 标准 base64 编码（RFC 4648 §4，带 `=` 填充）。
//!
//! 用途只有两处，都由 WebSocket 握手定义：
//! - `Sec-WebSocket-Key`：16 字节随机数 → base64；
//! - `Sec-WebSocket-Accept`：`SHA-1(key + GUID)` 的 20 字节 → base64。
//!
//! 故意只实现编码：客户端不需要解码握手响应里的任何 base64，少一段可被误用的代码。
//! 换行（MIME 风格）与 URL-safe 变体都不支持——WS 握手用不到，出现即视为错误输入。

/// base64 字母表（RFC 4648 标准表，索引 0..=63）。
const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// 编码后长度（含 `=` 填充）。
pub const fn encoded_len(input_len: usize) -> usize {
    // 每 3 字节一组 → 4 字符；不足一组按 4 字符算（填充补齐）。
    input_len.div_ceil(3) * 4
}

/// 把字节编码为 base64 文本。
pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(encoded_len(bytes.len()));
    encode_into(bytes, &mut out);
    out
}

/// 追加写入调用方缓冲区（握手热路径复用，避免中间 `String`）。
pub fn encode_into(bytes: &[u8], out: &mut String) {
    let mut chunks = bytes.chunks_exact(3);
    for chunk in chunks.by_ref() {
        let value = (u32::from(chunk[0]) << 16) | (u32::from(chunk[1]) << 8) | u32::from(chunk[2]);
        out.push(ALPHABET[(value >> 18) as usize & 0x3f] as char);
        out.push(ALPHABET[(value >> 12) as usize & 0x3f] as char);
        out.push(ALPHABET[(value >> 6) as usize & 0x3f] as char);
        out.push(ALPHABET[value as usize & 0x3f] as char);
    }
    let rest = chunks.remainder();
    match rest.len() {
        1 => {
            let value = u32::from(rest[0]) << 16;
            out.push(ALPHABET[(value >> 18) as usize & 0x3f] as char);
            out.push(ALPHABET[(value >> 12) as usize & 0x3f] as char);
            out.push('=');
            out.push('=');
        }
        2 => {
            let value = (u32::from(rest[0]) << 16) | (u32::from(rest[1]) << 8);
            out.push(ALPHABET[(value >> 18) as usize & 0x3f] as char);
            out.push(ALPHABET[(value >> 12) as usize & 0x3f] as char);
            out.push(ALPHABET[(value >> 6) as usize & 0x3f] as char);
            out.push('=');
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc4648_vectors() {
        for (input, expected) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(encode(input.as_bytes()), expected, "输入 {input:?}");
        }
    }

    #[test]
    fn encoded_len_matches_output_for_every_remainder() {
        for length in 0..64 {
            let bytes = vec![0x5au8; length];
            let text = encode(&bytes);
            assert_eq!(text.len(), encoded_len(length), "长度 {length}");
            assert_eq!(text.len() % 4, 0);
            let expected_padding = match length % 3 {
                0 => 0,
                1 => 2,
                _ => 1,
            };
            assert_eq!(text.matches('=').count(), expected_padding, "长度 {length}");
        }
    }

    #[test]
    fn high_bytes_and_ws_key_vector() {
        assert_eq!(encode(&[0xff, 0x00, 0x80]), "/wCA");
        // RFC 6455 §1.3 示例 key 的 16 字节随机源（解码后）编码结果。
        let key_bytes = [0x01u8, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10];
        assert_eq!(encode(&key_bytes), "ASNFZ4mrze/+3LqYdlQyEA==");
    }

    #[test]
    fn encode_into_appends_without_clearing() {
        let mut out = String::from("prefix:");
        encode_into(b"foo", &mut out);
        assert_eq!(out, "prefix:Zm9v");
    }
}

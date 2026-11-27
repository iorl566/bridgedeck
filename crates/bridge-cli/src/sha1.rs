//! SHA-1（FIPS 180-4）实现，只服务于 WebSocket 握手：
//! `Sec-WebSocket-Accept = base64(SHA-1(Sec-WebSocket-Key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))`。
//!
//! 安全说明：SHA-1 在这里**不是**密码学安全用途（RFC 6455 规定用它做握手校验），
//! 本 crate 的任何鉴权/配对证明都不使用 SHA-1。因此不引入第三方 crate，实现保持只读清晰。
//! 支持分块 `update`，便于测试用流式输入验证与一次性输入等价。

/// SHA-1 初始状态（FIPS 180-4 §5.3.1）。
const INIT: [u32; 5] = [0x6745_2301, 0xEFCD_AB89, 0x98BA_DCFE, 0x1032_5476, 0xC3D2_E1F0];

/// 分块 SHA-1 状态机。
pub struct Sha1 {
    state: [u32; 5],
    buffer: [u8; 64],
    buffered: usize,
    /// 已处理的完整字节数（换算成 bit 时乘以 8，用 u64 避免 32 位溢出）。
    processed: u64,
}

impl Default for Sha1 {
    fn default() -> Self {
        Self::new()
    }
}

impl Sha1 {
    pub fn new() -> Self {
        Self { state: INIT, buffer: [0u8; 64], buffered: 0, processed: 0 }
    }

    /// 追加输入；任意分块顺序拼接后结果与一次性输入相同。
    pub fn update(&mut self, bytes: &[u8]) {
        let mut rest = bytes;
        // 先把已有缓冲补满一个块。
        if self.buffered > 0 {
            let need = 64 - self.buffered;
            let take = need.min(rest.len());
            self.buffer[self.buffered..self.buffered + take].copy_from_slice(&rest[..take]);
            self.buffered += take;
            rest = &rest[take..];
            if self.buffered == 64 {
                let block = self.buffer;
                self.compress(&block);
                self.processed += 64;
                self.buffered = 0;
            }
        }
        // 整块直通。
        while rest.len() >= 64 {
            let (block, tail) = rest.split_at(64);
            let mut chunk = [0u8; 64];
            chunk.copy_from_slice(block);
            self.compress(&chunk);
            self.processed += 64;
            rest = tail;
        }
        if !rest.is_empty() {
            self.buffer[..rest.len()].copy_from_slice(rest);
            self.buffered = rest.len();
        }
    }

    /// 收尾（消费 self）：补 `0x80`、补零、写 64 位大端 bit 长度。
    pub fn finish(mut self) -> [u8; 20] {
        let total_bytes = self.processed + self.buffered as u64;
        let bit_len = total_bytes.wrapping_mul(8);

        // 填充：0x80 + 若干 0，直到块内剩余 8 字节放长度。
        let mut tail = [0u8; 128];
        tail[0] = 0x80;
        let pad = if self.buffered < 56 { 56 - self.buffered - 1 } else { 120 - self.buffered - 1 };
        tail[1 + pad..1 + pad + 8].copy_from_slice(&bit_len.to_be_bytes());
        let fill = 1 + pad + 8;
        self.update(&tail[..fill]);

        let mut out = [0u8; 20];
        for (index, word) in self.state.iter().enumerate() {
            out[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
        }
        out
    }

    /// 压缩 512-bit 块。
    fn compress(&mut self, block: &[u8; 64]) {
        let mut words = [0u32; 80];
        for (index, chunk) in block.chunks_exact(4).enumerate() {
            words[index] = u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        }
        for index in 16..80 {
            let word = words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16];
            words[index] = word.rotate_left(1);
        }

        let [mut a, mut b, mut c, mut d, mut e] = self.state;
        for (index, word) in words.iter().enumerate() {
            let (f, k) = match index {
                0..=19 => ((b & c) | ((!b) & d), 0x5A82_7999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        self.state[0] = self.state[0].wrapping_add(a);
        self.state[1] = self.state[1].wrapping_add(b);
        self.state[2] = self.state[2].wrapping_add(c);
        self.state[3] = self.state[3].wrapping_add(d);
        self.state[4] = self.state[4].wrapping_add(e);
    }
}

/// 一次性 SHA-1。
pub fn sha1(bytes: &[u8]) -> [u8; 20] {
    let mut hasher = Sha1::new();
    hasher.update(bytes);
    hasher.finish()
}

/// 十六进制小写表示（测试与诊断用）。
pub fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from_digit(u32::from(byte >> 4), 16).unwrap_or('0'));
        out.push(char::from_digit(u32::from(byte & 0x0f), 16).unwrap_or('0'));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(text: &str) -> String {
        hex(&sha1(text.as_bytes()))
    }

    #[test]
    fn fips180_vectors() {
        assert_eq!(digest(""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(digest("abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(
            digest("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
        );
        assert_eq!(
            digest("The quick brown fox jumps over the lazy dog"),
            "2fd4e1c67a2d28fced849ee1bb76e7391b93eb12"
        );
    }

    #[test]
    fn million_a_vector() {
        let million = "a".repeat(1_000_000);
        assert_eq!(hex(&sha1(million.as_bytes())), "34aa973cd4c4daa4f61eeb2bdbad27316534016f");
    }

    #[test]
    fn chunked_updates_match_one_shot_for_all_boundaries() {
        let data: Vec<u8> = (0..300u32).map(|value| (value % 251) as u8).collect();
        let expected = sha1(&data);
        for chunk in [1usize, 2, 3, 55, 56, 63, 64, 65, 127, 299] {
            let mut hasher = Sha1::new();
            for piece in data.chunks(chunk) {
                hasher.update(piece);
            }
            assert_eq!(hasher.finish(), expected, "分块 {chunk}");
        }
        // 空 update 不应改变状态。
        let mut hasher = Sha1::new();
        hasher.update(&[]);
        hasher.update(b"abc");
        hasher.update(&[]);
        assert_eq!(hasher.finish(), sha1(b"abc"));
    }

    #[test]
    fn hex_is_lowercase_and_padded() {
        assert_eq!(hex(&[0x00, 0x0f, 0xff, 0xa0]), "000fffa0");
        assert_eq!(hex(&[]), "");
    }
}

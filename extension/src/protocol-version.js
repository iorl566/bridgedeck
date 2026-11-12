// src/protocol-version.js —— 协议版本解析/比较（与 daemon/lib 的规则保持一致）
export const PROTOCOL_VERSION = '1.8';
export const PROTOCOL_MAJOR = 1;

export function parseProtocol(value) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value == null ? '' : value).trim());
  return match ? { major: Number(match[1]), minor: Number(match[2] || 0) } : null;
}

export function compareProtocol(a, b) {
  const pa = parseProtocol(a);
  const pb = parseProtocol(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major - pb.major;
  return pa.minor - pb.minor;
}

/** 返回 null 表示兼容；否则是 version_skew 的原因。 */
export function protocolSkew(value) {
  const parsed = parseProtocol(value);
  if (!parsed) return 'missing';
  if (parsed.major !== PROTOCOL_MAJOR) return 'major';
  if (parsed.minor > parseProtocol(PROTOCOL_VERSION).minor) return 'daemon_newer';
  return null;
}

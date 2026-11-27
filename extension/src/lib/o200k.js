// o200k_base BPE：词表由 tiktoken 的 o200k_base.tiktoken 提供（base64(token) rank）。
// 该模块只做文本计费，不处理 special tokens；加载失败时调用方必须回退启发式。
const PATTERN = /(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;

let RANKS = null;
let DECODE = null;
let LOADING = null;

function base64Bytes(value) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'base64'));
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToKey(bytes) {
  let key = '';
  for (const byte of bytes) key += String.fromCharCode(byte);
  return key;
}

function keyToBytes(key) {
  const bytes = new Uint8Array(key.length);
  for (let index = 0; index < key.length; index += 1) bytes[index] = key.charCodeAt(index);
  return bytes;
}

function utf8(text) {
  return new TextEncoder().encode(String(text || ''));
}

export function parseTiktoken(text) {
  const ranks = new Map();
  const decode = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space <= 0) continue;
    const bytes = base64Bytes(line.slice(0, space));
    const key = bytesToKey(bytes);
    const rank = Number(line.slice(space + 1));
    if (!Number.isInteger(rank) || rank < 0) continue;
    ranks.set(key, rank);
    decode.set(rank, key);
  }
  return { ranks, decode };
}

export function parseO200kBinary(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 9) throw new Error('o200k 二进制词表过短');
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'O2KB') throw new Error('o200k 二进制词表 magic 不匹配');
  if (bytes[4] !== 1) throw new Error('o200k 二进制词表版本不支持：' + bytes[4]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(5, true);
  let offset = 9;
  const readVarint = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= bytes.length) throw new Error('o200k 二进制词表截断');
      const byte = bytes[offset++];
      value += (byte & 0x7f) * (2 ** shift);
      if ((byte & 0x80) === 0) return value;
      shift += 7;
      if (shift > 35) throw new Error('o200k 二进制词表 varint 过长');
    }
  };
  const ranks = new Map();
  const decode = new Map();
  let previous = new Uint8Array(0);
  for (let index = 0; index < count; index += 1) {
    const prefix = readVarint();
    const suffixLength = readVarint();
    if (offset + suffixLength > bytes.length) throw new Error('o200k 二进制词表截断');
    const token = new Uint8Array(prefix + suffixLength);
    token.set(previous.subarray(0, prefix), 0);
    token.set(bytes.subarray(offset, offset + suffixLength), prefix);
    offset += suffixLength;
    const rank = readVarint();
    const key = bytesToKey(token);
    ranks.set(key, rank);
    decode.set(rank, key);
    previous = token;
  }
  return { ranks, decode };
}

export function setO200kBinary(input) {
  const parsed = parseO200kBinary(input);
  if (parsed.ranks.size < 256) throw new Error('o200k 词表过小：' + parsed.ranks.size);
  RANKS = parsed.ranks;
  DECODE = parsed.decode;
  return RANKS.size;
}

export function setO200kData(text) {
  const parsed = parseTiktoken(text);
  if (parsed.ranks.size < 256) throw new Error('o200k 词表过小：' + parsed.ranks.size);
  RANKS = parsed.ranks;
  DECODE = parsed.decode;
  return RANKS.size;
}

export function isO200kLoaded() {
  return Boolean(RANKS);
}

export function o200kSize() {
  return RANKS ? RANKS.size : 0;
}

function encodePiece(piece) {
  const bytes = utf8(piece);
  let keys = Array.from(bytes).map((byte) => String.fromCharCode(byte));
  while (keys.length > 1) {
    let bestRank = Infinity;
    let bestIndex = -1;
    for (let index = 0; index + 1 < keys.length; index += 1) {
      const rank = RANKS.get(keys[index] + keys[index + 1]);
      if (rank != null && rank < bestRank) {
        bestRank = rank;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) break;
    keys.splice(bestIndex, 2, keys[bestIndex] + keys[bestIndex + 1]);
  }
  const tokens = [];
  for (const key of keys) {
    const rank = RANKS.get(key);
    if (rank == null) {
      for (const byte of keyToBytes(key)) {
        const fallback = RANKS.get(String.fromCharCode(byte));
        if (fallback != null) tokens.push(fallback);
      }
    } else {
      tokens.push(rank);
    }
  }
  return tokens;
}

export function encodeO200k(text) {
  if (!RANKS) throw new Error('o200k 词表未加载');
  const input = String(text || '');
  if (!input) return [];
  const tokens = [];
  let last = 0;
  for (const match of input.matchAll(PATTERN)) {
    const start = match.index || 0;
    if (start > last) tokens.push(...encodePiece(input.slice(last, start)));
    tokens.push(...encodePiece(match[0]));
    last = start + match[0].length;
  }
  if (last < input.length) tokens.push(...encodePiece(input.slice(last)));
  return tokens;
}

export function decodeO200k(tokens) {
  if (!DECODE) throw new Error('o200k 词表未加载');
  const bytes = [];
  for (const token of tokens || []) {
    const key = DECODE.get(Number(token));
    if (key == null) continue;
    bytes.push(...keyToBytes(key));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function countO200k(text) {
  return encodeO200k(text).length;
}

export async function loadO200k() {
  if (RANKS) return RANKS.size;
  if (LOADING) return LOADING;
  LOADING = (async () => {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) {
      throw new Error('o200k 词表需要在扩展内加载');
    }
    const binUrl = chrome.runtime.getURL('vendor/o200k/o200k_base.bin');
    try {
      const bin = await fetch(binUrl);
      if (bin.ok) return setO200kBinary(new Uint8Array(await bin.arrayBuffer()));
    } catch {
      // 回退到原始文本词表（开发/旧包兼容）
    }
    const url = chrome.runtime.getURL('vendor/o200k/o200k_base.tiktoken');
    const response = await fetch(url);
    if (!response.ok) throw new Error('o200k 词表读取失败：' + response.status);
    return setO200kData(await response.text());
  })().finally(() => { LOADING = null; });
  return LOADING;
}

// src/tokens.js —— 轻量 token 估算（不加载词表，按 o200k 预分词特征近似）
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const KANA = /[\u3040-\u30ff]/;
const HANGUL = /[\uac00-\ud7af]/;

export function estimateTokens(text) {
  const value = String(text == null ? '' : text);
  if (!value) return 0;
  let tokens = 0;
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < value.length && /\s/.test(value[j])) j += 1;
      tokens += Math.ceil((j - i) / 2);
      i = j;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      let j = i + 1;
      while (j < value.length && /[A-Za-z0-9_'’-]/.test(value[j])) j += 1;
      const run = j - i;
      tokens += run <= 3 ? 1 : Math.ceil(run / (run > 12 ? 2.4 : 3.6));
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < value.length && /[0-9]/.test(value[j])) j += 1;
      tokens += Math.ceil((j - i) / 3);
      i = j;
      continue;
    }
    if (CJK.test(ch)) {
      let j = i + 1;
      while (j < value.length && CJK.test(value[j])) j += 1;
      tokens += Math.ceil((j - i) * 0.76);
      i = j;
      continue;
    }
    if (KANA.test(ch) || HANGUL.test(ch)) {
      let j = i + 1;
      while (j < value.length && (KANA.test(value[j]) || HANGUL.test(value[j]))) j += 1;
      tokens += Math.ceil((j - i) * 0.6);
      i = j;
      continue;
    }
    let j = i + 1;
    while (j < value.length && !/[\sA-Za-z0-9]/.test(value[j]) && !CJK.test(value[j]) && !KANA.test(value[j]) && !HANGUL.test(value[j])) j += 1;
    tokens += Math.ceil((j - i) / 2);
    i = j;
  }
  return Math.max(1, Math.round(tokens));
}

/** 从 offset 开始截取大约 maxTokens 的文本，返回 next 偏移与省略统计。 */
export function takeTokenChunk(text, offset, maxTokens) {
  const value = String(text == null ? '' : text);
  const start = Math.max(0, Math.min(value.length, Number(offset) || 0));
  const budget = Math.max(1, Number(maxTokens) || 0);
  if (!maxTokens) return { text: value.slice(start), next: null, used: estimateTokens(value.slice(start)), lines: 0, omittedChars: 0, omittedLines: 0 };
  let end = start;
  let used = 0;
  let lines = 0;
  while (end < value.length) {
    const newline = value.indexOf('\n', end);
    const lineEnd = newline === -1 ? value.length : newline + 1;
    const cost = estimateTokens(value.slice(end, lineEnd));
    if (used + cost > budget && end > start) break;
    if (used + cost > budget && end === start) {
      // 单行超预算时至少返回整行，避免把一行切成不可读碎片
      end = lineEnd;
      lines += 1;
      break;
    }
    end = lineEnd;
    lines += 1;
    used += cost;
  }
  const rest = value.slice(end);
  return {
    text: value.slice(start, end),
    next: end < value.length ? end : null,
    used,
    lines,
    omittedChars: rest.length,
    omittedLines: rest ? rest.split('\n').length - (rest.endsWith('\n') ? 1 : 0) : 0,
  };
}

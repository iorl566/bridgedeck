// observation-delta —— 观察文本的行级增量补丁（无依赖，扩展与 CLI 共用同一实现）
//
// 只处理"同一批节点、只有可见文本原地变化"的情况：
//   - 行数不同、ref 序列不同、URL 变化 → 视为结构性变化，调用方应回退整页观察；
//   - 否则返回被替换的行（行号 + 新内容），由调用方在本地合并。

export function observationLines(text) {
  return typeof text === 'string' && text.length ? text.split('\n') : [];
}

export function observationId(seed = '') {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return 'ob_' + (seed ? String(seed).slice(0, 4) + '_' : '') + suffix;
}

function refSignature(line) {
  const refs = String(line).match(/@e\d+/g);
  return refs ? refs.join(',') : '';
}

/**
 * @returns {{kind: 'same'|'text'|'structural', patch: Array<{line:number,value:string}>, changes: number, reason?: string}}
 */
export function diffObservation(previousText, nextText) {
  const prev = observationLines(previousText);
  const next = observationLines(nextText);
  if (prev.length !== next.length) return { kind: 'structural', patch: [], changes: 0, reason: 'line-count' };
  const patch = [];
  for (let i = 0; i < prev.length; i += 1) {
    if (prev[i] === next[i]) continue;
    if (refSignature(prev[i]) !== refSignature(next[i])) return { kind: 'structural', patch: [], changes: 0, reason: 'refs' };
    patch.push({ line: i, value: next[i] });
  }
  if (!patch.length) return { kind: 'same', patch: [], changes: 0 };
  return { kind: 'text', patch, changes: patch.length };
}

export function applyObservationPatch(previousText, patch) {
  const lines = observationLines(previousText);
  for (const entry of Array.isArray(patch) ? patch : []) {
    if (!entry || typeof entry !== 'object') continue;
    const index = Number(entry.line);
    if (!Number.isInteger(index) || index < 0 || index >= lines.length) continue;
    lines[index] = String(entry.value ?? '');
  }
  return lines.join('\n');
}

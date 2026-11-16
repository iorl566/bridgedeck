// observation-delta —— 观察文本的行级增量补丁（无依赖，扩展与 CLI 共用同一实现）
//
// 处理三类变化：
//   - 同一批节点、只有可见文本原地变化 → text 补丁（行号 + 新内容）
//   - 行数变化但 ref 序列未变 → structural-text（删除/插入若干行，可本地合并）
//   - ref 序列变化 / 结构不可信 → structural，调用方回退整页观察

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

function splitMiddle(prev, next) {
  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) start += 1;
  let prevEnd = prev.length - 1;
  let nextEnd = next.length - 1;
  while (prevEnd >= start && nextEnd >= start && prev[prevEnd] === next[nextEnd]) {
    prevEnd -= 1;
    nextEnd -= 1;
  }
  return { start, prevEnd, nextEnd };
}

/**
 * @returns {{kind: 'same'|'text'|'structural-text'|'structural', patch: Array<object>, ops?: Array<object>, changes: number, reason?: string}}
 */
export function diffObservation(previousText, nextText) {
  const prev = observationLines(previousText);
  const next = observationLines(nextText);
  const { start, prevEnd, nextEnd } = splitMiddle(prev, next);
  const removed = prevEnd - start + 1;
  const inserted = nextEnd - start + 1;
  if (removed <= 0 && inserted <= 0) return { kind: 'same', patch: [], changes: 0 };

  // 先确认中间段没有"换了一批 ref"：有的话不能本地拼，必须整页重来。
  const prevMiddle = prev.slice(start, prevEnd + 1);
  const nextMiddle = next.slice(start, nextEnd + 1);
  if (removed === inserted) {
    for (let i = 0; i < removed; i += 1) {
      if (refSignature(prevMiddle[i]) !== refSignature(nextMiddle[i])) {
        return { kind: 'structural', patch: [], changes: 0, reason: 'refs' };
      }
    }
    const patch = nextMiddle.map((value, index) => ({ line: start + index, value }));
    return { kind: 'text', patch, changes: patch.length };
  }

  // 行数变化：按"先删后插"生成顺序 ops（apply 时按当前数组下标执行）。
  const ops = [];
  if (removed > 0) ops.push({ op: 'remove', line: start, count: removed });
  if (inserted > 0) ops.push({ op: 'insert', line: start, lines: nextMiddle });
  return { kind: 'structural-text', patch: ops, ops, changes: removed + inserted };
}

export function applyObservationPatch(previousText, patch) {
  const lines = observationLines(previousText);
  for (const entry of Array.isArray(patch) ? patch : []) {
    if (!entry || typeof entry !== 'object') continue;
    const index = Number(entry.line);
    if (!Number.isInteger(index) || index < 0) continue;
    if (entry.op === 'remove') {
      const count = Math.max(0, Math.min(Number(entry.count) || 0, lines.length - index));
      if (count > 0) lines.splice(index, count);
      continue;
    }
    if (entry.op === 'insert') {
      const inserted = Array.isArray(entry.lines) ? entry.lines.map((line) => String(line ?? '')) : [];
      if (!inserted.length || index > lines.length) continue;
      lines.splice(index, 0, ...inserted);
      continue;
    }
    if (index >= lines.length) continue;
    lines[index] = String(entry.value ?? '');
  }
  return lines.join('\n');
}

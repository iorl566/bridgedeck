// extension/src/record-merge.js —— 录制事件的去重与多源合并（纯函数）。
//
// 录制链路里同一次用户动作可能被多处上报：
//   - 内容脚本 record-capture 与注入式 recorder（回退路径 / 导航后重挂）可能重叠；
//   - 同一帧里父文档与子 frame 的观察器都可能投递 state/text 事件；
//   - 页面导航后旧 document 的尾队列可能晚到。
// 如果照单全收，导出的 trace/recipe 会出现重复步骤、重复状态和互相覆盖的观察值。
//
// 本模块给两条明确的判据：
//   1) 严格重复（strict duplicate）：documentId + seq + kind + 步骤签名 完全相同。
//      这是可证明的重传（同一次事件被投递两次），运行时可以直接丢弃，并把“来源”合并回
//      第一次那条事件（保留 observation/screenshot 等增量字段）。
//   2) 同动作多源（multi-source same action）：不同 source、时间差 <= windowMs、步骤签名相同。
//      不丢弃（可能是用户快速两次操作，也可能是两路采集），而是标注 merged，并把两边的
//      观察/截图等增量字段合并到先到的那条上；导出/回放预检按 merged 计数去重。
//
// 所有函数都是纯函数，可注入 now/window；运行时消费点：src/record-events.js 的
// handleRecordEvent（每条录制事件都会走一遍去重/合并判定，结果只以新增字段挂回事件）。

import { stepSignature, stableHash } from './record-steps.js';

export const RECORD_MERGE_VERSION = 1;
/** 同动作多源合并的时间窗（毫秒）：超过就视为两次独立动作。 */
export const DEFAULT_MERGE_WINDOW_MS = 60;
/** 事件字段里可能出现的来源名（归一化后写入 evidence.source）。 */
export const KNOWN_SOURCES = Object.freeze(['content', 'injected', 'agent', 'human', 'frame', 'page']);

const MAX_TRACKED = 64;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteInt(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : fallback;
}

function textOf(value, max = 120) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function stepOf(event) {
  if (!event || typeof event !== 'object') return null;
  const step = event.recordStep;
  if (step && typeof step === 'object') return step;
  // 允许直接传 step（测试/导出路径）
  return typeof event.kind === 'string' && typeof event.params === 'object' ? event : null;
}

/** 事件来源：显式 source/capture 优先，actor 退化为 human/agent，最后按 frame 区分。 */
export function eventSourceOf(event) {
  if (!event || typeof event !== 'object') return 'unknown';
  const explicit = String(event.source || event.capture || '').trim().toLowerCase();
  if (explicit) return KNOWN_SOURCES.includes(explicit) ? explicit : explicit.slice(0, 24);
  const actor = String(event.actor || '').trim().toLowerCase();
  if (actor === 'agent') return 'agent';
  if (actor === 'human') return 'human';
  const frameId = finiteInt(event.frameId, 0);
  if (frameId > 0) return 'frame';
  return 'page';
}

/** 事件身份（严格）：同一 document 同一个 seq 就是同一次上报。 */
export function eventIdentity(event, options = {}) {
  const step = stepOf(event);
  const documentId = String(
    options.documentId
    || (event && event.documentId)
    || (event && event.boundary && event.boundary.documentId)
    || '',
  );
  const seq = Number.isInteger(options.seq)
    ? options.seq
    : (Number.isInteger(event && event.seq) ? event.seq : 0);
  const kind = String((step && step.kind) || (event && event.kind) || '');
  const signature = step ? stepSignature(step) : kind;
  return [documentId, seq, kind, signature].join('|');
}

/** 动作指纹（宽松）：不看 seq/document，用来识别“同一动作的多源上报”。 */
export function eventActionFingerprint(event) {
  const step = stepOf(event);
  if (!step) return '';
  return stepSignature(step);
}

function timeOf(event) {
  const step = stepOf(event);
  return finiteInt(step && step.evidence && step.evidence.at, finiteInt(event && (event.ts || event.at), 0));
}

function refOf(event) {
  const step = stepOf(event);
  return String((step && step.ref) || (event && event.ref) || '');
}

function mergeSources(...values) {
  const out = [];
  for (const value of values) {
    const list = Array.isArray(value) ? value : (value ? [value] : []);
    for (const item of list) {
      const text = textOf(item, 32);
      if (text && !out.includes(text)) out.push(text);
    }
  }
  return out.slice(0, 8);
}

function mergeNotes(...values) {
  const out = [];
  for (const value of values) {
    const list = Array.isArray(value) ? value : [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      out.push(item);
      if (out.length >= 12) return out;
    }
  }
  return out;
}

/**
 * 合并同一个动作的两条上报（先到的为 canonical）。
 * 规则：canonical 为主；incoming 只补空缺字段（observation/screenshot/stateUrl/frameUrl 等），
 * 并从 incoming 收集来源；对“两边都有值且不同”的字段记 conflict（不静默覆盖）。
 * @returns {{event:object, changed:boolean, conflicts:Array, sources:string[]}}
 */
export function mergeEventPair(canonical, incoming, options = {}) {
  if (!isPlainObject(canonical)) return { event: incoming || null, changed: false, conflicts: [], sources: mergeSources(eventSourceOf(incoming)) };
  if (!isPlainObject(incoming)) return { event: canonical, changed: false, conflicts: [], sources: mergeSources(eventSourceOf(canonical)) };
  const event = { ...canonical };
  const conflicts = [];
  const fillFields = ['observation', 'stateUrl', 'stateAt', 'screenshot', 'frameUrl', 'title', 'commit', 'label', 'refs'];
  let changed = false;
  for (const field of fillFields) {
    const before = canonical[field];
    const after = incoming[field];
    const beforeEmpty = before === undefined || before === null || before === '';
    const afterEmpty = after === undefined || after === null || after === '';
    if (beforeEmpty && !afterEmpty) {
      event[field] = after;
      changed = true;
    } else if (!beforeEmpty && !afterEmpty && String(before) !== String(after) && (field === 'observation' || field === 'stateUrl')) {
      conflicts.push({ field, canonical: String(before).slice(0, 120), incoming: String(after).slice(0, 120) });
    }
  }
  const canonicalStep = stepOf(canonical);
  const incomingStep = stepOf(incoming);
  if (canonicalStep && incomingStep) {
    const value = incomingStep.params && incomingStep.params.value;
    const canonicalValue = canonicalStep.params && canonicalStep.params.value;
    if ((canonicalValue === undefined || canonicalValue === '') && value !== undefined && value !== '') {
      event.recordStep = { ...canonicalStep, params: { ...(canonicalStep.params || {}), value } };
      changed = true;
    } else if (canonicalValue !== undefined && value !== undefined && canonicalValue !== value) {
      conflicts.push({ field: 'params.value', canonical: String(canonicalValue).slice(0, 80), incoming: String(value).slice(0, 80) });
    }
  }
  const sources = mergeSources(
    (canonicalStep && canonicalStep.evidence && canonicalStep.evidence.sources) || canonical.sources,
    (incoming.sources),
    eventSourceOf(canonical),
    eventSourceOf(incoming),
    options.extraSources,
  );
  const notes = mergeNotes(
    canonical.recordDedupe && canonical.recordDedupe.notes,
    incoming.recordDedupe && incoming.recordDedupe.notes,
    conflicts.map((item) => ({ kind: 'merge_conflict', field: item.field })),
  );
  const windows = [
    finiteInt(canonical.recordDedupe && canonical.recordDedupe.windowMs, 0),
    finiteInt(options.windowMs, 0),
  ].filter((value) => value > 0);
  event.recordDedupe = {
    version: RECORD_MERGE_VERSION,
    merged: true,
    sources,
    ref: refOf(canonical) || refOf(incoming),
    mergedAt: finiteInt(options.now, 0) || 0,
    windowMs: windows.length ? Math.max(...windows) : 0,
    duplicates: finiteInt(canonical.recordDedupe && canonical.recordDedupe.duplicates, 0),
    conflicts: conflicts.length,
    ...(notes.length ? { notes } : {}),
  };
  return { event, changed, conflicts, sources };
}

/**
 * 纯函数去重：按顺序扫描事件列表，严格重复丢弃、多源同动作合并。
 * @param {Array} events
 * @param {{windowMs?:number, now?:number, dropMerged?:boolean}} options
 * @returns {{events:Array, dropped:Array, merged:Array, conflicts:Array, stats:object}}
 */
export function dedupeEventList(events, options = {}) {
  const windowMs = Math.max(0, finiteInt(options.windowMs, DEFAULT_MERGE_WINDOW_MS));
  const list = Array.isArray(events) ? events : [];
  const kept = [];
  const dropped = [];
  const merged = [];
  const conflicts = [];
  const byIdentity = new Map();
  const byAction = new Map();
  let mergedCount = 0;
  for (let index = 0; index < list.length; index += 1) {
    const event = list[index];
    if (!isPlainObject(event)) continue;
    const identity = eventIdentity(event);
    const canonicalIndex = byIdentity.get(identity);
    if (canonicalIndex !== undefined) {
      const canonical = kept[canonicalIndex];
      const result = mergeEventPair(canonical, event, { windowMs, now: options.now });
      const dedupe = result.event && result.event.recordDedupe ? result.event.recordDedupe : {};
      kept[canonicalIndex] = {
        ...result.event,
        recordDedupe: {
          ...dedupe,
          merged: true,
          duplicates: (Number(dedupe.duplicates) || 0) + 1,
        },
      };
      for (const conflict of result.conflicts) conflicts.push({ index, canonicalIndex, ...conflict });
      dropped.push({
        index,
        canonicalIndex,
        ref: refOf(event),
        reason: 'strict_duplicate',
        identity,
        source: eventSourceOf(event),
      });
      continue;
    }
    // 多源同动作：时间接近 + 签名相同 + 来源不同 → 标注合并（默认仍保留事件，避免误删真实双击）。
    const action = eventActionFingerprint(event);
    const at = timeOf(event);
    const source = eventSourceOf(event);
    let match = null;
    if (action && at > 0) {
      for (const candidate of byAction.get(action) || []) {
        if (candidate.source === source) continue;
        if (Math.abs(at - candidate.at) > windowMs) continue;
        match = candidate;
        break;
      }
    }
    if (match) {
      const result = mergeEventPair(kept[match.keptIndex], event, { windowMs, now: options.now });
      kept[match.keptIndex] = result.event;
      for (const conflict of result.conflicts) conflicts.push({ index, canonicalIndex: match.keptIndex, ...conflict });
      mergedCount += 1;
      const marker = {
        index,
        canonicalIndex: match.keptIndex,
        ref: refOf(event),
        canonicalRef: refOf(result.event),
        action,
        source,
        canonicalSource: match.source,
        gapMs: Math.abs(at - match.at),
        conflicts: result.conflicts.length,
      };
      merged.push(marker);
      if (options.dropMerged === true) {
        dropped.push({ ...marker, reason: 'multi_source_merged' });
        continue;
      }
      const annotated = {
        ...event,
        recordMerge: {
          version: RECORD_MERGE_VERSION,
          mergedInto: marker.canonicalRef,
          source,
          canonicalSource: match.source,
          gapMs: marker.gapMs,
          action,
          ...(result.conflicts.length ? { conflicts: result.conflicts.length } : {}),
        },
      };
      const keptIndex = kept.length;
      kept.push(annotated);
      byIdentity.set(identity, keptIndex);
      const list = byAction.get(action) || [];
      list.push({ action, at, source, keptIndex });
      byAction.set(action, list.slice(-MAX_TRACKED));
      continue;
    }
    const keptIndex = kept.length;
    kept.push(event);
    byIdentity.set(identity, keptIndex);
    if (action && at > 0) {
      const list = byAction.get(action) || [];
      list.push({ action, at, source, keptIndex });
      byAction.set(action, list.slice(-MAX_TRACKED));
    }
  }
  return {
    events: kept,
    dropped,
    merged,
    conflicts,
    stats: {
      total: list.length,
      kept: kept.length,
      dropped: dropped.length,
      merged: mergedCount,
      conflicts: conflicts.length,
      windowMs,
    },
  };
}

/**
 * 多路事件流合并（同一录制里不同来源/不同 frame 各自一条流）。
 * 输入：`[{source, events}]` 或 `[[event...], ...]`；输出按 (at, seq) 排序后的去重事件。
 */
export function mergeEventStreams(streams, options = {}) {
  const tagged = [];
  const sources = {};
  for (const stream of Array.isArray(streams) ? streams : []) {
    const list = Array.isArray(stream) ? stream : (stream && Array.isArray(stream.events) ? stream.events : []);
    const source = Array.isArray(stream) ? '' : String((stream && stream.source) || '');
    for (const event of list) {
      if (!isPlainObject(event)) continue;
      const normalized = source && !event.source ? { ...event, source } : event;
      const name = eventSourceOf(normalized);
      sources[name] = (sources[name] || 0) + 1;
      tagged.push(normalized);
    }
  }
  tagged.sort((left, right) => {
    const delta = timeOf(left) - timeOf(right);
    if (delta !== 0) return delta;
    return finiteInt(left.seq, 0) - finiteInt(right.seq, 0);
  });
  const result = dedupeEventList(tagged, options);
  return {
    ...result,
    sources,
    stats: { ...result.stats, sources, streams: Array.isArray(streams) ? streams.length : 0 },
  };
}

/** 对外紧凑摘要（事件旁/导出报告用）。 */
export function summarizeMerge(result) {
  if (!result || typeof result !== 'object') return null;
  const stats = result.stats && typeof result.stats === 'object' ? result.stats : {};
  return {
    total: finiteInt(stats.total, 0),
    kept: finiteInt(stats.kept, 0),
    dropped: finiteInt(stats.dropped, Array.isArray(result.dropped) ? result.dropped.length : 0),
    merged: finiteInt(stats.merged, Array.isArray(result.merged) ? result.merged.length : 0),
    conflicts: finiteInt(stats.conflicts, Array.isArray(result.conflicts) ? result.conflicts.length : 0),
    windowMs: finiteInt(stats.windowMs, DEFAULT_MERGE_WINDOW_MS),
  };
}

/** 单 tab 的增量去重索引（运行时热路径用；只保留最近 MAX_TRACKED 条）。 */
export function createMergeIndex(options = {}) {
  const windowMs = Math.max(0, finiteInt(options.windowMs, DEFAULT_MERGE_WINDOW_MS));
  const limit = Math.max(4, finiteInt(options.limit, MAX_TRACKED));
  const identities = new Map();
  const actions = new Map();
  const order = [];
  return {
    windowMs,
    /**
     * 判定 incoming 与已见事件的关系。
     * @returns {{kind:'duplicate'|'merged'|'new', canonicalIndex?:number, canonical?:object,
     *   sources:string[], conflicts:Array, gapMs?:number, action?:string, identity:string}}
     */
    classify(event, context = {}) {
      const identity = eventIdentity(event, context);
      if (identities.has(identity)) {
        const canonicalIndex = identities.get(identity);
        const record = order.find((item) => item.index === canonicalIndex) || null;
        return {
          kind: 'duplicate',
          identity,
          canonicalIndex,
          canonical: record ? record.event : null,
          sources: mergeSources(eventSourceOf(event)),
          conflicts: [],
          action: eventActionFingerprint(event),
        };
      }
      const action = eventActionFingerprint(event);
      const at = timeOf(event);
      const source = eventSourceOf(event);
      if (action && at > 0) {
        for (const candidate of actions.get(action) || []) {
          if (candidate.source === source) continue;
          const gap = Math.abs(at - candidate.at);
          if (gap <= windowMs) {
            return { kind: 'merged', identity, canonicalIndex: candidate.index, canonical: candidate.event, sources: mergeSources(candidate.source, source), conflicts: [], gapMs: gap, action };
          }
        }
      }
      return { kind: 'new', identity, sources: [source], conflicts: [], action, at };
    },
    /** 登记已保留的事件（返回新的 canonical index）。 */
    remember(event, index) {
      const identity = eventIdentity(event);
      identities.set(identity, index);
      const action = eventActionFingerprint(event);
      if (action) {
        const list = actions.get(action) || [];
        list.push({ action, at: timeOf(event), source: eventSourceOf(event), index, event });
        actions.set(action, list.slice(-limit));
      }
      order.push({ index, identity, action, at: timeOf(event), event });
      while (order.length > limit) {
        const expired = order.shift();
        if (expired && identities.get(expired.identity) === expired.index) identities.delete(expired.identity);
      }
      return index;
    },
    /** 更新已保留事件（合并后 URL/observation 会变，索引里的引用保持同一对象即可）。 */
    touch(index, event) {
      if (!event) return;
      for (const item of order) if (item.index === index) item.event = event;
      for (const list of actions.values()) {
        for (const candidate of list) if (candidate.index === index) candidate.event = event;
      }
    },
    size() {
      return identities.size;
    },
    clear() {
      identities.clear();
      actions.clear();
      order.length = 0;
    },
  };
}

/** 事件指纹（诊断/测试用；与运行时 identity 一致）。 */
export function eventFingerprintHex(event) {
  return stableHash(eventIdentity(event));
}

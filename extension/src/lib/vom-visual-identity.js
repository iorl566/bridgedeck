// lib/vom-visual-identity.js —— visualObjects 的稳定身份与动作闭环（纯函数）。
//
// 页面侧每次 observe 都会重新收集视觉对象（canvas/图表/图片/自绘区域 + @eN 坐标），
// 原始条目只有 {kind, index, tag, id, rect} 或 {kind, ref, role, name, rect}：
//   1) 同一个 canvas 在两次 observe 之间 index 可能变化，Agent 需要**稳定 id**才能说
//      “还是那个图表”；本模块给每个对象分配 `voId`（签名哈希，跨帧不变），并用上一轮
//      观察做匹配，标注 stable / moved / resized / replaced / added / removed 及置信度；
//   2) 视觉对象只有“能落到动作目标”才有意义：closure 明确给出 click/hover 的 ref、
//      backendNodeId、DIP 坐标与图像坐标（×DPR）；region 类对象只给
//      screenshot --visual → click --capture --image-x/--image-y 的两步链；
//   3) 缺 ref / 缺 backendNodeId / 缺几何时如实标 blockedReason + evidence，不伪造目标。
//
// 纯函数；不读 DOM，不碰 CDP。

export const VOM_VISUAL_IDENTITY_VERSION = 1;

/** 视觉对象跨轮变化类型。 */
export const VISUAL_CHANGE_KINDS = Object.freeze(['stable', 'moved', 'resized', 'replaced', 'added', 'removed']);

export const VISUAL_IDENTITY_LIMITS = Object.freeze({
  objects: 200,
  previous: 400,
  minIou: 0.45,
  quantizeStep: 4,
  moveTolerance: 2,
  sizeTolerance: 2,
});

function limitOf(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), max);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** 视觉对象矩形：{x,y,width,height} 或页面侧 {x,y,w,h}。 */
export function visualRect(object) {
  if (!object || typeof object !== 'object') return null;
  const source = object.rect || object.bounds || null;
  if (!source || typeof source !== 'object') return null;
  const x = numberOrNull(source.x);
  const y = numberOrNull(source.y);
  const width = numberOrNull(source.width != null ? source.width : source.w);
  const height = numberOrNull(source.height != null ? source.height : source.h);
  if (x === null || y === null || width === null || height === null) return null;
  if (width < 0 || height < 0) return null;
  return { x, y, width, height };
}

function areaOf(rect) {
  return rect ? Math.max(0, rect.width) * Math.max(0, rect.height) : 0;
}

/** 交并比；任一矩形无效时为 0（不是 1）。 */
export function visualIoU(a, b) {
  if (!a || !b) return 0;
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return 0;
  const inter = width * height;
  const union = areaOf(a) + areaOf(b) - inter;
  if (!(union > 0)) return 0;
  return Math.min(1, Math.max(0, inter / union));
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function hashText(text) {
  return fnv1a(String(text)).toString(36).padStart(7, '0').slice(-7);
}

function quantize(value, step) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const size = Math.max(1, Number(step) || 4);
  return Math.round(number / size) * size;
}

function centerOf(rect) {
  if (!rect) return null;
  return { x: Math.round((rect.x + rect.width / 2) * 100) / 100, y: Math.round((rect.y + rect.height / 2) * 100) / 100 };
}

function centerDistance(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 视觉对象签名：不含绝对位置（移动不换身份），但含种类/结构/量化尺寸。
 * @returns {{signature:string, key:string, parts:object}}
 */
export function visualSignature(object, options = {}) {
  const step = Math.max(1, Number(options.quantizeStep) || VISUAL_IDENTITY_LIMITS.quantizeStep);
  const item = object && typeof object === 'object' ? object : {};
  const kind = String(item.kind || 'object');
  const rect = visualRect(item);
  const parts = {
    kind,
    tag: item.tag == null ? null : String(item.tag).toLowerCase(),
    domId: item.id == null ? null : String(item.id),
    role: item.role == null ? null : String(item.role).toLowerCase(),
    name: item.name == null ? null : String(item.name).slice(0, 48),
    width: rect ? quantize(rect.width, step) : null,
    height: rect ? quantize(rect.height, step) : null,
  };
  const key = [parts.kind, parts.tag || '', parts.domId || '', parts.role || '', parts.name || '', parts.width == null ? '' : parts.width, parts.height == null ? '' : parts.height].join('\u0000');
  return { signature: 'vs-' + hashText(key), key, parts };
}

function identityOf(object) {
  if (!object || typeof object !== 'object') return null;
  if (object.voId) return { voId: String(object.voId), signature: object.identity && object.identity.signature ? String(object.identity.signature) : null, change: object.identity && object.identity.change ? String(object.identity.change) : null };
  return null;
}

function previousOf(object) {
  const identity = identityOf(object);
  const signature = identity && identity.signature ? identity.signature : visualSignature(object).signature;
  const parts = visualSignature(object).parts;
  return {
    object,
    voId: identity ? identity.voId : null,
    signature,
    // 身份键不含尺寸/位置：用来区分“同一对象变化”与“换了对象”。
    identityKey: [parts.kind, parts.tag || '', parts.domId || '', parts.role || '', parts.name || ''].join('\u0000'),
    kind: String((object && object.kind) || 'object'),
    ref: object && object.ref ? String(object.ref) : null,
    tag: object && object.tag == null ? null : String(object.tag).toLowerCase(),
    domId: object && object.id == null ? null : String(object.id),
    regionIndex: object && Number.isInteger(object.index) ? object.index : null,
    rect: visualRect(object),
    center: centerOf(visualRect(object)),
  };
}

function classifyChange(previous, next) {
  const iou = visualIoU(previous.rect, next.rect);
  const moved = centerDistance(previous.center, next.center);
  const resized = Boolean(previous.rect && next.rect)
    && (Math.abs(previous.rect.width - next.rect.width) > VISUAL_IDENTITY_LIMITS.sizeTolerance
      || Math.abs(previous.rect.height - next.rect.height) > VISUAL_IDENTITY_LIMITS.sizeTolerance);
  const replaced = previous.identityKey !== next.identityKey;
  // 换了对象且几何也对不上 → replaced；同一对象尺寸变化 → resized；仅位置变化 → moved。
  if (replaced && iou < VISUAL_IDENTITY_LIMITS.minIou) return 'replaced';
  if (resized) return 'resized';
  if (moved > VISUAL_IDENTITY_LIMITS.moveTolerance) return 'moved';
  if (replaced) return 'replaced';
  return 'stable';
}

function matchScore(previous, next) {
  // 返回 {score, match} 或 null。match 是证据来源，决定 confidence。
  if (previous.kind !== next.kind) return null;
  if (previous.kind === 'ref' && previous.ref && next.ref && previous.ref === next.ref) {
    return { score: 0.97, match: 'ref' };
  }
  if (previous.kind === 'region' && previous.regionIndex != null && previous.regionIndex === next.regionIndex
    && previous.tag && previous.tag === next.tag && (previous.domId || '') === (next.domId || '')) {
    return { score: 0.88, match: 'region-index' };
  }
  if (previous.signature && previous.signature === next.signature) {
    return { score: 0.82, match: 'signature' };
  }
  const iou = visualIoU(previous.rect, next.rect);
  if (iou >= VISUAL_IDENTITY_LIMITS.minIou) {
    return { score: Math.round((0.45 + iou * 0.35) * 1000) / 1000, match: 'geometry' };
  }
  return null;
}

function uniqueVoId(base, used) {
  let candidate = base;
  let suffix = 1;
  while (used.has(candidate)) {
    candidate = base + '-' + suffix;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

/**
 * 给视觉对象分配稳定身份，并与上一轮观察做变化匹配。
 * @param {object[]} objects 本轮 visualObjects
 * @param {{previous?:object[], revision?:number|null, documentId?:string|null, limits?:object}} [options]
 */
export function assignVisualIdentity(objects, options = {}) {
  const limits = { ...VISUAL_IDENTITY_LIMITS, ...(options.limits && typeof options.limits === 'object' ? options.limits : {}) };
  const maxObjects = limitOf(options.limit != null ? options.limit : limits.objects, VISUAL_IDENTITY_LIMITS.objects, 2000);
  const maxPrevious = limitOf(options.previousLimit != null ? options.previousLimit : limits.previous, VISUAL_IDENTITY_LIMITS.previous, 2000);
  const list = (Array.isArray(objects) ? objects : []).slice(0, maxObjects);
  const previousList = (Array.isArray(options.previous) ? options.previous : []).slice(0, maxPrevious).map(previousOf);
  const usedIds = new Set();
  for (const previous of previousList) if (previous.voId) usedIds.add(previous.voId);

  const matchedPrevious = new Set();
  const items = [];
  const truncated = (Array.isArray(objects) ? objects.length : 0) > list.length
    || (Array.isArray(options.previous) ? options.previous.length : 0) > previousList.length;
  for (let index = 0; index < list.length; index += 1) {
    const object = list[index] && typeof list[index] === 'object' ? list[index] : { kind: 'object' };
    const signature = visualSignature(object, { quantizeStep: limits.quantizeStep });
    const next = previousOf({ ...object, voId: null });
    next.signature = signature.signature;
    let best = null;
    for (let pIndex = 0; pIndex < previousList.length; pIndex += 1) {
      const previous = previousList[pIndex];
      if (!previous || matchedPrevious.has(pIndex)) continue;
      const candidate = matchScore(previous, next);
      if (!candidate) continue;
      if (!best || candidate.score > best.score) best = { ...candidate, index: pIndex, previous };
    }
    if (best) {
      matchedPrevious.add(best.index);
      const change = classifyChange(best.previous, next);
      const voId = best.previous.voId || uniqueVoId(signature.signature, usedIds);
      usedIds.add(voId);
      items.push({
        ...object,
        voId,
        identity: {
          version: VOM_VISUAL_IDENTITY_VERSION,
          signature: signature.signature,
          change,
          match: best.match,
          confidence: best.score,
          previousVoId: best.previous.voId,
          revision: Number.isInteger(options.revision) ? options.revision : null,
          documentId: options.documentId == null ? null : String(options.documentId),
          evidence: {
            iou: Math.round(visualIoU(best.previous.rect, next.rect) * 1000) / 1000,
            movedPx: Number.isFinite(centerDistance(best.previous.center, next.center)) ? Math.round(centerDistance(best.previous.center, next.center) * 100) / 100 : null,
            refMatch: best.match === 'ref',
            geometryMatch: best.match === 'geometry' || best.match === 'region-index',
          },
        },
      });
    } else {
      items.push({
        ...object,
        voId: uniqueVoId(signature.signature, usedIds),
        identity: {
          version: VOM_VISUAL_IDENTITY_VERSION,
          signature: signature.signature,
          change: 'added',
          match: null,
          confidence: 1,
          previousVoId: null,
          revision: Number.isInteger(options.revision) ? options.revision : null,
          documentId: options.documentId == null ? null : String(options.documentId),
          evidence: { iou: null, movedPx: null, refMatch: false, geometryMatch: false },
        },
      });
    }
  }
  const removed = [];
  for (let index = 0; index < previousList.length; index += 1) {
    if (matchedPrevious.has(index)) continue;
    const previous = previousList[index];
    removed.push({
      voId: previous.voId,
      kind: previous.kind,
      ref: previous.ref,
      tag: previous.tag,
      domId: previous.domId,
      index: previous.regionIndex,
      rect: previous.rect,
      change: 'removed',
    });
  }
  const changes = { stable: 0, moved: 0, resized: 0, replaced: 0, added: 0, removed: removed.length };
  for (const item of items) {
    const change = item.identity && item.identity.change;
    if (change && changes[change] != null && change !== 'removed') changes[change] += 1;
  }
  return {
    version: VOM_VISUAL_IDENTITY_VERSION,
    objects: items,
    removed,
    changes,
    counts: {
      objects: items.length,
      previous: previousList.length,
      matched: matchedPrevious.size,
      removed: removed.length,
      identity: items.filter((item) => item.voId).length,
    },
    previousRevision: Number.isInteger(options.previousRevision) ? options.previousRevision : null,
    revision: Number.isInteger(options.revision) ? options.revision : null,
    truncated,
  };
}

/**
 * 视觉对象的动作闭环：能点/能悬停的具体目标；缺证据时标 blockedReason。
 * @param {object} object 带 voId 的 visualObject
 * @param {{nodes?:object[], dpr?:number, viewport?:object|null}} [options]
 */
export function visualActionClosure(object, options = {}) {
  const item = object && typeof object === 'object' ? object : {};
  // DPR 未知时不要拿 1 冒充：image 坐标返回 null，只给 DIP point。
  const dprValue = Number(options.dpr);
  const dpr = Number.isFinite(dprValue) && dprValue > 0 ? dprValue : null;
  const rect = visualRect(item);
  const kind = String(item.kind || 'object');
  const nodeByRef = options.nodes instanceof Map
    ? options.nodes
    : new Map((Array.isArray(options.nodes) ? options.nodes : []).filter((node) => node && node.ref).map((node) => [String(node.ref), node]));
  const evidence = {
    rect: Boolean(rect),
    ref: Boolean(item.ref),
    backendNodeId: false,
    dpr,
    actionable: false,
  };
  if (!rect) {
    return { voId: item.voId || null, kind, actionable: false, blockedReason: 'no-geometry', targets: [], evidence };
  }
  const center = centerOf(rect);
  const image = dpr ? { x: Math.round(center.x * dpr * 100) / 100, y: Math.round(center.y * dpr * 100) / 100 } : null;
  const viewport = options.viewport && typeof options.viewport === 'object' ? options.viewport : null;
  if (viewport && Number.isFinite(Number(viewport.width)) && Number(viewport.height) > 0) {
    const inside = center.x >= Number(viewport.x || 0) && center.y >= Number(viewport.y || 0)
      && center.x <= Number(viewport.x || 0) + Number(viewport.width)
      && center.y <= Number(viewport.y || 0) + Number(viewport.height);
    evidence.inViewport = inside;
  }
  if (kind === 'ref') {
    const ref = item.ref ? String(item.ref) : null;
    const node = ref ? nodeByRef.get(ref) : null;
    const backendNodeId = Number.isInteger(Number(item.backendNodeId))
      ? Number(item.backendNodeId)
      : (node && Number.isInteger(Number(node.backendNodeId)) ? Number(node.backendNodeId) : null);
    evidence.backendNodeId = Number.isInteger(backendNodeId) && backendNodeId > 0;
    const stableRef = item.stableRef || (node && node.stableRef ? node.stableRef : null);
    const baseTarget = {
      ref,
      stableRef: stableRef || null,
      backendNodeId: evidence.backendNodeId ? backendNodeId : null,
      point: center,
      image,
      dpr,
    };
    const targets = [];
    if (ref) {
      targets.push({ method: 'click', via: 'ref', ...baseTarget });
      targets.push({ method: 'hover', via: 'ref', ...baseTarget });
    }
    if (evidence.backendNodeId) {
      targets.push({ method: 'click-backend', via: 'backendNodeId', backendNodeId, point: center, image, dpr });
    }
    const actionable = targets.length > 0 && evidence.inViewport !== false;
    return {
      voId: item.voId || null,
      kind,
      actionable,
      blockedReason: actionable ? null : (evidence.inViewport === false ? 'offscreen' : 'no-action-target'),
      targets,
      evidence,
    };
  }
  // region（canvas/图片/自绘区域）：没有 ref 时不伪造，走 screenshot --visual → click --capture 两步链。
  // 第二步需要 DPR 换算出的图像坐标；DPR 未知时只给第一步，并标 dpr-unknown。
  const index = Number.isInteger(item.index) ? item.index : null;
  const targets = index == null
    ? []
    : [
      { method: 'screenshot', via: 'visual', params: { visual: index }, point: center, image, dpr },
      ...(image ? [{ method: 'click-capture', via: 'visual', params: { visual: index, imageX: image.x, imageY: image.y }, point: center, image, dpr }] : []),
    ];
  const actionable = targets.length > 1 && evidence.inViewport !== false;
  return {
    voId: item.voId || null,
    kind,
    actionable,
    blockedReason: actionable
      ? null
      : (evidence.inViewport === false ? 'offscreen' : (index == null ? 'no-action-target' : 'dpr-unknown')),
    targets,
    evidence,
  };
}

/**
 * 给一组视觉对象补 closure 并汇总（observe 输出 vomVisualIdentity）。
 * @param {object} report assignVisualIdentity() 结果
 * @param {{nodes?:object[], dpr?:number, viewport?:object|null, limit?:number}} [options]
 */
export function summarizeVisualIdentity(report, options = {}) {
  const objects = report && Array.isArray(report.objects) ? report.objects : [];
  const closures = [];
  const max = limitOf(options.limit, 24, 200);
  let actionable = 0;
  let blocked = 0;
  const blockedReasons = {};
  for (const object of objects) {
    const closure = visualActionClosure(object, options);
    if (closure.actionable) actionable += 1;
    else {
      blocked += 1;
      const reason = closure.blockedReason || 'unknown';
      blockedReasons[reason] = (blockedReasons[reason] || 0) + 1;
    }
    if (closures.length < max) {
      closures.push({
        voId: object.voId || null,
        kind: object.kind || null,
        index: Number.isInteger(object.index) ? object.index : null,
        ref: object.ref || null,
        change: object.identity && object.identity.change ? object.identity.change : null,
        confidence: object.identity && object.identity.confidence != null ? object.identity.confidence : null,
        signature: object.identity && object.identity.signature ? object.identity.signature : null,
        actionable: closure.actionable,
        blockedReason: closure.blockedReason,
        targets: closure.targets.map((target) => ({
          method: target.method,
          via: target.via,
          ref: target.ref || null,
          backendNodeId: target.backendNodeId || null,
          point: target.point || null,
          ...(target.params ? { params: target.params } : {}),
        })),
        evidence: closure.evidence,
      });
    }
  }
  return {
    version: VOM_VISUAL_IDENTITY_VERSION,
    available: objects.length > 0,
    counts: {
      objects: objects.length,
      actionable,
      blocked,
      identity: objects.filter((object) => object.voId).length,
      ...(report && report.counts ? { previous: report.counts.previous || 0, matched: report.counts.matched || 0 } : {}),
    },
    changes: report && report.changes ? { ...report.changes } : {},
    blockedReasons,
    removed: report && Array.isArray(report.removed) ? report.removed.slice(0, max) : [],
    objects: closures,
    truncated: Boolean(report && report.truncated) || objects.length > max,
  };
}

/** 一行诊断文本（observe 的 vomVisualIdentityText）。 */
export function describeVisualIdentity(summary) {
  if (!summary || typeof summary !== 'object') return '';
  const counts = summary.counts || {};
  const changes = summary.changes || {};
  const parts = ['visual objects=' + (counts.objects || 0) + ' actionable=' + (counts.actionable || 0)];
  const changeParts = ['added', 'removed', 'moved', 'resized', 'replaced'].filter((key) => Number(changes[key]) > 0).map((key) => key + '=' + Number(changes[key]));
  if (changeParts.length) parts.push('changes ' + changeParts.join('+'));
  if (Number(counts.blocked) > 0) parts.push('blocked=' + Number(counts.blocked));
  if (summary.truncated) parts.push('truncated');
  return parts.join(' ');
}

export function visualIdentityVersion() {
  return VOM_VISUAL_IDENTITY_VERSION;
}

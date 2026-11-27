// tools/longtail/lib/model.mjs —— 夹具 → 真实模块输入形状的转换层（纯函数）。
//
// 生成器刻意只产出"页面图 / HAR / step / segment"这类**原始事实**，不直接产出任何模块的内部结构；
// 转换层负责把原始事实适配成各真实模块的公开入参：
//   - 页面图：{graph:{nodes,edges}, nodes:[observed]} → buildVomGraph 入参；
//   - observed 节点：{graphKey,ref,tag,role,name,ancestors,...} → buildVomRelationGraph 的 entries；
//   - frame entries：{frameId,parentFrameId,graph,nodes,iframeOwners} → buildFrameVomGraphs 入参；
//   - frame-vom 输出 + 帧元数据 → buildFrameDepthReport / buildCrossFrameRelations 入参；
//   - HAR entries → buildWaterfall / attributeWaterfall 的 network entry 形状。
//
// 这里不做任何"编造事实"：ancestors 来自夹具的 parentKey 父链，frame 的 parentFrameId/hidden
// 来自夹具本身，HAR 的 timing 偏移由 HAR timings 分项换算（见 harEntryToNetworkEntry）。
// 转换结果里带 `source` 字段便于报告写清"哪一步是真模块、哪一步只是适配"。

/** 祖先事实：关系图/语义分组只读这些公开字段。 */
function ancestorFact(node) {
  return {
    tag: node.tag || '',
    role: node.role || '',
    id: node.domId == null ? null : String(node.domId),
    ref: node.ref || '',
    name: node.name || '',
  };
}

function graphOfEntry(fixture, frameId) {
  const entries = fixture && Array.isArray(fixture.entries) ? fixture.entries : [];
  return entries.find((entry) => entry.frameId === frameId) || null;
}

/**
 * 把一帧的夹具节点摊平成 VOM 的 observed 节点列表。
 * - graphKey 与原始图的 node.key 对齐（buildVomGraph 用它把 observed 的 ref 映射到图节点）；
 * - ancestors 是从 parentKey 上溯得到的公开事实（供关系图/语义分组使用）。
 */
export function observedNodesOf(fixture, frameId = 0) {
  const entry = graphOfEntry(fixture, frameId);
  if (!entry) return [];
  const nodes = Array.isArray(entry.graph.nodes) ? entry.graph.nodes : [];
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  return nodes.map((node) => {
    const ancestors = [];
    let current = node;
    let guard = 0;
    while (current && current.parentKey && guard < 64) {
      const parent = byKey.get(current.parentKey);
      if (!parent) break;
      ancestors.push(ancestorFact(parent));
      current = parent;
      guard += 1;
    }
    return {
      graphKey: node.key,
      ref: node.ref || null,
      stableRef: node.stableRef || null,
      tag: node.tag || '',
      role: node.role || '',
      name: node.name || '',
      domId: node.domId == null ? null : String(node.domId),
      frameIndex: node.frameIndex == null ? null : Number(node.frameIndex),
      srcUrl: node.srcUrl || null,
      anchor: node.anchor || null,
      ancestors,
      rect: node.rect || null,
      visible: node.visible !== false,
      pointerEvents: node.pointerEvents || null,
      hitTest: node.hitTest || null,
      interactive: node.interactive === true,
      clickable: node.clickable === true,
      text: node.text || '',
    };
  });
}

/** observed 节点 → buildVomRelationGraph 的 entries（id 用 ref，node 用富化事实）。 */
export function relationEntriesOf(fixture, frameId = 0) {
  return observedNodesOf(fixture, frameId).map((observed) => ({
    id: observed.ref,
    node: {
      id: observed.domId,
      tag: observed.tag,
      role: observed.role,
      name: observed.name,
      rect: observed.rect,
      visible: observed.visible,
      pointerEvents: observed.pointerEvents,
      hitTest: observed.hitTest,
      interactive: observed.interactive,
      clickable: observed.clickable,
      text: observed.text,
      ancestors: observed.ancestors,
      anchor: observed.anchor,
    },
    source: 'longtail.page',
  }));
}

/** buildVomGraph 的一帧入参：原始页面图 + observed 列表。 */
export function pageGraphInput(fixture, frameId = 0) {
  const entry = graphOfEntry(fixture, frameId);
  return {
    graph: entry ? entry.graph : null,
    nodes: observedNodesOf(fixture, frameId),
    source: 'longtail.page#frame' + frameId,
  };
}

/** buildFrameVomGraphs 入参：每帧一个 entry（含自己的原始图与 observed 节点）。 */
export function frameVomEntries(fixture) {
  const entries = fixture && Array.isArray(fixture.entries) ? fixture.entries : [];
  return entries.map((entry) => ({
    frameId: entry.frameId,
    parentFrameId: entry.parentFrameId == null ? null : entry.parentFrameId,
    frameIndex: entry.frameIndex,
    url: entry.url,
    hidden: entry.hidden === true,
    iframeOwners: Array.isArray(entry.iframeOwners) ? entry.iframeOwners : [],
    graph: entry.graph,
    nodes: observedNodesOf(fixture, entry.frameId),
  }));
}

/**
 * 给 buildFrameVomGraphs 的输出补上帧元数据（parentFrameId / hidden）。
 * frame-vom 子图本身不含父帧 id（它是逐帧构建的），跨帧关系需要它；
 * 元数据来自夹具同一份 frames 列表，不是推断。
 */
export function attachFrameMeta(frameVom, fixture) {
  const graphs = frameVom && Array.isArray(frameVom.graphs) ? frameVom.graphs : [];
  const metaById = new Map();
  for (const entry of fixture && Array.isArray(fixture.entries) ? fixture.entries : []) {
    metaById.set(entry.frameId, entry);
  }
  return graphs.map((graph) => {
    const meta = metaById.get(graph.frameId);
    return {
      ...graph,
      parentFrameId: meta && meta.parentFrameId != null ? meta.parentFrameId : null,
      hidden: Boolean(meta && meta.hidden),
      title: meta ? meta.title : '',
    };
  });
}

/** buildFrameDepthReport 入参：帧列表（挂 .vom 子图）+ 上游 summary。 */
export function frameDepthInput(fixture, frameVom) {
  const graphs = frameVom && Array.isArray(frameVom.graphs) ? frameVom.graphs : [];
  const metaById = new Map();
  for (const entry of fixture && Array.isArray(fixture.entries) ? fixture.entries : []) {
    metaById.set(entry.frameId, entry);
  }
  const frames = graphs.map((graph) => {
    const meta = metaById.get(graph.frameId) || {};
    return {
      frameId: graph.frameId,
      parentFrameId: meta.parentFrameId == null ? null : meta.parentFrameId,
      url: graph.url || meta.url || '',
      title: meta.title || '',
      hidden: meta.hidden === true,
      vom: graph,
    };
  });
  return { frames, vomFrames: frameVom && frameVom.summary ? frameVom.summary : null };
}

/** buildVomRelationGraph 入参。 */
export function relationInput(fixture, { graph = null, semantic = null, frameGraphs = null, limits = null } = {}) {
  return {
    entries: relationEntriesOf(fixture, 0),
    graph,
    semantic,
    frames: frameGraphs,
    ...(limits && typeof limits === 'object' ? { limits } : {}),
    source: 'longtail.page',
  };
}

// ---------------------------------------------------------------------------
// HAR → 网络瀑布/归因入参
// ---------------------------------------------------------------------------

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * 把一条 HAR entry 换算成 buildWaterfall/attributeWaterfall 的 network entry。
 *
 * 计时口径（真实 HAR 分项 → CDP timing 偏移）：
 *   queueing = blocked；dnsStart/End、connectStart/End、sendStart/End 依次累加；
 *   receiveHeadersEnd = sendEnd + wait；receive = time - receiveHeadersEnd。
 *
 * openTail 用于模拟"抓取时仍在进行中的流式请求"：这些 entry finished=false / streaming=true，
 * attribution 必须保留 live-until-now 语义（auditCompletion 会检查不伪造 finished）。
 */
export function harEntryToNetworkEntry(entry, options = {}) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const opts = options && typeof options === 'object' ? options : {};
  const request = source.request && typeof source.request === 'object' ? source.request : {};
  const response = source.response && typeof source.response === 'object' ? source.response : {};
  const timings = source.timings && typeof source.timings === 'object' ? source.timings : {};
  const blocked = positive(timings.blocked);
  const dns = positive(timings.dns);
  const connect = positive(timings.connect);
  const send = positive(timings.send);
  const wait = positive(timings.wait);
  const receive = positive(timings.receive);
  const startedAt = Number.isFinite(Number(source._startedAt))
    ? Number(source._startedAt)
    : Date.parse(String(source.startedDateTime));
  const durationMs = Number.isFinite(Number(source.time)) ? Number(source.time) : (blocked + dns + connect + send + wait + receive);
  const sendStart = blocked + dns + connect;
  const receiveHeadersEnd = sendStart + send + wait;
  const finished = opts.open === true ? false : true;
  const status = Number(response.status);
  return {
    id: source._requestId || ('har-' + (opts.index == null ? 0 : opts.index)),
    requestId: source._requestId || null,
    method: String(request.method || 'GET'),
    url: String(request.url || ''),
    status: Number.isFinite(status) ? status : null,
    type: String(source._resourceType || ''),
    resourceType: String(source._resourceType || ''),
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    responseAt: Number.isFinite(startedAt) ? startedAt + receiveHeadersEnd : null,
    ...(finished ? { finishedAt: Number.isFinite(startedAt) ? startedAt + durationMs : null } : {}),
    ...(finished ? { durationMs } : {}),
    finished,
    // 不显式声明 streaming：buildWaterfall 会按 "finished=false 且 status>0" 推导，
    // 显式 streaming=true 会被 auditCompletion 视为"声称流式但没给 finished"，与真实抓取语义不符。
    responseBytes: Number(response.bodySize) || 0,
    transferSize: Number(source._transferSize) || Number(response.bodySize) || 0,
    frameId: source._frameId == null ? null : source._frameId,
    documentURL: source._documentURL ? String(source._documentURL) : '',
    timing: {
      dnsStart: blocked,
      dnsEnd: blocked + dns,
      connectStart: blocked + dns,
      connectEnd: blocked + dns + connect,
      sendStart,
      sendEnd: sendStart + send,
      receiveHeadersEnd,
    },
    // 与 HAR 原始分项并列保留，报告里可与 timings 对账。
    harTimings: { blocked, dns, connect, send, wait, receive },
  };
}

/** 批量转换；openTail 把末尾 N 条标成"抓取时未完成"的流式请求。 */
export function harToNetworkEntries(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const openTail = Math.max(0, Math.floor(Number(options.openTail) || 0));
  return list.map((entry, index) => harEntryToNetworkEntry(entry, {
    index,
    open: openTail > 0 && index >= list.length - openTail,
  }));
}

/** frame 注册表（correlateFrames / buildWaterfall 的 frames 选项）。 */
export function frameRegistryOf(frames) {
  return (Array.isArray(frames) ? frames : []).map((frame) => ({
    frameId: frame.frameId,
    parentFrameId: frame.parentFrameId == null ? null : frame.parentFrameId,
    depth: Number(frame.depth) || 0,
    path: String(frame.path || frame.frameId),
    url: String(frame.url || ''),
  }));
}

/** 网络 entry 的体量摘要（报告用）。 */
export function summarizeNetworkEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let bytes = 0;
  let finished = 0;
  let streaming = 0;
  const byType = {};
  const byFrame = {};
  for (const entry of list) {
    bytes += Number(entry.transferSize) || 0;
    if (entry.finished === true) finished += 1;
    if (entry.streaming === true) streaming += 1;
    byType[entry.type || '(unknown)'] = (byType[entry.type || '(unknown)'] || 0) + 1;
    const frameId = entry.frameId == null ? 'null' : String(entry.frameId);
    byFrame[frameId] = (byFrame[frameId] || 0) + 1;
  }
  return { count: list.length, bytes, finished, streaming, byType, byFrame };
}

/** 夹具统计摘要（页面/网络共用；报告 evidence 里用）。 */
export function summarizeFixture(fixture) {
  if (!fixture || typeof fixture !== 'object') return null;
  return {
    kind: fixture.kind || '',
    seed: fixture.seed == null ? null : String(fixture.seed),
    profile: fixture.profile || '',
    fingerprint: fixture.fingerprint || null,
    stats: fixture.stats || null,
  };
}

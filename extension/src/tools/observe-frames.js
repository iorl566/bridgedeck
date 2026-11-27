import { execPage, execPageAllFrames } from '../inject.js';
import { ensureFrameGraph } from '../frame-graph.js';
import { matchBrowserFrame, readBrowserFrames } from './frame-identity.js';
import { collectCdpFrames } from '../frame-cdp.js';
import { setFrameAliases } from './frames.js';
import { requireTabId } from './shared.js';
import { buildFrameVomGraphs } from '../lib/frame-vom.js';
import { classifyFrameGap, summarizeFrameGaps } from '../lib/frame-gaps.js';
import { send as cdpSend } from '../debugger.js';
import { createRepairTracker } from '../lib/frame-repairs.js';

async function readFrameOwner(tabId, frameId) {
  try {
    const owner = await cdpSend(tabId, 'DOM.getFrameOwner', { frameId });
    if (!owner || !owner.backendNodeId) return null;
    const resolved = await cdpSend(tabId, 'DOM.resolveNode', { backendNodeId: owner.backendNodeId });
    const objectId = resolved && resolved.object && resolved.object.objectId;
    if (!objectId) return null;
    const called = await cdpSend(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function(){return {src:this.getAttribute("src")||"",srcdoc:this.hasAttribute("srcdoc"),name:this.getAttribute("name")||"",id:this.id||""};}',
      returnByValue: true,
    });
    cdpSend(tabId, 'Runtime.releaseObject', { objectId }).catch(() => {});
    return (called && called.result && called.result.value) || null;
  } catch {
    return null;
  }
}

const repairTracker = createRepairTracker();

/** observe-frames：所有 frame（含跨源）分别观察，ref 统一为 @eN，并记录 frame 映射。 */
export async function observeFrames(params = {}) {
  const tabId = requireTabId(params);
  const allowUnchanged = params.smart === true && params.force !== true;
  const listArgs = { probeHover: params.probeHover === true, maxDepth: params.maxDepth, debugSurfaces: params.debugSurfaces === true, force: params.force === true, vom: params.vom === true };
  const list = await execPageAllFrames(tabId, 'observe', listArgs);
  // 单 frame 页面没变：交回 unchanged，让 daemon 用缓存补文本（别把空文本当成新观察）。
  if (allowUnchanged && list.length === 1 && list[0].result && list[0].result.unchanged === true) {
    return {
      frames: [{ frameId: list[0].frameId, url: list[0].result.url || '', title: list[0].result.title || '', refs: list[0].result.refs || 0, observation: '' }],
      text: '',
      refs: list[0].result.refs || 0,
      aliases: [],
      unchanged: true,
      ...(list[0].result.mutations ? { mutations: list[0].result.mutations } : {}),
      url: list[0].result.url || '',
      title: list[0].result.title || '',
    };
  }
  const graph = await ensureFrameGraph(tabId).catch(() => []);
  const graphById = new Map(graph.map((item) => [item.frameId, item]));
  const browserFrames = await readBrowserFrames(tabId);
  const liveRepairKeys = new Set(
    (Array.isArray(browserFrames) ? browserFrames : []).map((frame) => String(frame.frameId) + ':' + (frame.documentId || frame.url || '')),
  );
  repairTracker.reconcile(tabId, liveRepairKeys);
  const metaList = await execPageAllFrames(tabId, 'frame-meta', {}).catch(() => []);
  const metaById = new Map(metaList.filter((item) => item && item.result).map((item) => [item.frameId, item.result]));
  const frames = [];
  const frameGraphs = new Map();
  const aliases = [];
  const mutationTotals = { text: 0, added: 0, removed: 0, attributes: 0, total: 0, layout: false, interaction: false };
  let aliasSeq = 0;
  for (let item of list) {
    const resultUrl = item && item.result ? item.result.url : '';
    const canonical = matchBrowserFrame(browserFrames, { frameId: item.frameId, url: resultUrl });
    const frameId = canonical ? canonical.frameId : item.frameId;
    const documentId = canonical ? canonical.documentId : undefined;
    if ((item.error || !item.result) && Number(item.frameId) > 0) {
      const visibility = metaById.get(item.frameId) || {};
      const decision = repairTracker.plan(tabId, frameId + ':' + (documentId || resultUrl || 'frame'), { hidden: visibility.hidden === true });
      if (decision === 'repair') {
        const retried = await execPage(tabId, 'observe', { ...listArgs, force: true }, frameId).catch(() => null);
        const repaired = Boolean(retried && retried.observation);
        repairTracker.finish(repaired);
        if (repaired) item = { frameId, result: retried };
      }
    }
    if (item.error || !item.result) {
      const meta = graphById.get(item.frameId) || {};
      const visibility = metaById.get(item.frameId) || {};
      const hidden = visibility.hidden === true;
      const gap = classifyFrameGap({ error: item.error || 'no result', hidden, message: item.error || '' });
      const owner = await readFrameOwner(tabId, frameId);
      const ownerSrc = owner && owner.src ? String(owner.src) : '';
      const ownerUrl = ownerSrc && !/^about:(blank|srcdoc)/i.test(ownerSrc) ? ownerSrc : '';
      frames.push({
        frameId,
        parentFrameId: (canonical && canonical.parentFrameId) || meta.parentFrameId,
        documentId,
        url: meta.url || '',
        title: '',
        refs: 0,
        hidden,
        hiddenReason: visibility.reason || null,
        ...(owner ? { ownerSrc, ownerName: owner.name || '', ownerId: owner.id || '', ownerHasSrcdoc: owner.srcdoc === true, ...(ownerUrl ? { ownerUrl } : {}) } : {}),
        ...(gap ? { gap } : {}),
        observation: gap === 'hidden_frame' ? '' : '（该 frame 不可观察：' + (item.error || 'no result') + '）',
        error: item.error || 'no result',
      });
      continue;
    }
    let result = item.result;
    if (allowUnchanged && result.unchanged === true) {
      // 多 frame 页面里个别 frame 没变：单独强制重取该 frame，保证合并文本完整。
      const refreshed = await execPage(tabId, 'observe', { ...listArgs, force: true }, item.frameId).catch(() => null);
      if (refreshed) result = refreshed;
    }
    if (result.mutations) {
      mutationTotals.text += Number(result.mutations.text) || 0;
      mutationTotals.added += Number(result.mutations.added) || 0;
      mutationTotals.removed += Number(result.mutations.removed) || 0;
      mutationTotals.attributes += Number(result.mutations.attributes) || 0;
      mutationTotals.layout = mutationTotals.layout || result.mutations.layout === true;
      mutationTotals.interaction = mutationTotals.interaction || result.mutations.interaction === true;
    }
    const meta = graphById.get(item.frameId) || {};
    const visibility = metaById.get(item.frameId) || {};
    if (params.vom === true) {
      frameGraphs.set(frameId, { graph: result.graph || null, nodes: Array.isArray(result.nodes) ? result.nodes : [], url: result.url || meta.url || '' });
    }
    const observation = String(result.observation || '').replace(/\[@e(\d+)\]/g, (match, n) => {
      aliasSeq += 1;
      const alias = '@e' + aliasSeq;
      aliases.push({ ref: alias, frameId, localRef: '@e' + n, url: String(result.url || '') });
      return '[' + alias + ']';
    });
    frames.push({
      frameId,
      parentFrameId: (canonical && canonical.parentFrameId) || meta.parentFrameId,
      documentId,
      url: result.url || meta.url || '',
      title: result.title || '',
      refs: typeof result.refs === 'number' ? result.refs : 0,
      hidden: visibility.hidden === true,
      hiddenReason: visibility.reason || null,
      ...(visibility.hidden === true ? { gap: 'hidden_frame' } : {}),
      offscreen: visibility.offscreen === true,
      frameSize: visibility.width != null ? { width: visibility.width, height: visibility.height } : null,
      observation,
    });
  }
  frames.sort((x, y) => {
    const a = Number(x.frameId);
    const b = Number(y.frameId);
    if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
    return String(x.frameId).localeCompare(String(y.frameId));
  });
  // 注入失败（跨源/沙箱/受限）的 frame 用 CDP 兜底采集；--cdp-frames 可强制用于诊断。
  let cdpFallback = false;
  let cdpFrameCount = 0;
  if (params.cdpFrames === true || list.some((item) => item && item.error)) {
    const observedUrls = new Set(frames.map((frame) => frame.url).filter(Boolean));
    const collected = await collectCdpFrames(tabId, { maxNodes: params.cdpMaxNodes }).catch(() => []);
    for (const frame of collected) {
      if (!frame || !frame.text) continue;
      if (params.cdpFrames !== true && observedUrls.has(frame.url)) continue;
      if (frames.some((item) => item.cdp === true && item.url === frame.url)) continue;
      frames.push({
        frameId: frame.frameId,
        parentFrameId: null,
        url: frame.url,
        title: '',
        refs: 0,
        hidden: false,
        hiddenReason: null,
        observation: frame.text,
        cdp: true,
        cdpSessionId: frame.sessionId || null,
      });
      cdpFallback = true;
      cdpFrameCount += 1;
    }
  }
  // 跨源 frame 的 frameElement 不可见：用父 frame 的 iframe 元素可见性补标。
  for (const frame of frames) {
    if (frame.hidden === true) continue;
    const parent = metaById.get(frame.parentFrameId);
    const child = parent && Array.isArray(parent.children)
      ? parent.children.find((item) => item && item.url && item.url === frame.url)
      : null;
    if (child && child.hidden === true) {
      frame.hidden = true;
      frame.hiddenReason = child.reason || 'not-visible';
      frame.offscreen = child.offscreen === true;
      if (child.width != null) frame.frameSize = { width: child.width, height: child.height };
    }
  }
  const aliasMap = new Map();
  for (const entry of aliases) aliasMap.set(entry.ref, { frameId: entry.frameId, localRef: entry.localRef, url: entry.url, documentId: entry.documentId });
  setFrameAliases(tabId, aliasMap);
  // 跨源 iframe 子图：每帧各自一张图，id 加 f<frameId>: 前缀，并用 frame:<frameId> 连到 roots。
  // iframe 元素 → 子帧的匹配在 buildFrameVomGraphs 内按父图 iframe 节点的 srcUrl 做（支持嵌套）。
  let frameVom = null;
  if (params.vom === true) {
    const entries = frames
      .filter((frame) => frame && !frame.error && frame.cdp !== true)
      .map((frame) => {
        const captured = frameGraphs.get(frame.frameId) || {};
        return {
          frameId: frame.frameId,
          url: frame.url,
          parentFrameId: frame.parentFrameId,
          graph: captured.graph || null,
          nodes: captured.nodes || [],
        };
      });
    const childFrames = frames
      .filter((frame) => frame && !frame.error && frame.cdp !== true)
      .map((frame) => ({
        frameId: frame.frameId,
        url: frame.url,
        parentFrameId: Number.isInteger(frame.parentFrameId) ? frame.parentFrameId : 0,
        hidden: frame.hidden === true,
      }));
    frameVom = buildFrameVomGraphs(entries, { childFrames });
    const byFrame = new Map(frameVom.graphs.map((graph) => [graph.frameId, graph]));
    for (const frame of frames) {
      if (!frame || frame.error || frame.cdp === true) continue;
      const sub = byFrame.get(frame.frameId);
      if (sub) frame.vom = sub;
    }
  }
  const text = frames.map((frame) => 'frame ' + frame.frameId + ' ' + frame.url + '\n' + frame.observation).join('\n\n');
  const gapInfo = summarizeFrameGaps(frames);
  const mainRevision = typeof list[0]?.result?.revision === 'number' ? list[0].result.revision : null;
  mutationTotals.total = mutationTotals.text + mutationTotals.added + mutationTotals.removed + mutationTotals.attributes;
  return {
    frames,
    text,
    refs: frames.reduce((sum, frame) => sum + frame.refs, 0),
    aliases,
    hiddenFrames: frames.filter((frame) => frame.hidden === true).length,
    frameGaps: gapInfo.gaps,
    frameGapCounts: gapInfo.counts,
    frameRepairs: repairTracker.summary(),
    ...(mutationTotals.total || mutationTotals.layout || mutationTotals.interaction ? { mutations: mutationTotals } : {}),
    ...(cdpFallback ? { cdpFallback: true, cdpFrames: cdpFrameCount } : {}),
    ...(frameVom ? { vomFrames: frameVom.summary, vomLimits: frameVom.limits } : {}),
    ...(mainRevision != null ? { revision: mainRevision } : {}),
  };
}


// src/video.js —— 视频录制（tabCapture → offscreen MediaRecorder，优先 MP4；必要时调试器截帧）
import { acquire, onEvent, release, send as cdpSend } from './debugger.js';
import { injectVideoStatusChip, removeVideoStatusChip } from './video-status-chip.js';
import { log } from './log.js';
import { listRecords, readRecord, deleteRecord, patchRecord } from './lib/video-store.js';
import { verifyRecording } from './lib/video-verify.js';
import {
  createVideoStateMachine,
  recordingStateOf,
  restoreVideoStateMachine,
  stateEvidenceOf,
  summarizeStateMachine,
} from './lib/video-state.js';
import {
  BUDGET_CODES,
  budgetReport,
  clampDuration,
  evaluateBudget,
  normalizeBudget,
  summarizeBudgetEvaluation,
} from './lib/video-budget.js';
import { scanEncodedRecordings, clearEncodedParts, readSegmentManifest } from './lib/opfs-encoded-store.js';
import { auditRecoveredRecording, recoveryRecordPatch, summarizeRecovery, summarizeScan } from './lib/video-recovery.js';
import { inspectRecordSeal, verifyRecordSeal, summarizeSealCheck } from './lib/video-seal.js';
import {
  degradationRecordFields,
  mergeDegradationHistory,
  planBudgetDegradation,
  summarizeDegradation,
} from './lib/video-degrade.js';
import {
  planPartialReassembly,
  reconcileAssembled,
  restoreRecordFields,
  stalePartsPlan,
  summarizeRestore,
  summarizeStaleCleanup,
} from './lib/video-restore.js';
import {
  createPersistenceSession,
  describePersistence,
  persistenceFromRecord,
  persistenceRecordFields,
  persistenceStopReason,
  restorePersistenceParts,
} from './lib/video-persist.js';
import {
  persistSummaryOf,
  persistenceBrief,
  persistenceRecoveryView,
  persistenceVerifyView,
  sealPersistenceFromFragments,
} from './lib/video-persist-view.js';

const MAX_BYTES = 256 * 1024 * 1024;
const MAX_DURATION_MS = 10 * 60 * 1000;
const STATE_KEY = 'bb.video.state';
// 第十批-D：录制持久化会话（分片日记 + 帧校验 + 预算），SW 重启后可由 record 反建。
const PERSIST_KEY_PREFIX = 'bb.video.persist.';

let active = null; // { id, tabId, url, title, startedAt, mime, mode, timer, budget, machine }
const pendingStops = new Map(); // id -> resolve
let screencast = null;
let recordingMachine = null;
let persistenceSession = null;

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
}

function nowMs() {
  return Date.now();
}

async function persistRecordingState(machine) {
  if (!machine) return;
  try {
    await chrome.storage.local.set({ [STATE_KEY]: machine.snapshot() });
  } catch {
    // 状态持久化失败不影响录制本身（证据只在重启后缺一段）
  }
}

/** 懒恢复录制状态机：Service Worker 重启后从 chrome.storage.local 还原。 */
async function ensureRecordingMachine() {
  if (recordingMachine) return { machine: recordingMachine, restored: true, restoreEvidence: null };
  let snapshot = null;
  try {
    const stored = await chrome.storage.local.get(STATE_KEY);
    snapshot = stored && stored[STATE_KEY];
  } catch {
    snapshot = null;
  }
  const restored = restoreVideoStateMachine(snapshot, { now: nowMs });
  recordingMachine = restored.machine;
  return { machine: recordingMachine, restored: restored.restored === true, restoreEvidence: restored.evidence || null };
}

function transitionRecording(machine, event, detail) {
  if (!machine) return null;
  const result = machine.send(event, detail);
  if (result && result.ok) persistRecordingState(machine);
  return result;
}

function stateFields(machine) {
  return machine ? machine.toRecordFields() : {};
}

function budgetInputOf(params = {}) {
  const input = {};
  if (params.maxDurationMs != null) input.maxDurationMs = params.maxDurationMs;
  if (params.maxSegmentBytes != null) input.maxSegmentBytes = params.maxSegmentBytes;
  if (params.maxTotalBytes != null) input.maxTotalBytes = params.maxTotalBytes;
  if (params.maxConcurrent != null) input.maxConcurrent = params.maxConcurrent;
  return input;
}

/**
 * 第十批-D：持久化会话的 IO 侧辅助。纯视图在 lib/video-persist-view.js，这里只做 chrome.storage/IDB 读写。
 */
async function ensurePersistenceSession(recordingId) {
  if (persistenceSession && persistenceSession.recordingId === recordingId) return persistenceSession;
  const record = await readRecord(recordingId).catch(() => null);
  if (record) {
    const rebuilt = persistenceFromRecord({ ...record, recordingId }, { now: nowMs() });
    if (rebuilt) {
      persistenceSession = rebuilt;
      return persistenceSession;
    }
  }
  persistenceSession = createPersistenceSession({
    recordingId,
    now: nowMs(),
    mime: record && record.mime ? record.mime : '',
    mode: record && record.mode ? record.mode : '',
    budget: active && active.budget ? active.budget : undefined,
  });
  return persistenceSession;
}

/** 会话落盘：patched 到 record 的 persist_* / journal_* 字段（失败不影响录制本身）。 */
async function persistSessionFields(recordingId, session) {
  if (!recordingId || !session) return null;
  const fields = persistenceRecordFields(session);
  await patchRecord(recordingId, fields).catch(() => null);
  try {
    await chrome.storage.local.set({ [PERSIST_KEY_PREFIX + recordingId]: { state: session.state, segments: Array.isArray(session.segments) ? session.segments.length : 0, bytes: session.totalBytes, at: nowMs() } });
  } catch {
    // storage 写失败只是少一条重启证据，不影响录制/落库
  }
  return fields;
}



async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: '录制标签页视频',
  });
}

function requireTabId(params) {
  const tabId = Number(params && params.tabId);
  if (!Number.isInteger(tabId)) throw new Error('需要 tabId');
  return tabId;
}

function bitrateOf(quality) {
  return quality === 'high' ? 8000000 : 4000000;
}

/** 兜底录制：chrome.debugger 的 Page.startScreencast → offscreen canvas → MediaRecorder。 */
async function startViaDebugger(tabId, tab, recordingId, quality, durationMs, encoder) {
  const dbg = await acquire(tabId, 'record');
  try {
    await cdpSend(tabId, 'Page.enable').catch(() => {});
    const started = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'bb.rec.start-frames',
      recordingId,
      durationMs,
      tabId,
      url: String(tab.url || ''),
      title: tab.title || '',
      fps: 10,
      width: 1280,
      height: 800,
      bitrate: bitrateOf(quality),
      encoder: 'avc',
    });
    if (!started || started.ok === false) throw new Error((started && started.error) || '截帧录制启动失败');
    const unsubscribe = onEvent(dbg, 'Page.screencastFrame', (event) => {
      if (!event || !event.data) return;
      chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'bb.rec.frame',
        data: 'data:image/jpeg;base64,' + event.data,
      }).catch(() => {});
      cdpSend(tabId, 'Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    });
    await cdpSend(tabId, 'Page.startScreencast', {
      format: 'jpeg',
      quality: 70,
      maxWidth: 1280,
      maxHeight: 800,
      everyNthFrame: 1,
    });
    screencast = { tabId, unsubscribe };
    return { ok: true, mime: started.mime, startedAt: started.startedAt, mode: 'debugger' };
  } catch (error) {
    await release(tabId, 'record').catch(() => {});
    throw error;
  }
}

async function stopScreencast() {
  if (!screencast) return;
  const { tabId, unsubscribe } = screencast;
  screencast = null;
  try {
    await cdpSend(tabId, 'Page.stopScreencast');
  } catch {
    // 忽略
  }
  try {
    unsubscribe();
  } catch {
    // 忽略
  }
  await release(tabId, 'record').catch(() => {});
}

const VIDEO_TTL_MS = 24 * 60 * 60 * 1000;

async function pruneExpired(ttlOverride) {
  let ttl = Number(ttlOverride);
  if (!Number.isFinite(ttl) || ttl < 0) {
    ttl = VIDEO_TTL_MS;
    try {
      const stored = await chrome.storage.local.get('bb.video.ttlMs');
      const custom = Number(stored && stored['bb.video.ttlMs']);
      if (Number.isFinite(custom) && custom >= 0) ttl = custom;
    } catch {
      // 用默认
    }
  }
  const records = await listRecords();
  const now = Date.now();
  let removed = 0;
  for (const record of records) {
    const at = Number(record.endedAt) || Number(record.startedAt) || 0;
    if (at > 0 && now - at > ttl) {
      await deleteRecord(record.id);
      removed += 1;
    }
  }
  return { removed, ttlMs: ttl };
}

/** 过期清理：IDB 记录 + OPFS 残留分片目录（stalePartsPlan 决定去留，逐条核对后再删）。 */
export async function videoPrune(params = {}) {
  const pruned = await pruneExpired(params.ttlMs);
  const removed = pruned.removed;
  const records = await listRecords();
  let cleanup = null;
  let partsRemoved = 0;
  let partsFailed = 0;
  try {
    const recordings = await scanEncodedRecordings();
    if (recordings.length) {
      const stale = stalePartsPlan(recordings, { now: Date.now(), ttlMs: pruned.ttlMs });
      for (const item of stale.remove) {
        const ok = await clearEncodedParts(item.recordingId).catch(() => false);
        if (ok) partsRemoved += 1;
        else partsFailed += 1;
      }
      cleanup = summarizeStaleCleanup(stale);
    }
  } catch {
    cleanup = null;
  }
  if (removed) log('已清理过期录制 ' + removed + ' 条');
  if (partsRemoved) log('已清理过期分片目录 ' + partsRemoved + ' 个');
  return {
    ok: true,
    removed,
    remaining: records.length,
    ...(cleanup ? { cleanup, parts_removed: partsRemoved, ...(partsFailed ? { parts_failed: partsFailed } : {}) } : {}),
  };
}


export async function startVideo(params = {}) {
  const normalized = normalizeBudget(budgetInputOf(params), { base: { maxDurationMs: MAX_DURATION_MS, maxTotalBytes: MAX_BYTES } });
  const budget = normalized.budget;
  const bitrate = bitrateOf(params.quality);
  if (active) {
    // 并发预算：已有录制时拒绝启动，并给出结构化证据（不静默覆盖）。
    // wire 层用已登记的 E_SESSION_BUSY，内部 budget 证据仍保留明细码。
    const evaluation = evaluateBudget({ activeCount: 2, maxDurationMs: budget.maxDurationMs }, budget);
    const plan = planBudgetDegradation({ activeCount: 2, elapsedMs: 0, totalBytes: 0, bitrate }, budget, { evaluation, now: nowMs() });
    const error = new Error('已有录制进行中（' + active.id + '）');
    error.code = 'E_SESSION_BUSY';
    error.evidence = { ...evaluation.evidence, reason_code: evaluation.code, budget_plan: summarizeDegradation(plan) };
    throw error;
  }
  // 上一段截帧录制可能没停干净，先收尾
  await stopScreencast().catch(() => {});
  const tabId = requireTabId(params);
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error('标签页不存在或已关闭');
  }
  const url = String(tab.url || '');
  if (/^(chrome|edge|about|devtools|view-source|chrome-extension):/i.test(url)) {
    throw new Error('受限页面不能录制');
  }
  const recordingId = uuid();
  const durationPlan = clampDuration(params.durationMs, budget);
  const durationMs = durationPlan.durationMs;
  await ensureOffscreen();

  let result = null;
  if (params.encoder === 'avc' || params.forceFrames === true) {
    result = await startViaDebugger(tabId, tab, recordingId, params.quality, durationMs, 'avc');
  } else {
    try {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
      result = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'bb.rec.start',
        streamId,
        recordingId,
        tabId,
        url,
        title: tab.title || '',
        bitrate: bitrateOf(params.quality),
        encoder: 'avc',
        durationMs,
      });
      if (result && result.ok !== false) result.mode = 'tabCapture';
    } catch (error) {
      const message = String((error && error.message) || error);
      if (!/activeTab|not been invoked|cannot be captured|cannot capture|not allowed/i.test(message)) {
        throw new Error(message);
      }
      log('tabCapture 不可用（' + message + '），改用调试器截帧录制');
      result = await startViaDebugger(tabId, tab, recordingId, params.quality, durationMs);
    }
  }

  if (!result || result.ok === false) {
    throw new Error((result && result.error) || '录制启动失败');
  }
  const machine = createVideoStateMachine({ id: recordingId, now: nowMs });
  const started = machine.send('start', {
    mode: result.mode || null,
    mime: result.mime || '',
    durationMs,
    budget: budgetReport(budget),
    ...(durationPlan.clamped ? { duration_clamped: true, requestedMs: durationPlan.requestedMs } : {}),
  });
  recordingMachine = machine;
  if (started && started.ok) await persistRecordingState(machine);
  active = {
    id: recordingId,
    tabId,
    url,
    title: tab.title || '',
    startedAt: result.startedAt || Date.now(),
    mime: result.mime || '',
    mode: result.mode || null,
    deadline: durationMs > 0 ? (result.startedAt || Date.now()) + durationMs : 0,
    timer: null,
    budget,
    bitrate,
    degradationHistory: [],
    machine,
  };
  try {
    await chrome.storage.local.set({ 'bb.video.active': { id: recordingId, tabId, startedAt: active.startedAt, url, title: active.title } });
  } catch {
    // 状态记录失败不影响录制
  }
  // 到时自动停止由 offscreen 文档负责（SW 可能被回收，定时器不可靠）
  log('视频录制开始 id=' + recordingId + ' tab=' + tabId + ' mime=' + active.mime + ' mode=' + active.mode);
  const startPlan = planBudgetDegradation({ activeCount: 1, elapsedMs: 0, totalBytes: 0, segmentBytes: 0, bitrate }, budget, { now: nowMs() });
  // 第十批-D：开持久化会话（分片日记 + 帧校验 + 预算），只加结果字段，不影响录制本身。
  try {
    persistenceSession = createPersistenceSession({
      recordingId, now: nowMs(), mime: active.mime, mode: active.mode, budget,
      degradeLevel: startPlan && startPlan.action !== 'continue' ? startPlan.action : 'none',
    });
    await chrome.storage.local.set({ [PERSIST_KEY_PREFIX + recordingId]: { state: 'recording', segments: 0, bytes: 0, at: nowMs() } }).catch(() => {});
  } catch (error) {
    persistenceSession = null;
    log('录制持久化会话创建失败（不影响录制）：' + ((error && error.message) || error));
  }
  await injectVideoStatusChip(tabId, active.startedAt);
  return {
    ok: true,
    recordingId,
    tabId,
    mime: active.mime,
    startedAt: active.startedAt,
    mode: active.mode,
    durationMs,
    recording_state: machine.state,
    budget: budgetReport(budget),
    budget_plan: summarizeDegradation(startPlan),
    ...(durationPlan.clamped ? { duration_clamped: true, requestedMs: durationPlan.requestedMs } : {}),
    ...(normalized.problems.length ? { budget_problems: normalized.problems.slice(0, 4) } : {}),
    ...(persistenceSession ? { persistence: persistenceBrief(persistenceSession) } : {}),
  };
}

function journalFields(record) {
  if (!record) return {};
  return {
    ...(record.complete_frames !== undefined ? { complete_frames: record.complete_frames } : {}),
    ...(record.finish_via ? { finish_via: record.finish_via } : {}),
    ...(record.journal ? { journal: record.journal } : {}),
    ...(record.raw_bytes !== undefined ? { raw_bytes: record.raw_bytes } : {}),
    ...(record.trimmed_bytes !== undefined ? { trimmed_bytes: record.trimmed_bytes } : {}),
    ...(record.indexed ? { indexed: true } : {}),
    ...(record.sidx_bytes ? { sidx_bytes: record.sidx_bytes } : {}),
    ...(record.faststart ? { faststart: true, faststart_bytes: record.faststart_bytes, faststart_packets: record.faststart_packets } : {}),
  };
}

export async function stopVideo(recordingId, options = {}) {
  if (active && active.tabId != null) await removeVideoStatusChip(active.tabId);
  if (!active) return { ok: false, error: '当前没有录制' };
  if (recordingId && recordingId !== active.id) {
    return { ok: false, error: 'recording 不存在：' + recordingId };
  }
  const current = active;
  const id = current.id;
  const machine = current.machine || (await ensureRecordingMachine()).machine;
  if (machine && (machine.state === 'recording' || machine.state === 'paused')) {
    transitionRecording(machine, 'stop', { reason: String(options.reason || 'user') });
  }
  const timer = setTimeout(() => {
    const resolve = pendingStops.get(id);
    if (!resolve) return;
    pendingStops.delete(id);
    resolve({ ok: false, timeout: true });
  }, 30000);
  let stopRetry = null;
  let done = await new Promise((resolve) => {
    pendingStops.set(id, (payload) => resolve(payload));
    const sendStop = () => chrome.runtime.sendMessage({ target: 'offscreen', type: 'bb.rec.stop' })
      .catch((error) => resolve({ ok: false, error: String((error && error.message) || error) }));
    Promise.resolve().then(sendStop);
    // 全量后段偶发 stop 消息丢失：8s 未完成则重发一次，不改变 30s 总超时。
    stopRetry = setTimeout(() => { Promise.resolve().then(sendStop).catch(() => {}); }, 8000);
  }).finally(() => { clearTimeout(timer); if (stopRetry) clearTimeout(stopRetry); });
  if (done && done.timeout === true) {
    // done 消息可能丢失/延迟，但 offscreen 已把记录落库：读回成功即视为停止完成。
    const savedAfterTimeout = await readRecord(id).catch(() => null);
    if (savedAfterTimeout && Number(savedAfterTimeout.bytes) > 0) {
      done = { ok: true, bytes: savedAfterTimeout.bytes, mime: savedAfterTimeout.mime, timeoutRecovered: true };
    }
  }
  if (active && active.id === id) {
    if (active.timer) clearTimeout(active.timer);
    active = null;
    chrome.storage.local.remove('bb.video.active').catch(() => {});
  }
  await stopScreencast().catch(() => {});
  if (done && done.ok === false && done.timeout) {
    transitionRecording(machine, 'fail', { reason: 'stop_timeout', error: '等待录制文件超时' });
    return { ok: false, error: '等待录制文件超时', ...stateFields(machine), ...(current.budget ? { budget: budgetReport(current.budget) } : {}) };
  }
  if (done && done.ok === false) {
    transitionRecording(machine, 'fail', { reason: 'stop_failed', error: done.error || '停止失败' });
    return { ok: false, error: done.error || '停止失败', ...stateFields(machine) };
  }
  const saved = await readRecord(id);
  // 收尾：正常完整落库 → sealed；超时兜底/部分落库 → recovered（可播放但证据不完整）。
  const partial = Boolean(done && done.timeoutRecovered) || Boolean(saved && saved.completeness === 'partial');
  const sealed = transitionRecording(machine, partial ? 'recover' : 'seal', {
    reason: (saved && saved.stop_reason) || String(options.reason || 'user'),
    bytes: done && done.bytes ? done.bytes : 0,
    transcript: partial ? 'partial-finalize' : 'complete-finalize',
  });
  const budgetEvaluation = current.budget
    ? evaluateBudget({ elapsedMs: machine ? machine.elapsedMs() : Date.now() - current.startedAt, totalBytes: done && done.bytes ? done.bytes : 0, bitrate: current.bitrate || 0 }, current.budget)
    : null;
  const lastSegmentBytes = Array.isArray(saved && saved.fragments) && saved.fragments.length
    ? Number(saved.fragments[saved.fragments.length - 1].bytes) || 0
    : 0;
  const degradePlan = current.budget
    ? planBudgetDegradation({
      elapsedMs: machine ? machine.elapsedMs() : Date.now() - current.startedAt,
      totalBytes: done && done.bytes ? done.bytes : 0,
      segmentBytes: lastSegmentBytes,
      bitrate: current.bitrate || 0,
    }, current.budget, { evaluation: budgetEvaluation, now: nowMs() })
    : null;
  // 真的发生降级时把证据写回记录（只加 budget_degradation/budget_plan 字段，供 list/status 回读）。
  const degradationFields = degradePlan ? degradationRecordFields(degradePlan) : {};
  if (saved && Object.keys(degradationFields).length) {
    await patchRecord(id, degradationFields).catch(() => null);
  }
  // 第十批-D：把 offscreen 落库的 fragments 反建成分片日记 → 密封 → persist_*/journal_* 落盘。
  // 崩溃前若只有 fragments 而没有日记，这条路径就是“原生持久化”的兜底；失败不影响 stop 结果。
  let persistenceSummary = null;
  try {
    if (saved && Array.isArray(saved.fragments) && saved.fragments.length) {
      const session = await ensurePersistenceSession(id);
      const sealedPersistence = sealPersistenceFromFragments(session, saved.fragments, {
        now: nowMs(),
        totalBytes: Number(done && done.bytes) || Number(saved.bytes) || 0,
      });
      persistenceSession = sealedPersistence.session;
      await persistSessionFields(id, persistenceSession);
      persistenceSummary = sealedPersistence.summary;
      log(describePersistence(persistenceSession));
    } else if (persistenceSession && persistenceSession.recordingId === id) {
      persistenceSummary = persistenceBrief(persistenceSession);
    }
  } catch (error) {
    log('录制持久化收尾失败（不影响录制结果）：' + ((error && error.message) || error));
  }
  const persistenceStop = persistenceSession && persistenceSession.recordingId === id ? persistenceStopReason(persistenceSession) : null;
  return {
    ok: true,
    recordingId: id,
    bytes: done && done.bytes ? done.bytes : 0,
    mime: (done && done.mime) || current.mime,
    durationMs: machine ? machine.elapsedMs() : Date.now() - current.startedAt,
    state: 'ready',
    ...(saved && saved.completeness ? { completeness: saved.completeness } : {}),
    ...(saved && saved.stop_reason ? { stop_reason: saved.stop_reason } : {}),
    ...(saved && Number.isInteger(saved.chunk_count) ? { chunk_count: saved.chunk_count } : {}),
    ...(saved && Array.isArray(saved.fragments) ? { fragments: saved.fragments } : {}),
    ...journalFields(saved),
    ...stateFields(machine),
    ...(sealed && sealed.ok === false ? { state_rejection: sealed.evidence } : {}),
    ...(budgetEvaluation ? { budget: summarizeBudgetEvaluation(budgetEvaluation) } : {}),
    ...(degradePlan && degradePlan.action !== 'continue' ? { budget_degradation: summarizeDegradation(degradePlan) } : {}),
    ...(saved && saved.sealed === true ? { seal_check: summarizeSealCheck(inspectRecordSeal(saved)) } : {}),
    ...(persistenceSummary ? { persistence: persistenceSummary } : {}),
    ...(persistenceStop ? { persistence_stop: persistenceStop } : {}),
  };
}

/**
 * video.verify：逐片 SHA-256 + 容器/分片日记/帧级完整性/可 seek 分类。
 * 保持既有字段（ok/chunks/verified/bytes/container/mismatches/journal*）不变，新增证据字段。
 */
export async function verifyVideo(params = {}) {
  const id = String(params.recording || '');
  const record = await readRecord(id);
  if (!record) throw new Error('找不到录制：' + id);
  // seal 深度校验：能读到 OPFS manifest 就做完整摘要重算 + 双侧对账，否则按记录侧一致性检查。
  let seal = null;
  try {
    const manifest = await readSegmentManifest(id).catch(() => null);
    seal = await verifyRecordSeal(record, { manifest, now: Date.now(), maxAgeMs: Number(params.maxSealAgeMs) || 0 });
  } catch {
    seal = inspectRecordSeal(record);
  }
  const sealCheck = summarizeSealCheck(seal);
  const fragments = Array.isArray(record.fragments) ? record.fragments : [];
  // 第十批-D：持久化诊断（分片日记 + 帧校验 + 预算）——只加字段，不影响既有校验结论。
  const persistenceReport = persistenceVerifyView({ ...record, recordingId: id }, { now: Date.now(), frames: params.frames !== false });
  if (!fragments.length) {
    return {
      ok: true,
      recordingId: id,
      chunks: 0,
      verified: false,
      mismatches: [],
      recording_state: recordingStateOf(record),
      ...(sealCheck ? { seal_check: sealCheck } : {}),
      ...(persistenceReport ? { persistence: persistenceReport } : {}),
    };
  }
  const report = await verifyRecording(record, {
    toleranceMs: params.toleranceMs,
    strictFrames: params.strictFrames === true,
    maxAnalyzeBytes: params.maxAnalyzeBytes,
  });
  const { mismatches } = report;
  return {
    ok: mismatches.length === 0,
    recordingId: id,
    chunks: report.chunks,
    verified: report.verified,
    bytes: report.bytes,
    container: report.container,
    mismatches,
    recording_state: recordingStateOf(record),
    hash: report.hash,
    journal_integrity: report.journal_integrity,
    integrity: report.integrity,
    seek: report.seek,
    problems: report.problems,
    ...(report.manifest ? { manifest: report.manifest } : {}),
    ...(sealCheck ? { seal_check: sealCheck } : {}),
    ...(seal && Array.isArray(seal.evidence) && seal.evidence.length ? { seal_evidence: seal.evidence.slice(-6) } : {}),
    ...journalFields(record),
    // 第十批-D：持久化诊断（日记完整性/帧校验/预算），只加字段。
    ...(persistenceReport ? { persistence: persistenceReport } : {}),
    ...(persistenceReport && persistenceReport.frames ? { frame_check: persistenceReport.frames } : {}),
  };
}

export async function fetchVideo(params = {}) {
  await pruneExpired();
  const id = String(params.recording || '');
  const record = await readRecord(id);
  if (!record) throw new Error('找不到录制：' + id);
  const budget = normalizeBudget(budgetInputOf(params), { base: { maxDurationMs: MAX_DURATION_MS, maxTotalBytes: MAX_BYTES } }).budget;
  if (Number(record.bytes) > budget.maxTotalBytes) {
    const evaluation = evaluateBudget({ totalBytes: Number(record.bytes) || 0, elapsedMs: 0 }, budget);
    const plan = planBudgetDegradation({ totalBytes: Number(record.bytes) || 0, elapsedMs: 0 }, budget, { evaluation, now: nowMs() });
    const error = new Error('录制过大（' + record.bytes + ' 字节），上限 ' + budget.maxTotalBytes);
    error.code = 'E_TOO_LARGE';
    error.evidence = { code: BUDGET_CODES.SIZE, bytes: Number(record.bytes), maxTotalBytes: budget.maxTotalBytes, recordingId: id, budget_plan: summarizeDegradation(plan) };
    throw error;
  }
  let blob = record.faststart === true && record.faststart_blob ? record.faststart_blob : record.blob;
  // 可 seek：把 worker 生成的 sidx 插到首个 moof 之前（只多几十字节，不重编码）。
  if (record.faststart !== true && record.indexed === true && record.sidx_base64 && Number(record.sidx_insert_at) > 0) {
    try {
      const binary = atob(String(record.sidx_base64));
      const sidx = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) sidx[i] = binary.charCodeAt(i);
      const at = Number(record.sidx_insert_at);
      if (at < record.blob.size) {
        blob = new Blob([record.blob.slice(0, at), sidx, record.blob.slice(at)], { type: record.mime || 'video/mp4' });
      }
    } catch {
      // 索引损坏时回退原始录制
    }
  }
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < buffer.length; i += chunk) {
    binary += String.fromCharCode.apply(null, buffer.subarray(i, i + chunk));
  }
  // 保存前做一次 seal 校验（有 OPFS manifest 时重算摘要，否则记录侧一致性），失败不阻断保存。
  let sealCheck = null;
  try {
    const manifest = await readSegmentManifest(id).catch(() => null);
    sealCheck = summarizeSealCheck(await verifyRecordSeal(record, { manifest, now: Date.now() }));
  } catch {
    sealCheck = summarizeSealCheck(inspectRecordSeal(record));
  }
  return {
    ok: true,
    recordingId: id,
    mime: record.mime,
    bytes: blob.size,
    base64: btoa(binary),
    recording_state: recordingStateOf(record),
    ...(record.sealed === true && record.seal ? { seal: record.seal } : {}),
    ...(sealCheck ? { seal_check: sealCheck } : {}),
    ...(record.faststart === true ? { faststart: true, remuxed: true } : {}),
    ...(record.completeness ? { completeness: record.completeness, stop_reason: record.stop_reason, chunk_count: record.chunk_count } : {}),
    ...(Array.isArray(record.fragments) ? { fragments: record.fragments } : {}),
    ...journalFields(record),
  };
}

/**
 * video.recover：崩溃恢复。
 * 1) 先在 Service Worker 侧扫描 OPFS manifest + 分片（不依赖 offscreen），产出恢复计划/证据；
 * 2) 调用 offscreen 现役恢复链路重建可播放文件并落库；
 * 3) 对恢复出的记录做二次审计（逐片哈希/容器/帧级/可 seek），把 recording_state='recovered'
 *    与结构化证据回写记录并返回。
 */
export async function recoverVideo(params = {}) {
  const recordings = await scanEncodedRecordings().catch(() => []);
  // 每条候选先算“重组策略”：可播放前缀/重取/拒绝/已封存跳过，供 offscreen 恢复与结果对账共用。
  const restorePlans = new Map();
  for (const item of recordings) {
    try {
      restorePlans.set(String(item.recordingId || ''), planPartialReassembly(item.manifest, item.parts, {
        recordingId: item.recordingId,
        now: Date.now(),
        maxAttempts: params.maxRefetchAttempts,
        refetch: params.refetch === false ? false : undefined,
        salvageTruncated: params.salvageTruncated === true,
      }));
    } catch {
      // 单条候选规划失败不影响其它候选
    }
  }
  const restoreSummary = { reassemble: 0, refetch: 0, sealed: 0, impossible: 0 };
  for (const plan of restorePlans.values()) {
    if (!plan) continue;
    if (plan.nextAction === 'reassemble') restoreSummary.reassemble += 1;
    else if (plan.nextAction === 'refetch') restoreSummary.refetch += 1;
    else if (plan.nextAction === 'skip') restoreSummary.sealed += 1;
    else restoreSummary.impossible += 1;
  }
  const scan = {
    ok: true,
    skipped: recordings.length === 0,
    count: recordings.length,
    candidates: recordings.map((item) => ({
      recordingId: item.recordingId,
      sealed: item.summary ? item.summary.sealed === true : false,
      parts: Array.isArray(item.parts) ? item.parts.length : 0,
      manifest: item.summary,
      plan: item.plan,
      restore: summarizeRestore(restorePlans.get(String(item.recordingId || '')) || null),
    })),
    unsealed: recordings.filter((item) => !(item.summary && item.summary.sealed)).length,
    recoverable: recordings.filter((item) => item.plan && item.plan.recovered).length,
    restore: restoreSummary,
    evidence: recordings.flatMap((item) => item.evidence || []),
  };
  await ensureOffscreen().catch(() => {});
  const result = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'bb.rec.recover' }).catch(() => null);
  if (!result || result.ok === false) {
    const error = new Error((result && result.error) || '没有可恢复的录制分片');
    const summary = summarizeScan(scan);
    if (summary && summary.candidates > 0) error.evidence = summary;
    throw error;
  }
  chrome.storage.local.remove('bb.video.active').catch(() => {});
  const recordSummary = result.record || {};
  const recoveredId = String(recordSummary.id || recordSummary.recordingId || '');
  const restorePlan = restorePlans.get(recoveredId) || null;
  const reconcile = restorePlan ? reconcileAssembled(restorePlan, { bytes: Number(recordSummary.bytes) || 0 }) : null;
  const machine = createVideoStateMachine({ id: recoveredId, now: nowMs });
  transitionRecording(machine, 'recover', { recordingId: recoveredId, source: 'video.recover' });
  recordingMachine = machine;
  let enriched = { ...recordSummary };
  let audit = null;
  if (recoveredId) {
    const record = await readRecord(recoveredId).catch(() => null);
    const candidate = recordings.find((item) => item.recordingId === recoveredId) || null;
    audit = await auditRecoveredRecording(record || recordSummary, {
      recordingId: recoveredId,
      manifest: candidate ? candidate.manifest : null,
      availableParts: candidate && Array.isArray(candidate.parts) ? candidate.parts : [],
      toleranceMs: params.toleranceMs,
    }).catch(() => null);
    if (record && audit) {
      const patch = { ...recoveryRecordPatch(audit, record), ...restoreRecordFields(restorePlan, reconcile) };
      await patchRecord(recoveredId, patch).catch(() => null);
      enriched = { ...recordSummary, ...patch };
    }
    enriched.recording_state = audit ? audit.state : machine.state;
    enriched.recording_state_evidence = audit ? audit.evidence : machine.snapshot().transitions.slice(-8);
    if (audit) enriched.recovery = summarizeRecovery(audit);
    if (restorePlan) enriched.restore = summarizeRestore(restorePlan);
    if (reconcile) {
      enriched.restore_reconcile = {
        ok: reconcile.ok === true,
        status: reconcile.status,
        expectedBytes: reconcile.expectedBytes,
        actualBytes: reconcile.actualBytes,
        ...(reconcile.deltaBytes ? { deltaBytes: reconcile.deltaBytes } : {}),
      };
    }
    // 第十批-D：分片日记重放 + 帧校验 + 预算的证据闭环（只加字段）。
    // 有 OPFS 分片条目时先并回日记（幂等），再规划恢复；没有日记就按 record 反建。
    try {
      const candidateRecord = await readRecord(recoveredId).catch(() => null);
      let session = persistenceFromRecord(candidateRecord || recordSummary, { now: nowMs() })
        || createPersistenceSession({
          recordingId: recoveredId,
          now: nowMs(),
          mime: recordSummary.mime,
          budget: active && active.budget ? active.budget : normalizeBudget({}, { base: { maxDurationMs: MAX_DURATION_MS, maxTotalBytes: MAX_BYTES } }).budget,
        });
      if (candidate && Array.isArray(candidate.parts) && candidate.parts.length) {
        session = restorePersistenceParts(session, candidate.parts.map((part) => ({
          index: Number(part && part.index) || 0,
          bytes: Number(part && part.bytes) || 0,
          hash: String((part && (part.hash || part.sha256)) || ''),
          tMs: Number(part && part.tMs) || 0,
        })), { now: nowMs() }).session;
      }
      const persisted = persistenceRecoveryView(session, {
        now: nowMs(),
        available: candidate && Array.isArray(candidate.parts) ? candidate.parts.map((part) => part && part.index) : [],
        manifest: candidate ? candidate.manifest : null,
        frames: params.frames !== false,
      });
      enriched.persistence = persisted.view;
      // 把恢复结论（含日记/帧摘要）写回记录，供 list/status 回读 —— 只加 persist_* 字段。
      await patchRecord(recoveredId, persisted.recordPatch).catch(() => null);
    } catch (error) {
      enriched.persistence = { ok: false, state: 'unknown', error: String((error && error.message) || error) };
    }
  }
  return {
    ok: true,
    ...enriched,
    recovery_scan: summarizeScan(scan),
  };
}

export async function listVideos() {
  await pruneExpired();
  const records = await listRecords();
  return {
    ok: true,
    recordings: records
      .map((item) => ({
        id: item.id,
        tabId: item.tabId,
        url: item.url,
        title: item.title,
        startedAt: item.startedAt,
        endedAt: item.endedAt,
        mime: item.mime,
        bytes: item.bytes,
        ...(item.completeness ? { completeness: item.completeness } : {}),
        ...(item.stop_reason ? { stop_reason: item.stop_reason } : {}),
        ...(Number.isInteger(item.chunk_count) ? { chunk_count: item.chunk_count } : {}),
        ...(Array.isArray(item.fragments) ? { fragments: item.fragments } : {}),
        ...(item.durability ? { durability: item.durability } : {}),
        ...(Number.isInteger(item.durability_parts) ? { durability_parts: item.durability_parts } : {}),
        ...(item.durability_policy ? { durability_policy: item.durability_policy } : {}),
        ...(item.fsync_supported !== undefined ? { fsync_supported: item.fsync_supported === true } : {}),
        ...(item.storage_persisted !== undefined ? { storage_persisted: item.storage_persisted === true } : {}),
        ...(item.storage_quota != null ? { storage_quota: item.storage_quota } : {}),
        recording_state: recordingStateOf(item),
        ...(item.recovered === true ? { recovered: true } : {}),
        ...(item.sealed === true && item.seal ? { seal: item.seal } : {}),
        ...(item.sealed === true || item.seal ? { seal_check: summarizeSealCheck(inspectRecordSeal(item)) } : {}),
        ...(item.budget_degradation ? { budget_degradation: item.budget_degradation } : {}),
        ...(item.segment_manifest ? { segment_manifest: item.segment_manifest } : {}),
        ...(item.recording_state_evidence ? { recording_state_evidence: stateEvidenceOf(item) } : {}),
        ...(item.recovery ? { recovery: summarizeRecovery(item.recovery) } : {}),
        ...journalFields(item),
        // 第十批-D：持久化会话摘要（只加字段；老记录没有 persist_* 时不出现在列表里）。
        ...(item.persist_state
          ? {
            persistence: {
              state: item.persist_state,
              segments: Number(item.persist_segments) || 0,
              bytes: Number(item.persist_bytes) || 0,
              journal_entries: Number(item.persist_journal_entries) || 0,
              journal_valid: Array.isArray(item.persist_journal_missing) ? item.persist_journal_missing.length === 0 : null,
              frames: Number(item.persist_frames) || 0,
              frames_playable: item.persist_frames_playable === true ? true : (item.persist_frames_playable === false ? false : null),
              seal_ok: item.persist_seal_ok === true ? true : (item.persist_seal_ok === false ? false : null),
            },
          }
          : {}),
      }))
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)),
  };
}
export async function discardVideo(params = {}) {
  const id = String(params.recording || '');
  await deleteRecord(id);
  return { ok: true, recordingId: id };
}
export async function videoState() {
  const restored = await ensureRecordingMachine();
  let machine = restored.machine;
  if (active) {
    if (machine.id !== active.id || machine.state === 'idle') {
      machine = createVideoStateMachine({ id: active.id, initial: 'recording', startedAt: active.startedAt, now: nowMs });
      recordingMachine = machine;
      await persistRecordingState(machine);
    }
    return {
      ok: true,
      active: true,
      recordingId: active.id,
      tabId: active.tabId,
      startedAt: active.startedAt,
      mime: active.mime,
      mode: active.mode,
      url: active.url,
      title: active.title,
      recording_state: machine.state,
      ...(active.budget ? { budget: budgetReport(active.budget) } : {}),
      recording_state_evidence: machine.snapshot().transitions.slice(-8),
    };
  }
  try {
    const stored = await chrome.storage.local.get(['bb.video.active', STATE_KEY]);
    const stale = stored && stored['bb.video.active'];
    if (stale && stale.id) {
      let live = null;
      try {
        live = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'bb.rec.status' });
      } catch {
        live = null;
      }
      if (live && live.active) {
        const meta = live.meta || {};
        active = {
          id: stale.id,
          tabId: meta.tabId != null ? meta.tabId : stale.tabId,
          url: meta.url || stale.url || '',
          title: meta.title || stale.title || '',
          startedAt: meta.startedAt || stale.startedAt || Date.now(),
          mime: meta.mime || stale.mime || '',
          mode: 'recovered',
          timer: null,
          deadline: 0,
          budget: null,
          machine: null,
        };
        if (machine.id !== active.id || machine.state === 'idle') {
          machine = createVideoStateMachine({ id: active.id, initial: 'recording', startedAt: active.startedAt, now: nowMs });
          recordingMachine = machine;
          await persistRecordingState(machine);
        }
        // 状态回读对齐：offscreen 真实 MediaRecorder 处于 paused/recording 时同步状态机。
        const liveState = String((live && live.state) || '');
        if (liveState === 'paused' && machine.state === 'recording') {
          transitionRecording(machine, 'pause', { source: 'offscreen-status' });
        } else if (liveState === 'recording' && machine.state === 'paused') {
          transitionRecording(machine, 'resume', { source: 'offscreen-status' });
        }
        active.machine = machine;
        return {
          ok: true, active: true, recovered: true,
          recordingId: active.id, tabId: active.tabId, startedAt: active.startedAt,
          mime: active.mime, mode: active.mode, url: active.url, title: active.title,
          recording_state: machine.state,
          recording_state_evidence: machine.snapshot().transitions.slice(-8),
        };
      }
      const interrupted = machine.state === 'recording' || machine.state === 'paused' || machine.state === 'finalizing';
      return {
        ok: true,
        active: false,
        interrupted: true,
        recordingId: stale.id,
        tabId: stale.tabId,
        startedAt: stale.startedAt,
        url: stale.url || '',
        title: stale.title || '',
        recording_state: machine.state,
        recovery_required: interrupted,
        recording_state_evidence: machine.snapshot().transitions.slice(-8),
      };
    }
  } catch {
    // 忽略存储读取失败
  }
  return {
    ok: true,
    active: false,
    recording_state: machine.state,
    ...(restored.restoreEvidence && restored.restoreEvidence.reason ? { restore_evidence: restored.restoreEvidence } : {}),
  };
}
export function handleRecDone(message) {
  if (!message) return;
  if (!message.id && message.tabId != null) {
    if (active && active.tabId === message.tabId) {
      if (active.timer) clearTimeout(active.timer);
      active = null;
      chrome.storage.local.remove('bb.video.active').catch(() => {});
    }
    return;
  }
  if (!message.id) return;
  const waiter = pendingStops.has(message.id);
  const resolve = pendingStops.get(message.id);
  if (resolve) {
    pendingStops.delete(message.id);
    resolve({ ok: true, bytes: message.bytes, mime: message.mime });
  }
  if (active && active.id === message.id) {
    const mode = active.mode;
    const machine = active.machine || recordingMachine;
    if (machine && (machine.state === 'recording' || machine.state === 'paused')) {
      transitionRecording(machine, 'stop', { reason: 'offscreen-done' });
    }
    // 没有等待者（例如 offscreen 到时自动停止）时在这里收敛到 sealed，避免状态卡在 finalizing。
    if (!waiter && machine && machine.state === 'finalizing') {
      transitionRecording(machine, 'seal', { reason: 'offscreen-done', bytes: message.bytes });
    }
    if (active.timer) clearTimeout(active.timer);
    active = null;
    chrome.storage.local.remove('bb.video.active').catch(() => {});
    if (mode === 'debugger') stopScreencast().catch(() => {});
  }
}
/** video.status：过了时长就先把录制停掉，返回 active 或 ready。 */
async function readTrace() {
  try {
    const stored = await chrome.storage.local.get('bb.video.trace');
    return Array.isArray(stored && stored['bb.video.trace']) ? stored['bb.video.trace'].slice(-10) : [];
  } catch {
    return [];
  }
}
export async function videoStatus(params = {}) {
  await pruneExpired();
  let machine = null;
  let budgetEvaluation = null;
  let degradePlan = null;
  if (active) {
    const restored = await ensureRecordingMachine();
    machine = active.machine || restored.machine;
    if (machine.id !== active.id || machine.state === 'idle') {
      machine = createVideoStateMachine({ id: active.id, initial: 'recording', startedAt: active.startedAt, now: nowMs });
      recordingMachine = machine;
      await persistRecordingState(machine);
    }
    active.machine = machine;
    // 预算评估：时长到点 → stop（stop_reason='duration'）；接近上限 → 只报告策略，不擅自降级。
    budgetEvaluation = evaluateBudget({
      activeCount: 1,
      elapsedMs: machine.elapsedMs() || (Date.now() - active.startedAt),
      maxDurationMs: active.deadline ? Math.max(1000, active.deadline - active.startedAt) : 0,
    }, active.budget || {});
    if (active.budget) {
      degradePlan = planBudgetDegradation({
        activeCount: 1,
        elapsedMs: machine.elapsedMs() || (Date.now() - active.startedAt),
        totalBytes: 0,
        bitrate: active.bitrate || 0,
        maxDurationMs: active.deadline ? Math.max(1000, active.deadline - active.startedAt) : 0,
      }, active.budget, { evaluation: budgetEvaluation, now: nowMs() });
      // 轮询路径累积降级历史（同动作+原因只留一条，最多 8 条）。
      const merged = mergeDegradationHistory(active.degradationHistory, degradePlan);
      active.degradationHistory = merged.history;
    }
    if (budgetEvaluation.action === 'stop') {
      await stopVideo(active.id, { reason: budgetEvaluation.stop_reason || 'duration' }).catch(() => {});
    }
  }
  if (active) {
    return {
      ok: true,
      active: true,
      state: 'recording',
      recordingId: active.id,
      tabId: active.tabId,
      startedAt: active.startedAt,
      deadlineMs: active.deadline || 0,
      mime: active.mime,
      mode: active.mode,
      url: active.url,
      title: active.title,
      recording_state: machine ? machine.state : 'recording',
      ...(active.budget ? { budget: budgetReport(active.budget) } : {}),
      ...(budgetEvaluation ? { budget_action: summarizeBudgetEvaluation(budgetEvaluation) } : {}),
      ...(degradePlan && degradePlan.action !== 'continue' ? { budget_degradation: summarizeDegradation(degradePlan) } : {}),
      ...(Array.isArray(active.degradationHistory) && active.degradationHistory.length ? { budget_history: active.degradationHistory.slice(-8) } : {}),
      recording_state_evidence: machine ? machine.snapshot().transitions.slice(-8) : [],
      // 第十批-D：正在录制中的持久化会话摘要（日记条目/字节/预算闸门）。
      ...(persistenceSession && active && persistenceSession.recordingId === active.id
        ? { persistence: persistenceBrief(persistenceSession) }
        : {}),
    };
  }
  const records = await listRecords();
  const id = params.recording ? String(params.recording) : '';
  const record = id ? records.find((item) => item.id === id) : records[0];
  if (!record) return { ok: true, active: false, state: 'none', trace: await readTrace() };
  return {
    ok: true,
    active: false,
    state: 'ready',
    trace: await readTrace(),
    recordingId: record.id,
    tabId: record.tabId,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    mime: record.mime,
    bytes: record.bytes,
    url: record.url,
    title: record.title,
    recording_state: recordingStateOf(record),
    ...(record.sealed === true && record.seal ? { seal: record.seal } : {}),
    ...(record.sealed === true || record.seal ? { seal_check: summarizeSealCheck(inspectRecordSeal(record)) } : {}),
    ...(record.recovered === true ? { recovered: true } : {}),
    ...(record.recovery ? { recovery: summarizeRecovery(record.recovery) } : {}),
    ...(record.restore ? { restore: record.restore } : {}),
    ...(record.budget_degradation ? { budget_degradation: record.budget_degradation } : {}),
    ...(record.recording_state_evidence ? { recording_state_evidence: stateEvidenceOf(record) } : {}),
    ...(record.completeness ? { completeness: record.completeness } : {}),
    ...(record.stop_reason ? { stop_reason: record.stop_reason } : {}),
    ...(Number.isInteger(record.chunk_count) ? { chunk_count: record.chunk_count } : {}),
    ...(Array.isArray(record.fragments) ? { fragments: record.fragments } : {}),
    ...journalFields(record),
    // 第十批-D：落盘持久化摘要（老记录没有 persist_* 时不出现）。
    ...(record.persist_state ? { persistence: persistSummaryOf(record) } : {}),
  };
}
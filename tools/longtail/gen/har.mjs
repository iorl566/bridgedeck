// tools/longtail/gen/har.mjs —— 大 HAR 夹具生成器（多来源、≥5MB、确定性）。
//
// 生成的是真实 HAR 1.2（外加 BridgeDeck 扩展字段），随后被真实模块消费：
//   - lib/har-merge.mjs               parseHarSource / mergeHarSources / validateHarDeep /
//                                      arbitrateHarEntries / compareHarRoundTrip / summarizeHarMergeReport
//   - lib/waterfall-attribution.mjs    attributeWaterfall / selectWaterfallRows / correlateFrames /
//                                      auditCompletion / summarizeWaterfallAttribution
//   - lib/network-waterfall.mjs        buildWaterfall / deriveCdpTimings（通过 lib/waterfall-attribution 重导出）
//
// 多来源的设计（让合并/裁决有真实工作可做）：
//   - 4 个来源，其中约 55% 的请求是**跨来源共享**的（同一 URL 在多个来源出现 → 去重）；
//   - 共享请求里刻意制造状态码/正文/时长冲突（→ arbitrate 的 status/content/size/timings 冲突）；
//   - 其余是各来源独有的请求（→ 合并规模）；
//   - 所有来源的时间轴在同一 base 上错开，但共享请求的 startedDateTime 对齐在默认 1000ms 去重窗口内；
//   - `_startedAt`/`_finishedAt` 与 `time`/`timings` 自洽，validateHarDeep 的 error 数为 0。
//
// 体积契约：sum(各来源 JSON 字节) ≥ minBytes（default 5MB），由响应正文长度保证；
// 正文内容来自 seed 派生的填充文本，逐字节确定。

import { DEFAULT_SEED, rngFor, stableHash, fillerText, utf8Bytes } from '../lib/prng.mjs';

export const HAR_FIXTURE_VERSION = 1;

/** 固定基准时间（2026-03-01T00:00:00Z）：不让 Date.now 进入夹具内容。 */
export const HAR_BASE_TIME = Date.parse('2026-03-01T00:00:00.000Z');

/** 资源类型 → MIME。 */
export const MIME_BY_TYPE = Object.freeze({
  document: 'text/html; charset=utf-8',
  script: 'application/javascript; charset=utf-8',
  stylesheet: 'text/css; charset=utf-8',
  image: 'image/png',
  xhr: 'application/json; charset=utf-8',
  fetch: 'application/json; charset=utf-8',
  font: 'font/woff2',
  media: 'video/mp4',
  websocket: 'application/octet-stream',
  other: 'application/octet-stream',
});

const RESOURCE_TYPES = Object.freeze(Object.keys(MIME_BY_TYPE));
const METHODS = Object.freeze(['GET', 'GET', 'GET', 'POST', 'PUT']);
const STATUS_POOL = Object.freeze([200, 200, 200, 200, 204, 301, 304, 404, 500]);

const FRAME_COUNT = 8;

/** 帧注册表：root + 5 个一级 + 2 层嵌套，给 correlateFrames/frame 关联用。 */
export function buildFrameRegistry({ count = FRAME_COUNT } = {}) {
  const frames = [{ frameId: 0, parentFrameId: null, url: 'https://longtail.test/', depth: 0, title: '主文档' }];
  for (let frameId = 1; frameId < Math.max(1, count); frameId += 1) {
    let parentFrameId = 0;
    let depth = 1;
    if (frameId === count - 1 && count > 4) {
      parentFrameId = count - 2;
      depth = 2;
    } else if (frameId === count - 2 && count > 4) {
      parentFrameId = count - 3;
      depth = 2;
    }
    frames.push({
      frameId,
      parentFrameId,
      url: 'https://longtail.test/frame/' + frameId,
      depth,
      title: '子帧 ' + frameId,
    });
  }
  return frames;
}

function headersFor(url, type, rng) {
  const origin = new URL(url).origin;
  const headers = [
    { name: 'accept', value: type === 'document' ? 'text/html' : 'application/json, */*' },
    { name: 'accept-encoding', value: 'gzip, deflate, br' },
    { name: 'user-agent', value: 'BridgeDeck-longtail/1.0' },
    { name: 'referer', value: origin + '/console?seed=' + rng.hex(4) },
  ];
  if (url.includes('/api/')) headers.push({ name: 'content-type', value: 'application/json; charset=utf-8' });
  if (rng.chance(0.35)) headers.push({ name: 'x-trace-id', value: 'trace-' + rng.hex(8) });
  if (rng.chance(0.2)) headers.push({ name: 'x-cache', value: rng.chance(0.5) ? 'HIT' : 'MISS' });
  return headers;
}

function timingFor(rng, { slow = false } = {}) {
  const blocked = rng.int(0, 6);
  const dns = rng.int(0, 12);
  const connect = rng.int(0, 22);
  const send = rng.int(1, 6);
  const wait = slow ? rng.int(600, 2400) : rng.int(20, 380);
  const receive = slow ? rng.int(120, 900) : rng.int(10, 220);
  const ssl = connect > 0 ? rng.int(0, connect) : 0;
  const time = blocked + dns + connect + send + wait + receive;
  return {
    blocked,
    dns,
    connect,
    ssl,
    send,
    wait,
    receive,
    _ttfbMs: Math.round((blocked + dns + connect) * 100 + wait) / 100,
    _breakdownSumMs: time,
  };
}

function isoAt(ms) {
  return new Date(ms).toISOString();
}

/**
 * 生成共享请求候选（跨来源重复），与来源数无关，保证不同 sources 配置下共享部分一致。
 * shared 请求带有冲突版本：status/bodyLength/waitShift，由来源序号 hash 选择。
 */
function buildSharedSpecs({ count, seed, bodyLength, rng }) {
  const specs = [];
  for (let index = 0; index < count; index += 1) {
    const type = RESOURCE_TYPES[index % 4];
    const url = 'https://longtail.test/api/shared/' + String(index).padStart(4, '0') + '.json';
    specs.push({
      index,
      url,
      method: 'GET',
      type,
      startOffsetMs: index * 1200, // 落在默认 1000ms 去重窗口的对齐点附近
      bodyLength,
      canonical: {
        status: 200,
        waitShift: 0,
        bodySalt: 'shared',
        transferSize: 1200 + (index % 500),
        frameId: index % FRAME_COUNT,
      },
      variant: index % 7 === 0
        ? { status: 404, waitShift: 350, bodySalt: 'variant-missing', transferSize: 640, frameId: (index + 1) % FRAME_COUNT }
        : (index % 11 === 0 ? { status: 500, waitShift: 900, bodySalt: 'variant-error', transferSize: 512, frameId: (index + 2) % FRAME_COUNT } : null),
    });
  }
  // 确保至少 8% 的共享请求有冲突版本（否则裁决证据不足）。
  const conflicts = specs.filter((spec) => spec.variant).length;
  const wanted = Math.max(2, Math.floor(count * 0.08));
  for (let index = 0; index < Math.min(wanted, specs.length) && conflicts < wanted; index += 3) {
    if (!specs[index].variant) {
      specs[index].variant = {
        status: 204,
        waitShift: 120 + index,
        bodySalt: 'variant-empty',
        transferSize: 300 + index,
        frameId: index % FRAME_COUNT,
      };
    }
  }
  return { specs, rng };
}

function makeEntry(spec, { sourceIndex, entryIndex, baseMs, frames, rng, bodyLength }) {
  const variant = spec.variant && (sourceIndex % 3 === 0 || sourceIndex % 5 === 0) ? spec.variant : spec.canonical;
  const startedAt = baseMs + spec.startOffsetMs;
  const timing = timingFor(rng, { slow: entryIndex % 37 === 0 });
  const shiftedWait = Math.max(1, timing.wait + (variant.waitShift || 0));
  const time = timing.blocked + timing.dns + timing.connect + timing.send + shiftedWait + timing.receive;
  const bodyText = fillerText(rng, bodyLength, spec.url + '|' + variant.bodySalt + '|' + sourceIndex);
  const status = Number(variant.status) || 200;
  const frameId = Number.isFinite(variant.frameId) ? variant.frameId : spec.frameId;
  const frame = frames.find((item) => item.frameId === frameId) || frames[0];
  return {
    pageref: 'page-' + sourceIndex,
    startedDateTime: isoAt(startedAt),
    time,
    request: {
      method: spec.method,
      url: spec.url,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: headersFor(spec.url, spec.type, rng),
      queryString: [],
      headersSize: 320 + rng.int(0, 120),
      bodySize: spec.method === 'GET' ? 0 : 64 + rng.int(0, 200),
    },
    response: {
      status,
      statusText: status === 200 ? 'OK' : (status === 204 ? 'No Content' : (status === 301 ? 'Moved Permanently' : (status === 304 ? 'Not Modified' : (status === 404 ? 'Not Found' : 'Internal Server Error')))),
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [
        { name: 'content-type', value: MIME_BY_TYPE[spec.type] || MIME_BY_TYPE.other },
        { name: 'content-length', value: String(bodyText.length) },
        { name: 'cache-control', value: rng.chance(0.4) ? 'max-age=60' : 'no-cache' },
        { name: 'server', value: 'longtail-test' },
      ],
      content: {
        size: bodyText.length,
        mimeType: MIME_BY_TYPE[spec.type] || MIME_BY_TYPE.other,
        text: bodyText,
      },
      redirectURL: status === 301 ? 'https://longtail.test/redirect/' + entryIndex : '',
      headersSize: 280 + rng.int(0, 100),
      bodySize: bodyText.length,
    },
    cache: {},
    timings: {
      blocked: timing.blocked,
      dns: timing.dns,
      connect: timing.connect,
      ssl: timing.ssl,
      send: timing.send,
      wait: shiftedWait,
      receive: timing.receive,
      _ttfbMs: Math.round((timing.blocked + timing.dns + timing.connect + shiftedWait) * 100) / 100,
      _breakdownSumMs: time,
      _reconciled: true,
    },
    serverIPAddress: '203.0.113.' + (sourceIndex + 1),
    connection: String(8000 + sourceIndex * 10 + entryIndex % 10),
    _resourceType: spec.type,
    _frameId: frame.frameId,
    _requestId: 'req-' + sourceIndex + '-' + String(entryIndex).padStart(4, '0'),
    _transferSize: Number(variant.transferSize) || 0,
    _fromCache: status === 304,
    _startedAt: startedAt,
    _finishedAt: startedAt + time,
    _documentURL: frame.url,
  };
}

/**
 * 生成多来源 HAR 夹具。
 * @param {{sources?:number, entriesPerSource?:number, bodyBytes?:number, minBytes?:number,
 *          seed?:string|number, profile?:string, baseMs?:number}} [options]
 */
export function buildHarFixture(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const sourceCount = Math.max(1, Math.floor(Number(opts.sources) || 4));
  const entriesPerSource = Math.max(8, Math.floor(Number(opts.entriesPerSource) || 320));
  const minBytes = Math.max(0, Math.floor(Number(opts.minBytes) || 5_000_000));
  const seed = opts.seed == null ? DEFAULT_SEED : opts.seed;
  const profile = String(opts.profile || 'default');
  const baseMs = Number.isFinite(Number(opts.baseMs)) ? Number(opts.baseMs) : HAR_BASE_TIME;
  const frames = buildFrameRegistry();

  // 正文长度：先满足 minBytes 的体积契约，再保证不少于用户给的单条基线。
  const totalEntries = sourceCount * entriesPerSource;
  const bytesTarget = Math.ceil((minBytes * 1.12) / totalEntries);
  const bodyLength = Math.max(Math.floor(Number(opts.bodyBytes) || 4200), bytesTarget);

  const sharedCount = Math.max(4, Math.round(entriesPerSource * 0.55));
  const sharedRng = rngFor(seed, 'har', 'shared');
  const shared = buildSharedSpecs({ count: sharedCount, seed, bodyLength, rng: sharedRng });

  const sources = [];
  const toBytes = (value) => utf8Bytes(JSON.stringify(value));
  for (let sourceIndex = 0; sourceIndex < sourceCount; sourceIndex += 1) {
    const rng = rngFor(seed, 'har', 'source', sourceIndex);
    const entries = [];
    // 1) 共享请求（每来源取不同子集 + 每条独立 entry，制造去重/冲突）。
    const offset = sourceIndex * 3;
    for (let index = 0; index < sharedCount; index += 1) {
      const spec = shared.specs[(index + offset) % shared.specs.length];
      entries.push(makeEntry(spec, {
        sourceIndex,
        entryIndex: entries.length,
        baseMs: baseMs + sourceIndex * 250,
        frames,
        rng: rngFor(seed, 'har', 'entry', sourceIndex, index),
        bodyLength,
      }));
    }
    // 2) 来源独有请求：不同 path/count，合并后总量继续增长。
    const uniqueCount = Math.max(4, entriesPerSource - sharedCount);
    for (let index = 0; index < uniqueCount; index += 1) {
      const type = RESOURCE_TYPES[(index + sourceIndex) % RESOURCE_TYPES.length];
      const nested = index % 5 === 0;
      const url = nested
        ? 'https://longtail.test/api/src' + sourceIndex + '/nested/' + index + '/detail.json?i=' + index
        : 'https://longtail.test/api/src' + sourceIndex + '/' + String(index).padStart(4, '0') + '/' + type;
      const spec = {
        index,
        url,
        method: METHODS[(index + sourceIndex) % METHODS.length],
        type,
        startOffsetMs: 900_000 + sourceIndex * 400_000 + index * 900,
        bodyLength: bodyLength,
        canonical: { status: type === 'image' ? 200 : STATUS_POOL[(index + sourceIndex) % STATUS_POOL.length], waitShift: 0, bodySalt: 'u' + index, transferSize: 900 + index % 700, frameId: (index + sourceIndex) % FRAME_COUNT },
        variant: null,
      };
      entries.push(makeEntry(spec, {
        sourceIndex,
        entryIndex: entries.length,
        baseMs,
        frames,
        rng: rngFor(seed, 'har', 'entry', sourceIndex, 'u', index),
        bodyLength,
      }));
    }
    const har = {
      log: {
        version: '1.2',
        creator: { name: 'BridgeDeck-longtail', version: '1.0.0' },
        browser: { name: 'Edge', version: '142.0.0.0' },
        pages: [{
          id: 'page-' + sourceIndex,
          title: '长尾来源 ' + sourceIndex,
          startedDateTime: isoAt(baseMs + sourceIndex * 1000),
          pageTimings: {
            onContentLoad: 600 + sourceIndex * 40,
            onLoad: 1800 + sourceIndex * 120,
            _startedAt: baseMs + sourceIndex * 1000,
            _finishedAt: baseMs + sourceIndex * 1000 + 1800 + sourceIndex * 120,
          },
        }],
        entries,
      },
    };
    sources.push({ index: sourceIndex, label: 'source-' + sourceIndex, har, bytes: toBytes(har), entries: entries.length });
  }

  const totalBytes = sources.reduce((sum, source) => sum + source.bytes, 0);
  const stats = {
    sources: sources.length,
    entriesPerSource,
    totalEntries: sources.reduce((sum, source) => sum + source.entries, 0),
    bodyLength,
    totalBytes,
    minBytes,
    meetsMinBytes: totalBytes >= minBytes,
    frames: frames.length,
    sharedRequests: sharedCount,
    sharedWithVariant: shared.specs.filter((spec) => spec.variant).length,
  };
  const fingerprint = stableHash({
    version: HAR_FIXTURE_VERSION,
    seed: String(seed),
    profile,
    sources: sources.length,
    entriesPerSource,
    sharedCount,
    sharedWithVariant: stats.sharedWithVariant,
    bodyLength,
    firstUrl: sources[0].har.log.entries[0].request.url,
    lastUrl: sources[sources.length - 1].har.log.entries[sources[sources.length - 1].har.log.entries.length - 1].request.url,
  });
  return {
    version: HAR_FIXTURE_VERSION,
    kind: 'har',
    seed: String(seed),
    profile,
    baseMs,
    frames,
    sources,
    labels: sources.map((source) => source.label),
    stats,
    fingerprint,
  };
}

/**
 * 把夹具写进 tmp 工作区（每个来源一个 JSON 文件）。返回文件清单与字节统计。
 * 只写 tmpdir：调用方传进来的 workspace 已由 lib/tmpdir.mjs 做仓库边界护栏。
 */
export function writeHarFixture(workspace, fixture) {
  const files = [];
  for (const source of fixture.sources) {
    const name = 'har/' + source.label + '.json';
    const written = workspace.writeJson(name, source.har);
    files.push({ path: written.path, bytes: written.bytes, entries: source.entries });
  }
  // 来源索引（小文件）：合并时按索引顺序读回，模拟 "scan HAR files" 的真实路径。
  const index = workspace.writeJson('har/index.json', {
    version: fixture.version,
    labels: fixture.labels,
    files: files.map((file) => file.path),
    stats: fixture.stats,
    fingerprint: fixture.fingerprint,
  });
  return {
    files,
    index,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    totalBytes: fixture.stats.totalBytes,
  };
}

/** 从 tmp 工作区按索引把来源读回（字符串输入给 parseHarSource，走真实解析路径）。 */
export function readHarFixture(workspace, fixture) {
  const index = workspace.readJson('har/index.json');
  const sources = index.files.map((file) => workspace.readText(file));
  return { index, sources };
}

// ---------------------------------------------------------------------------
// 失败注入探针：验证 validateHarDeep 能给出可解释的失败原因
// ---------------------------------------------------------------------------

const SMALL_VALID_HAR = () => ({
  log: {
    version: '1.2',
    creator: { name: 'longtail-probe', version: '1.0' },
    pages: [],
    entries: [{
      startedDateTime: '2026-03-01T00:00:00.000Z',
      time: 120,
      request: { method: 'GET', url: 'https://longtail.test/probe.json', httpVersion: 'HTTP/1.1', headers: [], queryString: [], cookies: [], headersSize: 10, bodySize: 0 },
      response: { status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [], cookies: [], content: { size: 2, mimeType: 'application/json', text: '{}' }, redirectURL: '', headersSize: 10, bodySize: 2 },
      cache: {},
      timings: { blocked: 0, dns: 0, connect: 0, send: 1, wait: 100, receive: 19 },
    }],
  },
});

/** 返回若干"坏 HAR"探针：每条带期望的 validateHarDeep issue code。 */
export function buildHarFailureProbes() {
  const probes = [];
  const missingUrl = SMALL_VALID_HAR();
  delete missingUrl.log.entries[0].request.url;
  probes.push({ name: 'missing-request-url', har: missingUrl, expectedCodes: ['missing-url'] });

  const badStatus = SMALL_VALID_HAR();
  badStatus.log.entries[0].response.status = 1200;
  probes.push({ name: 'bad-status', har: badStatus, expectedCodes: ['bad-status'] });

  const badTiming = SMALL_VALID_HAR();
  badTiming.log.entries[0].timings.wait = -5;
  probes.push({ name: 'bad-timing', har: badTiming, expectedCodes: ['bad-timing'] });

  const duplicatePageId = SMALL_VALID_HAR();
  duplicatePageId.log.pages = [
    { id: 'p1', startedDateTime: '2026-03-01T00:00:00.000Z', pageTimings: {} },
    { id: 'p1', startedDateTime: '2026-03-01T00:00:01.000Z', pageTimings: {} },
  ];
  probes.push({ name: 'duplicate-page-id', har: duplicatePageId, expectedCodes: ['duplicate-page-id'] });

  const badSum = SMALL_VALID_HAR();
  badSum.log.entries[0].timings.wait = 9000; // 分项和与 time 不一致 → warning
  badSum.log.entries[0].timings._breakdownSumMs = 9_120;
  probes.push({ name: 'timings-sum-mismatch', har: badSum, expectedCodes: ['timings-sum-mismatch'], severity: 'warning' });

  return probes;
}

// tests/unit/capture-tiled-runtime.test.mjs
// 运行时集成证据：在 Node 里用最小 chrome/CDP/IndexedDB/Canvas 假环境真正执行
// extension/src/tiled-capture.js（segmented / 单画布 / stale extend / 失败 / 预算降级）
// 与 extension/src/longshot-recover.js，断言结果字段、manifest、state 证据、断点恢复产物。
//
// 这不是复制实现：所有业务分支都由真实运行时模块执行，假环境只提供浏览器 API 替身
// （chrome.debugger.sendCommand 返回可解析的“PNG”字节、OffscreenCanvas 记录绘制指令并
// 产出确定性字节、IndexedDB 用内存 Map 实现事务/索引语义）。
import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// 假浏览器环境
// ---------------------------------------------------------------------------
const DB_STORES = new Map(); // storeName -> Map(key -> record)
const KEY_PATHS = { frames: 'key', tiles: 'key', manifests: 'captureId' };
const IDB_KEY_RANGE = { only: (value) => ({ only: true, value }) };

function makeFakeDb() {
  return {
    objectStoreNames: { contains: (name) => DB_STORES.has(name) },
    createObjectStore(name) {
      DB_STORES.set(name, DB_STORES.get(name) || new Map());
      return { createIndex() {} };
    },
    transaction(names) {
      return fakeTransaction(Array.isArray(names) ? names : [String(names)]);
    },
    close() {},
  };
}

function fakeTransaction() {
  const tx = { mode: 'readwrite', _pending: 0, oncomplete: null, onerror: null };
  const settle = () => {
    tx._pending -= 1;
    queueMicrotask(() => {
      if (tx._pending === 0 && typeof tx.oncomplete === 'function') tx.oncomplete();
    });
  };
  const request = (executor) => {
    tx._pending += 1;
    const req = { result: undefined, error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      try {
        req.result = executor();
        if (typeof req.onsuccess === 'function') req.onsuccess();
      } catch (error) {
        req.error = error;
        if (typeof req.onerror === 'function') req.onerror();
      } finally {
        settle();
      }
    });
    return req;
  };
  const cursorRequest = (map, matches) => {
    tx._pending += 1;
    const entries = [...map.entries()].filter(([, value]) => matches(value));
    let index = 0;
    const req = { result: null, onsuccess: null, onerror: null };
    const step = () => queueMicrotask(() => {
      if (index < entries.length) {
        const [key, value] = entries[index];
        index += 1;
        req.result = { primaryKey: key, value, delete() { map.delete(key); }, continue: step };
      } else {
        req.result = null;
      }
      if (typeof req.onsuccess === 'function') req.onsuccess();
      if (req.result === null) settle();
    });
    step();
    return req;
  };
  const store = (name) => {
    const data = () => {
      if (!DB_STORES.has(name)) DB_STORES.set(name, new Map());
      return DB_STORES.get(name);
    };
    const keyPath = KEY_PATHS[name] || 'key';
    return {
      put(value) {
        tx._pending += 1;
        queueMicrotask(() => {
          // 模拟"落盘后字节被改写"：只破坏一次，用于验证 hash 校验失败 → 重取链路。
          let stored = value;
          if (page.corruptNextTileWrite && name === 'tiles' && value && value.blob) {
            page.corruptNextTileWrite = false;
            const bytes = new Uint8Array(value.blob._bytes);
            bytes[bytes.length - 1] = bytes[bytes.length - 1] ^ 0xff;
            stored = { ...value, blob: new FakeBlob(bytes) };
          }
          data().set(String(stored[keyPath]), stored);
          settle();
        });
      },
      delete(key) {
        tx._pending += 1;
        queueMicrotask(() => {
          data().delete(String(key));
          settle();
        });
      },
      get(key) {
        return request(() => data().get(String(key)));
      },
      getAll() {
        return request(() => [...data().values()]);
      },
      openCursor() {
        return cursorRequest(data(), () => true);
      },
      index(indexName) {
        if (indexName !== 'captureId') throw new Error('假 IndexedDB 只实现 captureId 索引');
        return {
          getAll(range) {
            return request(() => [...data().values()].filter((record) => !range || record.captureId === range.value));
          },
          openKeyCursor(range) {
            return cursorRequest(data(), (record) => record.captureId === range.value);
          },
        };
      },
    };
  };
  tx.objectStore = store;
  return tx;
}

// IndexedDB 的一个简化实现：open 时按需建 store，事务用微任务模拟异步完成。
function fakeIndexedDbOpen(_name, _version) {
  const request = { result: undefined, error: null, onsuccess: null, onupgradeneeded: null, onerror: null };
  queueMicrotask(() => {
    request.result = makeFakeDb();
    if (typeof request.onupgradeneeded === 'function') request.onupgradeneeded();
    if (typeof request.onsuccess === 'function') request.onsuccess();
  });
  return request;
}

class FakeBlob {
  constructor(bytes, type = 'image/png') {
    this._bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.size = this._bytes.length;
    this.type = type;
  }
  async arrayBuffer() {
    return this._bytes.buffer.slice(this._bytes.byteOffset, this._bytes.byteOffset + this._bytes.byteLength);
  }
}

class FakeFileReader {
  readAsDataURL(blob) {
    queueMicrotask(() => {
      this.result = 'data:image/png;base64,' + Buffer.from(blob._bytes).toString('base64');
      if (typeof this.onload === 'function') this.onload();
    });
  }
}

let imageSeq = 0;
function makeBitmapFromMeta(meta) {
  imageSeq += 1;
  return { width: Math.max(1, meta.w), height: Math.max(1, meta.h), __id: imageSeq, __seed: meta.seed || 0, close() {} };
}

function parseDataUrl(url) {
  const text = String(url);
  const comma = text.indexOf(',');
  const base64 = comma >= 0 ? text.slice(comma + 1) : '';
  const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
  let meta = { w: 1, h: 1, seed: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
    if (parsed && typeof parsed === 'object') meta = { w: parsed.w || 1, h: parsed.h || 1, seed: parsed.seed || 0 };
  } catch { /* 非 JSON 字节按 1x1 处理 */ }
  const blob = new FakeBlob(bytes);
  blob.__meta = meta;
  return blob;
}

class FakeCanvasContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.fillStyle = '#000000';
    this.__seed = 0;
    this.draws = 0;
  }
  fillRect() {}
  drawImage(image, ...args) {
    const normalized = args.map((value) => (typeof value === 'number' ? Math.round(value * 1000) / 1000 : 0));
    this.canvas._ops.push(['draw', image && image.__id ? image.__id : 0, ...normalized]);
    if (image && typeof image.__seed === 'number') this.__seed = image.__seed;
    this.draws += 1;
  }
  getImageData(_x, _y, width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < data.length; index += 4) {
      data[index] = this.__seed & 255;
      data[index + 1] = (this.draws * 7) & 255;
      data[index + 2] = (this.canvas._ops.length * 13) & 255;
      data[index + 3] = 255;
    }
    return { data };
  }
}

let canvasSeq = 0;
class FakeOffscreenCanvas {
  constructor(width, height) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this._ops = [];
    this.__id = (canvasSeq += 1);
  }
  getContext() {
    if (!this._context) this._context = new FakeCanvasContext(this);
    return this._context;
  }
  async convertToBlob() {
    const payload = JSON.stringify({ w: this.width, h: this.height, ops: this._ops });
    return new FakeBlob(new TextEncoder().encode(payload));
  }
}

// ---- 页面事实与 CDP 假实现 ----
const page = {
  metrics: {
    url: 'https://fake.test/doc',
    title: 'fake',
    scrollHeight: 15000,
    scrollWidth: 1241,
    innerWidth: 1241,
    innerHeight: 800,
    scrollY: 0,
    scrollX: 0,
    dpr: 1,
    revision: 1,
    fixedTopHeight: 0,
    fixedBottomHeight: 0,
    fixedBands: [],
  },
  metricsPlan: [],
  metricsCalls: 0,
  screenshots: [],
  failNextScreenshot: false,
  corruptNextTileWrite: false,
};

function setupPage(options = {}) {
  page.metrics = {
    ...page.metrics,
    ...options.metrics,
    scrollHeight: options.scrollHeight != null ? options.scrollHeight : 15000,
    scrollWidth: options.scrollWidth != null ? options.scrollWidth : 1241,
    dpr: options.dpr != null ? options.dpr : 1,
    fixedTopHeight: options.fixedTop != null ? options.fixedTop : 0,
    fixedBottomHeight: options.fixedBottom != null ? options.fixedBottom : 0,
    fixedBands: options.fixedBands || [],
    scrollY: 0,
    revision: 1,
  };
  page.metricsPlan = Array.isArray(options.metricsPlan) ? options.metricsPlan.slice() : [];
  page.metricsCalls = 0;
  page.screenshots = [];
  page.failNextScreenshot = options.failNextScreenshot === true;
  page.corruptNextTileWrite = options.corruptNextTileWrite === true;
}

function pageResponse(name, args) {
  if (name === 'page-metrics') {
    page.metricsCalls += 1;
    if (page.metricsPlan.length) {
      const override = page.metricsPlan.shift();
      return override ? { ...page.metrics, ...override } : { ...page.metrics };
    }
    return { ...page.metrics };
  }
  if (name === 'scroll-to-y') {
    page.metrics.scrollY = Number(args && args.y) || 0;
    return { scrollY: page.metrics.scrollY };
  }
  return {};
}

let shotSeq = 0;
function fakeScreenshot(params) {
  if (page.failNextScreenshot) {
    page.failNextScreenshot = false;
    throw new Error('capture boom');
  }
  const clip = params && params.clip;
  const dpr = page.metrics.dpr;
  const width = clip ? Math.max(1, Math.round(clip.width * dpr)) : Math.max(1, Math.round(page.metrics.innerWidth * dpr));
  const height = clip ? Math.max(1, Math.round(clip.height * dpr)) : Math.max(1, Math.round(page.metrics.innerHeight * dpr));
  shotSeq += 1;
  const meta = { w: width, h: height, seed: shotSeq };
  page.screenshots.push(meta);
  return { data: Buffer.from(JSON.stringify(meta)).toString('base64') };
}

const chromeStub = {
  runtime: { getManifest: () => ({ version: 'test' }), lastError: null, getURL: (path) => 'chrome-extension://test/' + path },
  tabs: {
    get: async (tabId) => ({ id: tabId, windowId: 1, url: 'https://fake.test/doc', pendingUrl: '' }),
    query: async () => [],
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} },
    onCreated: { addListener() {} },
  },
  debugger: {
    sendCommand: async (_target, method, params) => {
      if (method === 'Page.captureScreenshot') return fakeScreenshot(params);
      return {};
    },
    attach: async () => {},
    detach: async () => {},
    onEvent: { addListener() {} },
    onDetach: { addListener() {} },
  },
  scripting: {
    executeScript: async (injection) => {
      const args = Array.isArray(injection && injection.args) ? injection.args : [];
      const name = args[0];
      // 与 inject.js 里 pageCallFunc 的返回形状保持一致：{ok:true, result}。
      return [{ result: { ok: true, result: pageResponse(name, args[1]) } }];
    },
  },
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    session: { get: async () => ({}), set: async () => {} },
    onChanged: { addListener() {} },
  },
  alarms: { create: async () => {}, onAlarm: { addListener() {} } },
  windows: { get: async () => ({ id: 1 }) },
  permissions: { contains: async () => true },
  offscreen: { hasDocument: async () => false, createDocument: async () => {} },
};

globalThis.chrome = chromeStub;
globalThis.indexedDB = { open: fakeIndexedDbOpen };
globalThis.IDBKeyRange = IDB_KEY_RANGE;
globalThis.OffscreenCanvas = FakeOffscreenCanvas;
globalThis.createImageBitmap = async (blob) => makeBitmapFromMeta(blob && blob.__meta ? blob.__meta : { w: 1, h: 1, seed: 0 });
globalThis.FileReader = FakeFileReader;
globalThis.fetch = async (url) => ({ blob: async () => parseDataUrl(url) });

// 静音运行时日志并收集，用于断言"运行时路径真的走到了"。
const runtimeLogs = [];
const originalLog = console.log;
console.log = (...args) => { runtimeLogs.push(args.map(String).join(' ')); };

const { captureTiledFullPage } = await import('../../extension/src/tiled-capture.js');
const { recoverLongshot } = await import('../../extension/src/longshot-recover.js');
const { listLongshotTiles } = await import('../../extension/src/lib/longshot-store.js');
const { longshotRuns } = await import('../../extension/src/lib/longshot-state.js');
const { estimateTileCount } = await import('../../extension/src/lib/longshot-budget.js');

test.after(() => {
  console.log = originalLog;
});

function findLatestRun(predicate) {
  return longshotRuns.list().filter(predicate).pop();
}

test('运行时集成：45000px 页面走分段采集 → 2 段 + manifest sealed + longshot.recover 复原', async () => {
  setupPage({ scrollWidth: 1241, scrollHeight: 45000, dpr: 1 });
  const result = await captureTiledFullPage(1, 'https://fake.test/tall', 1241, 45000, 1, 0, {});
  assert.equal(result.segmented, true, '应走分段路径');
  assert.equal(result.segment_count, 2);
  assert.equal(result.height, 45000);
  assert.equal(result.segments[0].height, 40000, '首段高度受单画布上限约束');
  assert.equal(result.segments[0].offsetY, 0);
  assert.equal(result.segments[1].offsetY, 40000);
  assert.equal(result.state.state, 'sealed', '状态机应走到 sealed');
  assert.equal(result.state.terminal, true);
  assert.equal(result.budget.degraded, false);
  assert.equal(result.budget.used.segments, 2);
  assert.equal(result.budget.budget.maxSegmentPixels, 64 * 1024 * 1024);
  assert.equal(typeof result.longshot_id, 'string');
  assert.equal(result.manifest.sealed, true, 'manifest 应封版');
  assert.equal(result.manifest.total, 2);
  assert.equal(result.manifest.captured, 2);
  assert.equal(result.manifest.hashCount, 2);
  assert.equal(result.manifest_verified.hashVerified, true);
  assert.equal(result.plan.fractionalDpr, false);
  assert.ok(result.tile_size >= 256);
  assert.ok(result.tiled > 0);

  const tiles = await listLongshotTiles(result.longshot_id);
  assert.equal(tiles.length, 2, '两个段各落一个分片');
  assert.ok(tiles.every((tile) => /^[0-9a-f]{16}$/.test(tile.hash)), '分片应带 16 hex hash');
  assert.ok(tiles.every((tile) => tile.bytes > 0));

  const recovered = await recoverLongshot({ longshotId: result.longshot_id });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.width, 1241);
  assert.equal(recovered.height, 45000, '恢复高度应与分段总高一致');
  assert.equal(recovered.tiles, 2);
  assert.equal(recovered.gaps.length, 0);
  assert.equal(recovered.complete, true);
  assert.equal(recovered.sealed, true);
  assert.equal(recovered.recovered, false, '已封版恢复不标 recovered');
  assert.equal(recovered.recovery.hashVerified, true);
  assert.equal(recovered.recovery.resume.action, 'sealed');
  assert.ok(String(recovered.dataUrl).startsWith('data:image/png;base64,'));
  assert.ok(recovered.bytes > 0);

  assert.ok(runtimeLogs.some((line) => line.includes('长截图预算')), '运行时没有走到预算日志');
  assert.ok(runtimeLogs.some((line) => line.includes('长截图分段规划')), '运行时没有走到分段规划');
  assert.ok(runtimeLogs.some((line) => line.includes('分段截图 2/2')), '运行时没有逐段落盘日志');
});

test('运行时集成：15000px@1.5 页面单画布分块 → 固定顶/底带重绘 + tile manifest 封版', async () => {
  setupPage({ scrollWidth: 1241, scrollHeight: 15000, dpr: 1.5, fixedTop: 56, fixedBottom: 80, fixedBands: [{ edge: 'top' }, { edge: 'bottom' }] });
  const result = await captureTiledFullPage(1, 'https://fake.test/footer', 1241, 15000, 1.5, 0, { tileSize: 512 });
  assert.notEqual(result.segmented, true, '15000px 不应分段');
  assert.equal(result.width, 1862);
  assert.equal(result.height, 22500);
  assert.equal(result.dpr, 1.5, '分数 DPR 必须原样透出');
  assert.equal(result.fixedTop, 84, '固定顶带按 1.5 DPR 重绘');
  assert.equal(result.fixedFooter, 120, '固定页脚按 1.5 DPR 重绘');
  assert.equal(result.fixedBands, 2);
  assert.equal(result.state.state, 'sealed');
  const expected = estimateTileCount({ deviceWidth: 1862, deviceHeight: 22500, tileSize: 512 });
  assert.equal(result.tiled, expected.tiles);
  assert.equal(result.tiles_persisted, expected.tiles);
  assert.equal(result.manifest.total, expected.tiles);
  assert.equal(result.manifest.captured, expected.tiles);
  assert.equal(result.manifest.sealed, true);
  assert.equal(result.manifest_verified.hashVerified, true);
  assert.equal(result.tile_size, 512);

  const recovered = await recoverLongshot({ longshotId: result.longshot_id });
  assert.equal(recovered.width, 1862);
  assert.equal(recovered.height, 22500);
  assert.equal(recovered.tiles, expected.tiles);
  assert.equal(recovered.complete, true);
  assert.equal(recovered.sealed, true);
  assert.equal(recovered.recovery.hashVerified, true);
});

test('运行时集成：页面底部增长触发 stale 补拍，状态回采集再封版', async () => {
  setupPage({
    scrollWidth: 1241,
    scrollHeight: 15000,
    dpr: 1,
    metricsPlan: [null, { scrollHeight: 15800, revision: 2 }],
  });
  const result = await captureTiledFullPage(1, 'https://fake.test/grow', 1241, 15000, 1, 0, { tileSize: 1024, staleAttempts: 2 });
  assert.equal(result.stale, true, '应标记 stale');
  assert.equal(result.extended, true, '底部增长应就地补拍');
  assert.equal(result.stale_repairs, 1);
  assert.equal(result.height, 15800, '补拍后总高应跟上页面');
  assert.equal(result.state.state, 'sealed', 'stale 修复后应能封版');
  assert.ok(result.state.staleRetries >= 0);
  const run = findLatestRun((item) => item.state === 'sealed' && item.tiles > 0);
  assert.ok(run, '状态机应留下 sealed 运行证据');
  assert.ok(run.history.some((entry) => entry.event === 'stale.detected'), '状态历史应包含 stale.detected');
  assert.equal(result.manifest.sealed, true);
});

test('运行时集成：CDP 截图失败 → 状态机 failed 且错误原样抛出', async () => {
  setupPage({ scrollWidth: 1241, scrollHeight: 15000, dpr: 1, failNextScreenshot: true });
  await assert.rejects(() => captureTiledFullPage(1, 'https://fake.test/fail', 1241, 15000, 1, 0, {}), /capture boom/);
  const failed = findLatestRun((item) => item.state === 'failed' && String(item.failedReason).includes('capture boom'));
  assert.ok(failed, '失败运行应有 failed 证据');
  assert.equal(failed.terminal, true);
  assert.ok(failed.lastRejection === null || failed.lastRejection !== undefined);
});

test('运行时集成：分片字节被改写 → hash 校验失败 → 重取该段后封版', async () => {
  setupPage({ scrollWidth: 1241, scrollHeight: 45000, dpr: 1, corruptNextTileWrite: true });
  const result = await captureTiledFullPage(1, 'https://fake.test/corrupt', 1241, 45000, 1, 0, {});
  assert.equal(result.segmented, true);
  assert.equal(result.manifest_verified.mismatched, 1, '被改写分片应被 hash 校验抓到');
  assert.equal(result.manifest_verified.refetched, 1, '抓到后应重取一次');
  assert.equal(result.manifest_verified.hashVerified, true);
  assert.equal(result.state.state, 'sealed');
  assert.equal(result.manifest.sealed, true);
  assert.equal(result.manifest.hashCount, 2);
  assert.ok(runtimeLogs.some((line) => line.includes('分片 hash 校验未通过')), '运行时没有走到 hash 重取日志');
  const recovered = await recoverLongshot({ longshotId: result.longshot_id });
  assert.equal(recovered.complete, true, '重取后的分片应能通过恢复校验');
  assert.equal(recovered.recovery.hashVerified, true);
  assert.equal(recovered.tiles, 2);
});

test('运行时集成：8000x60000 超大页触发预算降级（DPR 无档位可降 → 显式截断）', async () => {
  setupPage({ scrollWidth: 8000, scrollHeight: 60000, dpr: 1 });
  const result = await captureTiledFullPage(1, 'https://fake.test/huge', 8000, 60000, 1, 0, { tileSize: 4096 });
  assert.equal(result.degraded, true, '超预算必须标记 degraded');
  assert.equal(result.truncated, true, '超预算必须标记截断');
  assert.equal(result.budget.reason, 'memory-budget');
  assert.equal(result.budget.degraded, true);
  assert.equal(result.height, Math.floor((400 * 1024 * 1024) / 8000));
  assert.ok(result.height < 60000);
  assert.ok(result.budget.used.totalPixels <= result.budget.budget.maxTotalPixels);
  assert.equal(result.segmented, true);
  assert.equal(result.segment_count, result.budget.used.segments);
  assert.equal(result.state.state, 'sealed');
  assert.equal(result.manifest.sealed, true);
});

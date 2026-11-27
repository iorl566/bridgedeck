// tests/cdp-domains.test.ts —— trace / PDF / emulate / closed-shadow pierce / trusted input 单测。
//
// 全部用假 CdpChannel（记录命令、可脚本化返回），不 attach 真实浏览器：
// - TraceService：Tracing.start/dataCollected/tracingComplete → Trace JSON + summary；
// - PdfService：Page.printToPDF 参数归一（页码/缩放/边距/纸张）+ base64 回包；
// - EmulateService：Emulation.setDeviceMetricsOverride / clear + innerWidth 实测；
// - PierceService：DOM.getDocument(pierce) 找 closed shadow + shadow.click/shadow.read/ref；
// - InputService：Input 事件序列（可信鼠标/键盘/文本）+ backendNodeId 点击。

import assert from 'node:assert/strict';
import test from 'node:test';

import { TraceService, summarizeTraceEvents } from '../src/debug/trace.ts';
import { PdfService, buildPrintToPdfParams, normalizeMargins, normalizePageRanges } from '../src/capture/pdf.ts';
import { EmulateService } from '../src/debug/emulate.ts';
import {
  PierceService,
  browseClosedShadow,
  collectClosedShadowCandidates,
  findClosedShadowByText,
} from '../src/scripting/pierce.ts';
import { InputService, movePath, parseKeySpec, MODIFIERS } from '../src/scripting/input.ts';
import type { CdpChannel, CdpChannelHandler } from '../src/debug/cdp-channel.ts';

interface SentCommand {
  tabId: number;
  method: string;
  params: Record<string, unknown>;
}

class FakeChannel implements CdpChannel {
  acquires: Array<{ tabId: number; feature: string }> = [];
  releases: Array<{ tabId: number; feature: string }> = [];
  sent: SentCommand[] = [];
  commandImpl: (tabId: number, method: string, params: Record<string, unknown>) => Promise<unknown> = async () => ({});
  private readonly handlers = new Map<string, Set<CdpChannelHandler>>();

  async acquire(tabId: number, feature: string): Promise<void> {
    this.acquires.push({ tabId, feature });
  }

  release(tabId: number, feature: string): void {
    this.releases.push({ tabId, feature });
  }

  async send<T = unknown>(tabId: number, method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.sent.push({ tabId, method, params });
    return await this.commandImpl(tabId, method, params) as T;
  }

  onEvent(tabId: number, method: string, handler: CdpChannelHandler): () => void {
    const key = String(tabId) + ':' + method;
    let set = this.handlers.get(key);
    if (!set) {
      set = new Set();
      this.handlers.set(key, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  emit(tabId: number, method: string, params: Record<string, unknown> = {}): void {
    const set = this.handlers.get(String(tabId) + ':' + method);
    if (!set) return;
    for (const handler of [...set]) handler(params, { tabId });
  }

  commandsOf(method: string): Array<Record<string, unknown>> {
    return this.sent.filter((item) => item.method === method).map((item) => item.params);
  }

  has(method: string): boolean {
    return this.sent.some((item) => item.method === method);
  }
}

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// trace
// ---------------------------------------------------------------------------

test('TraceService：start → dataCollected → stop 产出 Trace JSON 与一致 summary', async () => {
  const channel = new FakeChannel();
  channel.commandImpl = async (tabId, method) => {
    if (method === 'Tracing.end') {
      setTimeout(() => {
        channel.emit(tabId, 'Tracing.dataCollected', { value: [
          { name: 'EventA', cat: 'devtools.timeline', ts: 1_000_000, dur: 1_000 },
          { name: 'EventA', cat: 'devtools.timeline', ts: 1_002_000, dur: 2_000 },
          { name: 'EventB', cat: 'v8.execute', ts: 1_004_000, dur: 500 },
        ] });
        channel.emit(tabId, 'Tracing.tracingComplete', {});
      }, 0);
    }
    return {};
  };
  const trace = new TraceService({ client: channel, now: () => 10_000 });
  const started = await trace.start(7);
  assert.equal(started['tracing'], true);
  assert.deepEqual(channel.commandsOf('Tracing.start')[0], {
    categories: 'devtools.timeline,v8.execute,blink.user_timing',
    options: 'sampling-frequency=1000',
    transferMode: 'ReportEvents',
  });
  assert.equal(trace.status(7)['tracing'], true);
  const stopped = await trace.stop(7);
  assert.equal(stopped['events'], 3);
  const summary = stopped['summary'] as Record<string, unknown>;
  assert.equal(summary['events'], 3);
  assert.equal((summary['topNames'] as Array<Record<string, unknown>>)[0]?.['name'], 'EventA');
  assert.equal((summary['topNames'] as Array<Record<string, unknown>>)[0]?.['count'], 2);
  assert.equal(summary['spanMs'], 4);
  const parsed = JSON.parse(String(stopped['trace'])) as { traceEvents?: unknown[] };
  assert.equal(parsed.traceEvents?.length, 3);
  assert.equal(trace.status(7)['tracing'], false);
  assert.deepEqual(channel.releases.map((item) => item.feature), ['trace']);
  await trace.dispose();
});

test('TraceService：重复 start / 未 start 的 stop 明确报 E_BAD_ARG', async () => {
  const channel = new FakeChannel();
  const trace = new TraceService({ client: channel, stopTimeoutMs: 50 });
  await trace.start(7);
  await assert.rejects(() => trace.start(7), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'E_BAD_ARG');
    return true;
  });
  await trace.stop(7);
  await assert.rejects(() => trace.stop(7), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'E_BAD_ARG');
    return true;
  });
  await trace.dispose();
});

test('summarizeTraceEvents：分类/名称 top20/clock domain 保护/截断标记', () => {
  const events = [
    { name: 'RunTask', cat: 'devtools.timeline', ts: 100 },
    { name: 'RunTask', cat: 'devtools.timeline', ts: 200 },
    { name: 'EvaluateScript', cat: 'devtools.timeline', ts: 300 },
    { name: 'X', cat: 'v8.execute', ts: 400 },
    { name: 'bad-ts', cat: 'v8.execute', ts: 99_999_999_999 },
  ];
  const summary = summarizeTraceEvents(events, { truncated: true });
  assert.equal(summary.events, 5);
  assert.equal(summary.topNames[0]?.name, 'RunTask');
  assert.equal(summary.topNames[0]?.count, 2);
  assert.equal(summary.categories[0]?.category, 'devtools.timeline');
  assert.equal(summary.spanMs, null, '超过 1h 的 clock domain 混入应判不可信');
  assert.equal(summary.truncated, true);
});

// ---------------------------------------------------------------------------
// pdf
// ---------------------------------------------------------------------------

test('buildPrintToPdfParams / normalizeMargins / normalizePageRanges：参数归一', () => {
  assert.deepEqual(normalizeMargins({ top: 0.5, right: 0.25, bottom: 0.5, left: 0.25 }), { top: 0.5, right: 0.25, bottom: 0.5, left: 0.25 });
  assert.deepEqual(normalizeMargins('0.5,0.5,0.5,0.5'), { top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 });
  assert.deepEqual(normalizeMargins([0.1, 0.2, 0.3, 0.4]), { top: 0.1, right: 0.2, bottom: 0.3, left: 0.4 });
  assert.equal(normalizePageRanges('1'), '1');
  assert.equal(normalizePageRanges(' 1-3, 5 '), '1-3,5');
  assert.equal(normalizePageRanges('abc'), '');
  const params = buildPrintToPdfParams({
    tabId: 7,
    pages: '1',
    scale: 1,
    margins: { top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 },
  });
  assert.equal(params['pageRanges'], '1');
  assert.equal(params['scale'], 1);
  assert.equal(params['marginTop'], 0.5);
  assert.equal(params['printBackground'], true);
  assert.equal(params['landscape'], false);
  const withHeader = buildPrintToPdfParams({ tabId: 7, headerTemplate: '<b>x</b>' });
  assert.equal(withHeader['displayHeaderFooter'], true);
});

test('PdfService.printPdf：Page.printToPDF 回包 base64 + 租约释放', async () => {
  const channel = new FakeChannel();
  const pdfBase64 = 'JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmoKPDwvTGVuZ3RoIDMgMCBSL0ZpbHRlci9GbGF0ZURlY29kZT4+CnN0cmVhbQp4nDPQM1Qo5ypUMFAwALJMLU31jBQsTAz1L兼容目标UrnCtRTyuQIV8vIV8lKLijLzShRCU4syU3IU8osSU4tLFHIzU3QUnBVCgGqBpjEVChROrVJwAQBQLhL6CmVuZHN0cmVhbQplbmRvYmoK';
  channel.commandImpl = async (_tabId, method) => {
    if (method === 'Page.printToPDF') return { data: pdfBase64 };
    return {};
  };
  const pdf = new PdfService({ client: channel, now: () => 1_000 });
  const result = await pdf.printPdf({ tabId: 7, pages: '1', scale: 1, margins: '0.5,0.5,0.5,0.5' });
  assert.equal(result['ok'], true);
  assert.equal(result['base64'], pdfBase64);
  assert.equal(Number(result['bytes']) > 100, true);
  assert.equal(result['via'], 'cdp-page-printToPDF');
  const printed = channel.commandsOf('Page.printToPDF');
  assert.equal(printed.length, 1);
  assert.equal(printed[0]?.['pageRanges'], '1');
  assert.deepEqual(channel.acquires.map((item) => item.feature), ['pdf']);
  assert.deepEqual(channel.releases.map((item) => item.feature), ['pdf']);
  // 缺少 tabId → E_BAD_ARG
  await assert.rejects(() => pdf.printPdf({}), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'E_BAD_ARG');
    return true;
  });
});

// ---------------------------------------------------------------------------
// emulate
// ---------------------------------------------------------------------------

test('EmulateService：视口/DPR 覆盖 → innerWidth 生效；reset 真正清空三要素且不追加零尺寸覆盖', async () => {
  const channel = new FakeChannel();
  const viewport = { innerWidth: 1280, innerHeight: 900, dpr: 1 };
  channel.commandImpl = async (_tabId, method, params) => {
    if (method === 'Runtime.evaluate') {
      return { result: { value: { innerWidth: viewport.innerWidth, innerHeight: viewport.innerHeight, dpr: viewport.dpr } } };
    }
    if (method === 'Emulation.setDeviceMetricsOverride') {
      const width = Number(params['width']);
      if (width > 0) {
        viewport.innerWidth = width;
        viewport.innerHeight = Number(params['height']) || viewport.innerHeight;
        viewport.dpr = Number(params['deviceScaleFactor']) || 1;
      }
      return {};
    }
    if (method === 'Emulation.clearDeviceMetricsOverride') {
      viewport.innerWidth = 1280;
      viewport.innerHeight = 900;
      viewport.dpr = 1;
      return {};
    }
    return {};
  };
  const emulate = new EmulateService({ client: channel, now: () => 1_000, sleep: async () => {} });
  const applied = await emulate.emulate({ tabId: 7, viewport: { width: 1241, height: 800, deviceScaleFactor: 1.5 } });
  assert.equal(applied['ok'], true);
  assert.deepEqual((applied['applied'] as Record<string, unknown>)['viewport'], { width: 1241, height: 800, deviceScaleFactor: 1.5 });
  assert.equal(viewport.innerWidth, 1241);
  assert.equal(viewport.dpr, 1.5);
  const reset = await emulate.emulate({ tabId: 7, reset: true });
  assert.equal(reset['reset'], true);
  assert.equal(reset['restored'], true, 'reset 应报告视口/DPR 已恢复');
  assert.equal(reset['innerWidthAfter'], 1280);
  assert.equal(reset['innerHeightAfter'], 900);
  assert.equal(reset['dprAfter'], 1);
  assert.deepEqual(reset['viewportDrift'], { width: 0, height: 0 });
  assert.equal(viewport.innerWidth, 1280);
  assert.equal(viewport.dpr, 1);
  assert.equal(channel.commandsOf('Emulation.clearDeviceMetricsOverride').length >= 1, true, 'reset 必须真的调 clearDeviceMetricsOverride');
  // 正常 reset 路径不允许再发零尺寸覆盖（31g 回归根因：0 尺寸在部分 Edge 版本被当成新覆盖）。
  const overrides = channel.commandsOf('Emulation.setDeviceMetricsOverride');
  assert.equal(overrides.length, 1, '正常 reset 不应追加 setDeviceMetricsOverride：' + JSON.stringify(overrides));
  assert.deepEqual(channel.releases.map((item) => item.feature), ['emulate', 'emulate']);
  await assert.rejects(() => emulate.emulate({ tabId: 7 }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'E_BAD_ARG');
    return true;
  });
});

test('EmulateService.reset：clear 卡住时用快照真实视口兜底恢复（而非零尺寸）', async () => {
  const channel = new FakeChannel();
  const viewport = { innerWidth: 1280, innerHeight: 900, dpr: 1 };
  let clears = 0;
  let overrideCalls = 0;
  channel.commandImpl = async (_tabId, method, params) => {
    if (method === 'Runtime.evaluate') {
      return { result: { value: { innerWidth: viewport.innerWidth, innerHeight: viewport.innerHeight, dpr: viewport.dpr } } };
    }
    if (method === 'Emulation.setDeviceMetricsOverride') {
      overrideCalls += 1;
      const width = Number(params['width']);
      if (width > 0) {
        viewport.innerWidth = width;
        viewport.innerHeight = Number(params['height']) || viewport.innerHeight;
        viewport.dpr = Number(params['deviceScaleFactor']) || 1;
      }
      return {};
    }
    if (method === 'Emulation.clearDeviceMetricsOverride') {
      clears += 1;
      // 模拟 Edge 卡住：clear 成功但视口不变；兜底覆盖（width>0）才恢复。
      return {};
    }
    return {};
  };
  const emulate = new EmulateService({ client: channel, now: () => 1_000, sleep: async () => {} });
  await emulate.emulate({ tabId: 7, viewport: { width: 800, height: 600, deviceScaleFactor: 1.5 } });
  assert.equal(viewport.innerWidth, 800);
  const reset = await emulate.emulate({ tabId: 7, reset: true });
  assert.equal(clears, 4, 'clear 卡住时应重试到上限');
  const lastOverride = channel.commandsOf('Emulation.setDeviceMetricsOverride').at(-1);
  assert.deepEqual(lastOverride, { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, '兜底必须是恢复快照视口，不是零尺寸');
  assert.equal(reset['restored'], true);
  assert.equal(reset['innerWidthAfter'], 1280);
  assert.equal(reset['dprAfter'], 1);
  assert.equal(overrideCalls, 2, '一次 apply + 一次兜底恢复');
});

test('EmulateService：时区/语言/UA/touch 走对应 CDP 命令并容忍不支持', async () => {
  const channel = new FakeChannel();
  channel.commandImpl = async (_tabId, method) => {
    if (method === 'Emulation.setTimezoneOverride') throw new Error('not supported');
    return {};
  };
  const emulate = new EmulateService({ client: channel, sleep: async () => {} });
  const result = await emulate.emulate({ tabId: 7, timezone: 'Asia/Shanghai', locale: 'zh-CN', userAgent: 'UA', touch: true });
  assert.equal(result['ok'], false, '不支持的域应进 errors 而不是抛错');
  assert.equal((result['errors'] as string[]).length, 1);
  assert.deepEqual(channel.commandsOf('Network.setUserAgentOverride')[0], { userAgent: 'UA' });
  assert.deepEqual(channel.commandsOf('Emulation.setLocaleOverride')[0], { locale: 'zh-CN' });
  assert.deepEqual(channel.commandsOf('Emulation.setTouchEmulationEnabled')[0], { enabled: true, maxTouchPoints: 5 });
});

// ---------------------------------------------------------------------------
// closed shadow pierce
// ---------------------------------------------------------------------------

function closedShadowDocument(): Record<string, unknown> {
  return {
    root: {
      nodeId: 1,
      nodeType: 9,
      children: [{
        nodeId: 2,
        nodeType: 1,
        nodeName: 'DIV',
        shadowRoots: [{
          nodeId: 3,
          shadowRootType: 'closed',
          children: [{
            nodeId: 4,
            nodeType: 1,
            nodeName: 'BUTTON',
            backendNodeId: 40,
            children: [{ nodeId: 5, nodeType: 3, nodeValue: '封闭按钮' }],
          }],
        }],
      }, {
        nodeId: 6,
        nodeType: 1,
        nodeName: 'DIV',
        shadowRoots: [{
          nodeId: 7,
          shadowRootType: 'open',
          children: [{ nodeId: 8, nodeType: 1, nodeName: 'BUTTON', backendNodeId: 80 }],
        }],
      }],
    },
  };
}

function pierceChannel(): FakeChannel {
  const channel = new FakeChannel();
  channel.commandImpl = async (_tabId, method, params) => {
    if (method === 'DOM.getDocument') return closedShadowDocument();
    if (method === 'DOM.resolveNode') {
      const backendNodeId = Number(params['backendNodeId']);
      return { object: { objectId: 'obj-' + String(backendNodeId) } };
    }
    if (method === 'Runtime.callFunctionOn') {
      return { result: { value: { text: '封闭按钮', tag: 'button', visible: true } } };
    }
    return {};
  };
  return channel;
}

test('collectClosedShadowCandidates：只收 closed 子树里的交互元素', () => {
  const candidates = collectClosedShadowCandidates(closedShadowDocument()['root']);
  assert.equal(candidates.length, 1, 'open shadow 不算 closed shadow');
  assert.equal(candidates[0]?.backendNodeId, 40);
  assert.equal(candidates[0]?.nodeName, 'BUTTON');
});

test('PierceService.shadowClick/shadowRead：via=cdp-closed-shadow；ref 路径 via=closed-shadow-ref', async () => {
  const channel = pierceChannel();
  const inputCalls: Array<{ tabId: number; backendNodeId: number }> = [];
  const input = {
    async clickBackendNode(tabId: number, backendNodeId: number) {
      inputCalls.push({ tabId, backendNodeId });
      return { ok: true, trusted: true, via: 'cdp-backend', x: 11, y: 22 };
    },
  };
  const pierce = new PierceService({ client: channel, input, now: () => 1_000 });
  const clicked = await pierce.shadowClick({ tabId: 7, text: '封闭按钮' });
  assert.equal(clicked['via'], 'cdp-closed-shadow');
  assert.equal(clicked['matched'], '封闭按钮');
  assert.equal(clicked['trusted'], true);
  assert.deepEqual(inputCalls[0], { tabId: 7, backendNodeId: 40 });

  const read = await pierce.shadowRead({ tabId: 7, text: '封闭' });
  assert.equal(read['via'], 'cdp-closed-shadow');
  assert.equal(read['matched'], '封闭按钮');

  const byRef = await pierce.clickRefNode(7, 40);
  assert.equal(byRef['via'], 'closed-shadow-ref');
  assert.equal(byRef['backendNodeId'], 40);

  await assert.rejects(() => pierce.shadowClick({ tabId: 7, text: '不存在的按钮' }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'E_NOT_FOUND');
    return true;
  });
  await assert.rejects(() => pierce.shadowClick({ tabId: 7 }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'E_BAD_ARG');
    return true;
  });
});

test('browseClosedShadow / findClosedShadowByText：返回可见 closed shadow 条目', async () => {
  const channel = pierceChannel();
  const entries = await browseClosedShadow(channel, 7);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.text, '封闭按钮');
  assert.equal(entries[0]?.backendNodeId, 40);
  assert.deepEqual(channel.releases.map((item) => item.feature), ['closed-shadow']);
  const found = await findClosedShadowByText(channel, 7, '封闭');
  assert.equal(found?.backendNodeId, 40);
  assert.equal(await findClosedShadowByText(channel, 7, 'nope'), null);
});

// ---------------------------------------------------------------------------
// trusted input
// ---------------------------------------------------------------------------

test('parseKeySpec / movePath：按键映射与轨迹分段', () => {
  const enter = parseKeySpec('Enter');
  assert.equal(enter.key, 'Enter');
  assert.equal(enter.vk, 13);
  assert.equal(enter.text, '\r');
  const ctrlA = parseKeySpec('ctrl+a');
  assert.equal(ctrlA.modifiers, MODIFIERS.ctrl);
  assert.equal(ctrlA.key, 'a');
  assert.equal(ctrlA.code, 'KeyA');
  const slash = parseKeySpec('/');
  assert.equal(slash.code, 'Slash');
  const question = parseKeySpec('?');
  assert.equal(question.shift, true);
  assert.equal(question.modifiers & MODIFIERS.shift, MODIFIERS.shift);
  assert.throws(() => parseKeySpec('NotARealKey'), /不支持的按键/);
  const path = movePath({ x: 0, y: 0 }, { x: 10, y: 20 }, 3);
  assert.equal(path.length, 3);
  assert.deepEqual(path[2], { x: 10, y: 20 });
});

test('InputService.clickPoint/pressKey/insertText/clickBackendNode：可信事件序列', async () => {
  const channel = new FakeChannel();
  channel.commandImpl = async (_tabId, method, params) => {
    if (method === 'Runtime.callFunctionOn') return { result: { value: { x: 100, y: 200, tag: 'button' } } };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
    void params;
    return {};
  };
  const input = new InputService({ client: channel, now: () => 1_000 });
  const clicked = await input.clickPoint(7, { x: 100, y: 200 }, { human: true, steps: 4 });
  assert.equal(clicked['trusted'], true);
  const moves = channel.commandsOf('Input.dispatchMouseEvent').filter((item) => item['type'] === 'mouseMoved');
  assert.equal(moves.length, 5, 'human 点击应先有 5 段 mousemove（antibot 要求 ≥3）');
  assert.equal(channel.commandsOf('Input.dispatchMouseEvent').filter((item) => item['type'] === 'mousePressed').length, 1);
  assert.equal(channel.commandsOf('Input.dispatchMouseEvent').filter((item) => item['type'] === 'mouseReleased').length, 1);
  assert.equal(channel.has('Emulation.setFocusEmulationEnabled'), true);
  // 时间戳单调递增
  const stamps = channel.commandsOf('Input.dispatchMouseEvent').map((item) => Number(item['timestamp']));
  for (let index = 1; index < stamps.length; index += 1) {
    assert.equal(stamps[index]! > stamps[index - 1]!, true, '事件时间戳必须单调递增');
  }

  const pressed = await input.pressKey(7, 'Enter');
  assert.equal(pressed['trusted'], true);
  const keyDown = channel.commandsOf('Input.dispatchKeyEvent').find((item) => item['type'] === 'keyDown');
  assert.equal(keyDown?.['key'], 'Enter');
  assert.equal(keyDown?.['text'], '\r');
  assert.equal(keyDown?.['windowsVirtualKeyCode'], 13);

  const typed = await input.insertText(7, 'native-typing');
  assert.equal(typed['length'], 13);
  assert.deepEqual(channel.commandsOf('Input.insertText')[0], { text: 'native-typing' });

  const backend = await input.clickBackendNode(7, 40);
  assert.equal(backend['via'], 'cdp-backend');
  assert.equal(backend['x'], 100);
  assert.equal(backend['y'], 200);
  assert.equal(backend['trusted'], true);
  await input.forgetTab(7);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, renderTraceHtml } from '../../lib/trace-viewer.mjs';

function sampleTrace() {
  return {
    version: 3,
    purpose: 'demo <trace>',
    started_at: '2026-11-13T10:00:00.000Z',
    recorded_at: '2026-11-13T10:00:05.000Z',
    stopped_by: 'cli_stop',
    entry: { start_url: 'https://example.test/?q=<script>alert(1)</script>' },
    recorder: { cli: '0.1.2', vom: 1 },
    states: [
      { id: 's1', url: 'https://example.test/', title: 'Home', body: 'hello <script>alert(1)</script>' },
      { id: 's2', url: 'https://example.test/next', title: 'Next', body: 'world' },
    ],
    steps: [
      { id: 1, at: '2026-11-13T10:00:01.250Z', op: 'click', state: 's1', result: { state: 's2' }, target: { ref: '@e1', role: 'button', name: '提交 <b>' }, screenshot: 'data:image/jpeg;base64,AAA' },
      { id: 2, at: '2026-11-13T10:00:02.500Z', op: 'fill', state: 's2', result: { state: 's2' }, target: { selector: '#name' }, value: 'visible-value', commit: 'blur' },
      { id: 3, at: '2026-11-13T10:00:03.750Z', op: 'fill', state: 's2', result: { state: 's2' }, target: { name: '密码' }, value: 'secret-value', commit: 'enter', redacted: true },
    ],
    network: [
      { at: '2026-11-13T10:00:01.500Z', method: 'GET', url: 'https://example.test/api?q=<script>', status: 200, type: 'xhr' },
      { at: '2026-11-13T10:00:02.000Z', method: 'POST', url: 'https://example.test/login', status: 401, type: 'fetch' },
    ],
    screenshots: [
      { id: 'shot-1', at: '2026-11-13T10:00:04.000Z', label: '导出时页面', width: 120, height: 80, dataUrl: 'data:image/png;base64,' + Buffer.from('png').toString('base64') },
      { id: 'bad', label: 'bad', dataUrl: 'javascript:alert(1)' },
    ],
  };
}

test('escapeHtml 转义五类字符', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
});

test('渲染步骤、目标、状态与搜索属性', () => {
  const html = renderTraceHtml(sampleTrace());
  assert.match(html, /demo &lt;trace&gt;/);
  assert.match(html, /提交 &lt;b&gt;/);
  assert.match(html, /data-search="[^"]*提交 &lt;b&gt;/);
  assert.match(html, /状态 s1/);
  assert.match(html, /状态 s2/);
  assert.match(html, /visible-value/);
  assert.match(html, /commit blur/);
  assert.match(html, /10:00:01\.250/);
  assert.match(html, /class="step-shot"/);
});

test('渲染网络时间轴并转义 URL', () => {
  const html = renderTraceHtml(sampleTrace());
  assert.match(html, /网络请求/);
  assert.match(html, /GET/);
  assert.match(html, /POST/);
  assert.match(html, /401/);
  assert.match(html, /https:\/\/example\.test\/login/);
  assert.equal(html.includes('<script>'), true); // 页面脚本本身
  assert.equal(html.includes('q=<script>'), false);
  assert.match(html, /q=&lt;script&gt;/);
  assert.match(html, /10:00:01\.500/);
});

test('转义页面文本，不注入脚本', () => {
  const html = renderTraceHtml(sampleTrace());
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(html.includes('secret-value'), false);
  assert.match(html, /•••（敏感值已脱敏）/);
});

test('网络请求按步骤时间窗对齐', () => {
  const html = renderTraceHtml(sampleTrace());
  assert.match(html, /2 个请求 · GET 200 · POST 401/);
  assert.equal((html.match(/class="step-net"/g) || []).length, 1);
});

test('渲染截图并拒绝非 data:image URL', () => {
  const html = renderTraceHtml(sampleTrace());
  assert.match(html, /截图/);
  assert.match(html, /<img src="data:image\/png;base64,/);
  assert.match(html, /导出时页面/);
  assert.match(html, /120×80/);
  assert.equal(html.includes('javascript:alert'), false);
});

test('空步骤给出明确提示', () => {
  const html = renderTraceHtml({ version: 3, steps: [], states: [] });
  assert.match(html, /没有可回放步骤/);
});

test('非法输入显式报错', () => {
  assert.throws(() => renderTraceHtml(null), /trace 必须是对象/);
  assert.throws(() => renderTraceHtml([]), /trace 必须是对象/);
});

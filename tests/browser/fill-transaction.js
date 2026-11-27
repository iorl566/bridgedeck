// 真实 DOM 夹具：fill 快路径步数/证据、虚拟行 guard 拒绝、原生输入时钟。
// 直接加载扩展源码里的纯函数模块（fill-verify / virtual-row-guard / input-clock），
// 在真实 Chromium DOM 上执行 insertText 与行事实分类。
import { classifyFillControl, fillPlanFields, fillStepEvidence, fillVerifyFields, planFillSteps } from '/extension/src/tools/fill-verify.js';
import {
  buildRowAnchorProbeExpression,
  classifyVirtualRow,
  checkRowAnchor,
  compareRowAnchor,
} from '/extension/src/lib/virtual-row-guard.js';
import { createInputClock } from '/extension/src/lib/input-clock.js';

const fixture = document.getElementById('fixture');
const tests = [];
const passed = [];
const fail = (message) => { throw new Error(message); };
const assert = (value, message) => { if (!value) fail(message); };
const test = (name, fn) => tests.push({ name, fn });

function factsFor(el) {
  return {
    textLike: true,
    tag: el.tagName.toLowerCase(),
    type: String(el.type || ''),
    isContentEditable: el.isContentEditable === true,
    hadValue: String(el.value == null ? '' : el.value).length > 0,
  };
}

function verifyValue(el, expected) {
  const actual = el.isContentEditable === true ? String(el.textContent || '') : String(el.value == null ? '' : el.value);
  return { value: actual, expected_value: expected, formatted: actual !== expected, matches: actual === expected };
}

function clearRich(el) {
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

// 与运行时相同的动作序列：聚焦 →（需要时）清空 → insertText 一次。
function runFill(el, value) {
  const plan = planFillSteps(factsFor(el));
  if (el.isContentEditable === true) {
    clearRich(el);
  } else {
    el.focus();
    if (plan.needs_clear) el.select();
  }
  const inserted = document.execCommand('insertText', false, value);
  assert(inserted === true, '真实 DOM insertText 失败');
  return plan;
}

test('空 input：1 步 insertText 一次成型 + matches/expected 证据', () => {
  const el = document.createElement('input');
  el.type = 'text';
  el.id = 'fill-empty';
  fixture.appendChild(el);
  const plan = runFill(el, 'BridgeDeck 你好');
  assert(plan.step_count === 1, '空格 input 步数=' + plan.step_count);
  assert(plan.steps.length === 1 && plan.steps[0] === 'insert', 'steps=' + plan.steps);
  assert(plan.insert_text_calls === 1, 'insertText 次数=' + plan.insert_text_calls);

  const fields = { ...fillPlanFields(plan), ...fillVerifyFields(verifyValue(el, 'BridgeDeck 你好')) };
  assert(fields.fill_step_count === 1, '对外步数=' + fields.fill_step_count);
  assert(fields.fill_strategy === 'fast', 'strategy=' + fields.fill_strategy);
  assert(el.value === 'BridgeDeck 你好', '真实 DOM 值=' + el.value);
  assert(fields.matches === true, 'matches 不为 true');
  assert(fields.expected_value === 'BridgeDeck 你好', 'expected 证据缺失');
  passed.push('empty');
});

test('已有值 input：≤3 步（focus→clear→insert）替换成功', () => {
  const el = document.createElement('input');
  el.type = 'text';
  el.value = '旧值 old';
  fixture.appendChild(el);
  const plan = runFill(el, '新值 new');
  assert(plan.step_count <= 3, '有值 input 步数=' + plan.step_count);
  assert(plan.needs_clear === true, '有值 input 没有 clear 步骤');
  assert(plan.clear_via === 'page-select', 'clear_via=' + plan.clear_via);
  const fields = fillVerifyFields(verifyValue(el, '新值 new'));
  assert(el.value === '新值 new', '真实 DOM 值=（' + el.value + '）');
  assert(fields.matches === true, '替换后 matches 不为 true');
  assert(fields.expected_value === '新值 new');
  passed.push('existing');
});

test('contenteditable：3 步 + 键盘清空语义，替换旧文本且页面完整', () => {
  const el = document.createElement('div');
  el.contentEditable = 'true';
  el.textContent = '旧富文本';
  fixture.appendChild(el);
  const plan = runFill(el, '新富文本');
  assert(plan.kind === 'rich-text', 'kind=' + plan.kind);
  assert(plan.step_count === 3, '富文本步数=' + plan.step_count);
  assert(plan.needs_clear === true, '富文本没有 clear 步骤');
  assert(plan.clear_via === 'keyboard', '富文本 clear_via=' + plan.clear_via);
  assert(el.textContent === '新富文本', '真实 DOM 富文本=(' + el.textContent + ')');
  assert(fixture.isConnected === true, '页面容器被破坏');
  const fields = fillVerifyFields(verifyValue(el, '新富文本'));
  assert(fields.matches === true);
  passed.push('rich');
});

test('复杂控件（select/date）走 programmatic 且 ≤3 步', () => {
  const select = document.createElement('select');
  select.innerHTML = '<option>a</option><option>b</option>';
  fixture.appendChild(select);
  const date = document.createElement('input');
  date.type = 'date';
  fixture.appendChild(date);
  for (const el of [select, date]) {
    const facts = factsFor(el);
    facts.textLike = false; // 页面库 fillFastTarget 对非文本控件返回 textLike:false
    const plan = planFillSteps(facts);
    assert(plan.strategy === 'programmatic', el.tagName + ' strategy=' + plan.strategy);
    assert(plan.step_count <= 3, el.tagName + ' 步数=' + plan.step_count);
  }
  passed.push('programmatic');
});

test('虚拟行 guard：稳定行通过，索引位移/transform 平移/滚动位移被拒绝并带证据', () => {
  const grid = document.createElement('div');
  grid.setAttribute('role', 'grid');
  grid.style.cssText = 'height:60px;overflow:auto;position:relative';
  fixture.appendChild(grid);
  const makeRow = (id, ariaIndex, dataIndex, transform) => {
    const row = document.createElement('div');
    row.id = id;
    row.setAttribute('role', 'row');
    row.setAttribute('aria-rowindex', String(ariaIndex));
    row.setAttribute('data-index', String(dataIndex));
    row.style.cssText = 'min-height:40px;transform:' + transform;
    row.textContent = id;
    grid.appendChild(row);
    return row;
  };
  const factsOf = (el) => ({
    role: el.getAttribute('role'),
    tag: el.tagName.toLowerCase(),
    ariaRowIndex: el.getAttribute('aria-rowindex'),
    dataIndex: el.getAttribute('data-index'),
    transform: getComputedStyle(el).transform,
    scrollTop: grid.scrollTop,
  });

  const stableRow = makeRow('row-stable', 1, 1, 'none');
  const stable = classifyVirtualRow(factsOf(stableRow));
  assert(stable.stable === true, '稳定行被判不稳定：' + stable.reason);
  assert(stable.rowIndex === 1, 'rowIndex=' + stable.rowIndex);
  assert(stable.kind === 'row', 'kind=' + stable.kind);

  const driftRow = makeRow('row-drift', 12, 3, 'none');
  const driftFacts = factsOf(driftRow);
  const drift = classifyVirtualRow(driftFacts);
  assert(drift.stable === false, '索引漂移行未被拒绝');
  assert(drift.reason === 'index-mismatch', 'reason=' + drift.reason);
  const rejected = checkRowAnchor(driftFacts);
  assert(rejected.ok === false, 'checkRowAnchor 未拒绝漂移行');
  assert(rejected.code === 'E_TARGET_MISMATCH', 'code=' + rejected.code);
  assert(rejected.evidence.check === 'index', '证据检查项=' + rejected.evidence.check);

  const translatedRow = makeRow('row-translated', 2, 2, 'translateY(-40px)');
  const translated = classifyVirtualRow(factsOf(translatedRow));
  assert(translated.reason === 'translated', 'reason=' + translated.reason);
  assert(translated.evidence.translateY === -40, 'translateY=' + translated.evidence.translateY);

  grid.scrollTop = 30;
  assert(grid.scrollTop > 0, '夹具容器不可滚动，无法验证滚动位移');
  const scrolled = classifyVirtualRow({ ...factsOf(stableRow), previousScrollTop: 0 });
  assert(scrolled.reason === 'scroll-shifted', 'reason=' + scrolled.reason);
  assert(scrolled.evidence.deltaPx === grid.scrollTop, 'deltaPx=' + scrolled.evidence.deltaPx);
  passed.push('virtual-row');
});

test('原生输入时钟：TimeSinceEpoch 单调、回退拒绝、事务结束拒绝', () => {
  const clock = createInputClock();
  const tx = clock.begin('tab', 'pointer');
  const stamps = [clock.tick(tx), clock.tick(tx), clock.tick(tx)];
  assert(stamps.every((item) => item.ok === true), 'tick 失败');
  assert(stamps[0].seq === 1 && stamps[1].seq === 2 && stamps[2].seq === 3, '序号不连续');
  assert(stamps[1].timestamp >= stamps[0].timestamp && stamps[2].timestamp >= stamps[1].timestamp, '时间戳回退');
  assert(stamps[0].timestamp > 1e9, 'timestamp 不是 TimeSinceEpoch 秒：' + stamps[0].timestamp);
  const ended = clock.end(tx);
  assert(ended.ok === true && ended.events === 3, 'end events=' + ended.events);
  const stale = clock.tick(tx);
  assert(stale.ok === false && stale.cause === 'clock_stale', '结束事务未拒绝：' + stale.cause);

  let reversed = 1000;
  const injected = createInputClock({ now: () => reversed, epochMs: 0 });
  const injectedTx = injected.begin(1, 'pointer');
  assert(injected.tick(injectedTx).ok === true);
  reversed = 900;
  const regression = injected.tick(injectedTx);
  assert(regression.ok === false, '时间回退未被拒绝');
  assert(regression.cause === 'clock_regression', 'cause=' + regression.cause);
  assert(regression.evidence.previousAt === 1000, 'previousAt=' + regression.evidence.previousAt);
  assert(regression.evidence.observedAt === 900, 'observedAt=' + regression.evidence.observedAt);
  assert(regression.evidence.deltaMs === 100, 'deltaMs=' + regression.evidence.deltaMs);
  passed.push('input-clock');
});

test('select 真实路径：option 匹配 → 写入 → input/change，3 步证据齐全', () => {
  const select = document.createElement('select');
  select.id = 'fill-select';
  select.innerHTML = '<option value="a">甲</option><option value="b">乙</option>';
  fixture.appendChild(select);
  const plan = planFillSteps({ textLike: false, tag: 'select' });
  assert(plan.kind === 'select', 'select kind=' + plan.kind);
  assert(plan.strategy === 'programmatic', 'select strategy=' + plan.strategy);
  assert(plan.step_count === 3 && plan.steps.join('>') === 'focus>match-option>commit', 'select steps=' + plan.steps);
  assert(plan.step_evidence[1].via === 'page-lib:select', 'select 中间步 via=' + plan.step_evidence[1].via);
  // 与 page-lib actionSelect 同语义：value → 可见文本 → label。
  const wanted = '乙';
  const options = [...select.options];
  let chosen = options.find((item) => item.value === wanted);
  if (!chosen) chosen = options.find((item) => String(item.textContent || '').trim() === wanted);
  assert(Boolean(chosen), '无法按 value/文本匹配 option');
  let inputEvents = 0;
  let changeEvents = 0;
  select.addEventListener('input', () => { inputEvents += 1; });
  select.addEventListener('change', () => { changeEvents += 1; });
  select.value = chosen.value;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  assert(select.value === 'b', '真实 DOM select 值=' + select.value);
  assert(inputEvents === 1 && changeEvents === 1, 'select 事件次数 input=' + inputEvents + ' change=' + changeEvents);
  const observed = { focus: { ok: true }, 'match-option': { value: chosen.value, label: String(chosen.textContent || '').trim() }, commit: { matches: select.value === chosen.value } };
  const fields = fillPlanFields({ ...plan, observed });
  assert(fields.fill_step_evidence.length === 3, '步骤证据数量=' + fields.fill_step_evidence.length);
  assert(fields.fill_step_evidence.every((item) => item.ok === true), '步骤证据存在失败项');
  assert(fields.fill_step_evidence[1].detail.value === 'b', 'match-option 证据缺 value');
  assert(fields.fill_control_kind === 'select', 'fill_control_kind=' + fields.fill_control_kind);
  passed.push('select');
});

test('date 真实路径：原生 setter 写入完整 value + input/change，程序化 3 步', () => {
  const date = document.createElement('input');
  date.type = 'date';
  date.id = 'fill-date';
  fixture.appendChild(date);
  const plan = planFillSteps({ textLike: false, tag: 'input', inputType: 'date' });
  assert(plan.control_kind === 'date-control', 'date control_kind=' + plan.control_kind);
  assert(plan.steps.join('>') === 'focus>set-value>commit', 'date steps=' + plan.steps);
  assert(plan.step_evidence[1].via === 'native-value-setter', 'date set-value via=' + plan.step_evidence[1].via);
  // 页面库用独立 input 做浏览器原生合法性校验后写值。
  const normalizer = document.createElement('input');
  normalizer.type = 'date';
  normalizer.value = '2026-11-25';
  assert(normalizer.value === '2026-11-25', '日期值未被浏览器接受：' + normalizer.value);
  date.value = normalizer.value;
  date.dispatchEvent(new Event('input', { bubbles: true }));
  date.dispatchEvent(new Event('change', { bubbles: true }));
  assert(date.value === '2026-11-25', '真实 DOM date 值=' + date.value);
  const verified = verifyValue(date, '2026-11-25');
  const fields = { ...fillPlanFields({ ...plan, observed: { focus: { ok: true }, 'set-value': { value: date.value }, commit: { matches: verified.matches } } }), ...fillVerifyFields(verified) };
  assert(fields.fill_step_count === 3, 'date 步数=' + fields.fill_step_count);
  assert(fields.matches === true, 'date 校验未通过');
  assert(fields.fill_step_evidence.every((item) => item.ok === true), 'date 步骤证据存在失败项');
  passed.push('date');
});

test('contenteditable：control_kind=contenteditable、键盘清空 + 一次 insertText，3 步证据', () => {
  const editable = document.createElement('div');
  editable.contentEditable = 'true';
  editable.id = 'fill-rich';
  editable.textContent = '旧富文本';
  fixture.appendChild(editable);
  const facts = factsFor(editable);
  const control = classifyFillControl({ ...facts, textLike: true });
  assert(control.kind === 'contenteditable', 'classifyFillControl=' + control.kind);
  assert(control.clearVia === 'keyboard', 'clearVia=' + control.clearVia);
  const plan = runFill(editable, '新富文本');
  assert(plan.control_kind === 'contenteditable', 'plan.control_kind=' + plan.control_kind);
  assert(plan.step_evidence[1].via === 'keyboard:Control+a', 'clear via=' + plan.step_evidence[1].via);
  assert(editable.textContent === '新富文本', '真实 DOM contenteditable=' + editable.textContent);
  const verified = verifyValue(editable, '新富文本');
  const fields = { ...fillPlanFields({ ...plan, observed: fillStepEvidence(plan, { focus: { ok: true }, clear: { via: 'keyboard' }, insert: { matches: true } }) }), ...fillVerifyFields(verified) };
  assert(fields.fill_step_evidence.length === 3, '富文本步骤证据=' + fields.fill_step_evidence.length);
  assert(fields.fill_step_evidence.every((item) => item.ok === true), '富文本步骤证据失败');
  assert(fields.matches === true, '富文本读回不匹配');
  passed.push('contenteditable');
});

test('row facts 探针：真实虚拟行 anchor 与 observe 期望一致；回收/平移后 compareRowAnchor 拒绝', () => {
  const scroller = document.createElement('div');
  scroller.id = 'vlist';
  scroller.style.cssText = 'height:80px;overflow:auto;position:relative';
  fixture.appendChild(scroller);
  const row = document.createElement('div');
  row.id = 'vrow-1';
  row.setAttribute('role', 'row');
  row.setAttribute('aria-rowindex', '5');
  row.setAttribute('data-index', '5');
  row.setAttribute('data-row-key', 'ord-5');
  row.style.cssText = 'min-height:40px;transform:translateY(0px)';
  row.textContent = '订单 5 Bob 88.00';
  scroller.appendChild(row);
  const spacer = document.createElement('div');
  spacer.style.height = '400px';
  scroller.appendChild(spacer);
  const readAnchor = () => {
    const probe = (0, eval)(buildRowAnchorProbeExpression({ selector: '#vrow-1' }));
    assert(probe && probe.ok === true, '探针失败：' + JSON.stringify(probe));
    assert(Boolean(probe.anchor), '探针没有读出虚拟行 anchor（cause=' + probe.cause + '）');
    return probe.anchor;
  };
  const observed = readAnchor();
  assert(observed.ariaRowIndex === 5, 'ariaRowIndex=' + observed.ariaRowIndex);
  assert(observed.rowKey === 'ord-5', 'rowKey=' + observed.rowKey);
  assert(observed.rowText === '订单 5 Bob 88.00', 'rowText=' + observed.rowText);
  assert(observed.containerScrollTop === 0, 'containerScrollTop=' + observed.containerScrollTop);
  assert(String(observed.transform).includes('matrix') || observed.transform === 'none', 'transform=' + observed.transform);

  const stable = compareRowAnchor(observed, readAnchor());
  assert(stable.ok === true, '同一行两次读取被判不稳定：' + stable.reason);

  // 回收：同一 DOM 位置复用成另一行（index/key/text 全变）。
  row.setAttribute('aria-rowindex', '6');
  row.setAttribute('data-index', '6');
  row.setAttribute('data-row-key', 'ord-6');
  row.textContent = '订单 6 Alice 12.00';
  const recycled = compareRowAnchor(observed, readAnchor());
  assert(recycled.ok === false, '行回收未被拒绝');
  assert(recycled.code === 'E_TARGET_MISMATCH', 'code=' + recycled.code);
  assert(recycled.reason === 'index-mismatch', 'reason=' + recycled.reason);
  assert(recycled.evidence.guard === 'virtual-row', '证据 guard=' + recycled.evidence.guard);

  // 平移：index/key/text 复原，但 transform 变了 → translated。
  row.setAttribute('aria-rowindex', '5');
  row.setAttribute('data-index', '5');
  row.setAttribute('data-row-key', 'ord-5');
  row.textContent = '订单 5 Bob 88.00';
  row.style.transform = 'translateY(-40px)';
  const translated = compareRowAnchor(observed, readAnchor());
  assert(translated.ok === false, '行平移未被拒绝：' + JSON.stringify(translated.checks));
  assert(translated.reason === 'translated', 'reason=' + translated.reason);
  assert(translated.evidence.check === 'transform', 'evidence.check=' + translated.evidence.check);

  // 滚动容器位移：也会被拒绝（observe 之后页面自己滚了）。
  row.style.transform = 'translateY(0px)';
  scroller.scrollTop = 30;
  assert(scroller.scrollTop > 0, '夹具容器不可滚动');
  const scrolled = compareRowAnchor(observed, readAnchor());
  assert(scrolled.ok === false, '容器滚动未被拒绝');
  passed.push('row-facts');
});

(async () => {
  try {
    for (const item of tests) await item.fn();
    document.title = 'FILL_TX_OK:' + passed.length;
  } catch (error) {
    document.title = 'FILL_TX_FAIL:' + String((error && error.message) || error);
  }
})();

// 真实 DOM 测试：content/cooperation.js 的输入锁、passthrough 与协作读取。
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message) => { throw new Error(message); };
const assert = (value, message) => { if (!value) fail(message); };
const send = (message) => new Promise((resolve) => {
  const handler = window.__coopHandler;
  if (typeof handler !== 'function') fail('cooperation handler 未注册');
  const returned = handler(message, {}, resolve);
  if (returned === true) fail('handler 不应使用异步 sendResponse');
});
const blocker = () => document.getElementById('__bb_input_blocker');
const wheel = () => {
  const event = new WheelEvent('wheel', { deltaY: 10, bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};
const key = (value, init = {}) => {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};
const clean = async () => {
  await send({ type: 'bb.cooperation.block', blocked: false });
  for (const node of document.querySelectorAll('#coop-fields, #coop-overlay')) node.remove();
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('read 返回字段/媒体/焦点，密码字段脱敏', async () => {
  const box = document.createElement('div');
  box.id = 'coop-fields';
  box.innerHTML = '<input id="plain" value="hello"><input id="pass" type="password" value="secret">' +
    '<textarea id="area">multi</textarea><input id="check" type="checkbox" checked>' +
    '<video id="vid"></video><div id="edit" contenteditable="true">typed</div>';
  document.body.appendChild(box);
  document.getElementById('plain').focus();
  const reply = await send({ type: 'bb.cooperation.read' });
  assert(reply.ok === true, 'read 没有 ok');
  const state = reply.state;
  const plain = state.fields.find((field) => field.selector === '#plain');
  const pass = state.fields.find((field) => field.selector === '#pass');
  assert(plain && plain.value === 'hello', '普通字段值不对');
  assert(pass && pass.sensitive === true && pass.value === '', '密码字段没有脱敏');
  assert(state.fields.some((field) => field.selector === '#check' && field.checked === true), 'checkbox 状态缺失');
  assert(state.media.some((item) => item.selector === '#vid'), '媒体状态缺失');
  assert(state.editing === true && state.focus === 'plain', '焦点/编辑状态不对');
  assert(state.textLength > 0 && typeof state.textTail === 'string', '文本尾部缺失');
  assert(Number.isInteger(state.revision) && state.revision >= 1, 'revision 缺失');
  assert(typeof state.mode === 'string' && state.mode.length > 0, 'mode 缺失');
  globalThis.__bbCooperation.noteHuman('pointer', document.getElementById('plain'));
  const after = await send({ type: 'bb.cooperation.read' });
  assert(after.state.activity.lastKind === 'pointer', '人操作活动没有记录');
  assert(after.state.mode === 'editing', '输入框人操作 mode 不是 editing：' + after.state.mode);
  assert(after.state.revision > state.revision, '人操作没有推进 revision');
  assert(after.state.activity.recent.some((item) => item.label === 'plain'), '活动事件缺少目标标签');
});

test('block 显示覆盖层并阻止滚动，不吞键盘', async () => {
  const reply = await send({ type: 'bb.cooperation.block', blocked: true });
  assert(reply.ok === true && reply.blocked === true, 'block 没有生效');
  const node = blocker();
  assert(node, '覆盖层未创建');
  assert(node.style.position === 'fixed' && node.style.pointerEvents === 'auto', '覆盖层样式不对');
  assert(wheel() === true, '滚轮没有被阻止');
  assert(key('a') === false, '键盘不应被输入锁吞掉（与 bsk ControlInputBlocker 对齐）');
  const point = document.elementFromPoint(20, 20);
  assert(point === node, '覆盖层没有成为点击命中目标');
  const snapshot = globalThis.__bbCooperation.snapshot();
  assert(snapshot.blocked === true && snapshot.hasBlocker === true && snapshot.listening === true, 'snapshot 不对');
  assert(Number.isInteger(snapshot.revision) && snapshot.revision >= 2, '上锁没有推进 revision：' + snapshot.revision);
});

test('passthrough 临时放开覆盖层，结束/过期后恢复', async () => {
  await send({ type: 'bb.cooperation.block', blocked: true });
  await send({ type: 'bb.cooperation.passthrough', token: 'lease-1', active: true });
  assert(blocker().style.pointerEvents === 'none', 'passthrough 没有放开指针');
  assert(globalThis.__bbCooperation.snapshot().mode === 'acting', 'passthrough 期间 mode 不是 acting');
  assert(wheel() === false, 'passthrough 期间滚轮仍被阻止');
  await send({ type: 'bb.cooperation.passthrough', token: 'lease-1', active: false });
  assert(blocker().style.pointerEvents === 'auto', 'passthrough 结束后没有恢复');
  assert(wheel() === true, 'passthrough 结束后滚轮未恢复阻止');
  await send({ type: 'bb.cooperation.passthrough', token: 'lease-2', active: true });
  assert(globalThis.__bbCooperation.passThrough('lease-2', false) === 0, '过期/结束计数不对');
});

test('接管浮层按钮在覆盖层之上仍可点击', async () => {
  await send({ type: 'bb.cooperation.block', blocked: true });
  const host = document.createElement('div');
  host.id = 'coop-overlay';
  host.setAttribute('data-bb-ui', 'takeover');
  host.style.cssText = 'position:fixed;left:20px;top:20px;z-index:2147483647;width:160px;height:40px';
  const button = document.createElement('button');
  button.textContent = '暂停 Agent';
  button.style.cssText = 'width:160px;height:40px';
  host.appendChild(button);
  document.documentElement.appendChild(host);
  assert(document.elementFromPoint(30, 30) === button, '浮层按钮没有位于覆盖层之上');
});

test('passthrough 同时让接管卡片点击穿透', async () => {
  await send({ type: 'bb.cooperation.block', blocked: true });
  const host = document.createElement('div');
  host.id = 'coop-overlay';
  host.setAttribute('data-bb-ui', 'takeover');
  const shadow = host.attachShadow({ mode: 'closed' });
  const card = document.createElement('div');
  card.className = 'card';
  card.style.pointerEvents = 'auto';
  shadow.appendChild(card);
  document.documentElement.appendChild(host);
  globalThis.__bbTakeoverRoots = new WeakMap([[host, shadow]]);
  await send({ type: 'bb.cooperation.passthrough', token: 'card-lease', active: true });
  assert(card.style.pointerEvents === 'none', 'passthrough 没有禁用接管卡片');
  await send({ type: 'bb.cooperation.passthrough', token: 'card-lease', active: false });
  assert(card.style.pointerEvents !== 'none', 'passthrough 结束后卡片仍不可点');
});

test('passthrough-clear 清理所有租约', async () => {
  await send({ type: 'bb.cooperation.block', blocked: true });
  await send({ type: 'bb.cooperation.passthrough', token: 'clear-a', active: true });
  await send({ type: 'bb.cooperation.passthrough', token: 'clear-b', active: true });
  assert(blocker().style.pointerEvents === 'none', '租约没有生效');
  const reply = await send({ type: 'bb.cooperation.passthrough-clear' });
  assert(reply.ok === true && reply.pending === 0, 'passthrough-clear 没有清空');
  assert(blocker().style.pointerEvents === 'auto', '清租约后没有恢复阻止');
});

test('block=false 移除覆盖层并停止监听', async () => {
  await send({ type: 'bb.cooperation.block', blocked: false });
  assert(!blocker(), '覆盖层没有移除');
  assert(wheel() === false, '解除后滚轮仍被阻止');
  const snapshot = globalThis.__bbCooperation.snapshot();
  assert(snapshot.blocked === false && snapshot.hasBlocker === false && snapshot.listening === false, '解除后 snapshot 不对');
});

(async () => {
  while (typeof window.__coopHandler !== 'function') await sleep(10);
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      await clean();
    } catch (error) {
      await clean().catch(() => {});
      document.title = 'COOP_DOM_FAIL:' + name + ':' + String((error && error.message) || error);
      return;
    }
  }
  document.title = 'COOP_DOM_OK:' + passed;
})();

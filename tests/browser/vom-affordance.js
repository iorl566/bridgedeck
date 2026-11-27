// 真实 Chromium DOM 证据：页面侧 page-lib 事实 + lib/vom-affordance.js / lib/vom-layers.js。
// 成功 title = VOM_AFF_OK:<断言数>，失败 title = VOM_AFF_FAIL:<message>。
import { affordanceForNode } from '../../extension/src/lib/vom-affordance.js';
import { deriveLayers } from '../../extension/src/lib/vom-layers.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
const expect = (value, message) => {
  if (!value) throw new Error(message);
  passed += 1;
};
const fail = (message) => { throw new Error(message); };

const page = () => {
  const lib = globalThis.__BB_PAGE__;
  if (!lib || typeof lib.handle !== 'function') fail('page-lib 未加载');
  return lib;
};

async function call(name, args) {
  const reply = await page().handle(name, args || {});
  if (!reply || reply.ok !== true) {
    throw new Error(name + ' 失败：' + JSON.stringify((reply && reply.error) || reply));
  }
  return reply.result;
}

function nodeById(nodes, id) {
  const node = nodes.find((item) => item && item.id === id);
  if (!node) fail('观察结果缺少节点 #' + id);
  return node;
}

function typeOf(nodes, id) {
  return affordanceForNode(nodeById(nodes, id)).type;
}

function layerById(layers, id) {
  return layers.find((item) => item && item.id === id) || null;
}

async function main() {
  // page-lib 是普通 <script> 注入，等它挂到隔离世界全局上。
  for (let index = 0; index < 200; index += 1) {
    if (globalThis.__BB_PAGE__ && typeof globalThis.__BB_PAGE__.handle === 'function') break;
    await sleep(20);
  }
  page();

  // 1) 真实页面观察事实 → lib affordance 归约
  const observed = await call('observe', { collectNodes: true, vom: true, force: true });
  const nodes = Array.isArray(observed.nodes) ? observed.nodes : [];
  expect(nodes.length > 0, 'observe 没有返回节点');

  expect(typeOf(nodes, 'btn-activate') === 'activate', 'button 应为 activate');
  expect(typeOf(nodes, 'txt-type') === 'type', 'input[type=text] 应为 type');
  expect(typeOf(nodes, 'chk-toggle') === 'toggle', 'checkbox 应为 toggle');
  expect(typeOf(nodes, 'sum-toggle') === 'toggle', 'details>summary 应为 toggle');
  expect(typeOf(nodes, 'sel-select') === 'select', '原生 select 应为 select');
  expect(typeOf(nodes, 'cbx-select') === 'select', 'role=combobox 应为 select');
  expect(typeOf(nodes, 'sld-drag') === 'drag', 'role=slider 应为 drag');
  expect(typeOf(nodes, 'drg-drag') === 'drag', 'draggable 元素应为 drag');
  expect(typeOf(nodes, 'file-upload') === 'upload', 'input[type=file] 应为 upload');
  expect(typeOf(nodes, 'mnu-item') === 'hover', 'menuitem+aria-haspopup 应为 hover');
  expect(typeOf(nodes, 'btn-dismiss') === 'dismiss', 'dialog 内“关闭”按钮应为 dismiss');
  expect(typeOf(nodes, 'dismiss-wrap') === 'dismiss', 'role=dialog 容器应为 dismiss');

  const toggleNode = affordanceForNode(nodeById(nodes, 'chk-toggle'));
  expect(toggleNode.confidence >= 0.9, 'toggle 置信度应 >=0.9：' + toggleNode.confidence);
  expect(Array.isArray(toggleNode.evidence) && toggleNode.evidence.length > 0, 'toggle 缺少 evidence');
  expect(toggleNode.evidence.every((item) => item && typeof item.rule === 'string' && typeof item.field === 'string'), 'evidence 形状不对');
  expect(toggleNode.evidence.some((item) => item.field === 'inputType'), 'evidence 应命中 inputType 字段');

  // 2) 页面侧 affordanceFactsOf 经 hit-at 返回，再走同一个纯函数归约
  const button = document.getElementById('btn-activate').getBoundingClientRect();
  const buttonHit = await call('hit-at', { x: button.left + button.width / 2, y: button.top + button.height / 2 });
  expect(buttonHit.hit === true, '按钮 hit-at 未命中');
  expect(buttonHit.affordance && buttonHit.affordance.role === 'button', 'hit-at 未带回页面侧 role 事实');
  expect(affordanceForNode(buttonHit.affordance).type === 'activate', '页面侧事实归约后应为 activate');
  expect(buttonHit.layer && buttonHit.layer.position === 'static', 'hit-at 未带回层事实');

  const scrollBox = document.getElementById('scr-scroll').getBoundingClientRect();
  const scrollHit = await call('hit-at', { x: scrollBox.left + 10, y: scrollBox.top + 10 });
  expect(scrollHit.hit === true, '滚动容器 hit-at 未命中');
  expect(scrollHit.affordance && scrollHit.affordance.scrollable === true, '页面侧未识别 scrollable');
  expect(affordanceForNode(scrollHit.affordance).type === 'scroll', '滚动容器应为 scroll');

  // 3) 页面侧层事实 → lib 有序层模型：z-index 顺序 + base
  const scanBefore = await call('visual-scan', {});
  expect(Array.isArray(scanBefore.layers) && scanBefore.layers.length >= 3, 'visual-scan 未返回层事实：' + JSON.stringify(scanBefore.layers));
  const modelBefore = deriveLayers(scanBefore.layers);
  expect(modelBefore.layers[0].kind === 'base' && modelBefore.layers[0].index === 0, '层模型缺少 base 层');
  const z1 = layerById(modelBefore.layers, 'lyr-z1');
  const z50 = layerById(modelBefore.layers, 'lyr-z50');
  const z500 = layerById(modelBefore.layers, 'lyr-z500');
  expect(z1 && z50 && z500, '层事实缺少 z1/z50/z500');
  expect(z1.zIndex === 1 && z50.zIndex === 50 && z500.zIndex === 500, 'z-index 解析不对');
  expect(z1.index < z50.index && z50.index < z500.index, 'z-index 分层顺序不对：' + [z1.index, z50.index, z500.index].join(','));

  // 4) 真实 top-layer：modal dialog + popover
  document.getElementById('dlg-top').showModal();
  document.getElementById('pop-top').showPopover();
  const scanAfter = await call('visual-scan', {});
  const modelAfter = deriveLayers(scanAfter.layers);
  const dialogLayer = modelAfter.layers.find((item) => item.topLayer === 'modal-dialog');
  const popLayer = modelAfter.layers.find((item) => item.topLayer === 'popover');
  expect(Boolean(dialogLayer), '未识别 modal dialog 的 top-layer');
  expect(Boolean(popLayer), '未识别 popover 的 top-layer');
  expect(dialogLayer.kind === 'top-layer' && dialogLayer.blocking === true, 'dialog 层应为 top-layer/blocking');
  expect(popLayer.kind === 'top-layer' && popLayer.blocking === false, 'popover 层应为 top-layer 且不阻挡');
  expect(dialogLayer.index > layerById(modelAfter.layers, 'lyr-z500').index, 'top-layer 应在 floating 之上');
  expect(popLayer.index > layerById(modelAfter.layers, 'lyr-z500').index, 'popover 应在 floating 之上');

  document.getElementById('dlg-top').close();
  document.getElementById('pop-top').hidePopover();

  return passed;
}

main().then((count) => {
  document.title = 'VOM_AFF_OK:' + count;
}).catch((error) => {
  const message = String((error && error.message) || error).replace(/\s+/g, ' ').slice(0, 120);
  document.title = 'VOM_AFF_FAIL:' + message;
});

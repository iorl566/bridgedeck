import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 视觉定位接口的静态护栏：
// 坐标拖拽必须走"图片像素 → 页面坐标"的统一换算，且强制原生输入。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('drag 协议带上视觉坐标参数', () => {
  const schemas = fs.readFileSync(path.join(ROOT, 'lib', 'schemas.mjs'), 'utf8');
  const block = schemas.slice(schemas.indexOf('  drag: {'), schemas.indexOf('  drag: {') + 600);
  for (const key of ['capture', 'imageX', 'imageY', 'imageDx', 'imageDy']) {
    assert.match(block, new RegExp(key + ':'), 'drag schema 缺少 ' + key);
  }
});

test('生成物已同步（否则协议校验会挡）', () => {
  const generated = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'generated', 'protocol.js'), 'utf8');
  assert.match(generated, /"image_x":\s*"imageX"/);
  assert.match(generated, /"image_dx":\s*"imageDx"/);
  assert.match(generated, /"image_dy":\s*"imageDy"/);
});

test('换算集中在 resolveCapturePoint，拖拽强制 trusted', () => {
  const screenshot = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'screenshot.js'), 'utf8');
  assert.match(screenshot, /export function resolveCapturePoint/);
  const interaction = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'tools', 'interaction.js'), 'utf8');
  assert.match(interaction, /withImageDrag/);
  assert.match(interaction, /trusted: true/, '视觉坐标拖拽必须强制走原生输入');
  assert.match(interaction, /fromPoint/, '拖拽需要支持预换算好的起点');
});

test('CLI 接受视觉坐标拖拽参数', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'cli', 'bridge.mjs'), 'utf8');
  assert.match(cli, /'image-dx', 'image-dy'/);
  assert.match(cli, /params\.imageDx = Number/);
  assert.match(cli, /params\.imageDy = Number/);
});

test('截图网格与剖面参数已接入', () => {  const schemas = fs.readFileSync(path.join(ROOT, 'lib', 'schemas.mjs'), 'utf8');
  const start = schemas.indexOf('  screenshot: {');
  const block = schemas.slice(start, start + 900);
  for (const key of ['grid', 'gridStep', 'profile']) {
    assert.match(block, new RegExp(key + ':'), 'screenshot schema 缺少 ' + key);
  }
  const generated = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'generated', 'protocol.js'), 'utf8');
  assert.match(generated, /"grid_step":\s*"gridStep"/);
  const cli = fs.readFileSync(path.join(ROOT, 'cli', 'bridge.mjs'), 'utf8');
  assert.match(cli, /'annotate', 'grid'/);
  assert.match(cli, /'grid-step', 'profile'/);
  const ext = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'screenshot.js'), 'utf8');
  assert.match(ext, /async function gridShot/);
  assert.match(ext, /async function profileShot/);
  assert.match(ext, /clip: \{ x, y, width, height, scale: zoom \}/, '区域截图需要支持放大倍率');
});

test('视觉候选发现：scan → screenshot --visual → 坐标归一化', () => {
  const lib = fs.readFileSync(path.join(ROOT, 'extension', 'injected', 'page-lib.js'), 'utf8');
  assert.match(lib, /function visualScan\(\)/, 'page-lib 要有 visualScan');
  assert.match(lib, /case 'visual-scan':/, 'handle 分发要认识 visual-scan');
  assert.match(lib, /visualScan,/, 'visualScan 要挂到导出上');

  const ext = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'screenshot.js'), 'utf8');
  assert.match(ext, /params\.visualIndex != null/, '截图要支持按候选序号取区域');
  assert.match(ext, /candidateIndex/, 'capture 要记住候选序号供命中校验');
  assert.match(ext, /capture\.region\.x \+ \(imageX \/ Math\.max\(1, capture\.width\)\)/, '候选 capture 用归一化映射');

  const dispatch = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'dispatch.js'), 'utf8');
  assert.match(dispatch, /visualOnly === true/, 'observe 要能切到视觉扫描');

  const cli = fs.readFileSync(path.join(ROOT, 'cli', 'bridge.mjs'), 'utf8');
  assert.match(cli, /case 'visuals'/, '要能列出视觉候选');
  assert.match(cli, /params\.visualIndex = index/, '--visual 要传到协议');
  const schemas = fs.readFileSync(path.join(ROOT, 'lib', 'schemas.mjs'), 'utf8');
  assert.match(schemas, /visualIndex: \{ type: 'integer'/, 'screenshot schema 要带 visualIndex');
});

test('一步式视觉动作：visuals / visual-drag / visual-click', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'cli', 'bridge.mjs'), 'utf8');
  for (const name of ['visuals', 'visual-drag', 'visual-click']) {
    assert.match(cli, new RegExp("case '" + name + "'", 'm'), '缺少命令 ' + name);
    assert.match(cli, new RegExp("'" + name + "'"), '缺少命令注册 ' + name);
  }
  assert.match(cli, /visualIndex: index/, '组合命令要复用 screenshot 的视觉候选参数');
  assert.match(cli, /writeDataUrl\(flags\.out, shot\.result\.dataUrl\)/, '组合命令要支持 --out 预览');
});

test('extract 覆盖度：声明行数 + 停止原因 + 完整性', () => {
  const lib = fs.readFileSync(path.join(ROOT, 'extension', 'injected', 'page-lib.js'), 'utf8');
  assert.match(lib, /function declaredRowCount\(/, '要有声明行数读取');
  assert.match(lib, /aria-rowcount/, '声明行数取 aria-rowcount');
  assert.match(lib, /aria-setsize/, '列表声明数取 aria-setsize');
  assert.match(lib, /if \(value == null \|\| value === ''\) return null;/, '没有声明属性时必须回 null，不能被 Number(null)=0 骗成"声明 0 行"');
  assert.match(lib, /function withCoverage\(/, '要有覆盖度组装');
  assert.match(lib, /datasetComplete/, '结果要带 datasetComplete');
  assert.match(lib, /stopReason = 'max-bytes'/, '字节上限要标停止原因');
  const calls = (lib.match(/withCoverage\(/g) || []).length;
  assert.ok(calls >= 4, '表格/列表/网格抽取都要补覆盖度，当前调用点 ' + calls);
  const cli = fs.readFileSync(path.join(ROOT, 'cli', 'bridge.mjs'), 'utf8');
  assert.match(cli, /function formatCoverage\(/, 'CLI 要能打印覆盖度');
});

test('观测代数守卫：observe 返回 revision，动作可要求同一代数', () => {
  const lib = fs.readFileSync(path.join(ROOT, 'extension', 'injected', 'page-lib.js'), 'utf8');
  assert.match(lib, /const revisionState = \{ value: 0 \}/, 'page-lib 要维护 DOM 代数');
  assert.match(lib, /new MutationObserver\(bumpRevision\)/, 'DOM 变更要递增代数');
  assert.match(lib, /revision: currentRevision\(\)/, 'observe 结果要带 revision');
  assert.match(lib, /E_OBSERVATION_CHANGED/, '代数不符要报专门错误码');
  assert.match(lib, /input\.expectRevision != null/, '守卫要按请求生效，不默认拦截');
  const observation = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'tools', 'observation.js'), 'utf8');
  assert.match(observation, /revision: typeof base\.revision === 'number'/, '扩展要把 revision 透出');
  const schemas = fs.readFileSync(path.join(ROOT, 'lib', 'schemas.mjs'), 'utf8');
  assert.match(schemas, /expectRevision: \{ type: 'integer'/, '协议要声明 expectRevision');
  const cli = fs.readFileSync(path.join(ROOT, 'cli', 'bridge.mjs'), 'utf8');
  assert.match(cli, /'expect-revision'/, 'CLI 要接受 --expect-revision');
});

test('多段手势：visual-gesture 支持点击序列 / 长按拖拽 / 等待', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'cli', 'bridge.mjs'), 'utf8');
  assert.match(cli, /case 'visual-gesture':/, '要有 visual-gesture 命令');
  assert.match(cli, /'visual-gesture',/, '命令要注册到 PAGE_COMMANDS');
  assert.match(cli, /flags\.points !== undefined/, '支持 --points 简写');
  assert.match(cli, /value\.startsWith\('\{'\)/, '--plan 支持内联 JSON 与文件两种来源');
  assert.match(cli, /type === 'wait'/, '支持等待步');
  assert.match(cli, /const hold = parseDurationMs\(step\.hold, 0\)/, '拖拽步支持长按');
  assert.match(cli, /step\.dx/, '拖拽步支持位移');
  const flags = cli.slice(cli.indexOf('const VALUE_FLAGS'), cli.indexOf('const BOOLEAN_FLAGS'));
  assert.ok(flags.includes("'points'") && flags.includes("'plan'"), '--points/--plan 要进值旗标表');
});

test('视觉候选必须真的能被点到', () => {
  const lib = fs.readFileSync(path.join(ROOT, 'extension', 'injected', 'page-lib.js'), 'utf8');
  assert.match(lib, /document\.elementFromPoint\(cx, cy\)/, '要按候选中心做命中测试');
  assert.match(lib, /const hitSelf = top === el/, '命中测试要允许自身/子树/祖先三种关系');
  assert.match(lib, /if \(!hitSelf\) return;/, '点不到的候选（模板/隐藏副本）要丢弃');
});

test('读取类结果也标代数，读与写可绑定在同一代 DOM', () => {
  const lib = fs.readFileSync(path.join(ROOT, 'extension', 'injected', 'page-lib.js'), 'utf8');
  assert.match(lib, /function withRevision\(/, '读取类结果要能标注代数');
  assert.match(lib, /case 'read':\s+return ok\(withRevision\(actionRead/, 'read 结果带代数');
  assert.match(lib, /case 'extract':\s+return ok\(withRevision\(capExtractBytes/, 'extract 结果带代数');
  const cli = fs.readFileSync(path.join(ROOT, 'cli', 'bridge.mjs'), 'utf8');
  assert.match(cli, /async function cmdRead[\s\S]{0,900}expectRevision/, 'read 要能带 expectRevision');
  assert.match(cli, /async function cmdExtract[\s\S]{0,900}expectRevision/, 'extract 要能带 expectRevision');
});

test('capture 单次消费 + 截图后几何复测', () => {
  const ext = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'screenshot.js'), 'utf8');
  assert.match(ext, /export function consumeCapture/, '需要单次消费入口');
  assert.match(ext, /options\.consume === true \? consumeCapture/, '换算处必须支持消费语义');
  assert.match(ext, /capture_skipped: 'geometry-changed'/, '截图后几何变化必须作废 capture');
  const interaction = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'tools', 'interaction.js'), 'utf8');
  assert.match(interaction, /\{ consume: true \}/, '视觉拖拽要消费 capture');
});

test('派发前做命中校验', () => {
  const ext = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'screenshot.js'), 'utf8');
  assert.match(ext, /export async function verifyVisualHit/);
  assert.match(ext, /execPage\(tabId, 'hit-at'/, '命中校验要走页面能力库');
  assert.match(ext, /E_OBSCURED/, '被铺满视口的元素遮住要单独报错');
  const lib = fs.readFileSync(path.join(ROOT, 'extension', 'injected', 'page-lib.js'), 'utf8');
  assert.match(lib, /\n  function hitAt\(args\)/, 'page-lib 要提供 hitAt');
  assert.match(lib, /INERT|inert/, 'hitAt 要检查 inert');
  assert.match(lib, /hitAt,\s+visualScan,\s+resetRefs,/, 'hitAt / visualScan 要挂到能力库导出上');
  assert.match(lib, /case 'hit-at':/, 'handle 分发要认识 hit-at');
  const interaction = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'tools', 'interaction.js'), 'utf8');
  assert.match(interaction, /verifyVisualHit\(resolved\.capture\.tabId/, '拖拽也要命中校验');
  const inject = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'inject.js'), 'utf8');
  const libVersion = Number((lib.match(/const LIB_VERSION = (\d+);/) || [])[1]);
  const expectVersion = Number((inject.match(/const PAGE_LIB_VERSION = (\d+);/) || [])[1]);
  assert.equal(libVersion, expectVersion, 'page-lib 版本号必须与 inject.js 期望一致');
});

test('长按是"按下之后保持"，不是"先等再按"', () => {
  const lib = fs.readFileSync(path.join(ROOT, 'extension', 'injected', 'page-lib.js'), 'utf8');
  const start = lib.indexOf('async function actionDrag');
  assert.ok(start >= 0, 'page-lib 要有 actionDrag');
  const body = lib.slice(start);
  const down = body.indexOf("fireMouseTarget(fromEl, 'pointerdown'");
  const hold = body.indexOf('if (holdMs > 0) await sleepMs(holdMs);');
  assert.ok(down >= 0, 'actionDrag 要派发 pointerdown');
  assert.ok(hold > down, '长按必须发生在 pointerdown 之后，否则控件收不到长按时长');
  const move = body.indexOf('for (let i = 1; i <= steps; i += 1) {', hold);
  assert.ok(hold < move, '长按必须发生在开始移动之前');
});

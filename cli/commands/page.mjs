// cli/commands/page.mjs —— 页面命令（navigate/observe/click/fill/screenshot/evaluate 等）的大分派。
//
// 所有 CLI 共享 helper（RPC/输出/目标解析/截图落盘）由 bridge 注入；纯参数与格式化走 cli/lib。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ArgError, intFlag, requirePos, parseDurationMs } from '../lib/args.mjs';
import { formatBytes, formatTime, renderTable, truncateText } from '../lib/format.mjs';
import { defaultInputMode } from '../../lib/input-mode.mjs';
import { deriveActions } from '../../lib/observe-actions.mjs';
import { redactFillResult, resolveSecretValue } from '../../lib/secrets.mjs';
import { diffObservation } from '../../lib/observation-delta.mjs';
import { parseVomWeights } from '../../lib/vom-weight-config.mjs';
import { RISK } from '../lib/arg-contract.mjs';
import { buildPlan, callStep, dryRunNotes, isDryRun, outputDryRun, rpcStep } from '../lib/action-plan.mjs';

export const PAGE_COMMANDS = new Set([
  'navigate', 'reload', 'back', 'forward', 'navigate-back', 'navigate-forward', 'observe', 'snapshot', 'pdf',
  'get-html', 'screenshot', 'click', 'click-backend', 'hover', 'fill', 'press',
  'select', 'focus', 'scroll-to', 'evaluate',
  'wait-for-element', 'wait-for-navigation', 'wait-ms', 'console', 'actionable',
  'visuals', 'visual-drag', 'visual-click', 'visual-gesture',
]);

/** 兼容目标 风格 `--flag true|false` 的布尔取值解析（默认 true，与 CDP 默认一致）。 */
function parseBooleanFlag(flags, name) {
  const raw = flags[name];
  if (raw === undefined || raw === true) return true;
  const text = String(raw).trim().toLowerCase();
  if (['true', '1', 'on', 'yes'].includes(text)) return true;
  if (['false', '0', 'off', 'no'].includes(text)) return false;
  throw new ArgError('--' + name + ' 需要 true|false，收到 "' + raw + '"');
}

export function createPageCommand({
  withControl,
  withSession,
  callRpc,
  timeoutOf,
  renderPageBody,
  resolveTarget,
  writeDataUrl,
  writeStreamedCapture,
  emitJson,
  outputFailure,
  outputJsonBody,
  isJson,
  print,
  ACTION_CACHE_PATH,
  applyCachedObservation,
  followOpenedTab,
  healAction,
  readCachedObservation,
  saveObservationCache,
  sessionTabIds,
  waitForNavigationAfterClick,
  withNavigationProbe,
  writeFileAtomic,
}) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const loadObservationDelta = () => import('../../lib/observation-delta.mjs');
  const planIo = {
    callRpc,
    timeoutOf,
    flags: null,
    isJson,
    emitJson,
    print,
  };

  /** wait-for-element 的 plan：只读等待，超时不算错误。 */
  function buildWaitElementPlan(flags, pos) {
    const target = resolveTarget(flags, pos, 1, { required: true });
    const state = flags.state !== undefined ? String(flags.state) : 'visible';
    const timeoutMs = parseDurationMs(flags.timeout, 10_000);
    const params = { ...target, state, timeoutMs };
    if (flags['operation-id'] !== undefined) params.operationId = String(flags['operation-id']);
    const name = target.ref || target.selector || target.text || target.stableRef || '(target)';
    return buildPlan({
      command: 'wait-for-element',
      subcommand: null,
      risk: RISK.READ_ONLY,
      steps: [rpcStep('wait-for-element', withControl(flags, params), {
        description: '等待 ' + name + ' 满足 state=' + state + '（上限 ' + timeoutMs + 'ms）',
        target: { kind: 'element', name },
        risk: RISK.READ_ONLY,
        minTimeoutMs: timeoutMs + 5000,
      })],
      notes: dryRunNotes(flags),
    });
  }

  /** wait-for-navigation 的 plan：只读等待导航阶段。 */
  function buildWaitNavigationPlan(flags) {
    const waitUntil = flags['wait-until'] !== undefined ? String(flags['wait-until']) : 'load';
    const params = withControl(flags, { waitUntil });
    params.timeoutMs = parseDurationMs(flags.timeout, 30000);
    return buildPlan({
      command: 'wait-for-navigation',
      subcommand: null,
      risk: RISK.READ_ONLY,
      steps: [rpcStep('wait-for-navigation', params, {
        description: '等待导航阶段 ' + waitUntil + '（上限 ' + params.timeoutMs + 'ms）',
        target: { kind: 'navigation', name: waitUntil },
        risk: RISK.READ_ONLY,
        minTimeoutMs: params.timeoutMs + 5000,
      })],
      notes: dryRunNotes(flags),
    });
  }

function normalizeWaitUntil(value) {
  if (value === undefined) return 'domcontentloaded';
  const allowed = ['load', 'domcontentloaded', 'commit'];
  const text = String(value);
  if (!allowed.includes(text)) throw new ArgError('--wait-until 只接受 ' + allowed.join('|'));
  return text;
}

  return async function cmdPage(command, flags, pos, invocation) {
  if (!PAGE_COMMANDS.has(command)) throw new ArgError(`未知命令：${command}（运行 bridge -h 查看用法）`);
  planIo.flags = flags;

  switch (command) {
    case 'navigate': {
      const url = requirePos(pos, 1, '<url>');
      const waitUntil = normalizeWaitUntil(flags['wait-until']);
      // PROTOCOL §5.2 的 navigate 没有 noFocus 参数；窗口聚焦由 session start --no-focus 决定。
      // CLI 默认在 domcontentloaded 就返回：重页面（GitHub 等）不再卡到 60s；需要完整 load 用 --wait-until load。
      const navParams = { url };
      if (waitUntil === 'commit') navParams.timeoutMs = 800;
      else if (waitUntil === 'domcontentloaded') navParams.timeoutMs = 2000;
      const body = await callRpc('navigate', withControl(flags, navParams), Math.max(timeoutOf(flags), 15000));
      if (body.ok && waitUntil === 'domcontentloaded') {
        await callRpc('wait-for-navigation', withControl(flags, { waitUntil: 'domcontentloaded', timeoutMs: 30000 }), 45000).catch(() => null);
      }
      return renderPageBody(body, (result) => {
        const title = result && result.title ? `（${result.title}）` : '';
        print(`已导航：${(result && result.url) || url}${title}`);
      });
    }
    case 'reload':
    case 'back':
    case 'forward':
    case 'navigate-back':
    case 'navigate-forward': {
      const method = command === 'navigate-back' || command === 'back' ? 'navigate-back' : (command === 'navigate-forward' || command === 'forward' ? 'navigate-forward' : 'reload');
      const body = await callRpc(method, withControl(flags, {}), timeoutOf(flags));
      return renderPageBody(body, () => print('ok'));
    }
    case 'observe': {
      if (flags.frames === true) {
        const params = withControl(flags, {});
        if (flags['probe-hover'] === true) params.probeHover = true;
        if (flags.vom === true) params.vom = true;
        const body = await callRpc('observe-frames', params, timeoutOf(flags));
        if (!body.ok) return outputFailure(body);
        if (isJson()) return outputJsonBody(body);
        const result = body.result || {};
        print(String(result.text || '').trim() || '(没有可观察的 frame)');
        print('');
        if (result.downgraded) print('（该扩展未声明 frames 能力，已降级为主文档观察）');
        print('frames: ' + (result.frames || []).length + '  refs: ' + (result.refs || 0));
        return 0;
      }
      const params = withControl(flags, {});
      if (flags['probe-hover'] === true) params.probeHover = true;
      if (flags['closed-shadow'] === true) params.closedShadow = true;
      if (flags['max-tokens'] !== undefined) params.maxTokens = intFlag(flags, 'max-tokens', { min: 1 });
      if (flags['max-depth'] !== undefined) params.maxDepth = intFlag(flags, 'max-depth', { min: 1 });
      if (flags['debug-surfaces'] === true) params.debugSurfaces = true;
      if (flags.vom === true || flags.actions === true) params.vom = true;
      if (flags['vom-deep'] === true) params.vomDeep = true;
      if (flags['vom-tree'] === true) params.vomTree = true;
      if (flags['vom-rank'] === true) params.vomRank = true;
      if (flags['vom-top'] !== undefined) params.vomTop = intFlag(flags, 'vom-top', { min: 1 });
      if (flags['vom-min-score'] !== undefined) params.vomMinScore = Number(flags['vom-min-score']);
      if (flags['vom-max-nodes'] !== undefined) params.vomMaxNodes = intFlag(flags, 'vom-max-nodes', { min: 1 });
      if (flags['vom-max-tokens'] !== undefined) params.vomMaxTokens = intFlag(flags, 'vom-max-tokens', { min: 1 });
      if (flags['vom-explain'] === true) params.vomExplain = true;
      if (flags['vom-exclude-hidden'] === true) params.vomExcludeHidden = true;
      if (flags['vom-profile']) params.vomProfile = String(flags['vom-profile']);
      if (flags['vom-per-group'] !== undefined) params.vomPerGroup = intFlag(flags, 'vom-per-group', { min: 1 });
      if (flags['vom-group-tokens'] !== undefined) params.vomGroupTokens = intFlag(flags, 'vom-group-tokens', { min: 1 });
      if (flags['vom-billing-model']) params.vomBillingModel = String(flags['vom-billing-model']);
      if (flags['vom-semantic-max-groups'] !== undefined) params.vomSemanticMaxGroups = intFlag(flags, 'vom-semantic-max-groups', { min: 1 });
      if (flags['vom-group-context'] === true) params.vomGroupContext = true;
      if (flags['vom-semantic-min-score'] !== undefined) params.vomSemanticMinScore = Number(flags['vom-semantic-min-score']);
      if (flags['vom-semantic-max-tokens'] !== undefined) params.vomSemanticMaxTokens = intFlag(flags, 'vom-semantic-max-tokens', { min: 1 });
      if (flags['vom-weights'] !== undefined) {
        try {
          params.vomWeights = parseVomWeights(String(flags['vom-weights']));
        } catch (error) {
          throw new ArgError(error.message);
        }
      }
      if (flags['deep-max-tokens'] !== undefined) params.deepMaxTokens = intFlag(flags, 'deep-max-tokens', { min: 1 });
      if (flags.ax === true) params.ax = true;
      if (flags.facts === true) params.facts = true;
      if (flags['fallback-ax'] === true) params.fallbackAx = true;
      if (flags['compare-ax'] === true) params.compareAx = true;
      if (flags['cdp-frames'] === true) params.cdpFrames = true;
      if (flags.force === true) params.force = true;
      if (flags.pipeline !== undefined) {
        const pipeline = String(flags.pipeline);
        if (pipeline !== 'page-lib' && pipeline !== 'ax') throw new Error('--pipeline 只支持 page-lib 或 ax');
        params.pipeline = pipeline;
      }
      if (flags.cursor !== undefined) params.cursor = String(flags.cursor);
      if (flags.delta === true || flags.baseline !== undefined) {
        const baseline = flags.baseline !== undefined ? String(flags.baseline) : '';
        params.delta = true;
        if (baseline) params.baseline = baseline;
      }
      const body = await callRpc('observe', params, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (body.result && flags.actions === true) {
        const actions = deriveActions(body.result.nodes);
        body.result.actions = actions;
        rememberActions(ACTION_CACHE_PATH, actions, body.result.url || '');
        if (isJson()) {
          emitJson(body);
          return 0;
        }
        if (!actions.length) {
          print('当前没有可执行候选动作（可加 --max-tokens 或先滚动/等待）');
          return 0;
        }
        print('候选动作 ' + actions.length + ' 个（用 ref 执行；--heal 可在 ref 失效时按语义重找）：');
        for (const item of actions) {
          print('  ' + item.ref + '  ' + item.action + '  ' + item.role + '  ' + JSON.stringify(item.name) + (item.offscreen ? '  (offscreen)' : ''));
        }
        return 0;
      }
      if (body.result) {
        if (!body.result.observationId) body.result.observationId = 'ob_' + crypto.randomBytes(6).toString('hex');
        // --delta：本地拿基线文本做行级 diff（扩展只回全文/unchanged，diff 在 CLI 侧算）。
        if (params.delta === true && params.baseline && typeof body.result.observation === 'string') {
          const baselineText = readCachedObservation(params.baseline);
          if (baselineText) {
            const { diffObservation } = await loadObservationDelta();
            const diff = diffObservation(baselineText, body.result.observation);
            if (diff.kind === 'same') {
              body.result.unchanged = true;
              body.result.changes = 0;
              body.result.patch = [];
            } else if (diff.kind === 'text' || diff.kind === 'structural-text') {
              body.result.delta = true;
              body.result.changes = diff.changes;
              body.result.patch = diff.ops || diff.patch;
            }
          }
        }
      }
      if (body.result && body.result.unchanged === true) {
        saveObservationCache(body.result.observationId, String(body.result.observation || ''));
        if (flags.out !== undefined) {
          writeFileAtomic(path.resolve(process.cwd(), String(flags.out)), String(body.result.observation || ''), 0o600);
        }
        if (isJson()) {
          emitJson(body);
          return 0;
        }
        print(`unchanged: 与基线 ${params.baseline || '(上一版)'} 一致，未重复输出（${String(body.result.observation || '').length} 字符）`);
        return 0;
      }
      if (body.result && body.result.delta === true) {
        const baseline = String(body.result.baseline || params.baseline || '');
        const merged = await applyCachedObservation(baseline, body.result.patch);
        if (merged == null) {
          // 本地没有基线缓存：退回整页观察，避免凭空合并
          const fresh = await callRpc('observe', withControl(flags, {}), timeoutOf(flags));
          if (!fresh.ok) return outputFailure(fresh);
          body.result = fresh.result;
        } else {
          saveObservationCache(body.result.observationId, merged);
          if (isJson()) {
            emitJson({ ok: true, result: { ...body.result, mergedChars: merged.length } });
            return 0;
          }
          print(`delta: ${body.result.changes} 行变化（基线 ${baseline}）`);
          for (const entry of body.result.patch || []) {
            const line = Number(entry.line);
            if (entry.op === 'remove') {
              print(`  - L${line + 1} 删除 ${Number(entry.count) || 0} 行`);
            } else if (entry.op === 'insert') {
              const inserted = Array.isArray(entry.lines) ? entry.lines : [];
              print(`  + L${line + 1} 插入 ${inserted.length} 行：${String(inserted[0] ?? '').slice(0, 160)}`);
            } else {
              print(`  L${line + 1}: ${String(entry.value).slice(0, 200)}`);
            }
          }
          if (flags.out !== undefined) {
            const file = path.resolve(process.cwd(), String(flags.out));
            writeFileAtomic(file, merged, 0o600);
            print('已写出合并结果：' + file);
          }
          return 0;
        }
      }
      if (body.result && body.result.observationId) {
        saveObservationCache(body.result.observationId, String(body.result.observation || ''));
      }
      const savedPath = flags['save-full'];
      if (savedPath !== undefined && body.result) {
        const file = path.resolve(process.cwd(), String(savedPath));
        writeFileAtomic(file, String(body.result.observation || ''), 0o600);
        body.result.savedTo = file;
      }
      if (isJson()) {
        emitJson(body);
        return 0;
      }
      const result = body.result || {};
      const lines = [
        `url: ${result.url || ''}`,
        `title: ${result.title || ''}`,
        '',
        result.observation || '',
      ];
      if (typeof result.refs === 'number') lines.push('', `refs: ${result.refs}`);
      if (result.observationId) lines.push(`observation: ${result.observationId}${result.observationAlias ? ' (' + result.observationAlias + ')' : ''}（用于 --delta --baseline / --observation）`);
      if (result.mutations && (result.mutations.total || result.mutations.interaction)) {
        lines.push(`mutations: text ${result.mutations.text || 0} / added ${result.mutations.added || 0} / removed ${result.mutations.removed || 0} / attr ${result.mutations.attributes || 0}${result.mutations.layout ? ' / layout' : ''}${result.mutations.interaction ? ' / interaction' : ''}`);
      }
      if (result.baselineReason) lines.push(`baseline: 结构性变化（${result.baselineReason}），已返回整页`);
      if (Array.isArray(result.nodes)) lines.push(`vom nodes: ${result.nodes.length}（--json 查看结构化字段）`);
      if (Array.isArray(result.axNodes)) lines.push(`ax nodes: ${result.axNodes.length}（--json 查看 AX 字段）`);
      if (result.axJoin) lines.push(`ax join: matched ${result.axJoin.matched} / unmatched ${result.axJoin.unmatched}`);
      if (result.savedTo) lines.push(`已保存完整观察：${result.savedTo}`);
      if (result.cursor) lines.push('', '@more ' + result.cursor);
      print(lines.join('\n'));
      return 0;
    }
    case 'visuals': {
      const body = await callRpc('observe', withControl(flags, { visualOnly: true }), timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const result = body.result || {};
      const list = Array.isArray(result.candidates) ? result.candidates : [];
      if (!list.length) {
        print('当前视口没有可用视觉候选（canvas / 图片 / 自绘区域）');
        return 0;
      }
      print('视觉候选 ' + list.length + ' 个（页面坐标）：');
      for (const item of list) {
        const rect = item.rect || {};
        print('  v' + item.index + '  <' + item.tag + (item.id ? '#' + item.id : '') + '>'
          + (item.cls ? '.' + String(item.cls).split(' ')[0] : '')
          + '  ' + (item.kind || '') + '  ' + rect.x + ',' + rect.y + ' ' + rect.width + 'x' + rect.height);
      }
      print('下一步：bridge screenshot --visual <index> --out crop.png --session <id>');
      return 0;
    }
    // 一步到位的视觉拖拽：截候选区域 → 用区域坐标派发 → 命中校验自动带上候选序号。
    // 不缓存 capture（内部一次用完即弃），调用方不用在两条命令之间传 capture_id。
    // 多段手势：一次调用里按顺序做「区域点击 / 区域拖拽 / 等待」。
    // 用于需要多点（点选类）或多把手（双滑块类）的控件——单次拖拽覆盖不到这些形态。
    case 'visual-gesture': {
      let plan = null;
      if (flags.plan !== undefined) {
        const value = String(flags.plan).trim();
        if (value.startsWith('{') || value.startsWith('[')) {
          try { plan = JSON.parse(value); } catch (error) { throw new ArgError('--plan 内联 JSON 不合法：' + error.message); }
        } else {
          const raw = fs.readFileSync(path.resolve(process.cwd(), value), 'utf8');
          try { plan = JSON.parse(raw); } catch (error) { throw new ArgError('--plan 文件不是合法 JSON：' + error.message); }
        }
      } else if (flags.points !== undefined) {
        // 简写：--points "x1,y1;x2,y2;..." + --visual N，等价于对该区域依次点击
        if (flags.visual === undefined) throw new ArgError('--points 需要配合 --visual <index>');
        plan = {
          steps: String(flags.points).split(';').filter((s) => s.trim()).map((pair) => {
            const [x, y] = pair.split(',').map((v) => Number(v.trim()));
            if (!Number.isFinite(x) || !Number.isFinite(y)) throw new ArgError('--points 每段格式为 x,y：' + pair);
            return { type: 'click', visual: Number(flags.visual), x, y };
          }),
        };
      } else {
        throw new ArgError('visual-gesture 需要 --plan <file|json> 或 --points "x,y;x,y" --visual N');
      }
      const steps = Array.isArray(plan) ? plan : plan && Array.isArray(plan.steps) ? plan.steps : null;
      if (!steps || !steps.length) throw new ArgError('手势计划里没有 steps');
      if (steps.length > 12) throw new ArgError('手势计划最多 12 步');
      const done = [];
      for (const step of steps) {
        const type = step.type === 'drag' ? 'drag' : step.type === 'wait' ? 'wait' : 'click';
        if (type === 'wait') {
          await sleep(Math.max(0, Math.min(5000, Number(step.ms) || 200)));
          done.push({ type: 'wait', ms: Number(step.ms) || 200 });
          continue;
        }
        const index = Number(step.visual);
        if (!Number.isInteger(index) || index < 1) throw new ArgError('每步需要 visual 序号');
        const shot = await callRpc('screenshot', withControl(flags, { visualIndex: index }), timeoutOf(flags));
        if (!shot.ok) return outputFailure(shot);
        const captureId = shot.result && shot.result.capture_id;
        if (!captureId) throw new ArgError('候选 v' + index + ' 截图没有生成 capture（' + ((shot.result && shot.result.capture_skipped) || '未知原因') + '）');
        const params = withControl(flags, { capture: captureId, imageX: Number(step.x), imageY: Number(step.y) });
        if (type === 'drag') {
          params.imageDx = Number(step.dx) || 0;
          params.imageDy = Number(step.dy) || 0;
          const hold = parseDurationMs(step.hold, 0);
          if (hold) params.holdMs = hold;
          params.durationMs = parseDurationMs(step.duration, 0);
          if (step.steps !== undefined) params.steps = Number(step.steps);
        }
        const body = await callRpc(type === 'drag' ? 'drag' : 'click-point', params, timeoutOf(flags));
        if (!body.ok) return outputFailure(body);
        done.push({ type, visual: index, ok: true, hit: body.result && body.result.hit ? body.result.hit : undefined });
        const gap = Math.max(0, Math.min(3000, Number(step.gap) || 120));
        if (gap) await sleep(gap);
      }
      if (isJson()) return outputJsonBody({ ok: true, result: { steps: done } });
      print('手势完成：' + done.map((d) => d.type + (d.visual ? '#' + d.visual : '')).join(' → '));
      return 0;
    }
    case 'visual-drag':
    case 'visual-click': {
      const isDrag = command === 'visual-drag';
      if (flags.visual === undefined) throw new ArgError(command + ' 需要 --visual <index>（先用 bridge visuals 取序号）');
      const index = Number(flags.visual);
      if (!Number.isInteger(index) || index < 1) throw new ArgError('--visual 需要 ≥1 的整数');
      if (flags['image-x'] === undefined || flags['image-y'] === undefined) {
        throw new ArgError(command + ' 需要 --image-x 与 --image-y（区域图内坐标）');
      }
      const shotParams = withControl(flags, { visualIndex: index });
      const shot = await callRpc('screenshot', shotParams, timeoutOf(flags));
      if (!shot.ok) return outputFailure(shot);
      const captureId = shot.result && shot.result.capture_id;
      if (!captureId) {
        throw new ArgError('候选区域截图没有生成 capture（' + ((shot.result && shot.result.capture_skipped) || '未知原因') + '）');
      }
      let previewPath = null;
      if (flags.out !== undefined && shot.result && shot.result.dataUrl) {
        previewPath = writeDataUrl(flags.out, shot.result.dataUrl).target;
      }
      const dragParams = withControl(flags, {
        capture: captureId,
        imageX: Number(flags['image-x']),
        imageY: Number(flags['image-y']),
      });
      if (isDrag) {
        dragParams.imageDx = flags['image-dx'] !== undefined ? Number(flags['image-dx']) : 0;
        dragParams.imageDy = flags['image-dy'] !== undefined ? Number(flags['image-dy']) : 0;
        dragParams.durationMs = parseDurationMs(flags.duration, 0);
        const steps = intFlag(flags, 'steps', { min: 2 });
        if (steps !== undefined) dragParams.steps = steps;
      }
      const body = await callRpc(isDrag ? 'drag' : 'click-point', dragParams, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) {
        emitJson({ ok: true, result: { ...(body.result || {}), visual: shot.result && shot.result.visual, preview: previewPath || undefined } });
        return 0;
      }
      const result = body.result || {};
      print((isDrag ? '区域拖拽完成' : '区域点击完成')
        + '：候选 v' + index
        + (result.from ? ' 从 ' + Math.round(result.from.x) + ',' + Math.round(result.from.y) + ' 到 ' + Math.round(result.to.x) + ',' + Math.round(result.to.y) : '')
        + (result.hit ? '，命中 <' + result.hit.tag + (result.hit.id ? '#' + result.hit.id : '') + '>' : ''));
      if (previewPath) print('区域预览：' + previewPath);
      return 0;
    }
    case 'snapshot': {
      const body = await callRpc('snapshot', withControl(flags, {}), timeoutOf(flags));
      return renderPageBody(body, (result) => print(result.text ?? ''));
    }
    case 'actionable': {
      const t = resolveTarget(flags, pos, 1, { required: true });
      const body = await callRpc('actionable', withControl(flags, { ...(t || {}) }), timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const r = body.result || {};
      print(r.ok ? 'actionable: ok' : 'actionable: ' + (r.reason || 'unknown'));
      return r.ok ? 0 : 1;
    }
    case 'get-html': {
      const target = resolveTarget(flags, pos, 1, { required: false });
      const body = await callRpc('get-html', withControl(flags, { ...(target || {}) }), timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      const result = body.result || {};
      const html = typeof result.html === 'string' ? result.html : '';
      const bytes = Buffer.byteLength(html);
      if (flags.out !== undefined) {
        const file = path.resolve(process.cwd(), String(flags.out));
        writeFileAtomic(file, html, 0o600);
        if (isJson()) {
          emitJson({
            ok: true,
            result: {
              tab_id: result.tabId !== undefined ? result.tabId : null,
              path: file,
              written_bytes: bytes,
              byte_size: bytes,
              truncated: result.truncated === true,
              ...(result.dialogs ? { dialogs: result.dialogs } : {}),
            },
          });
          return 0;
        }
        print('已保存 HTML：' + file + '（' + formatBytes(bytes) + (result.truncated === true ? '，已截断' : '') + '）');
        return 0;
      }
      if (isJson()) {
        emitJson(body);
        return 0;
      }
      print(html);
      return 0;
    }
    case 'pdf': {
      const out = flags.out;
      if (!out) throw new ArgError('pdf 需要 --out <file>');
      const pdfParams = {};
      if (flags.pages) pdfParams.pages = String(flags.pages);
      if (flags.scale !== undefined) pdfParams.scale = Number(flags.scale);
      if (flags.margins) {
        const [top, right, bottom, left] = String(flags.margins).split(',').map(Number);
        pdfParams.margins = { top, right, bottom, left };
      }
      const body = await callRpc('pdf', withControl(flags, pdfParams), Math.max(timeoutOf(flags), 30000));
      if (!body.ok) return outputFailure(body);
      const result = body.result || {};
      const buffer = Buffer.from(String(result.base64 || ''), 'base64');
      const targetPath = path.resolve(process.cwd(), String(out));
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, buffer);
      const written = { target: targetPath, buffer };
      if (isJson()) {
        emitJson({ ok: true, result: { path: written.target, bytes: written.buffer.length } });
        return 0;
      }
      print('已导出 PDF：' + written.target + '（' + formatBytes(written.buffer.length) + '）');
      return 0;
    }

    case 'screenshot': {
      const out = flags.out;
      const mode = flags.mode === undefined
        ? (flags.full === true || flags['full-page'] === true ? 'auto' : 'visible')
        : String(flags.mode);
      if (!['visible', 'auto', 'manual'].includes(mode)) throw new ArgError('--mode 需要 visible|auto|manual');

      if (flags.stitch === true) {
        if (!out) throw new ArgError('screenshot --stitch 需要 --out <path>');
        const body = await callRpc('screenshot.manual.save', withControl(flags, {}), Math.max(timeoutOf(flags), 120000));
        if (!body.ok) return outputFailure(body);
        const result = body.result || {};
        const written = writeDataUrl(out, result.dataUrl);
        if (isJson()) {
          emitJson({ ok: true, result: { path: written.target, width: result.width, height: result.height, frames: result.frames, bytes: written.buffer.length } });
          return 0;
        }
        print('已保存拼接长图：' + written.target + '（' + result.width + 'x' + result.height + '，' + (result.frames || 0) + ' 帧，' + formatBytes(written.buffer.length) + '）');
        return 0;
      }

      if (mode === 'manual') {
        // 每次只追加一帧；帧由扩展按 tabId 保存，直到 --stitch 拼接后清空。
        const body = await callRpc('screenshot.manual.frame', withControl(flags, {}), timeoutOf(flags));
        if (!body.ok) return outputFailure(body);
        const frame = body.result || {};
        if (isJson()) {
          emitJson({ ok: true, result: { frames: frame.frames, width: frame.width, height: frame.height } });
          return 0;
        }
        print('已拍第 ' + frame.frames + ' 帧（' + frame.width + 'x' + frame.height + '）：滚动页面后重复执行，最后用 --stitch --out <path> 保存');
        return 0;
      }

      if (!out) throw new ArgError('screenshot 需要 --out <path>');
      const params = withControl(flags, { fullPage: mode === 'auto' });
      if (flags.stream === true) params.stream = true;
      if (flags.segmented === true) params.segmented = true;
      if (flags['tile-size'] !== undefined) params.tileSize = intFlag(flags, 'tile-size', { min: 256 });
      if (flags['stale-attempts'] !== undefined) params.staleAttempts = intFlag(flags, 'stale-attempts', { min: 1 });
      if (flags.diff === true) params.diff = true;
      if (flags.annotate === true) params.annotate = true;
      if (flags.grid === true) params.grid = true;
      if (flags['grid-step'] !== undefined) {
        const step = Number(flags['grid-step']);
        if (!Number.isFinite(step) || step < 10 || step > 200) throw new ArgError('--grid-step 需要 10–200 的整数');
        params.gridStep = Math.round(step);
        params.grid = true;
      }
      if (flags.profile !== undefined) {
        const axis = String(flags.profile).toLowerCase();
        if (!['x', 'y'].includes(axis)) throw new ArgError('--profile 只能是 x 或 y');
        params.profile = axis;
      }
      if (flags['region-scale'] !== undefined) {
        const zoom = Number(flags['region-scale']);
        if (!Number.isFinite(zoom) || zoom < 1 || zoom > 8) throw new ArgError('--region-scale 需要 1–8');
        params.scale = zoom;
      }
      if (flags.visual !== undefined) {
        const index = Number(flags.visual);
        if (!Number.isInteger(index) || index < 1) throw new ArgError('--visual 需要 ≥1 的整数（视觉候选序号）');
        params.visualIndex = index;
      }
      if (flags.overlap !== undefined) {
        const overlap = Number(flags.overlap);
        if (!Number.isFinite(overlap) || overlap < 0) throw new ArgError('--overlap 需要非负数');
        params.overlap = overlap;
      }
      if (flags.scope !== undefined) {
        const scope = String(flags.scope);
        if (!['viewport', 'document', 'follow', 'current'].includes(scope)) throw new ArgError('--scope 只能是 viewport|document|follow|current');
        params.scope = scope;
        if (scope === 'viewport') params.fullPage = false;
        if (scope === 'follow') { params.fullPage = true; params.growth = true; }
        if (scope === 'current') { params.fullPage = true; params.growth = false; }
      }
      const target = resolveTarget(flags, pos, 1, { required: false });
      if (target) Object.assign(params, target);
      if (flags.region !== undefined) {
        const parts = String(flags.region).split(',').map((item) => Number(item.trim()));
        if (parts.length !== 4 || parts.some((item) => !Number.isFinite(item) || item < 0) || parts[2] <= 0 || parts[3] <= 0) {
          throw new ArgError('--region 需要 x,y,w,h 四个非负数，且宽高大于 0');
        }
        params.region = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
      }
      const body = await callRpc('screenshot', params, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      const result = body.result || {};
      const written = result.captureId
        ? await writeStreamedCapture(out, result, flags)
        : writeDataUrl(out, result.dataUrl);
      const segmentPaths = [];
      if (Array.isArray(result.segments) && result.segments.length > 1) {
        const ext = path.extname(written.target);
        const base = written.target.slice(0, written.target.length - ext.length);
        segmentPaths.push({ path: written.target, height: result.segments[0].height, offsetY: result.segments[0].offsetY });
        for (let index = 1; index < result.segments.length; index += 1) {
          const target = base + '-' + (index + 1) + ext;
          writeDataUrl(target, result.segments[index].dataUrl);
          segmentPaths.push({ path: target, height: result.segments[index].height, offsetY: result.segments[index].offsetY });
        }
      }
      if (isJson()) {
        // --json 不输出 dataUrl（数 MB base64 会撑爆调用方行缓冲，且已落盘）
        const summary = {
          path: written.target,
          width: result.width ?? null,
          height: result.height ?? null,
          bytes: written.buffer.length,
        };
        if (result.streamed === true) summary.streamed = true;
        if (result.capture_id) summary.capture_id = result.capture_id;
        if (result.captureAlias) summary.captureAlias = result.captureAlias;
        if (result.capture_mode) summary.capture_mode = result.capture_mode;
        if (result.visual) summary.visual = result.visual;
        if (result.capture_skipped) summary.capture_skipped = result.capture_skipped;
        if (result.tiled) summary.tiled = result.tiled;
        if (result.tile_size) summary.tile_size = result.tile_size;
        if (result.fixedFooter) summary.fixedFooter = result.fixedFooter;
        if (result.fixedTop) summary.fixedTop = result.fixedTop;
        if (result.dpr) summary.dpr = result.dpr;
        if (result.fixedBands) summary.fixedBands = result.fixedBands;
        if (result.stale === true) summary.stale = true;
        if (result.stale_retries) summary.stale_retries = result.stale_retries;
        if (result.stale_attempts) summary.stale_attempts = result.stale_attempts;
        if (result.stale_repairs) summary.stale_repairs = result.stale_repairs;
        if (result.extended === true) summary.extended = true;
        if (result.rewritten_tiles) summary.rewritten_tiles = result.rewritten_tiles;
        if (result.longshot_id) summary.longshot_id = result.longshot_id;
        if (result.tiles_persisted) summary.tiles_persisted = result.tiles_persisted;
        if (result.segmented === true) { summary.segmented = true; summary.segment_count = result.segment_count; summary.segments = segmentPaths; }
        if (result.diff) summary.diff = result.diff;
        if (result.full_page === true) summary.full_page = true;
        if (Array.isArray(result.visual_refs)) summary.visual_refs = result.visual_refs;
        if (result.profile) summary.profile = result.profile;
        emitJson({ ok: true, result: summary });
        return 0;
      }
      print('已保存：' + written.target + '（' + (result.width || '?') + 'x' + (result.height || '?') + '，' + formatBytes(written.buffer.length) + '）');
      if (result.capture_id) print('capture_id: ' + result.capture_id + (result.captureAlias ? ' (' + result.captureAlias + ')' : '') + '（视觉坐标点击：bridge click --capture <id|别名> --image-x X --image-y Y）');
      if (result.capture_mode === 'visual-region' && result.visual) {
        print('区域 capture：候选 v' + result.visual.index + ' <' + result.visual.tag
          + (result.visual.id ? '#' + result.visual.id : '') + '>，图片 ' + (result.width || '?') + 'x' + (result.height || '?')
          + '（坐标相对该图，0..宽/高）');
      }
      if (result.capture_skipped) print('capture 未生成：' + result.capture_skipped + '（页面在截图期间变化，图片仅供参考）');
      if (Array.isArray(result.visual_refs)) print('视觉引用：' + result.visual_refs.length + ' 个');
      if (result.profile) {
        const peaks = Array.isArray(result.profile.peaks) ? result.profile.peaks : [];
        print('差分剖面（' + result.profile.axis + ' 轴，' + (result.profile.width || '?') + 'x' + (result.profile.height || '?') + '）峰值：'
          + (peaks.slice(0, 6).map((item) => item.pos + '@' + item.score).join(', ') || '无'));
      }
      return 0;
    }
    case 'click-backend': {
      if (flags.backend === undefined) throw new ArgError('click-backend 需要 --backend <backendNodeId>');
      const backendId = intFlag(flags, 'backend', { min: 1 });
      const body = await callRpc('click-backend', withControl(flags, { backendId }), timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const result = body.result || {};
      print('已点击 backend 节点 ' + backendId + '（' + result.x + ',' + result.y + '）');
      return 0;
    }
    case 'click':
    case 'hover':
    case 'focus':
    case 'scroll-to': {
      if (command === 'click' && flags['closed-shadow-text'] !== undefined) {
        const params = withControl(flags, { text: String(flags['closed-shadow-text']) });
        const body = await callRpc('shadow.click', params, timeoutOf(flags));
        if (!body.ok) return outputFailure(body);
        if (isJson()) return outputJsonBody(body);
        const result = body.result || {};
        print('已在 closed shadow 内点击「' + (result.matched || '') + '」（' + (result.tag || '') + '，' + result.via + '）');
        return 0;
      }
      if (command === 'click' && flags.capture !== undefined) {
        if (flags['image-x'] === undefined || flags['image-y'] === undefined) {
          throw new ArgError('click --capture 需要同时给 --image-x 与 --image-y');
        }
        const params = withControl(flags, {
          capture: String(flags.capture),
          imageX: Number(flags['image-x']),
          imageY: Number(flags['image-y']),
        });
        const body = await callRpc('click-point', params, timeoutOf(flags));
        if (!body.ok) return outputFailure(body);
        if (isJson()) return outputJsonBody(body);
        const result = body.result || {};
        print('已按图坐标点击（' + result.via + '）：页面 (' + result.x + ', ' + result.y + ')' + (result.tag ? ' <' + result.tag + '>' : ''));
        return 0;
      }
      const stableRef = flags['stable-ref'] !== undefined ? String(flags['stable-ref']) : null;
      const target = stableRef ? { stableRef } : resolveTarget(flags, pos, 1, { required: true });
      let params = withControl(flags, { ...target });
      params = defaultInputMode(params, flags);
      if (flags.synthetic === true) { params.synthetic = true; params.trusted = false; }
      if (flags.human === true) params.human = true;
      if (flags.force === true) params.force = true;
      // 兼容目标 click --button（left|middle|right）与 --click-count（连续按几次）。
      // 两个参数都真实进入 click 协议参数：扩展的 trusted 输入路径按 button 选择
      // CDP 路径/回退路径；clickCount>1 时 CLI 连续派发 N 次真实点击（默认 1 次，行为不变）。
      let button = null;
      if (flags.button !== undefined) {
        const value = String(flags.button).toLowerCase();
        if (!['left', 'middle', 'right'].includes(value)) {
          throw new ArgError('--button 只支持 left|middle|right，收到 "' + flags.button + '"');
        }
        button = value;
        params.button = value;
      }
      let clickCount = 1;
      if (flags['click-count'] !== undefined) {
        clickCount = intFlag(flags, 'click-count', { min: 1 });
        if (clickCount > 10) throw new ArgError('--click-count 最多 10（连续点击上限）');
        params.clickCount = clickCount;
      }
      if (flags['expect-revision'] !== undefined) {
        const revision = Number(flags['expect-revision']);
        if (!Number.isInteger(revision) || revision < 0) throw new ArgError('--expect-revision 需要 ≥0 的整数（取自 observe 的 revision）');
        params.expectRevision = revision;
      }
      let followBefore = null;
      const followSession = flags.session || flags['session-id'];
      if (flags.follow === true) {
        if (!followSession) throw new ArgError('--follow 需要 --session <id>');
        const tabs = await sessionTabIds(String(followSession));
        followBefore = new Set(tabs.map((tab) => tab.tabId));
      }
      let beforeUrl = null;
      if (command === 'click' && flags['wait-navigation'] === true) {
        const probe = await callRpc('evaluate', withNavigationProbe(flags, 'location.href'), Math.max(timeoutOf(flags), 5000));
        if (probe.ok) beforeUrl = String((probe.result || {}).value || '');
      }
      let body;
      if (command === 'click' && clickCount > 1) {
        // 连续真实点击：--click-count 2 等价“连续按两次”（兼容目标 口径），默认 1 次时完全不进这个分支。
        for (let index = 0; index < clickCount; index += 1) {
          body = await callRpc(command, params, timeoutOf(flags));
          body = await healAction(command, params, body, flags);
          if (!body.ok) break;
        }
        if (body.ok) {
          if (!body.result) body.result = {};
          body.result.clickCount = clickCount;
          body.result.clicks = clickCount;
          if (button) body.result.button = button;
        }
      } else {
        body = await callRpc(command, params, timeoutOf(flags));
        body = await healAction(command, params, body, flags);
        if (body.ok && button && body.result) body.result.button = button;
      }
      if (command === 'click' && flags['accept-dialog'] === true && !body.ok && body.error && body.error.code === 'E_DIALOG_PENDING') {
        // 一步式确认框：点击后自动接受对话框，并取回被挂起的原始点击结果。
        const data = body.error.data || {};
        const dialogId = data.dialog && Number.isInteger(data.dialog.id) ? data.dialog.id : null;
        if (dialogId !== null) {
          const accepted = await callRpc('dialog.accept', withControl(flags, { id: dialogId }), Math.max(timeoutOf(flags), 15000));
          if (accepted.ok) {
            let result = { dialog: { id: dialogId, action: 'accept' } };
            if (data.operationId) {
              const awaited = await callRpc('operation.await', withControl(flags, { id: data.operationId, timeoutMs: 5000 }), 20000).catch(() => null);
              if (awaited && awaited.ok && awaited.result) {
                result = { ...(awaited.result.result || awaited.result), dialog: { id: dialogId, action: 'accept' } };
              }
            }
            body = { ok: true, result };
          }
        }
      }

      if (body.ok && command === 'click' && flags.follow === true) {
        try {
          const followed = await followOpenedTab(String(followSession), followBefore);
          if (followed) {
            if (!body.result) body.result = {};
            body.result.followed = followed;
            if (!isJson()) print('已跟随新标签页：' + followed.url);
          }
        } catch (error) {
          const code = (error && error.code) || 'E_APP_SSO_FAILED';
          const message = (error && error.message) || String(error);
          if (isJson()) emitJson({ ok: false, error: { code, message } });
          else print('跟随失败：' + message);
          return 1;
        }
      }
      if (body.ok && command === 'click' && beforeUrl) {
        const navigation = await waitForNavigationAfterClick(flags, beforeUrl);
        if (!body.result) body.result = {};
        body.result.navigation = navigation;
        if (!isJson() && navigation.navigated) print('已导航到：' + navigation.url);
      }
      if (command === 'scroll-to' && body.ok && !isJson()) {
        const result = body.result || {};
        const bounds = result.bounds || {};
        const viewport = result.viewport || {};
        print('已滚动到目标（元素边界 ' + bounds.x + ',' + bounds.y + ' ' + bounds.width + 'x' + bounds.height +
          '，视口 ' + viewport.width + 'x' + viewport.height + '，scroll ' + (result.scroll && result.scroll.y) + '）');
        return 0;
      }
      return renderPageBody(body, () => print('ok'));
    }
    case 'fill': {
      const target = resolveTarget(flags, pos, 1, { required: true });
      if (flags.value === undefined && flags.secret === undefined) throw new ArgError('fill 需要 --value <text> 或 --secret <NAME>');
      const secret = resolveSecretValue({ value: flags.value, secret: flags.secret });
      const params = { ...target, value: secret.value };
      if (flags['no-clear'] === true) params.noClear = true;
      if (flags.trusted === true) params.trusted = true;
      if (flags.force === true) params.force = true;
      const fillParams = defaultInputMode(withControl(flags, params), flags);
      let body = await callRpc('fill', fillParams, timeoutOf(flags));
      body = await healAction('fill', fillParams, body, flags);
      if (secret.used && body.result) body.result = redactFillResult(body.result);
      return renderPageBody(body, (result) => {
        const bits = [];
        if (result.actual_value !== undefined) bits.push('实际值=' + result.actual_value + (result.actual_value_truncated === true ? '…' : ''));
        if (result.formatted === true) bits.push('页面已格式化');
        print(bits.length ? 'ok（' + bits.join('，') + '）' : 'ok');
      });
    }
    case 'press': {
      const key = requirePos(pos, 1, '<key>');
      let params = { key };
      params = defaultInputMode(params, flags);
      if (flags.force === true) params.force = true;
      const target = resolveTarget(flags, pos, 2, { required: false });
      if (target) Object.assign(params, target);
      const body = await callRpc('press', withControl(flags, params), timeoutOf(flags));
      return renderPageBody(body, () => print('ok'));
    }
    case 'select': {
      const target = resolveTarget(flags, pos, 1, { required: true });
      if (flags.value === undefined) throw new ArgError('select 需要 --value <value>');
      const params = { ...target, value: String(flags.value) };
      const selectParams = withControl(flags, params);
      let body = await callRpc('select', selectParams, timeoutOf(flags));
      body = await healAction('select', selectParams, body, flags);
      return renderPageBody(body, () => print('ok'));
    }
    case 'evaluate': {
      const expression = requirePos(pos, 1, '<expression>');
      const params = { expression };
      if (flags['await-promise'] !== undefined) {
        // 兼容目标 用 `--await-promise true|false`（默认 true），对应 CDP Runtime.evaluate.awaitPromise。
        params.awaitPromise = parseBooleanFlag(flags, 'await-promise');
      }
      if (flags['return-by-value'] !== undefined) {
        // 对应 CDP Runtime.evaluate.returnByValue（默认 true：拿到普通 JSON 值而不是 RemoteObject id）。
        params.returnByValue = parseBooleanFlag(flags, 'return-by-value');
      }
      if (flags.unverified === true) {
        if (flags.expect !== undefined || flags['depends-on'] !== undefined || flags.observation !== undefined) {
          throw new ArgError('--unverified 不能与 --expect/--depends-on/--observation 同时使用');
        }
        params.unverified = true;
      }
      const body = await callRpc('evaluate', withControl(flags, params), timeoutOf(flags));
      return renderPageBody(body, (result) => {
        if (typeof result.value === 'string') print(result.value);
        else print(JSON.stringify(result.value ?? null, null, 2));
        if (result.note) process.stderr.write(`(${result.note})\n`);
        if (result.verified === false) process.stderr.write('(unverified：已跳过观察校验，结果未经页面观察核对)\n');
      });
    }
    case 'wait-for-element': {
      const planned = buildWaitElementPlan(flags, pos);
      if (isDryRun(flags)) return outputDryRun(planned, planIo);
      const body = await callStep(planned.steps[0], planIo);
      if (!body.ok) return outputFailure(body);
      if (isJson()) {
        emitJson(body);
        return 0;
      }
      const state = planned.steps[0].params.state;
      const result = body.result || {};
      print(
        (result.cancelled ? '已取消' : result.satisfied ? '已满足' : '未满足') + '：' + state +
        '（' + (result.elapsedMs || 0) + 'ms，attached=' + Boolean(result.attached) +
        ' visible=' + Boolean(result.visible) + '）',
      );
      if (result.operationId) print('operation: ' + result.operationId + '（bridge operation cancel <id> 可中止）');
      return 0;
    }
    case 'wait-for-navigation': {
      const planned = buildWaitNavigationPlan(flags);
      if (isDryRun(flags)) return outputDryRun(planned, planIo);
      const body = await callStep(planned.steps[0], planIo);
      return renderPageBody(body, (result) => print('已等待导航：' + ((result && result.url) || '') + '（' + ((result && result.phase) || 'load') + '）'));
    }
    case 'wait-ms': {
      const ms = requirePos(pos, 1, '<ms>');
      if (!/^\d+$/.test(ms)) throw new ArgError(`<ms> 需要整数，收到 "${ms}"`);
      const value = Number(ms);
      const body = await callRpc('wait-ms', withControl(flags, { ms: value }), Math.max(timeoutOf(flags), value + 5000));
      return renderPageBody(body, () => print('ok'));
    }
    case 'console': {
      const since = intFlag(flags, 'since', { min: 0 });
      const limit = intFlag(flags, 'limit', { min: 1 });
      const cursor = intFlag(flags, 'cursor', { min: 0 });
      const maxTextChars = intFlag(flags, 'max-text-chars', { min: 1 });
      const params = {};
      if (cursor !== undefined) params.since = cursor;
      else if (since !== undefined) params.since = since;
      if (limit !== undefined) params.limit = limit;
      if (maxTextChars !== undefined) params.maxTextChars = maxTextChars;
      if (flags['include-stack'] === true) params.includeStack = true;
      const body = await callRpc('console', withControl(flags, params), timeoutOf(flags));
      return renderPageBody(body, (result) => {
        const entries = (result && result.entries) || [];
        if (!entries.length) {
          print('(无 console 输出)');
          return;
        }
        print(entries.map((entry) => `[${entry.level || 'log'} ${formatTime(entry.ts)}] ${entry.text ?? ''}`).join('\n'));
        if (result && result.nextCursor != null) print('\n@more ' + result.nextCursor);
      });
    }
    default:
      throw new ArgError(`未知命令：${command}`);
  }
  };
}

// cli/lib/command-plans.mjs —— video / longshot / record / debug / trace 的 dry-run 计划构造（单一来源）。
//
// 为什么需要这个文件：这五类命令原来只在执行路径里内联拼参数，`--dry-run` 无从预检；
// 但它们的 RPC 方法 / 本机文件操作 / 风险级别其实是可以静态声明的。于是把“将要发生什么”
// 收敛到一张表：
//   - `--dry-run`：`preflight()` 只构造并打印 plan，绝不发 RPC、绝不写文件；
//   - 真实执行：命令实现继续用同一份参数构造逻辑（模块里显式镜像，靠单测对拍）；
//   - 帮助/README：子命令与 `--dry-run` 支持情况由 command-specs 声明，两边共用一张表。
//
// 本模块是纯函数：不读文件、不碰网络、不读环境变量（会话参数由调用方用 withControl 传进来）。
// 因此可以在单测里直接构造任意 plan，也可以被 `bridge <命令> --dry-run` 安全调用。
import path from 'node:path';
import { ArgError, parseDurationMs } from './args.mjs';
import { RISK, isSet } from './arg-contract.mjs';
import { buildPlan, dryRunNotes, localStep, outputDryRun, rpcStep } from './action-plan.mjs';

/** 支持 dry-run 计划构造的子命令表（command-specs 的 dryRun 标记与单测都对着它断言）。 */
export const PLAN_SUBCOMMANDS = Object.freeze({
  video: Object.freeze(['start', 'stop', 'status', 'save', 'verify', 'durability', 'list', 'prune', 'discard', 'recover', 'info', 'merge', 'split', 'trim']),
  longshot: Object.freeze(['recover']),
  record: Object.freeze(['start', 'stop', 'status', 'list', 'export']),
  debug: Object.freeze([
    'start', 'stop', 'status', 'requests', 'har-import', 'ws', 'har', 'request', 'console', 'pages',
    'performance', 'aggregate', 'operations', 'operation', 'coverage', 'duplicates', 'fetch_probe',
    'capabilities', 'pin', 'unpin', 'pinned', 'activity', 'rule_add', 'rule_enable', 'rule_disable',
    'rule_remove', 'rule_list', 'rule_clear', 'rule_export', 'rule_import', 'export', 'archives',
    'archive', 'query', 'evidence', 'analyze', 'journal', 'replay', 'history',
  ]),
  trace: Object.freeze(['start', 'status', 'stop', 'diff', 'summary', 'view']),
});

/** 该命令/子命令是否能给出 dry-run 计划。 */
export function supportsDryRun(command, sub) {
  const list = PLAN_SUBCOMMANDS[String(command || '')];
  return Boolean(list && list.includes(String(sub || '')));
}

// ---------------------------------------------------------------------------
// 参数取值小工具：只做“取用/转换”，不校验（校验在参数契约层）
// ---------------------------------------------------------------------------

function textOf(flags, name) {
  const value = flags && flags[name];
  return value === undefined || value === null || value === '' ? null : String(value);
}

function intOf(flags, name) {
  const value = flags && flags[name];
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function durationOf(flags, name, fallback = 0) {
  const value = textOf(flags, name);
  if (value === null) return fallback;
  return parseDurationMs(value, fallback);
}

/** 位置参数（子命令之后）转字符串；缺省返回空串。 */
function positionalOf(pos, index) {
  const value = Array.isArray(pos) ? pos[index] : undefined;
  return value === undefined || value === null ? '' : String(value);
}

/** 用户给的路径 → 绝对路径（dry-run 打印的路径与真实写入一致）。 */
function absolutePath(raw) {
  const value = raw === null || raw === undefined ? '' : String(raw);
  return value ? path.resolve(process.cwd(), value) : '';
}

/** 过滤空路径并去重：localStep.paths 不允许空串，否则预检输出会变成空白行。 */
function existingPaths(list) {
  return list.map((item) => (item === null || item === undefined ? '' : String(item))).filter(Boolean);
}

/** 会话/控制参数（由调用方的 withControl 计算，本模块不重复实现）。 */
function sessionOf(context) {
  const session = context && context.session;
  return session && typeof session === 'object' ? { ...session } : {};
}

/** 组装一个“本机步骤”列表；没有路径时返回空数组（调用方据此决定是否加入 plan）。 */
function localSteps(specs) {
  const steps = [];
  for (const spec of specs) {
    const paths = existingPaths(spec.paths || []);
    if (!paths.length) continue;
    steps.push(localStep({
      action: spec.action || 'write',
      description: spec.description || '',
      paths,
      target: spec.target || null,
      risk: spec.risk,
      effects: spec.effects || [],
    }));
  }
  return steps;
}

/** 一条 RPC 步骤的简写：把“方法 + 参数 + 说明 + 目标”一次说完。 */
function step(method, params, description, extra = {}) {
  return rpcStep(method, params, { description, ...extra });
}

function planOf(command, sub, steps, extra = {}) {
  return buildPlan({
    command,
    subcommand: sub,
    steps,
    risk: extra.risk,
    warnings: extra.warnings || [],
    confirmations: extra.confirmations || [],
    notes: [...(extra.notes || []), ...dryRunNotes(extra.flags || {})],
  });
}

// ---------------------------------------------------------------------------
// video
// ---------------------------------------------------------------------------

function videoPlan(sub, context) {
  const flags = context.flags || {};
  const pos = context.pos || [];
  const session = sessionOf(context);
  const id = positionalOf(pos, 2);

  if (sub === 'start') {
    const params = { ...session };
    const durationMs = durationOf(flags, 'duration', 0);
    if (durationMs > 0) params.durationMs = durationMs;
    const quality = textOf(flags, 'quality');
    if (quality) params.quality = quality;
    const encoder = textOf(flags, 'encoder');
    if (encoder) params.encoder = encoder;
    if (flags['force-frames'] === true) params.forceFrames = true;
    return planOf('video', 'start', [step('video.start', params, '开始录屏（标签页画面，无声音）', {
      target: { kind: 'tab', sessionId: session.session || null },
      risk: RISK.BROWSER_MUTATION,
      effects: ['recording'],
    })], { flags });
  }

  if (sub === 'stop') {
    const params = { ...session };
    if (id) params.recording = id;
    return planOf('video', 'stop', [step('video.stop', params, '停止录制并封存分片', {
      target: { kind: 'recording', id: id || '(active)' },
      risk: RISK.BROWSER_MUTATION,
    })], { flags });
  }

  if (sub === 'status') {
    const params = { ...session };
    const steps = [step('video.status', params, '查询当前录制状态', { risk: RISK.READ_ONLY })];
    // 执行路径：status 没命中进行中的录制时会再查 video.list 找已完成的录制。
    steps.push(step('video.list', { ...session }, '查找已完成的录制（status 未命中时）', { risk: RISK.READ_ONLY }));
    return planOf('video', 'status', steps, {
      flags,
      notes: ['若录制仍进行中且 id 匹配，真实执行只会发出 video.status，不会发 video.list。'],
    });
  }

  if (sub === 'save') {
    const out = absolutePath(textOf(flags, 'out'));
    const steps = [step('video.fetch', { ...session, recording: id }, '取回录制字节（可能很大，超时自动放宽）', {
      target: { kind: 'recording', id },
      risk: RISK.BROWSER_MUTATION,
      effects: ['large_transfer'],
    })];
    steps.push(...localSteps([{
      action: 'write',
      description: '把录制写成文件' + (flags.overwrite === true ? '（允许覆盖）' : '（已存在则拒绝）'),
      paths: [out],
      target: { kind: 'file', file: out },
      risk: RISK.LOCAL_WRITE,
    }]));
    return planOf('video', 'save', steps, {
      flags,
      warnings: flags.overwrite === true ? ['--overwrite 会覆盖目标文件，旧内容无法恢复。'] : [],
    });
  }

  if (sub === 'verify') {
    return planOf('video', 'verify', [step('video.verify', { ...session, recording: id }, '校验分片完整性（不落盘）', {
      target: { kind: 'recording', id },
      risk: RISK.READ_ONLY,
    })], { flags });
  }

  if (sub === 'durability') {
    return planOf('video', 'durability', [step('video.list', { ...session }, '读取录制的持久化/配额信息', { risk: RISK.READ_ONLY })], {
      flags,
      notes: ['只读取录制列表里的 durability 字段，不写入任何存储。'],
    });
  }

  if (sub === 'list') {
    return planOf('video', 'list', [step('video.list', { ...session }, '列出可保存的录制', { risk: RISK.READ_ONLY })], { flags });
  }

  if (sub === 'prune') {
    const params = { ...session };
    const ttlMs = durationOf(flags, 'ttl', 0);
    if (ttlMs > 0) params.ttlMs = ttlMs;
    return planOf('video', 'prune', [step('video.prune', params, '清理过期录制（TTL=' + (ttlMs || '默认') + '）', {
      risk: RISK.DAEMON_STATE,
      effects: ['delete_recordings'],
    })], {
      flags,
      risk: RISK.DAEMON_STATE,
      warnings: ['prune 会删除过期录制，删除后无法从浏览器恢复。'],
    });
  }

  if (sub === 'discard') {
    return planOf('video', 'discard', [step('video.discard', { ...session, recording: id }, '丢弃录制 ' + id, {
      target: { kind: 'recording', id },
      risk: RISK.BROWSER_MUTATION,
      effects: ['delete_recording'],
    })], {
      flags,
      warnings: ['丢弃后该录制无法找回；需要成品请先 video save。'],
    });
  }

  if (sub === 'recover') {
    return planOf('video', 'recover', [step('video.recover', { ...session }, '扫描并恢复未封存的录屏分片', {
      risk: RISK.BROWSER_MUTATION,
      effects: ['recover_recording'],
    })], {
      flags,
      notes: ['recover 成功后会用 video save <id> --out <file> 才能拿到文件；先看 summary.nextSteps。'],
    });
  }

  if (sub === 'info') {
    return planOf('video', 'info', localSteps([{
      action: 'read',
      description: '只读取视频容器元数据（codec/尺寸/时长/包数），不解码',
      paths: [absolutePath(id)],
      target: { kind: 'file', file: absolutePath(id) },
      risk: RISK.READ_ONLY,
    }]), { flags });
  }

  if (sub === 'merge') {
    const inputs = (context.pos || []).slice(2).filter(Boolean).map((item) => absolutePath(item));
    const out = absolutePath(textOf(flags, 'out'));
    return planOf('video', 'merge', localSteps([
      { action: 'read', description: '读取待合并的视频（按给出顺序拼接）', paths: inputs, risk: RISK.READ_ONLY },
      { action: 'write', description: '写出合并后的视频', paths: [out], target: { kind: 'file', file: out }, risk: RISK.LOCAL_WRITE },
    ]), { flags, notes: ['合并按 packet 级拼接，要求输入编码参数一致。'] });
  }

  if (sub === 'split') {
    const input = absolutePath(id);
    const outDir = absolutePath(textOf(flags, 'out-dir'));
    const parts = intOf(flags, 'parts');
    return planOf('video', 'split', localSteps([
      { action: 'read', description: '读取待分段的视频', paths: [input], risk: RISK.READ_ONLY },
      { action: 'write', description: '按 ' + (parts || 2) + ' 段写出到目录', paths: [outDir], target: { kind: 'dir', file: outDir }, risk: RISK.LOCAL_WRITE },
    ]), { flags });
  }

  if (sub === 'trim') {
    const input = absolutePath(id);
    const out = absolutePath(textOf(flags, 'out'));
    const startMs = durationOf(flags, 'start', 0);
    const endMs = textOf(flags, 'end') === null ? null : durationOf(flags, 'end', 0);
    return planOf('video', 'trim', localSteps([
      { action: 'read', description: '读取待裁剪的视频', paths: [input], risk: RISK.READ_ONLY },
      { action: 'write', description: '写出裁剪结果（' + (startMs / 1000) + 's → ' + (endMs === null ? '末尾' : endMs / 1000 + 's') + '）', paths: [out], target: { kind: 'file', file: out }, risk: RISK.LOCAL_WRITE },
    ]), { flags });
  }

  return null;
}

// ---------------------------------------------------------------------------
// longshot
// ---------------------------------------------------------------------------

function longshotPlan(sub, context) {
  if (sub !== 'recover') return null;
  const flags = context.flags || {};
  const id = positionalOf(context.pos || [], 2);
  const out = absolutePath(textOf(flags, 'out'));
  const steps = [step('longshot.recover', { ...sessionOf(context), longshotId: id }, '取回长截图分片并校验 hash', {
    target: { kind: 'longshot', id },
    risk: RISK.READ_ONLY,
  })];
  steps.push(...localSteps([{
    action: 'write',
    description: '把重建的 PNG 落盘',
    paths: [out],
    target: { kind: 'file', file: out },
    risk: RISK.LOCAL_WRITE,
  }]));
  return planOf('longshot', 'recover', steps, {
    flags,
    notes: ['缺片/截断会在 JSON 的 summary.verification 里给出；dry-run 不发 RPC，无法知道分片是否齐全。'],
  });
}

// ---------------------------------------------------------------------------
// record
// ---------------------------------------------------------------------------

function recordPlan(sub, context) {
  const flags = context.flags || {};
  const session = sessionOf(context);
  const pos = context.pos || [];

  if (sub === 'start') {
    const params = { ...session };
    if (flags.screenshots === true) params.screenshots = true;
    if (flags['include-agent'] === true) params.includeAgent = true;
    return planOf('record', 'start', [step('record.start', params, '开始记录用户操作' + (flags['include-agent'] === true ? '（含 Agent 动作）' : ''), {
      target: { kind: 'tab', sessionId: session.session || null },
      risk: RISK.BROWSER_MUTATION,
      effects: ['recording'],
    })], { flags });
  }

  if (sub === 'stop') {
    return planOf('record', 'stop', [step('record.stop', { ...session }, '停止记录并落库', { risk: RISK.BROWSER_MUTATION })], { flags });
  }

  if (sub === 'status') {
    return planOf('record', 'status', [step('record.status', { ...session }, '查询进行中的记录', { risk: RISK.READ_ONLY })], { flags });
  }

  if (sub === 'list') {
    return planOf('record', 'list', [step('record.list', { ...session }, '列出历史记录', { risk: RISK.READ_ONLY })], { flags });
  }

  if (sub === 'export') {
    const id = positionalOf(pos, 2);
    const outDir = path.resolve(process.cwd(), textOf(flags, 'out') || 'trace');
    const steps = [step('record.list', { ...session }, '取出录制列表（export 需要整份事件）', { risk: RISK.READ_ONLY })];
    if (flags.screenshot === true) {
      steps.push(step('screenshot', { ...session, fullPage: false }, '导出一张当前页面截图放进 trace', { risk: RISK.READ_ONLY }));
    }
    steps.push(...localSteps([{
      action: 'write',
      description: '写出 Trace v3：trace.json + states/*.txt' + (id ? '（目标录制 ' + id + '）' : '（取最近一条录制）'),
      paths: [path.join(outDir, 'trace.json')],
      target: { kind: 'dir', file: outDir },
      risk: RISK.LOCAL_WRITE,
    }]));
    return planOf('record', 'export', steps, {
      flags,
      notes: ['export 不会删除录制；同一份录制可以重复导出。'],
    });
  }

  return null;
}

// ---------------------------------------------------------------------------
// trace
// ---------------------------------------------------------------------------

function tracePlan(sub, context) {
  const flags = context.flags || {};
  const session = sessionOf(context);
  const pos = context.pos || [];

  if (sub === 'start') {
    return planOf('trace', 'start', [step('trace.start', { ...session }, '开始 CDP 性能追踪', {
      risk: RISK.BROWSER_MUTATION,
      effects: ['tracing'],
    })], { flags });
  }

  if (sub === 'status') {
    return planOf('trace', 'status', [step('trace.status', { ...session }, '查询 tracing 状态与事件数', { risk: RISK.READ_ONLY })], { flags });
  }

  if (sub === 'stop') {
    const steps = [step('trace.stop', { ...session }, '停止 tracing 并取回 traceEvents', {
      risk: RISK.BROWSER_MUTATION,
      minTimeoutMs: 30000,
    })];
    const out = absolutePath(textOf(flags, 'out'));
    if (out) {
      steps.push(...localSteps([{
        action: 'write',
        description: '把 trace JSON 落盘',
        paths: [out],
        target: { kind: 'file', file: out },
        risk: RISK.LOCAL_WRITE,
      }]));
    }
    return planOf('trace', 'stop', steps, { flags });
  }

  if (sub === 'diff') {
    const base = absolutePath(positionalOf(pos, 2));
    const head = absolutePath(positionalOf(pos, 3));
    return planOf('trace', 'diff', localSteps([
      { action: 'read', description: '读取基线 trace（只解析 JSON，不联网）', paths: [base], risk: RISK.READ_ONLY },
      { action: 'read', description: '读取对比 trace（只解析 JSON，不联网）', paths: [head], risk: RISK.READ_ONLY },
    ]), { flags, notes: ['diff 是纯本地计算：不触达 daemon，也不修改任何文件。'] });
  }

  if (sub === 'summary') {
    const file = absolutePath(positionalOf(pos, 2) || textOf(flags, 'file'));
    return planOf('trace', 'summary', localSteps([
      { action: 'read', description: '读取 trace 并做本地统计（阶段/关键路径/长任务）', paths: [file], risk: RISK.READ_ONLY },
    ]), { flags, notes: ['summary 是纯本地计算：不触达 daemon。'] });
  }

  if (sub === 'view') {
    const file = absolutePath(positionalOf(pos, 2) || textOf(flags, 'file'));
    const debugFile = absolutePath(textOf(flags, 'debug'));
    const out = absolutePath(textOf(flags, 'out') || (file ? file.replace(/\.json$/i, '') + '.html' : ''));
    const steps = localSteps([
      { action: 'read', description: '读取 Trace v3', paths: [file], risk: RISK.READ_ONLY },
      { action: 'read', description: '可选：把 debug 归档的请求投影进网络面板', paths: [debugFile], risk: RISK.READ_ONLY },
      { action: 'write', description: '渲染离线 HTML 查看器', paths: [out], target: { kind: 'file', file: out }, risk: RISK.LOCAL_WRITE },
    ]);
    return planOf('trace', 'view', steps, {
      flags,
      notes: ['view 不触达 daemon：trace 文件在本地渲染成单文件 HTML。'],
    });
  }

  return null;
}

// ---------------------------------------------------------------------------
// debug
// ---------------------------------------------------------------------------

const DEBUG_RULE_ID_SUBS = new Set(['rule_enable', 'rule_disable', 'rule_remove']);

function debugPlan(sub, context) {
  const flags = context.flags || {};
  const session = sessionOf(context);
  const pos = context.pos || [];
  const id = positionalOf(pos, 2);
  const output = absolutePath(textOf(flags, 'output'));
  const file = absolutePath(textOf(flags, 'file') || positionalOf(pos, 2));
  const dir = absolutePath(textOf(flags, 'dir'));

  if (sub === 'start') {
    const params = { ...session };
    const name = textOf(flags, 'name');
    if (name) params.name = name;
    if (flags.bodies === true) params.bodies = true;
    return planOf('debug', 'start', [step('debug.start', params, '开始网络/控制台采集' + (flags.bodies === true ? '（含正文）' : '（只采元数据）'), {
      risk: RISK.BROWSER_MUTATION,
      effects: ['capture'],
    })], { flags });
  }

  if (sub === 'stop') {
    return planOf('debug', 'stop', [step('debug.stop', { ...session }, '停止采集并落库', {
      risk: RISK.BROWSER_MUTATION,
      minTimeoutMs: 30000,
    })], { flags });
  }

  if (sub === 'status') {
    return planOf('debug', 'status', [step('debug.current', { ...session }, '读取当前采集快照', { risk: RISK.READ_ONLY })], {
      flags,
      notes: ['若当前没有采集，真实执行会回落到 debug.history 列出最近记录（只读）。'],
    });
  }

  if (sub === 'requests') {
    const params = { ...session };
    const filter = textOf(flags, 'filter') || textOf(flags, 'url');
    return planOf('debug', 'requests', [step('debug.current', params, '读取采集快照并按参数在本地过滤请求', {
      risk: RISK.READ_ONLY,
      effects: filter ? ['filter:' + filter] : [],
    })], { flags, notes: ['过滤/分页/裁剪（--filter/--method/--limit/--fields 等）都在本地做，不额外发 RPC。'] });
  }

  if (sub === 'har-import') {
    return planOf('debug', 'har-import', localSteps([
      { action: 'read', description: '读取 HAR 1.2 文件', paths: [file], risk: RISK.READ_ONLY },
      { action: 'write', description: '转换成 debug 归档 JSON', paths: [output], target: { kind: 'file', file: output }, risk: RISK.LOCAL_WRITE },
    ]), { flags, notes: ['har-import 是纯离线转换：不触达 daemon。'] });
  }

  if (sub === 'ws') {
    const steps = [step('debug.current', { ...session }, '读取采集快照里的 WebSocket 帧索引', { risk: RISK.READ_ONLY })];
    if (output) {
      steps.push(...localSteps([{ action: 'write', description: '把 WS 帧索引落盘', paths: [output], target: { kind: 'file', file: output }, risk: RISK.LOCAL_WRITE }]));
    }
    return planOf('debug', 'ws', steps, { flags });
  }

  if (sub === 'har') {
    const limit = intOf(flags, 'limit') || 100;
    return planOf('debug', 'har', [
      step('debug.current', { ...session }, '读取采集快照', { risk: RISK.READ_ONLY }),
      step('debug.request', { ...session, id: null }, '对前 ' + limit + ' 条请求逐个调用 debug.request 取详情（数量取决于采集结果）', { risk: RISK.READ_ONLY, effects: ['dynamic:' + limit] }),
      ...localSteps([{ action: 'write', description: '写出 HAR 1.2', paths: [output], target: { kind: 'file', file: output }, risk: RISK.LOCAL_WRITE }]),
    ], { flags, notes: ['真实执行的 debug.request 次数 = 快照里的请求数（最多 --limit 条），dry-run 无法预知实际条数。'] });
  }

  if (sub === 'request') {
    return planOf('debug', 'request', [step('debug.request', { ...session, id: Number(id) }, '按 id 取单条请求详情', {
      target: { kind: 'request', id },
      risk: RISK.READ_ONLY,
    })], { flags, notes: ['--part / --pointer / --max-chars / --offset 只影响本地截取与打印。'] });
  }

  if (sub === 'console') {
    return planOf('debug', 'console', [step('debug.current', { ...session }, '读取采集快照里的控制台输出', { risk: RISK.READ_ONLY })], { flags });
  }

  if (sub === 'pages') {
    return planOf('debug', 'pages', [step('debug.current', { ...session }, '读取采集快照里的页面上下文', { risk: RISK.READ_ONLY })], { flags });
  }

  if (sub === 'performance') {
    return planOf('debug', 'performance', [step('debug.performance', { ...session }, '读取性能指标' + (flags.insight === true ? '，并在本地生成阈值结论' : ''), { risk: RISK.READ_ONLY })], { flags });
  }

  if (sub === 'aggregate') {
    return planOf('debug', 'aggregate', [step('debug.current', { ...session }, '读取采集快照并在本地按接口聚合（--slow-ms 为阈值）', { risk: RISK.READ_ONLY })], { flags });
  }

  if (sub === 'operations') {
    const params = {};
    const limit = intOf(flags, 'limit');
    if (limit !== null) params.limit = limit;
    const since = textOf(flags, 'since');
    if (since) params.since = since;
    return planOf('debug', 'operations', [step('operations.list', params, '列出最近 RPC 操作审计', { risk: RISK.READ_ONLY })], {
      flags,
      notes: ['执行路径还会额外尝试 debug.current 来统计时间窗内请求数（只读，失败不影响结果）。'],
    });
  }

  if (sub === 'operation') {
    const steps = [step('operations.get', { id: String(id) }, '读取单条操作审计记录', { target: { kind: 'operation', id }, risk: RISK.READ_ONLY })];
    if (flags['with-requests'] === true) {
      steps.push(step('debug.current', { ...session }, '按时间窗把采集到的请求标到该操作上', { risk: RISK.READ_ONLY }));
    }
    return planOf('debug', 'operation', steps, { flags });
  }

  if (sub === 'coverage') {
    return planOf('debug', 'coverage', [step('debug.coverage', { ...session }, '评估采集覆盖度与缺口根因', { risk: RISK.READ_ONLY })], { flags });
  }

  if (sub === 'duplicates') {
    return planOf('debug', 'duplicates', [step('debug.current', { ...session }, '读取采集快照并在本地聚簇重复请求', { risk: RISK.READ_ONLY })], { flags });
  }

  if (sub === 'fetch_probe') {
    const params = { ...session };
    const ms = intOf(flags, 'ms');
    if (ms !== null) params.ms = ms;
    return planOf('debug', 'fetch_probe', [step('debug.fetch_probe', params, '短暂挂起页面 fetch 看谁在发请求（会暂停页面请求 ' + (ms || 1500) + 'ms）', {
      risk: RISK.BROWSER_MUTATION,
      effects: ['pause_fetch'],
    })], {
      flags,
      warnings: ['fetch_probe 会真实暂停页面 fetch 一段时间，期间页面请求会变慢。'],
    });
  }

  if (sub === 'capabilities') {
    return planOf('debug', 'capabilities', [step('debug.capabilities', { ...session }, '查询扩展支持哪些 debug 动作/parts', { risk: RISK.READ_ONLY })], { flags });
  }

  if (sub === 'pin' || sub === 'unpin') {
    return planOf('debug', sub, [step('debug.pin', { ...session, id, pinned: sub === 'pin' }, (sub === 'pin' ? '钉住 ' : '取消钉住 ') + id, {
      target: { kind: 'request', id: String(id) },
      risk: RISK.BROWSER_MUTATION,
    })], { flags });
  }

  if (sub === 'pinned') {
    return planOf('debug', 'pinned', [step('debug.pinned', { ...session }, '列出钉住的请求', { risk: RISK.READ_ONLY })], { flags });
  }

  if (sub === 'activity') {
    const params = { ...session };
    const limit = intOf(flags, 'limit');
    if (limit !== null) params.limit = limit;
    return planOf('debug', 'activity', [step('operations.list', params, '列出调试/操作记录', { risk: RISK.READ_ONLY })], { flags });
  }

  if (sub === 'rule_add') {
    const ruleFile = absolutePath(textOf(flags, 'rule-file'));
    const inline = textOf(flags, 'rule');
    const steps = [];
    if (ruleFile) {
      steps.push(...localSteps([{ action: 'read', description: '读取规则定义 JSON', paths: [ruleFile], risk: RISK.READ_ONLY }]));
    }
    steps.push(step('debug.rule_add', { ...session, rule: ruleFile ? '(来自 ' + (ruleFile ? path.basename(ruleFile) : '') + ')' : inline }, '添加一条请求拦截规则', {
      risk: RISK.BROWSER_MUTATION,
      effects: ['intercept_rule'],
    }));
    return planOf('debug', 'rule_add', steps, {
      flags,
      warnings: [ruleFile
        ? '规则内容取自 ' + ruleFile + '，dry-run 不读取文件；真实执行会先校验 JSON。'
        : '规则会立即对当前标签页生效（fulfill/block/modify），先确认 urlPattern 范围。'],
    });
  }

  if (DEBUG_RULE_ID_SUBS.has(sub)) {
    return planOf('debug', sub, [step('debug.' + sub, { ...session, id: Number(id) }, sub + ' 规则 ' + id, {
      target: { kind: 'rule', id },
      risk: RISK.BROWSER_MUTATION,
    })], { flags });
  }

  if (sub === 'rule_list') {
    return planOf('debug', 'rule_list', [step('debug.rule_list', { ...session }, '列出当前拦截规则', { risk: RISK.READ_ONLY })], { flags });
  }

  if (sub === 'rule_clear') {
    return planOf('debug', 'rule_clear', [step('debug.rule_clear', { ...session }, '清空全部拦截规则', {
      risk: RISK.BROWSER_MUTATION,
      effects: ['clear_rules'],
    })], { flags, warnings: ['rule_clear 会删除全部规则，无法撤销。'] });
  }

  if (sub === 'rule_export') {
    return planOf('debug', 'rule_export', [
      step('debug.rule_export', { ...session }, '读取当前规则快照', { risk: RISK.READ_ONLY }),
      ...localSteps([{ action: 'write', description: '把规则快照写成 JSON', paths: [output], target: { kind: 'file', file: output }, risk: RISK.LOCAL_WRITE }]),
    ], { flags });
  }

  if (sub === 'rule_import') {
    return planOf('debug', 'rule_import', [
      ...localSteps([{ action: 'read', description: '读取规则快照 JSON', paths: [file], risk: RISK.READ_ONLY }]),
      step('debug.rule_import', { ...session, rules: '(来自 ' + (file ? path.basename(file) : '') + ')' }, '导入规则（替换当前规则集）', {
        risk: RISK.BROWSER_MUTATION,
        effects: ['replace_rules'],
      }),
    ], { flags, warnings: ['rule_import 会替换当前规则集，先 rule_export 备份。'] });
  }

  if (sub === 'export') {
    return planOf('debug', 'export', [
      step('debug.current', { ...session }, '读取当前采集快照', { risk: RISK.READ_ONLY }),
      ...localSteps([{ action: 'write', description: '把快照导出成 JSON', paths: [output], target: { kind: 'file', file: output }, risk: RISK.LOCAL_WRITE }]),
    ], { flags });
  }

  if (sub === 'archives') {
    const max = intOf(flags, 'max');
    const prune = flags.prune === true;
    const steps = localSteps([{ action: 'read', description: '扫描目录里的归档 JSON 并建立索引', paths: [dir], target: { kind: 'dir', file: dir }, risk: RISK.READ_ONLY }]);
    if (prune || max !== null) {
      steps.push(...localSteps([{
        action: 'delete',
        description: prune ? '删除已过期的归档文件（--prune）' : '只保留最新的 ' + max + ' 条归档（--max）',
        paths: [dir],
        target: { kind: 'dir', file: dir },
        risk: RISK.LOCAL_WRITE,
      }]));
    }
    return planOf('debug', 'archives', steps, {
      flags,
      warnings: prune || max !== null ? ['--prune / --max 会删除归档文件，删除后无法恢复。'] : [],
    });
  }

  if (sub === 'archive') {
    return planOf('debug', 'archive', [
      step('debug.current', { ...session }, '读取当前采集快照', { risk: RISK.READ_ONLY }),
      ...localSteps([{ action: 'write', description: '写出带 coverage/gaps 的归档 JSON 并更新索引', paths: [output], target: { kind: 'file', file: output }, risk: RISK.LOCAL_WRITE }]),
    ], { flags });
  }

  if (sub === 'query') {
    const paths = dir ? [dir] : [file];
    return planOf('debug', 'query', localSteps([{
      action: 'read',
      description: dir ? '在目录里的归档中按条件查询请求' : '在单个归档里按条件查询请求',
      paths,
      risk: RISK.READ_ONLY,
    }]), { flags, notes: ['query 是纯离线查询：不发 RPC。'] });
  }

  if (sub === 'evidence') {
    const steps = [];
    if (file) {
      steps.push(...localSteps([{ action: 'read', description: '读取离线快照文件', paths: [file], risk: RISK.READ_ONLY }]));
    } else {
      steps.push(step('debug.current', { ...session }, '读取当前采集快照', { risk: RISK.READ_ONLY }));
      steps.push(step('operations.list', { ...session, limit: 100 }, '读取最近操作审计（用于关联证据）', { risk: RISK.READ_ONLY }));
    }
    if (output) {
      steps.push(...localSteps([{ action: 'write', description: '写出证据包 JSON', paths: [output], target: { kind: 'file', file: output }, risk: RISK.LOCAL_WRITE }]));
    }
    return planOf('debug', 'evidence', steps, { flags });
  }

  if (sub === 'analyze') {
    const steps = [];
    if (file) {
      steps.push(...localSteps([{ action: 'read', description: '离线分析归档/快照文件', paths: [file], risk: RISK.READ_ONLY }]));
    } else {
      steps.push(step('debug.current', { ...session }, '读取当前采集快照后本地分析', { risk: RISK.READ_ONLY }));
    }
    return planOf('debug', 'analyze', steps, { flags });
  }

  if (sub === 'journal') {
    return planOf('debug', 'journal', [
      step('debug.current', { ...session }, '读取采集快照', { risk: RISK.READ_ONLY }),
      step('operations.list', { ...session, limit: flags.limit !== undefined ? Number(flags.limit) : 100 }, '读取操作审计（journal 的 operation 事件）', { risk: RISK.READ_ONLY }),
    ], { flags, notes: ['--merged 只在本地把两条时间线合并成带 elapsedMs 的时间轴。'] });
  }

  if (sub === 'replay') {
    return planOf('debug', 'replay', [step('network.replay', { ...session, id: Number(id) }, '重放请求 ' + id + '（会真实修改服务端数据）', {
      target: { kind: 'request', id },
      risk: RISK.BROWSER_MUTATION,
      minTimeoutMs: 120000,
    })], {
      flags,
      warnings: ['replay 发的是新请求，可能改变服务端状态；先看清请求再决定。'],
    });
  }

  if (sub === 'history') {
    return planOf('debug', 'history', [step('debug.history', { ...session }, '列出最近的采集历史', { risk: RISK.READ_ONLY })], { flags });
  }

  return null;
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

const BUILDERS = Object.freeze({
  video: videoPlan,
  longshot: longshotPlan,
  record: recordPlan,
  trace: tracePlan,
  debug: debugPlan,
});

/**
 * 构造一次调用的 dry-run plan；不支持的组合返回 null（调用方决定是否报错）。
 * context: { flags, pos, session }，其中 session 由命令模块用 withControl 计算。
 */
export function buildCommandPlan(command, sub, context = {}) {
  const builder = BUILDERS[String(command || '')];
  if (!builder) return null;
  if (!supportsDryRun(command, sub)) return null;
  return builder(String(sub || ''), context);
}

/** 构造一个只够 outputDryRun 用的 io（调用方注入真实输出函数）。 */
export function dryRunIo(context = {}) {
  const isJson = typeof context.isJson === 'function' ? context.isJson : () => false;
  const emitJson = typeof context.emitJson === 'function' ? context.emitJson : () => {};
  const print = typeof context.print === 'function' ? context.print : () => {};
  return {
    isJson,
    emitJson,
    print,
    flags: context.flags || {},
    callRpc: null,
    timeoutOf: () => 0,
  };
}

/**
 * 命令模块的统一 dry-run 分支：构造 plan → 打印 → 返回退出码。
 * 计划不存在时抛参数错误（而不是静默继续执行，避免“声称预检了却真的动了浏览器”）。
 */
export function preflight(command, sub, context, io) {
  const plan = buildCommandPlan(command, sub, context);
  if (!plan) {
    throw new ArgError('bridge ' + command + ' ' + (sub || '') + ' 暂不支持 --dry-run（没有可打印的计划）');
  }
  return outputDryRun(plan, io);
}

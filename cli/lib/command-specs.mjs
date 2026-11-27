// cli/lib/command-specs.mjs —— 目标命令的参数契约声明（单一来源）。
//
// 每个命令声明：用法、示例、风险级别、位置参数、允许的 flag、依赖/互斥关系、
// 以及少量无法用声明表达的检查（JSON steps、controller 信息、policy 组合等）。
// 本文件被三处消费：
//   1) bridge.mjs 的命令入口 —— 先校验、再执行（非法组合在参数层就退出 2）；
//   2) cli/help.mjs + `bridge help <命令>` —— 帮助与 examples 由同一份声明渲染；
//   3) 命令实现（session/tab/plan/recipe/extract/page/schema-ledger）—— dry-run 用
//      同一份风险与用法信息，避免“帮助说一套、执行做一套”。
import fs from 'node:fs';
import path from 'node:path';
import { isControllerInfo } from '../../extension/src/lib/controller-info.js';
import {
  ContractError, RISK, RISK_INFO, assertAbsent, assertAllowedFlags, assertAtLeastOne,
  assertExclusive, assertPositionals, assertRequires, checkPositional, checkValue,
  isSet, resolveSessionArg,
} from './arg-contract.mjs';

/** 所有目标命令都接受的全局参数（它们不改变命令语义）。 */
export const GLOBAL_FLAGS = Object.freeze([
  'json', 'quiet', 'verbose', 'port', 'timeout', 'help', 'dry-run',
]);

const GLOBAL_FLAG_DOCS = Object.freeze({
  json: 'stdout 只输出单行 JSON（bb.cli/1 契约）',
  quiet: '抑制人类可读输出（JSON/错误不受影响）',
  verbose: '把每次 RPC 的耗时打到 stderr',
  port: 'daemon 未运行时自动拉起的端口（默认 BB_PORT → 52900）',
  timeout: 'RPC 超时（默认 60000；支持 20s / 2m）',
  'dry-run': '只做参数/目标/风险预检，不调用 daemon、不改浏览器',
  help: '显示本命令帮助',
});

// ---------------------------------------------------------------------------
// 可复用的 flag 定义
// ---------------------------------------------------------------------------

const flag = (kind, extra = {}) => Object.freeze({ kind, ...extra });
const bool = (desc) => flag('bool', { desc });
const text = (desc) => flag('string', { desc });

const SESSION_FLAGS = Object.freeze({
  session: text('指定会话 id（只有一个会话时可省略）'),
  'session-scope': text('按 controller name/project 选择唯一会话'),
});

const CONTROL_FLAGS = Object.freeze({
  'tab-id': text('目标 tabId（支持 tab alias；会先解析成数字）'),
  context: text('观察上下文 id（observe/read 返回）'),
  observation: text('观察快照 id（本次动作的校验基线）'),
  expect: flag('json', { desc: '动作后置条件（JSON 数组）' }),
  'depends-on': flag('json', { desc: '前置观察依赖（JSON 数组）' }),
  settle: flag('duration', { desc: '动作后等待稳定的时长（300ms / 1s）' }),
  'node-scope': bool('只校验目标节点自身，页面别处变化不拦动作'),
  focus: bool('显式把窗口置前（默认后台执行）'),
  'wait-timeout': flag('duration', { desc: '动作内动态校验等待上限' }),
});

const TARGET_FLAGS = Object.freeze({
  ref: text('目标引用 @eN（observe 返回）'),
  selector: text('目标 CSS selector'),
  text: text('目标可见文本'),
  'stable-ref': text('稳定引用 stableRef（observe --stable-ref 返回）'),
});

function mergeFlags(...groups) {
  return Object.freeze(Object.assign({}, ...groups));
}

// ---------------------------------------------------------------------------
// 声明式检查（组合类）
// ---------------------------------------------------------------------------

function controlChecks(flags, context) {
  for (const name of ['expect', 'depends-on']) {
    if (!isSet(flags, name)) continue;
    let parsed;
    try {
      parsed = JSON.parse(String(flags[name]));
    } catch (error) {
      throw new ContractError('E_ARG_TYPE', '`--' + name + '` 不是合法 JSON：' + error.message, {
        hint: '用单引号包住数组，例如 --' + name + " '[{\"kind\":\"ref\",\"ref\":\"@e1\"}]'。",
        usage: context.usage,
      });
    }
    if (!Array.isArray(parsed)) {
      throw new ContractError('E_ARG_TYPE', '`--' + name + '` 需要 JSON 数组（协议要求数组）', {
        hint: '例如 --' + name + " '[{\"kind\":\"ref\",\"ref\":\"@e1\"}]'。",
        usage: context.usage,
      });
    }
  }
}

function controllerChecks(flags, context) {
  if (!isSet(flags, 'agent-name')) {
    if (isSet(flags, 'project') || isSet(flags, 'controller-color')) {
      throw new ContractError('E_ARG_REQUIRES', '`--project` / `--controller-color` 需要同时提供 `--agent-name`', {
        hint: '补上 --agent-name <名字>，或删掉 --project/--controller-color。',
        usage: context.usage,
      });
    }
    return;
  }
  const controller = { name: String(flags['agent-name']) };
  if (isSet(flags, 'project')) controller.project = String(flags.project);
  if (isSet(flags, 'controller-color')) controller.color = String(flags['controller-color']);
  if (!isControllerInfo(controller)) {
    throw new ContractError('E_ARG_TYPE', '--agent-name/--project/--controller-color 不合法', {
      hint: '名称 1-80 字符，项目 1-120 字符，颜色 #rrggbb；不要包含控制字符。',
      usage: context.usage,
    });
  }
}

function requireTargetSource(flags, pos, offset, context) {
  const positional = pos[offset];
  const sources = ['ref', 'selector', 'text', 'stable-ref'].filter((name) => isSet(flags, name));
  if (sources.length > 1) {
    throw new ContractError('E_ARG_CONFLICT', '--ref、--selector、--text、--stable-ref 只能给一个', {
      hint: '保留一个目标来源；位置参数 <ref|selector> 也可以。',
      usage: context.usage,
    });
  }
  if (positional !== undefined && positional !== '' && sources.length) {
    throw new ContractError('E_ARG_CONFLICT', '位置参数目标与 ' + sources.map((name) => '--' + name).join('/') + ' 不能同时给', {
      hint: '二选一：位置参数 <ref|selector> 或 --ref/--selector/--text/--stable-ref。',
      usage: context.usage,
    });
  }
  if ((positional === undefined || positional === '') && !sources.length) {
    throw new ContractError('E_ARG_MISSING', '缺少目标：<ref|selector> 或 --ref/--selector/--text/--stable-ref', {
      hint: '先 bridge observe 拿 @eN，再 bridge ' + context.label + ' @eN；也可以直接给 CSS selector。',
      usage: context.usage,
    });
  }
}

function sessionRequired(flags, pos, index, context) {
  const resolved = resolveSessionArg(flags, pos, index, { required: true, usage: context.usage, label: '缺少会话 id' });
  return resolved;
}

// ---------------------------------------------------------------------------
// 命令声明
// ---------------------------------------------------------------------------

function sub(name, definition) {
  return Object.freeze({ name, risk: RISK.BROWSER_MUTATION, precheck: 'cli', ...definition });
}

const SESSION_SPEC = Object.freeze({
  command: 'session',
  summary: '会话生命周期、会话内控制权与 run log',
  topic: 'session',
  notes: [
    'session start 默认后台开窗（不抢焦点），--focus 才置前；--no-focus 保留兼容。',
    '共享已有 tab 用 --tab <tabId> --share；控制权仲裁用 --control open|exclusive。',
    '所有子命令都支持 --dry-run：只打印将要发出的 RPC 与风险，不触达 daemon。',
  ],
  subs: Object.freeze({
    start: sub('start', {
      usage: 'bridge session start [--browser <id|名字|edge|chrome>] [--tab <tabId>] [--share] [--control open|exclusive] [--focus|--no-focus] [--incognito] [--request-id <token>] [--agent-name <名字>] [--project <名字>] [--controller-color #rrggbb] [--scope <名字>] [--allow-domains a,b] [--deny-domains x,y] [--min-interval 300ms] [--dry-run]',
      summary: '新建 Agent 会话（默认后台，不抢用户焦点）',
      examples: [
        'bridge session start',
        'bridge session start --browser edge',
        'bridge session start --browser "工作账号" --incognito',
        'bridge session start --tab 123 --share --control exclusive',
        'bridge open https://example.com --observe',
      ],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({
        focus: bool('显式置前（默认后台）'),
        'no-focus': bool('保留兼容：显式要求不置前（默认即如此）'),
        incognito: bool('无痕窗口'),
        browser: text('目标浏览器实例 id / 名字 / edge|chrome'),
        scope: text('会话 scope（多 agent 隔离）'),
        'agent-name': flag('name', { desc: 'controller 显示名（1-80 字符）' }),
        project: flag('name', { desc: 'controller 项目名（1-120 字符）' }),
        'controller-color': flag('color', { desc: 'controller 颜色 #rrggbb' }),
        tab: flag('tab-id', { min: 1, desc: '共享已有 tab（需配合 --share）' }),
        share: bool('共享 --tab 指定的已有标签页'),
        control: flag('enum', { values: ['open', 'exclusive'], desc: '共享控制模式' }),
        'request-id': text('可恢复启动 token（<expiry-ms>:<id>）'),
        'allow-domains': text('允许的域（逗号分隔）'),
        'deny-domains': text('拒绝的域（逗号分隔）'),
        'min-interval': flag('duration', { desc: '会话内动作最小间隔（上限 5000ms）' }),
      }),
      requires: [
        { flag: 'share', requires: ['tab'], hint: '共享已有标签页需要 --tab <tabId>。' },
      ],
      exclusive: [
        { flags: ['focus', 'no-focus'], hint: '--focus 与 --no-focus 互斥。' },
      ],
      checks: [controllerChecks],
    }),
    prepare: sub('prepare', {
      usage: 'bridge session prepare --request-id <token> [--browser <id>] [--incognito] [--no-focus]',
      summary: '预登记一次可恢复启动（发通知/预热，尚未创建会话）',
      examples: ['bridge session prepare --request-id 1760000000000:abc12345', 'bridge session prepare --request-id <token> --browser edge'],
      risk: RISK.DAEMON_STATE,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({
        'request-id': text('启动 token（<expiry-ms>:<id>，10 分钟内有效）'),
        browser: text('目标浏览器实例'),
        incognito: bool('无痕窗口'),
        'no-focus': bool('不置前（默认后台）'),
      }),
      requires: [],
      checks: [(flags, pos, context) => {
        if (!isSet(flags, 'request-id')) {
          throw new ContractError('E_ARG_MISSING', 'session ' + context.sub + ' 需要 --request-id <token>', {
            hint: '用法：' + context.usage,
            usage: context.usage,
          });
        }
      }],
    }),
    claim: sub('claim', {
      usage: 'bridge session claim --request-id <token>',
      summary: '认领已 ready 的启动请求（返回 sessionId）',
      examples: ['bridge session claim --request-id 1760000000000:abc12345'],
      risk: RISK.DAEMON_STATE,
      positionals: { min: 0, max: 0 },
      flags: { 'request-id': text('启动 token') },
      checks: [(flags, pos, context) => {
        if (!isSet(flags, 'request-id')) {
          throw new ContractError('E_ARG_MISSING', 'session claim 需要 --request-id <token>', { hint: '用法：' + context.usage, usage: context.usage });
        }
      }],
    }),
    cancel: sub('cancel', {
      usage: 'bridge session cancel --request-id <token>',
      summary: '取消启动请求（留下墓碑，token 不可再启动）',
      examples: ['bridge session cancel --request-id 1760000000000:abc12345'],
      risk: RISK.DAEMON_STATE,
      positionals: { min: 0, max: 0 },
      flags: { 'request-id': text('启动 token') },
      checks: [(flags, pos, context) => {
        if (!isSet(flags, 'request-id')) {
          throw new ContractError('E_ARG_MISSING', 'session cancel 需要 --request-id <token>', { hint: '用法：' + context.usage, usage: context.usage });
        }
      }],
    }),
    request: sub('request', {
      usage: 'bridge session request --request-id <token>',
      summary: '查看启动请求状态（prepared/ready/claimed/cancelled）',
      examples: ['bridge session request --request-id 1760000000000:abc12345'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 0 },
      flags: { 'request-id': text('启动 token') },
      checks: [(flags, pos, context) => {
        if (!isSet(flags, 'request-id')) {
          throw new ContractError('E_ARG_MISSING', 'session request 需要 --request-id <token>', { hint: '用法：' + context.usage, usage: context.usage });
        }
      }],
    }),
    stop: sub('stop', {
      usage: 'bridge session stop <sessionId> [--keep] | bridge session stop --all [--keep]',
      summary: '停止一个会话或全部会话（默认关闭它开的窗口）',
      examples: [
        'bridge session stop a1b2',
        'bridge session stop a1b2 --keep',
        'bridge session stop --all',
        'bridge session stop --all --dry-run',
      ],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 0, max: 1, labels: ['<sessionId>'] },
      positionalKinds: [{ index: 0, kind: 'session-id', label: '<sessionId>' }],
      flags: mergeFlags({
        all: bool('停止所有会话'),
        keep: bool('保留窗口/标签页'),
        ...SESSION_FLAGS,
      }),
      checks: [(flags, pos, context) => {
        if (isSet(flags, 'all')) {
          assertAbsent(flags, ['session', 'session-scope'], {
            usage: context.usage,
            hint: '--all 与指定会话互斥：bridge session stop --all。',
          });
          if (pos[2] !== undefined) {
            throw new ContractError('E_ARG_CONFLICT', '--all 不能再指定 <sessionId>', {
              hint: '去掉位置参数，或去掉 --all 只停一个会话。', usage: context.usage,
            });
          }
          return;
        }
        resolveSessionArg(flags, pos, 2, { required: true, usage: context.usage, label: '缺少要停止的会话' });
      }],
    }),
    'run-log': sub('run-log', {
      aliases: ['run_log'],
      usage: 'bridge session run-log <sessionId> [--limit N]',
      summary: '会话步骤日志（只含目标描述，不含输入值；recipe draft 的来源）',
      examples: ['bridge session run-log a1b2', 'bridge session run-log a1b2 --limit 50 --json'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 1, labels: ['<sessionId>'] },
      positionalKinds: [{ index: 0, kind: 'session-id', label: '<sessionId>' }],
      flags: mergeFlags({ limit: flag('int', { min: 1, desc: '最多返回多少步' }), ...SESSION_FLAGS }),
      checks: [(flags, pos, context) => sessionRequired(flags, pos, 2, context)],
    }),
    pause: sub('pause', {
      usage: 'bridge session pause <sessionId> [--reason <文本>]',
      summary: '暂停会话（自动暂停 vs 人工暂停在 run log 里可区分）',
      examples: ['bridge session pause a1b2', 'bridge session pause a1b2 --reason "等待用户登录"'],
      risk: RISK.DAEMON_STATE,
      positionals: { min: 0, max: 1, labels: ['<sessionId>'] },
      positionalKinds: [{ index: 0, kind: 'session-id', label: '<sessionId>' }],
      flags: mergeFlags({ reason: text('暂停原因（人类可读）'), ...SESSION_FLAGS }),
      checks: [(flags, pos, context) => sessionRequired(flags, pos, 2, context)],
    }),
    resume: sub('resume', {
      usage: 'bridge session resume <sessionId> [--auto]',
      summary: '恢复会话（--auto 只恢复自动暂停）',
      examples: ['bridge session resume a1b2', 'bridge session resume a1b2 --auto'],
      risk: RISK.DAEMON_STATE,
      positionals: { min: 0, max: 1, labels: ['<sessionId>'] },
      positionalKinds: [{ index: 0, kind: 'session-id', label: '<sessionId>' }],
      flags: mergeFlags({ auto: bool('只对自动暂停生效'), ...SESSION_FLAGS }),
      checks: [(flags, pos, context) => sessionRequired(flags, pos, 2, context)],
    }),
    rebind: sub('rebind', {
      usage: 'bridge session rebind <sessionId> --tab <tabId> [--release-old]',
      summary: '把会话重绑到另一个标签页',
      examples: ['bridge session rebind a1b2 --tab 123', 'bridge session rebind --tab 123 --session a1b2 --release-old'],
      risk: RISK.DAEMON_STATE,
      positionals: { min: 0, max: 1, labels: ['<sessionId>'] },
      positionalKinds: [{ index: 0, kind: 'session-id', label: '<sessionId>' }],
      flags: mergeFlags({ tab: flag('tab-id', { min: 1, desc: '目标 tabId' }), 'release-old': bool('释放旧 tab 的占用'), ...SESSION_FLAGS }),
      checks: [(flags, pos, context) => {
        sessionRequired(flags, pos, 2, context);
        if (!isSet(flags, 'tab')) {
          throw new ContractError('E_ARG_MISSING', 'session rebind 需要 --tab <tabId>', { hint: '用法：' + context.usage, usage: context.usage });
        }
      }],
    }),
    list: sub('list', {
      usage: 'bridge session list [--json]',
      summary: '列出活动会话（含共享 tab 的控制权状态）',
      examples: ['bridge session list', 'bridge session list --json'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 0 },
      flags: {},
    }),
    control: sub('control', {
      usage: 'bridge session control <sessionId> [--mode open|exclusive]',
      summary: '查看/切换共享 tab 的控制权与租约',
      examples: ['bridge session control a1b2', 'bridge session control a1b2 --mode exclusive'],
      risk: RISK.DAEMON_STATE,
      positionals: { min: 0, max: 1, labels: ['<sessionId>'] },
      positionalKinds: [{ index: 0, kind: 'session-id', label: '<sessionId>' }],
      flags: mergeFlags({
        mode: flag('enum', { values: ['open', 'exclusive'], desc: '控制权仲裁模式' }),
        ...SESSION_FLAGS,
      }),
      checks: [(flags, pos, context) => sessionRequired(flags, pos, 2, context)],
    }),
    'claim-control': sub('claim-control', {
      usage: 'bridge session claim-control <sessionId> [--lease 60s] [--expect-epoch N]',
      summary: '认领/续租控制权（主会话可收回）',
      examples: ['bridge session claim-control a1b2', 'bridge session claim-control a1b2 --lease 30s --expect-epoch 3'],
      risk: RISK.DAEMON_STATE,
      positionals: { min: 0, max: 1, labels: ['<sessionId>'] },
      positionalKinds: [{ index: 0, kind: 'session-id', label: '<sessionId>' }],
      flags: mergeFlags({
        lease: flag('duration', { desc: '租约时长（默认 60s）' }),
        'expect-epoch': flag('int', { min: 0, desc: '期望的控制权 epoch（乐观锁）' }),
        ...SESSION_FLAGS,
      }),
      checks: [(flags, pos, context) => sessionRequired(flags, pos, 2, context)],
    }),
    'release-control': sub('release-control', {
      usage: 'bridge session release-control <sessionId> [--expect-epoch N]',
      summary: '主动放弃控制权',
      examples: ['bridge session release-control a1b2'],
      risk: RISK.DAEMON_STATE,
      positionals: { min: 0, max: 1, labels: ['<sessionId>'] },
      positionalKinds: [{ index: 0, kind: 'session-id', label: '<sessionId>' }],
      flags: mergeFlags({
        'expect-epoch': flag('int', { min: 0, desc: '期望的控制权 epoch' }),
        ...SESSION_FLAGS,
      }),
      checks: [(flags, pos, context) => {
        sessionRequired(flags, pos, 2, context);
        assertAbsent(flags, ['lease', 'to'], {
          usage: context.usage,
          hint: '释放控制权不需要 --lease/--to；认领才需要 --lease，转交用 session handoff。',
        });
      }],
    }),
    handoff: sub('handoff', {
      usage: 'bridge session handoff <sessionId> --to <targetSessionId> [--lease 60s] [--expect-epoch N]',
      summary: '把控制权显式转交给同一 tab 上的另一个会话',
      examples: ['bridge session handoff a1b2 --to c3d4', 'bridge session handoff a1b2 --to c3d4 --lease 2m'],
      risk: RISK.DAEMON_STATE,
      positionals: { min: 0, max: 2, labels: ['<sessionId>', '[targetSessionId]'] },
      positionalKinds: [{ index: 0, kind: 'session-id', label: '<sessionId>' }],
      flags: mergeFlags({
        to: flag('session-id', { desc: '接收控制权的会话 id' }),
        lease: flag('duration', { desc: '新持有者的租约' }),
        'expect-epoch': flag('int', { min: 0, desc: '期望的控制权 epoch' }),
        ...SESSION_FLAGS,
      }),
      checks: [(flags, pos, context) => {
        const resolved = sessionRequired(flags, pos, 2, context);
        if (!isSet(flags, 'to') && pos[3] === undefined) {
          throw new ContractError('E_ARG_MISSING', 'session handoff 需要 --to <targetSessionId>', {
            hint: '用法：bridge session handoff a1b2 --to c3d4。', usage: context.usage,
          });
        }
        if (resolved && resolved.value && String(flags.to || pos[3]) === resolved.value) {
          throw new ContractError('E_ARG_CONFLICT', 'handoff 的来源与目标会话相同', {
            hint: '--to 必须是同一 tab 上的另一个会话（bridge session list 可查）。', usage: context.usage,
          });
        }
      }],
    }),
  }),
  order: ['start', 'prepare', 'claim', 'cancel', 'request', 'stop', 'run-log', 'pause', 'resume', 'rebind', 'list', 'control', 'claim-control', 'release-control', 'handoff'],
});

const TAB_SPEC = Object.freeze({
  command: 'tab',
  summary: '标签页列表、创建、关闭、移动、别名与借用',
  topic: 'tab',
  notes: [
    'tab close/select/move/borrow/return/new 都会改变浏览器状态，支持 --dry-run 预检。',
    'tab cleanup 的 dry-run 由 daemon 计算（需要真实 tab 列表），不经过 CLI 预检。',
    'tabId 支持 tab alias 设置的别名。',
  ],
  subs: Object.freeze({
    list: sub('list', {
      usage: 'bridge tab list [--scope agent|user|all] [--json]',
      summary: '列出标签页',
      examples: ['bridge tab list', 'bridge tab list --scope all', 'bridge tab list --json'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 0 },
      flags: {
        scope: flag('enum', { values: ['agent', 'user', 'all'], desc: '列表范围（默认 agent）' }),
        browser: text('兼容参数：按浏览器实例过滤（daemon 未实现时忽略）'),
        ...SESSION_FLAGS,
      },
    }),
    new: sub('new', {
      usage: 'bridge tab new [url] [--focus] [--window] [--read-only] [--allow-origins a,b] [--keep-open] [--group <名字>] [--alias <名字>]',
      summary: '新建标签页（默认不激活、后台打开）',
      examples: [
        'bridge tab new https://example.com/',
        'bridge tab new about:blank --window',
        'bridge tab new https://example.com/ --read-only --alias docs',
      ],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 0, max: 1, labels: ['[url]'] },
      positionalKinds: [{ index: 0, kind: 'url', label: '[url]' }],
      flags: mergeFlags({
        focus: bool('新建后激活该 tab'),
        window: bool('在新窗口打开'),
        'read-only': bool('只读 tab（禁止动作）'),
        'allow-origins': text('允许的源（逗号分隔）'),
        'keep-open': bool('会话结束后保留 tab'),
        group: text('标签组名'),
        alias: flag('alias', { desc: '创建后设置别名' }),
        ...SESSION_FLAGS,
      }),
    }),
    close: sub('close', {
      usage: 'bridge tab close <tabId>',
      summary: '关闭标签页',
      examples: ['bridge tab close 123', 'bridge tab close 123 --dry-run'],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 1, max: 1, labels: ['<tabId>'] },
      positionalKinds: [{ index: 0, kind: 'tab-id', label: '<tabId>' }],
      flags: { ...SESSION_FLAGS },
    }),
    select: sub('select', {
      usage: 'bridge tab select <tabId>',
      summary: '激活标签页（置前该 tab）',
      examples: ['bridge tab select 123', 'bridge tab select 123 --dry-run'],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 1, max: 1, labels: ['<tabId>'] },
      positionalKinds: [{ index: 0, kind: 'tab-id', label: '<tabId>' }],
      flags: { ...SESSION_FLAGS },
    }),
    move: sub('move', {
      usage: 'bridge tab move <tabId> --to-window <windowId>',
      summary: '把标签页移动到另一个窗口',
      examples: ['bridge tab move 123 --to-window 456', 'bridge tab move 123 --to-window 456 --dry-run'],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 1, max: 1, labels: ['<tabId>'] },
      positionalKinds: [{ index: 0, kind: 'tab-id', label: '<tabId>' }],
      flags: {
        'to-window': flag('int', { min: 1, desc: '目标 windowId' }),
        ...SESSION_FLAGS,
      },
      checks: [(flags, pos, context) => {
        if (!isSet(flags, 'to-window')) {
          throw new ContractError('E_ARG_MISSING', 'tab move 需要 --to-window <windowId>', {
            hint: '窗口 id 来自 bridge tab list / session start 的 windowId。', usage: context.usage,
          });
        }
      }],
    }),
    borrow: sub('borrow', {
      usage: 'bridge tab borrow <tabId> [--confirmation-timeout 60s]',
      summary: '借用一个用户标签页（可能弹确认闸门，可显式指定确认超时）',
      examples: ['bridge tab borrow 123', 'bridge tab borrow 123 --confirmation-timeout 30s'],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 1, max: 1, labels: ['<tabId>'] },
      positionalKinds: [{ index: 0, kind: 'tab-id', label: '<tabId>' }],
      flags: mergeFlags({
        // 兼容目标 BorrowConfirmationTimeout：显式 confirmation_timeout_ms 需要 1.9 扩展理解，
        // 旧扩展会静默忽略 —— 由协议特性门 borrow_confirmation_timeout 在派发前拒绝。
        'confirmation-timeout': flag('duration', { desc: '借用确认超时（默认扩展本地 60s）' }),
        ...SESSION_FLAGS,
      }),
    }),
    return: sub('return', {
      usage: 'bridge tab return <tabId>',
      summary: '归还借用的用户标签页（保持打开）',
      examples: ['bridge tab return 123'],
      risk: RISK.DAEMON_STATE,
      positionals: { min: 1, max: 1, labels: ['<tabId>'] },
      positionalKinds: [{ index: 0, kind: 'tab-id', label: '<tabId>' }],
      flags: { ...SESSION_FLAGS },
    }),
    cleanup: sub('cleanup', {
      usage: 'bridge tab cleanup [--idle-ms 10m] [--dry-run] [--yes]',
      summary: '清理空闲的 Agent 标签页（默认 dry-run，--yes 才真关）',
      examples: ['bridge tab cleanup', 'bridge tab cleanup --yes', 'bridge tab cleanup --idle-ms 30m --dry-run'],
      risk: RISK.BROWSER_MUTATION,
      precheck: 'daemon',
      positionals: { min: 0, max: 0 },
      flags: {
        'idle-ms': flag('duration', { desc: '空闲阈值（默认 10m）' }),
        yes: bool('真正关闭（不带 --yes 时等价 --dry-run）'),
        ...SESSION_FLAGS,
      },
    }),
    alias: sub('alias', {
      usage: 'bridge tab alias <tabId> <alias> | bridge tab alias <tabId> --clear <alias>',
      summary: '给标签页设置/清除别名',
      examples: ['bridge tab alias 123 checkout', 'bridge tab alias 123 --clear checkout'],
      risk: RISK.DAEMON_STATE,
      positionals: { min: 2, max: 2, labels: ['<tabId>', '<alias>'] },
      positionalKinds: [
        { index: 0, kind: 'tab-id', label: '<tabId>' },
        { index: 1, kind: 'alias', label: '<alias>' },
      ],
      flags: mergeFlags({ clear: bool('清除该别名'), ...SESSION_FLAGS }),
      extraHint: '别名 <alias> 不能省略（--clear 也需要指定要清除的别名）。',
    }),
    aliases: sub('aliases', {
      usage: 'bridge tab aliases',
      summary: '列出标签页别名',
      examples: ['bridge tab aliases'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 0 },
      flags: { ...SESSION_FLAGS },
    }),
    policy: sub('policy', {
      usage: 'bridge tab policy <tabId> [--read-only] [--keep-open] [--allow-origins a,b] [--clear]',
      summary: '设置标签页动作策略',
      examples: [
        'bridge tab policy 123 --read-only',
        'bridge tab policy 123 --allow-origins https://example.com',
        'bridge tab policy 123 --clear',
      ],
      risk: RISK.DAEMON_STATE,
      positionals: { min: 1, max: 1, labels: ['<tabId>'] },
      positionalKinds: [{ index: 0, kind: 'tab-id', label: '<tabId>' }],
      flags: mergeFlags({
        'read-only': bool('只读（拒绝动作）'),
        'keep-open': bool('会话结束后保留'),
        'allow-origins': text('允许的源（逗号分隔）'),
        clear: bool('清除策略'),
        ...SESSION_FLAGS,
      }),
      checks: [(flags, pos, context) => {
        if (!['read-only', 'keep-open', 'allow-origins', 'clear'].some((name) => isSet(flags, name))) {
          throw new ContractError('E_ARG_MISSING', 'tab policy 至少需要 --read-only / --keep-open / --allow-origins / --clear 之一', {
            hint: '只查策略请用 bridge tab list --json（control 字段）；设置策略至少给一个开关。',
            usage: context.usage,
          });
        }
      }],
    }),
  }),
  order: ['list', 'new', 'close', 'select', 'move', 'borrow', 'return', 'cleanup', 'alias', 'aliases', 'policy'],
});


const REPLAY_SPEC = Object.freeze({
  command: 'replay',
  summary: '回放 Trace v3（record export 产物）',
  order: ['default'],
  topic: 'replay',
  notes: [
    'trace.json 来自 record stop / record export（version=3，steps 数组）。',
    '只回放 action/observe/wait 步骤；human-gate/branch 会跳过并在 dry-run 中列出原因。',
    '记录时的 @ref 可能已过期：dry-run 会提示回放前确认目标。',
  ],
  subs: Object.freeze({
    default: sub('default', {
      usage: 'bridge replay <trace.json> [--dry-run] [--until-visible <selector>] [--wait-timeout-ms N] [--save-full <path>]',
      summary: '回放 trace 中的步骤',
      examples: [
        'bridge replay trace/trace.json --dry-run',
        'bridge replay trace/trace.json --until-visible "#result"',
      ],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 1, max: 1, labels: ['<trace.json>'] },
      positionalKinds: [{ index: 0, kind: 'path', label: '<trace.json>' }],
      flags: mergeFlags({
        'until-visible': text('回放后等待出现的目标 selector'),
        'wait-timeout-ms': flag('int', { min: 1, max: 25000, desc: 'until-visible 等待上限（默认 5000）' }),
        'save-full': flag('path', { desc: '回放后把完整观察落盘' }),
        ...SESSION_FLAGS,
        ...CONTROL_FLAGS,
      }),
    }),
  }),
});

const CONTRACT_JSON = flag('json', { desc: 'JSON（steps 数组）' });

const PLAN_SPEC = Object.freeze({
  command: 'plan',
  summary: '把多个动作合并成一次 RPC（带观察与 after 校验）',
  topic: 'plan',
  notes: [
    'plan 的步骤用协议方法名：click/fill/press/navigate/...（见 bridge schema）。',
    '--steps 与 --steps-file 二选一；步骤必须是非空 JSON 数组。',
    'dry-run 会逐条标注哪些步骤会改变浏览器（browser_mutation）。',
  ],
  subs: Object.freeze({
    default: sub('default', {
      usage: 'bridge plan --steps \'[{"method":"click","params":{"ref":"@e1"}}]\' | --steps-file <json> [--until-visible <selector>] [--wait-timeout-ms N] [--save-full <path>]',
      summary: '执行多步动作计划',
      examples: [
        'bridge plan --steps \'[{"method":"fill","params":{"selector":"#kw","value":"x"}},{"method":"click","params":{"selector":"#go"}}]\'',
        'bridge plan --steps-file plan.json --until-visible "#result" --wait-timeout-ms 3000',
        'bridge plan --steps-file plan.json --dry-run',
      ],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({
        steps: CONTRACT_JSON,
        'steps-file': flag('path', { desc: '步骤 JSON 文件' }),
        'until-visible': text('执行后等待出现的目标 selector'),
        'wait-timeout-ms': flag('int', { min: 1, max: 25000, desc: 'until-visible 等待上限（默认 5000）' }),
        'save-full': flag('path', { desc: '把执行后的完整观察落盘' }),
        ...SESSION_FLAGS,
        ...CONTROL_FLAGS,
      }),
      checks: [(flags, pos, context) => {
        if (isSet(flags, 'steps') === isSet(flags, 'steps-file')) {
          throw new ContractError('E_ARG_REQUIRES', 'plan 需要 --steps 或 --steps-file（且只能给一个）', {
            hint: '内联：bridge plan --steps \'[{"method":"click","params":{"selector":"#a"}}]\'；或写成文件用 --steps-file plan.json。',
            usage: context.usage,
          });
        }
      }],
    }),
    step: sub('step', {
      usage: 'bridge step <method> [<ref|selector>] [--value v] [--key k] [--url u] [--until-visible <selector>] [--save-full <path>] | bridge step --action <method> --params <json>',
      summary: '执行单个协议动作（等价 plan 的单步）',
      examples: [
        'bridge step focus --selector "#kw"',
        'bridge step click --ref @e2',
        'bridge step navigate --url https://example.com/',
        'bridge step click --ref @e2 --until-visible "#result"',
      ],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 0, max: 2, labels: ['[method]', '[ref|selector]'] },
      positionalKinds: [
        { index: 0, kind: 'string', label: '[method]' },
        { index: 1, kind: 'string', label: '[ref|selector]' },
      ],
      flags: mergeFlags({
        ...TARGET_FLAGS,
      action: text('协议动作方法名（与 <method> 二选一）'),
      method: text('同 --action（别名）'),
      params: text('动作参数 JSON（与显式参数合并，显式参数优先）'),
        value: text('fill/select 的值'),
        key: text('press 的按键'),
        url: flag('url', { schemes: ['http:', 'https:', 'about:', 'file:'], desc: 'navigate 的目标 URL' }),
        'until-visible': text('执行后等待出现的目标 selector'),
        'wait-timeout-ms': flag('int', { min: 1, max: 25000, desc: 'until-visible 等待上限' }),
        'save-full': flag('path', { desc: '把执行后的完整观察落盘' }),
        ...SESSION_FLAGS,
        ...CONTROL_FLAGS,
      }),
      checks: [(flags, pos, context) => {
        const method = String((flags.action !== undefined ? flags.action : (flags.method !== undefined ? flags.method : pos[1])) || '').trim();
        if (!method) {
          throw new ContractError('E_ARG_MISSING', 'step 需要 <method> 或 --action', { hint: '用法：' + context.usage, usage: context.usage });
        }
        if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(method)) {
          throw new ContractError('E_ARG_TYPE', '步骤方法名不合法：' + method, {
            hint: '方法名来自协议 catalog：bridge schema | findstr ' + method.slice(0, 8), usage: context.usage,
          });
        }
      }],
    }),
    view: sub('view', {
      usage: 'bridge view [--grep <文本>] [--offset N] [--limit N] | bridge view <file> [--find <文本>] [--start-line N] [--line-count N]',
      summary: '查看观察缓存（或本地观察文件）',
      examples: [
        'bridge view',
        'bridge view --grep 提交 --limit 5',
        'bridge view notes/observation.txt --find 提交 --start-line 1 --line-count 40',
      ],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 1, labels: ['[file]'] },
      positionalKinds: [{ index: 0, kind: 'optional-string', label: '[file]' }],
      flags: mergeFlags({
        grep: text('按子串过滤（观察缓存模式）'),
        offset: flag('int', { min: 0, desc: '从第几行开始（观察缓存模式）' }),
        limit: flag('int', { min: 1, desc: '最多返回多少行' }),
        find: text('按子串过滤（文件模式，带上下文）'),
        'start-line': flag('int', { min: 1, desc: '起始行号（文件模式）' }),
        'line-count': flag('int', { min: 1, desc: '最多返回行数（文件模式）' }),
        ...SESSION_FLAGS,
        ...CONTROL_FLAGS,
      }),
      checks: [(flags, pos, context) => {
        const fileMode = pos[1] !== undefined && pos[1] !== '';
        if (fileMode) {
          assertAbsent(flags, ['grep', 'offset', 'limit'], {
            usage: context.usage,
            hint: '文件模式用 --find/--start-line/--line-count；--grep/--offset/--limit 用于观察缓存模式。',
          });
        } else {
          assertAbsent(flags, ['find', 'start-line', 'line-count'], {
            usage: context.usage,
            hint: '--find/--start-line/--line-count 需要文件参数：bridge view <file> --find <文本>。',
          });
        }
      }],
    }),
  }),
  order: ['default', 'step', 'view'],
});

// plan / step / view 共享同一组子命令定义（help plan 会一次列出三者），
// 但 bridge step / bridge view 是独立的顶层命令，需要各自的 spec 入口做参数校验。
const STEP_SPEC = Object.freeze({
  command: 'step',
  summary: '执行单个协议动作（等价 plan 的单步）',
  topic: 'step',
  subs: Object.freeze({ default: PLAN_SPEC.subs.step }),
  order: ['default'],
  notes: ['step 是单动作版本：参数与 plan 中一步一致；风险按方法在协议 catalog 里的 effect 推导。'],
});

const VIEW_SPEC = Object.freeze({
  command: 'view',
  summary: '查看观察缓存（或本地观察文件）',
  topic: 'view',
  subs: Object.freeze({ default: PLAN_SPEC.subs.view }),
  order: ['default'],
  notes: ['view 是只读命令；文件模式带 --find 时自动带上下文行。'],
});

const RECIPE_SPEC = Object.freeze({
  command: 'recipe',
  summary: '回放配方：列表/查看/保存/草拟/审批/执行/删除',
  topic: 'recipe',
  notes: [
    'recipe save 保存的是草稿；含 click/fill 等风险步骤必须先 recipe approve --confirm-human 才能 run。',
    'recipe run 默认只回放只读/可逆步骤；审批绑定内容，步骤被篡改后会拒绝执行。',
    'dry-run 只读本地存储，不触达 daemon（仍会检查审批/内容指纹）。',
  ],
  subs: Object.freeze({
    list: sub('list', {
      usage: 'bridge recipe list',
      summary: '列出本地 recipe（含步骤数与文件路径）',
      examples: ['bridge recipe list', 'bridge recipe list --json'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 0 },
      flags: {},
    }),
    show: sub('show', {
      usage: 'bridge recipe show <name>',
      summary: '打印一个 recipe 的完整 JSON',
      examples: ['bridge recipe show checkout'],
      risk: RISK.READ_ONLY,
      positionals: { min: 1, max: 1, labels: ['<name>'] },
      positionalKinds: [{ index: 0, kind: 'string', label: '<name>' }],
      flags: {},
    }),
    save: sub('save', {
      usage: 'bridge recipe save <name> --file <recipe.json>',
      summary: '保存 recipe 草稿（需人工审批后才能执行）',
      examples: ['bridge recipe save checkout --file recipe.json', 'bridge recipe save checkout --file recipe.json --dry-run'],
      risk: RISK.LOCAL_WRITE,
      positionals: { min: 1, max: 1, labels: ['<name>'] },
      positionalKinds: [{ index: 0, kind: 'string', label: '<name>' }],
      flags: { file: flag('path', { desc: 'recipe JSON 文件' }) },
      checks: [(flags, pos, context) => {
        if (!isSet(flags, 'file')) {
          throw new ContractError('E_ARG_MISSING', 'recipe save 需要 --file <json>', {
            hint: '例如 bridge recipe save checkout --file recipe.json。', usage: context.usage,
          });
        }
      }],
    }),
    rm: sub('rm', {
      usage: 'bridge recipe rm <name>',
      summary: '删除一个 recipe 文件',
      examples: ['bridge recipe rm checkout', 'bridge recipe rm checkout --dry-run'],
      risk: RISK.LOCAL_WRITE,
      positionals: { min: 1, max: 1, labels: ['<name>'] },
      positionalKinds: [{ index: 0, kind: 'string', label: '<name>' }],
      flags: {},
    }),
    draft: sub('draft', {
      usage: 'bridge recipe draft --name <name> --session <id> [--limit N] [--max-steps N]',
      summary: '从会话 run log 草拟 recipe（值/参数不记录）',
      examples: [
        'bridge recipe draft --name checkout --session a1b2',
        'bridge recipe draft --name checkout --session a1b2 --limit 50 --max-steps 20 --dry-run',
      ],
      risk: RISK.LOCAL_WRITE,
      positionals: { min: 0, max: 1, labels: ['[name]'] },
      positionalKinds: [{ index: 0, kind: 'optional-string', label: '[name]' }],
      flags: mergeFlags({
        name: flag('name', { desc: 'recipe 名字' }),
        limit: flag('int', { min: 1, desc: 'run log 最多读取步数' }),
        'max-steps': flag('int', { min: 1, desc: '草稿最多生成步数' }),
        ...SESSION_FLAGS,
      }),
      checks: [(flags, pos, context) => {
        const name = isSet(flags, 'name') ? String(flags.name) : (pos[2] || '');
        if (!name) {
          throw new ContractError('E_ARG_MISSING', 'recipe draft 需要 --name <name>', {
            hint: '用法：' + context.usage, usage: context.usage,
          });
        }
        sessionRequired(flags, pos, 99, { usage: context.usage, label: 'recipe draft 需要 --session <id>', sub: 'draft' });
      }],
    }),
    approve: sub('approve', {
      usage: 'bridge recipe approve <name> --confirm-human [--by <名字>]',
      summary: '人工审批 recipe（绑定内容指纹与过期时间）',
      examples: ['bridge recipe approve checkout --confirm-human', 'bridge recipe approve checkout --confirm-human --by alice'],
      risk: RISK.HUMAN_GATE,
      positionals: { min: 1, max: 1, labels: ['<name>'] },
      positionalKinds: [{ index: 0, kind: 'string', label: '<name>' }],
      flags: { 'confirm-human': bool('声明这是人工审批（必需）'), by: flag('name', { desc: '审批人名字' }) },
      checks: [(flags, pos, context) => {
        if (!isSet(flags, 'confirm-human')) {
          throw new ContractError('E_HUMAN_GATE', 'recipe approve 只能由人类执行：请加 --confirm-human', {
            hint: '先 bridge recipe show <name> 人工看过步骤，再 bridge recipe approve <name> --confirm-human。',
            usage: context.usage,
          });
        }
      }],
    }),
    run: sub('run', {
      usage: 'bridge recipe run <name> [--param k=v ...] [--session <id>]',
      summary: '回放 recipe（需已审批；支持 if/human/loop 块）',
      examples: [
        'bridge recipe run checkout',
        'bridge recipe run checkout --param city=上海 --param size=L',
        'bridge recipe run checkout --dry-run',
      ],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 1, max: 1, labels: ['<name>'] },
      positionalKinds: [{ index: 0, kind: 'string', label: '<name>' }],
      flags: mergeFlags({
        param: flag('key-value', { repeatable: true, desc: '参数 k=v（可重复）' }),
        ...SESSION_FLAGS,
        ...CONTROL_FLAGS,
      }),
    }),
  }),
  order: ['list', 'show', 'save', 'draft', 'approve', 'run', 'rm'],
});

const OPEN_SPEC = Object.freeze({
  command: 'open',
  summary: '一步式：新建会话（可选直接导航/观察）',
  topic: 'open',
  notes: [
    'open 等价 session start + navigate；--observe 会在导航后再返回一次观察。',
    'dry-run 会展示两步请求：session.start 与 navigate。',
  ],
  subs: Object.freeze({
    default: sub('default', {
      usage: 'bridge open [url] [--observe] [--wait-for <文本>] [--wait-not <文本>] [--timeout-ms N] [--wait-until load|domcontentloaded|commit] [--reuse-window] [--browser <id|名字>] [--focus] [--incognito] [--scope <名字>] [--agent-name <名字>] [--max-tokens N]',
      summary: '新建会话并可一键导航/观察（可选等待 VOM 出现/消失指定文本）',
      examples: [
        'bridge open https://example.com/',
        'bridge open https://example.com/ --observe',
        'bridge open https://example.com/ --wait-for "登录成功" --timeout-ms 8000',
        'bridge open https://example.com/ --wait-not "加载中"',
        'bridge open https://example.com/ --browser "工作账号" --observe --max-tokens 4000',
        'bridge open https://example.com/ --dry-run',
      ],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 0, max: 1, labels: ['[url]'] },
      positionalKinds: [{ index: 0, kind: 'url', label: '[url]' }],
      flags: mergeFlags({
        observe: bool('导航后同时返回 observe 结果'),
        focus: bool('显式置前（默认后台）'),
        incognito: bool('无痕窗口'),
        browser: text('目标浏览器实例'),
        scope: text('会话 scope'),
        'agent-name': flag('name', { desc: 'controller 显示名' }),
        project: flag('name', { desc: 'controller 项目名' }),
        'controller-color': flag('color', { desc: 'controller 颜色 #rrggbb' }),
        'max-tokens': flag('int', { min: 1, desc: 'observe 的 token 预算（需 --observe）' }),
        // 兼容目标 0.5.0 对齐：对渲染后的 VOM 做有界轮询（真实 observe），默认 5000ms。
        'wait-for': text('等待渲染后的 VOM 包含该文本（有界轮询）'),
        'wait-not': text('等待渲染后的 VOM 不再包含该文本（有界轮询）'),
        'timeout-ms': flag('int', { min: 1, desc: '--wait-for/--wait-not 的轮询上限（默认 5000ms）' }),
        'wait-until': flag('enum', { values: ['load', 'domcontentloaded', 'commit'], desc: '导航等待阶段（默认 domcontentloaded；load 会等整页加载完）' }),
        'reuse-window': bool('复用已存在的 Agent Window（更快；默认新建）'),
        // 显式声明以便给出"open 会新建会话"的针对性错误，而不是"未知参数"。
        session: text('open 不接受 --session（它总会新建会话）'),
      }),
      requires: [
        { flag: 'observe', requires: [], hint: '' },
      ],
      checks: [(flags, pos, context) => {
        const url = pos[1];
        if (isSet(flags, 'session')) {
          throw new ContractError('E_ARG_CONFLICT', 'open 不能带 --session（它会新建会话）', {
            hint: '已有会话请直接 bridge navigate <url> --session <id>。', usage: context.usage,
          });
        }
        if (isSet(flags, 'timeout-ms') && !isSet(flags, 'wait-for') && !isSet(flags, 'wait-not')) {
          throw new ContractError('E_ARG_REQUIRES', '--timeout-ms 需要配合 --wait-for/--wait-not 使用', {
            hint: '加上 --wait-for <文本> 或 --wait-not <文本>。', usage: context.usage,
          });
        }
        if (isSet(flags, 'wait-for') || isSet(flags, 'wait-not')) {
          if (!url) {
            throw new ContractError('E_ARG_REQUIRES', '--wait-for/--wait-not 需要 URL（open 会先导航再轮询）', {
              hint: '补上 URL，例如 bridge open https://example.com/ --wait-for "就绪"。', usage: context.usage,
            });
          }
        }
        if (isSet(flags, 'observe') && !url) {
          throw new ContractError('E_ARG_REQUIRES', '--observe 需要 URL：bridge open <url> --observe', {
            hint: '补上 URL（例如 bridge open https://example.com/ --observe）。', usage: context.usage,
          });
        }
        if (isSet(flags, 'max-tokens') && !isSet(flags, 'observe') && !isSet(flags, 'wait-for') && !isSet(flags, 'wait-not')) {
          throw new ContractError('E_ARG_REQUIRES', '--max-tokens 需要 --observe 或 --wait-for/--wait-not（它只影响 open 的观察预算）', {
            hint: '加上 --observe（或等待参数），或删掉 --max-tokens。', usage: context.usage,
          });
        }
        controllerChecks(flags, context);
      }],
    }),
  }),
  order: ['default'],
});

// extract 公共 flag 在四个子命令间共享；放在这里定义一次，避免四种写法漂移。
const EXTRACT_COMMON_FLAGS = mergeFlags({
  'max-rows': flag('int', { min: 1, desc: '最多导出行数' }),
  'max-columns': flag('int', { min: 1, desc: '最多导出列数（兼容目标 对齐；超出部分由 daemon 截断并给 truncated 证据）' }),
  'max-bytes': flag('int', { min: 1, desc: '最多导出字节数' }),
  'max-cells': flag('int', { min: 1, desc: '最多导出单元格数' }),
  'max-targets': flag('int', { min: 1, desc: 'discover 最多列出的候选数' }),
  'preview-columns': flag('int', { min: 1, desc: 'discover 预览列数' }),
  format: flag('enum', { values: ['json', 'csv'], desc: '导出格式（默认 json）' }),
  out: flag('path', { desc: 'csv 输出文件（--format csv 时必需）' }),
  'csv-safe': bool('CSV 公式注入防护（=+-@ 前缀加 \'）'),
  frame: flag('int', { min: 0, desc: '目标 frameId' }),
  cursor: text('游标（上一次 extract 返回的 cursor）'),
  'expect-revision': flag('int', { min: 0, desc: '要求页面 revision 匹配（取自 observe）' }),
  target: text('discover 返回的 target id（仅 table）'),
  'item-selector': text('列表项 selector（仅 list）'),
  'fields-json': flag('json', { desc: '字段定义 JSON（仅 list）' }),
  fields: flag('path', { desc: '字段定义 JSON 文件（仅 list）' }),
  ...TARGET_FLAGS,
  ...SESSION_FLAGS,
  ...CONTROL_FLAGS,
});

const EXTRACT_SPEC = Object.freeze({
  command: 'extract',
  summary: '表格/列表导出（JSON/CSV、覆盖度、游标分页）',
  topic: 'extract',
  // 默认子命令是“直接导出”，但 pos[1] 也可能是目标（bridge extract '#people'），
  // 因此用 subOf 显式区分“已知子命令名”与“位置参数目标”。
  subOf: (pos) => (pos[1] && ['list', 'table', 'discover'].includes(String(pos[1])) ? String(pos[1]) : 'default'),
  notes: [
    '默认子命令是“直接导出”：bridge extract --selector table。',
    'extract table --target <id> 的 id 来自 extract discover。',
    '--format csv 必须配 --out；--csv-safe 只在 csv 下生效。',
    '返回值带 cursor/truncated 时，JSON 契约会给出 page.hasMore/page.cursor。',
  ],
  subs: Object.freeze({
    default: sub('default', {
      usage: 'bridge extract [<ref|selector>] [--format json|csv --out <path>] [--max-rows N] [--max-bytes N] [--max-cells N] [--cursor <token>] [--expect-revision N]',
      summary: '直接导出当前页面的表格/列表',
      examples: [
        'bridge extract',
        'bridge extract --selector table',
        'bridge extract --max-rows 100 --json',
        'bridge extract --selector table --format csv --out people.csv',
        'bridge extract --cursor x1abc --json',
      ],
      risk: RISK.READ_ONLY,
      posOffset: 1,
      positionals: { min: 0, max: 1, labels: ['[ref|selector]'] },
      positionalKinds: [{ index: 0, kind: 'optional-string', label: '[ref|selector]' }],
      flags: EXTRACT_COMMON_FLAGS,
      checks: [
        (flags, pos, context) => {
          if (isSet(flags, 'format') && String(flags.format) === 'csv' && !isSet(flags, 'out')) {
            throw new ContractError('E_ARG_REQUIRES', '--format csv 需要 --out <path>', {
              hint: '例如 bridge extract --selector table --format csv --out people.csv。', usage: context.usage,
            });
          }
          if (isSet(flags, 'out') && String(flags.format || 'json') !== 'csv') {
            throw new ContractError('E_ARG_CONFLICT', '--out 只在 --format csv 下使用（JSON 输出走 stdout）', {
              hint: 'JSON 导出直接重定向：bridge extract --json > out.json；或加 --format csv。', usage: context.usage,
            });
          }
          if (isSet(flags, 'csv-safe') && String(flags.format || 'json') !== 'csv') {
            throw new ContractError('E_ARG_REQUIRES', '--csv-safe 只在 --format csv 下生效', {
              hint: '加上 --format csv --out <path>，或删掉 --csv-safe。', usage: context.usage,
            });
          }
        },
      ],
    }),
    discover: sub('discover', {
      usage: 'bridge extract discover [--max-targets N] [--preview-columns N]',
      summary: '发现页面里可导出的表格/列表',
      examples: ['bridge extract discover', 'bridge extract discover --max-targets 16 --preview-columns 6 --json'],
      risk: RISK.READ_ONLY,
      posOffset: 2,
      positionals: { min: 0, max: 0 },
      flags: EXTRACT_COMMON_FLAGS,
      checks: [(flags, pos, context) => {
        assertAbsent(flags, ['format', 'out', 'csv-safe', 'target', 'cursor', 'fields-json', 'fields', 'item-selector', 'expect-revision'], {
          usage: context.usage,
          hint: 'discover 只列候选；导出请用 bridge extract --target <id>。',
        });
      }],
    }),
    table: sub('table', {
      usage: 'bridge extract table --target <id> | --selector <css> | --ref @eN [--max-rows N] [--format json|csv --out <path>]',
      summary: '导出指定表格（--target 来自 discover，或直接给 selector/ref）',
      examples: [
        'bridge extract table --target 1',
        'bridge extract table --selector "#people" --max-rows 100',
        'bridge extract table --target 1 --format csv --out people.csv',
      ],
      risk: RISK.READ_ONLY,
      posOffset: 2,
      positionals: { min: 0, max: 1, labels: ['[ref|selector]'] },
      positionalKinds: [{ index: 0, kind: 'optional-string', label: '[ref|selector]' }],
      flags: EXTRACT_COMMON_FLAGS,
      checks: [(flags, pos, context) => {
        // --target <id>（来自 extract discover）本身就是目标来源，不再要求 ref/selector。
        if (!isSet(flags, 'target')) requireTargetSource(flags, pos, 2, { ...context, label: 'extract table' });
        if (isSet(flags, 'format') && String(flags.format) === 'csv' && !isSet(flags, 'out')) {
          throw new ContractError('E_ARG_REQUIRES', '--format csv 需要 --out <path>', {
            hint: '例如 bridge extract table --target 1 --format csv --out people.csv。', usage: context.usage,
          });
        }
      }],
    }),
    list: sub('list', {
      usage: 'bridge extract list --selector <css> [--item-selector <css>] [--fields-json <json>] [--max-rows N]',
      summary: '导出列表（按 item 逐个取字段）',
      examples: [
        'bridge extract list --selector "#items"',
        'bridge extract list --selector "#items" --item-selector li --fields-json \'[{"name":"text"}]\'',
        'bridge extract list --selector "#items" --item-selector li --max-rows 20 --json',
      ],
      risk: RISK.READ_ONLY,
      posOffset: 2,
      positionals: { min: 0, max: 1, labels: ['[ref|selector]'] },
      positionalKinds: [{ index: 0, kind: 'optional-string', label: '[ref|selector]' }],
      flags: EXTRACT_COMMON_FLAGS,
      checks: [(flags, pos, context) => {
        // list 的目标是可选的（--cursor 续取/整页列表），不强制 ref/selector。
        if (isSet(flags, 'item-selector') && !/^[^\s]+$/.test(String(flags['item-selector']))) {
          throw new ContractError('E_ARG_TYPE', '--item-selector 需要 CSS selector', {
            hint: '例如 --item-selector li。', usage: context.usage,
          });
        }
        if (isSet(flags, 'fields-json')) {
          let parsed;
          try {
            parsed = JSON.parse(String(flags['fields-json']));
          } catch (error) {
            throw new ContractError('E_ARG_TYPE', '--fields-json 不是合法 JSON：' + error.message, {
              hint: '例如 --fields-json \'[{"name":"text"}]\'。', usage: context.usage,
            });
          }
          if (!Array.isArray(parsed) && !(parsed && Array.isArray(parsed.fields))) {
            throw new ContractError('E_ARG_TYPE', '--fields-json 需要数组或 {fields:[...]}', {
              hint: '例如 --fields-json \'[{"name":"text"}]\'。', usage: context.usage,
            });
          }
        }
      }],
    }),
  }),
  order: ['default', 'discover', 'table', 'list'],
});

const WAIT_ELEMENT_SPEC = Object.freeze({
  command: 'wait-for-element',
  summary: '等待元素满足状态（超时不是错误：satisfied=false 且退出码 0）',
  topic: 'wait-for-element',
  notes: [
    '只读命令：不改变页面，可安全重复执行。',
    '--timeout 支持 400ms / 5s / 2m；超时返回 satisfied=false，退出码仍是 0。',
    '--operation-id 可配合 bridge operation cancel 中止等待。',
  ],
  subs: Object.freeze({
    default: sub('default', {
      usage: 'bridge wait-for-element <selector|@ref> [--state visible|hidden|attached|detached] [--timeout 20s] [--operation-id <id>]',
      summary: '等待元素可见/隐藏/挂载状态',
      examples: [
        'bridge wait-for-element "#submit"',
        'bridge wait-for-element @e2 --state visible --timeout 20s',
        'bridge wait-for-element "#dialog" --state hidden --timeout 5s',
        'bridge wait-for-element "#submit" --dry-run',
      ],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 1, labels: ['<selector|@ref>'] },
      positionalKinds: [{ index: 0, kind: 'optional-string', label: '<selector|@ref>' }],
      flags: mergeFlags({
        ...TARGET_FLAGS,
        state: flag('enum', { values: ['visible', 'hidden', 'attached', 'detached'], desc: '等待的状态（默认 visible）' }),
        timeout: flag('duration', { desc: '等待上限（默认 10s）' }),
        'operation-id': text('可取消的操作 id'),
        ...SESSION_FLAGS,
        ...CONTROL_FLAGS,
      }),
      checks: [(flags, pos, context) => {
        requireTargetSource(flags, pos, 1, { ...context, label: 'wait-for-element' });
        controlChecks(flags, context);
      }],
    }),
  }),
  order: ['default'],
});

const WAIT_NAV_SPEC = Object.freeze({
  command: 'wait-for-navigation',
  summary: '等待页面导航完成',
  topic: 'wait-for-navigation',
  notes: [
    '只读命令：不改页面。',
    '--wait-until 取值 load|domcontentloaded|networkidle|commit。',
  ],
  subs: Object.freeze({
    default: sub('default', {
      usage: 'bridge wait-for-navigation [--wait-until load|domcontentloaded|networkidle|commit] [--timeout 30s]',
      summary: '等待导航到指定阶段',
      examples: [
        'bridge wait-for-navigation',
        'bridge wait-for-navigation --wait-until networkidle --timeout 45s',
        'bridge wait-for-navigation --dry-run',
      ],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({
        'wait-until': flag('enum', { values: ['load', 'domcontentloaded', 'networkidle', 'commit'], desc: '等待阶段（默认 load）' }),
        timeout: flag('duration', { desc: '等待上限（默认 30s）' }),
        ...SESSION_FLAGS,
        ...CONTROL_FLAGS,
      }),
    }),
  }),
  order: ['default'],
});

// ---------------------------------------------------------------------------
// 高频命令（视频 / 长截图 / 录制 / 调试 / trace）的严格参数契约
//
// 这批命令原来只靠各命令实现里的 requirePos/if 判断兜底：多余参数被静默忽略、
// 非法枚举要等 daemon 往返才报错、`--dry-run` 没有统一入口。这里按
// `tools/e2e.mjs` 的真实调用形状逐条登记（不是先写 spec 再让 E2E 迁就），
// 因此白名单是“E2E 已覆盖的调用 ∪ 帮助/技能文档里已经承诺的参数”。
// `dryRun: true` 表示该子命令能给出 plan（cli/lib/command-plans.mjs），
// tools/readme-commands.mjs 会据此在 README 里列出可预检的命令。
// ---------------------------------------------------------------------------

const pathFlag = (desc) => flag('path', { desc });

/** 与 `sub()` 相同，但显式声明“支持 --dry-run 预检”。 */
function planSub(name, definition) {
  return sub(name, { ...definition, dryRun: true });
}

/** 调试采集的过滤参数（requests 与快照类子命令共用，执行端 filterDebugEntries 读同一组）。 */
const DEBUG_FILTER_FLAGS = Object.freeze({
  filter: text('按 URL 子串过滤'),
  url: text('同 --filter（兼容写法）'),
  method: text('按 HTTP 方法过滤（GET/POST/...）'),
  status: flag('int', { min: 100, max: 599, desc: '按 HTTP 状态码过滤' }),
  'resource-type': text('按资源类型过滤（script/image/font/...）'),
  state: flag('enum', { values: ['all', 'pending', 'complete', 'failed'], desc: '按推导状态过滤' }),
  kind: flag('enum', { values: ['all', 'business', 'resource', 'extension'], desc: '按请求分类过滤' }),
  offset: flag('int', { min: 0, desc: '跳过前 N 条' }),
  limit: flag('int', { min: 1, desc: '最多返回条数' }),
  fields: text('只保留这些字段（逗号分隔）'),
});

/** 需要 --output 的调试子命令共用的检查。 */
function requireOutput(label) {
  return (flags, pos, context) => {
    if (!isSet(flags, 'output')) {
      throw new ContractError('E_ARG_MISSING', 'bridge debug ' + label + ' 需要 --output <file>', {
        hint: '用法：' + context.usage,
        usage: context.usage,
      });
    }
  };
}

const VIDEO_SPEC = Object.freeze({
  command: 'video',
  summary: '录屏：开始/停止/查询/保存/校验/恢复/裁剪/合并/分段/清理',
  topic: 'video',
  notes: [
    '录制由扩展在标签页内完成（无声音）；打码/裁剪用 video trim，分段用 video split。',
    'video 的命令风险分三档：录制类改浏览器（browser_mutation）、查询类只读、save/trim/split 会写本机文件。',
    '所有子命令都支持 --dry-run：只打印将要发出的 RPC 与本机路径，不触达 daemon、不写文件。',
  ],
  subs: Object.freeze({
    start: planSub('start', {
      usage: 'bridge video start [--duration 60s] [--quality <档位>] [--encoder <名字>] [--force-frames] [--session <id>] [--dry-run]',
      summary: '开始录制当前任务标签页（无声音）',
      examples: [
        'bridge video start --duration 10s',
        'bridge video start --quality standard --session a1b2',
        'bridge video start --duration 5s --dry-run',
      ],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({
        duration: flag('duration', { desc: '最长录制时长（到点自动停止）' }),
        quality: text('画质档位（标准/清晰，具体取值由扩展支持情况决定）'),
        encoder: text('编码器偏好（默认让扩展选）'),
        'force-frames': bool('强制走逐帧编码（调试用，更慢但更稳定）'),
        ...SESSION_FLAGS,
      }),
    }),
    stop: planSub('stop', {
      usage: 'bridge video stop [<recordingId>] [--session <id>] [--dry-run]',
      summary: '停止录制并封存分片',
      examples: ['bridge video stop', 'bridge video stop rec-a1b2 --session a1b2', 'bridge video stop --dry-run'],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 0, max: 1, labels: ['[recordingId]'] },
      positionalKinds: [{ index: 0, kind: 'optional-string', label: '[recordingId]' }],
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    status: planSub('status', {
      usage: 'bridge video status [<recordingId>] [--session <id>] [--dry-run]',
      summary: '查询录制状态（进行中或已完成）',
      examples: ['bridge video status', 'bridge video status rec-a1b2 --json', 'bridge video status --dry-run'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 1, labels: ['[recordingId]'] },
      positionalKinds: [{ index: 0, kind: 'optional-string', label: '[recordingId]' }],
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    save: planSub('save', {
      usage: 'bridge video save <recordingId> --out <file> [--overwrite] [--session <id>] [--dry-run]',
      summary: '把录制保存成本机文件（需要时自动 remux faststart）',
      examples: [
        'bridge video save rec-a1b2 --out demo.webm',
        'bridge video save rec-a1b2 --out demo.webm --overwrite --session a1b2',
        'bridge video save rec-a1b2 --out demo.webm --dry-run',
      ],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 1, max: 1, labels: ['<recordingId>'] },
      positionalKinds: [{ index: 0, kind: 'string', label: '<recordingId>' }],
      flags: mergeFlags({
        out: pathFlag('保存路径（目录会被创建）'),
        overwrite: bool('允许覆盖已存在的目标文件'),
        ...SESSION_FLAGS,
      }),
      checks: [(flags, pos, context) => {
        if (!isSet(flags, 'out')) {
          throw new ContractError('E_ARG_MISSING', 'video save 需要 --out <file>', {
            hint: '例如 bridge video save rec-a1b2 --out demo.webm。', usage: context.usage,
          });
        }
      }],
    }),
    verify: planSub('verify', {
      usage: 'bridge video verify <recordingId> [--session <id>] [--dry-run]',
      summary: '校验录制分片完整性（不落盘）',
      examples: ['bridge video verify rec-a1b2', 'bridge video verify rec-a1b2 --json --session a1b2'],
      risk: RISK.READ_ONLY,
      positionals: { min: 1, max: 1, labels: ['<recordingId>'] },
      positionalKinds: [{ index: 0, kind: 'string', label: '<recordingId>' }],
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    durability: planSub('durability', {
      usage: 'bridge video durability [<recordingId>] [--session <id>] [--dry-run]',
      summary: '查看录制的持久化/配额/完整性结论',
      examples: ['bridge video durability', 'bridge video durability rec-a1b2 --json'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 1, labels: ['[recordingId]'] },
      positionalKinds: [{ index: 0, kind: 'optional-string', label: '[recordingId]' }],
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    list: planSub('list', {
      usage: 'bridge video list [--session <id>] [--dry-run]',
      summary: '列出可保存的录制',
      examples: ['bridge video list', 'bridge video list --json'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    prune: planSub('prune', {
      usage: 'bridge video prune [--ttl 24h] [--session <id>] [--dry-run]',
      summary: '清理过期录制',
      examples: ['bridge video prune', 'bridge video prune --ttl 24h --session a1b2', 'bridge video prune --ttl 1ms --dry-run'],
      risk: RISK.DAEMON_STATE,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({
        ttl: flag('duration', { minMs: 0, desc: '超过该时长的录制视为过期' }),
        ...SESSION_FLAGS,
      }),
    }),
    discard: planSub('discard', {
      usage: 'bridge video discard <recordingId> [--session <id>] [--dry-run]',
      summary: '丢弃一条录制（不可恢复）',
      examples: ['bridge video discard rec-a1b2', 'bridge video discard rec-a1b2 --dry-run'],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 1, max: 1, labels: ['<recordingId>'] },
      positionalKinds: [{ index: 0, kind: 'string', label: '<recordingId>' }],
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    recover: planSub('recover', {
      usage: 'bridge video recover [--session <id>] [--dry-run]',
      summary: '扫描并恢复未封存的录屏分片',
      examples: ['bridge video recover', 'bridge video recover --json --session a1b2'],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    info: planSub('info', {
      usage: 'bridge video info <file> [--dry-run]',
      summary: '只读本机视频的容器元数据（codec/尺寸/时长/包数）',
      examples: ['bridge video info demo.webm', 'bridge video info demo.webm --json'],
      risk: RISK.READ_ONLY,
      positionals: { min: 1, max: 1, labels: ['<file>'] },
      positionalKinds: [{ index: 0, kind: 'file', label: '<file>' }],
      // info/merge/split/trim 是纯本机命令：--session 不参与任何逻辑，
      // 但既有 E2E 与脚本会顺手带上它；参数层保持接受、执行层继续忽略。
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    merge: planSub('merge', {
      usage: 'bridge video merge <file...> --out <file> [--dry-run]',
      summary: '按顺序拼接多段视频（packet 级）',
      examples: ['bridge video merge a.webm b.webm --out merged.webm', 'bridge video merge a.webm b.webm --out merged.webm --dry-run'],
      risk: RISK.LOCAL_WRITE,
      positionals: { min: 2, max: 20, labels: ['<file>', '<file>'] },
      positionalKinds: [
        { index: 0, kind: 'file', label: '<file>' },
        { index: 1, kind: 'file', label: '<file>' },
      ],
      flags: mergeFlags({ out: pathFlag('合并结果路径'), ...SESSION_FLAGS }),
      checks: [(flags, pos, context) => {
        if (!isSet(flags, 'out')) {
          throw new ContractError('E_ARG_MISSING', 'video merge 需要 --out <file>', {
            hint: '例如 bridge video merge a.webm b.webm --out merged.webm。', usage: context.usage,
          });
        }
      }],
    }),
    split: planSub('split', {
      usage: 'bridge video split <file> --out-dir <dir> [--parts 2] [--dry-run]',
      summary: '把视频按包数均分成多段',
      examples: ['bridge video split demo.webm --out-dir parts', 'bridge video split demo.webm --out-dir parts --parts 3 --dry-run'],
      risk: RISK.LOCAL_WRITE,
      positionals: { min: 1, max: 1, labels: ['<file>'] },
      positionalKinds: [{ index: 0, kind: 'file', label: '<file>' }],
      flags: mergeFlags({
        'out-dir': pathFlag('输出目录'),
        parts: flag('int', { min: 1, max: 1000, desc: '分段数（默认 2）' }),
        ...SESSION_FLAGS,
      }),
      checks: [(flags, pos, context) => {
        if (!isSet(flags, 'out-dir')) {
          throw new ContractError('E_ARG_MISSING', 'video split 需要 --out-dir <dir>', {
            hint: '例如 bridge video split demo.webm --out-dir parts。', usage: context.usage,
          });
        }
      }],
    }),
    trim: planSub('trim', {
      usage: 'bridge video trim <file> --out <file> [--start 0s] [--end 5s] [--dry-run]',
      summary: '按时间范围裁剪视频（packet 级，不重编码）',
      examples: [
        'bridge video trim demo.webm --out clip.webm --start 0s --end 5s',
        'bridge video trim demo.webm --out clip.webm --end 5s --dry-run',
      ],
      risk: RISK.LOCAL_WRITE,
      positionals: { min: 1, max: 1, labels: ['<file>'] },
      positionalKinds: [{ index: 0, kind: 'file', label: '<file>' }],
      flags: mergeFlags({
        out: pathFlag('裁剪结果路径'),
        start: flag('duration', { minMs: 0, desc: '起始时间（默认 0s）' }),
        end: flag('duration', { minMs: 0, desc: '结束时间（默认末尾）' }),
        ...SESSION_FLAGS,
      }),
      checks: [(flags, pos, context) => {
        if (!isSet(flags, 'out')) {
          throw new ContractError('E_ARG_MISSING', 'video trim 需要 --out <file>', {
            hint: '例如 bridge video trim demo.webm --out clip.webm --end 5s。', usage: context.usage,
          });
        }
      }],
    }),
  }),
  order: ['start', 'stop', 'status', 'save', 'verify', 'durability', 'list', 'prune', 'discard', 'recover', 'info', 'merge', 'split', 'trim'],
});

const LONGSHOT_SPEC = Object.freeze({
  command: 'longshot',
  summary: '长截图：从落盘分片恢复整图（校验 hash/缺片）',
  topic: 'longshot',
  notes: [
    '长截图本身由 screenshot --mode manual --stitch 产生；本命令只负责恢复未完成的分片。',
    'recover 会先校验分片 hash：缺片/截断会写进 JSON 的 summary.verification 并给出下一步。',
    '--out 是唯一写入位置；dry-run 只打印将要发出的 RPC 与目标路径。',
  ],
  subs: Object.freeze({
    recover: planSub('recover', {
      usage: 'bridge longshot recover <longshotId> --out <file> [--session <id>] [--dry-run]',
      summary: '从分片重建长截图并落盘为 PNG',
      examples: [
        'bridge longshot recover ls-a1b2 --out shot.png',
        'bridge longshot recover ls-a1b2 --out shot.png --session a1b2 --json',
        'bridge longshot recover ls-a1b2 --out shot.png --dry-run',
      ],
      risk: RISK.LOCAL_WRITE,
      positionals: { min: 1, max: 1, labels: ['<longshotId>'] },
      positionalKinds: [{ index: 0, kind: 'string', label: '<longshotId>' }],
      flags: mergeFlags({
        out: pathFlag('PNG 输出路径'),
        ...SESSION_FLAGS,
      }),
      checks: [(flags, pos, context) => {
        if (!isSet(flags, 'out')) {
          throw new ContractError('E_ARG_MISSING', 'longshot recover 需要 --out <file>', {
            hint: '例如 bridge longshot recover ls-a1b2 --out shot.png。', usage: context.usage,
          });
        }
      }],
    }),
  }),
  order: ['recover'],
});

const RECORD_SPEC = Object.freeze({
  command: 'record',
  summary: '操作录制：记录用户操作并导出 Trace v3',
  topic: 'record',
  notes: [
    'record start 记录的是用户操作；--include-agent 才会同时记录 Agent 动作。',
    'record export 只读录制并写本机 trace.json/states，不删除录制、可重复导出。',
    '所有子命令支持 --dry-run：export 的 dry-run 会列出 trace.json 与 states 的落盘目录。',
  ],
  subs: Object.freeze({
    start: planSub('start', {
      usage: 'bridge record start [--screenshots] [--include-agent] [--blocking] [--out <dir>] [--url <url>] [--purpose <text>] [--redact-values] [--max-page-tokens N] [--trace-version 2|3] [--session <id>] [--dry-run]',
      summary: '开始记录操作（--blocking：阻塞到用户在浏览器结束并导出 ./trace）',
      examples: [
        'bridge record start',
        'bridge record start --include-agent --session a1b2',
        'bridge record start --blocking --out trace --include-agent',
        'bridge record start --blocking --url https://example.com/ --purpose "发布文章"',
        'bridge record start --blocking --dry-run',
      ],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({
        screenshots: bool('同时记录关键步骤截图'),
        'include-agent': bool('同时记录 Agent 动作（默认只记用户）'),
        blocking: bool('阻塞式：启动后等到用户在浏览器结束录制，再导出 trace 目录'),
        out: pathFlag('阻塞式导出的 trace 目录（默认 ./trace）'),
        url: flag('url', { schemes: ['http:', 'https:'], desc: '录制前先导航到该 URL（需要已有 session）' }),
        purpose: text('给 Agent 的目标说明，写入 trace.purpose'),
        'redact-values': bool('导出时把表单值脱敏为 [filled]'),
        'max-page-tokens': flag('int', { min: 1, max: 20000, desc: '每个页面观察的 VOM token 上限' }),
        'trace-version': flag('int', { min: 2, max: 3, desc: '期望 trace 版本（默认 3）' }),
        ...SESSION_FLAGS,
      }),
    }),
    stop: planSub('stop', {
      usage: 'bridge record stop [--session <id>] [--dry-run]',
      summary: '停止记录并落库',
      examples: ['bridge record stop', 'bridge record stop --session a1b2 --dry-run'],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    status: planSub('status', {
      usage: 'bridge record status [--session <id>] [--dry-run]',
      summary: '查询进行中的记录',
      examples: ['bridge record status', 'bridge record status --json'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    list: planSub('list', {
      usage: 'bridge record list [--session <id>] [--dry-run]',
      summary: '列出历史记录',
      examples: ['bridge record list', 'bridge record list --json'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    export: planSub('export', {
      usage: 'bridge record export [<id>] [--out <dir>] [--screenshot] [--session <id>] [--dry-run]',
      summary: '导出 Trace v3（trace.json + states/）',
      examples: [
        'bridge record export --out trace-dir',
        'bridge record export --out trace-dir --screenshot --session a1b2',
        'bridge record export --out trace-dir --dry-run',
      ],
      risk: RISK.LOCAL_WRITE,
      positionals: { min: 0, max: 1, labels: ['[id]'] },
      positionalKinds: [{ index: 0, kind: 'optional-string', label: '[id]' }],
      flags: mergeFlags({
        out: pathFlag('导出目录（默认 ./trace）'),
        screenshot: bool('额外截一张当前页面放进 trace'),
        ...SESSION_FLAGS,
      }),
    }),
  }),
  order: ['start', 'stop', 'status', 'list', 'export'],
});

const TRACE_SPEC = Object.freeze({
  command: 'trace',
  summary: '性能追踪：start/stop/status 采集，summary/diff/view 离线分析',
  topic: 'trace',
  notes: [
    'summary/diff/view 是纯本地命令：只读 trace JSON，不触达 daemon。',
    'trace stop --out 会把 trace JSON 落盘；不落盘时 JSON 输出里也不含整份 trace（避免巨型输出）。',
    '所有子命令支持 --dry-run：view/summary/diff 会列出将要读取的文件与渲染产物路径。',
  ],
  subs: Object.freeze({
    start: planSub('start', {
      usage: 'bridge trace start [--session <id>] [--dry-run]',
      summary: '开始 CDP 性能追踪',
      examples: ['bridge trace start', 'bridge trace start --session a1b2 --dry-run'],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    status: planSub('status', {
      usage: 'bridge trace status [--session <id>] [--dry-run]',
      summary: '查询 tracing 状态与事件数',
      examples: ['bridge trace status', 'bridge trace status --json'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    stop: planSub('stop', {
      usage: 'bridge trace stop [--out <trace.json>] [--session <id>] [--dry-run]',
      summary: '停止 tracing 并可把 traceEvents 落盘',
      examples: [
        'bridge trace stop',
        'bridge trace stop --out trace.json --session a1b2',
        'bridge trace stop --out trace.json --dry-run',
      ],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({
        out: pathFlag('trace JSON 输出路径'),
        ...SESSION_FLAGS,
      }),
    }),
    summary: planSub('summary', {
      usage: 'bridge trace summary <trace.json> [--limit 20] [--dry-run]',
      summary: '离线统计：阶段分布/关键路径/长任务',
      examples: ['bridge trace summary trace.json', 'bridge trace summary trace.json --json', 'bridge trace summary trace.json --dry-run'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 1, labels: ['<trace.json>'] },
      positionalKinds: [{ index: 0, kind: 'optional-string', label: '<trace.json>' }],
      flags: mergeFlags({
        file: pathFlag('trace 文件（等价位置参数）'),
        limit: flag('int', { min: 1, max: 1000, desc: '热点条目数量（默认 20）' }),
        ...SESSION_FLAGS,
      }),
      checks: [(flags, pos, context) => {
        if (!pos[2] && !isSet(flags, 'file')) {
          throw new ContractError('E_ARG_MISSING', 'trace summary 需要 <trace.json>', {
            hint: '例如 bridge trace summary trace.json。', usage: context.usage,
          });
        }
      }],
    }),
    diff: planSub('diff', {
      usage: 'bridge trace diff <base.json> <head.json> [--limit 10] [--dry-run]',
      summary: '离线对比两份 trace 的差异',
      examples: ['bridge trace diff before.json after.json', 'bridge trace diff before.json after.json --json'],
      risk: RISK.READ_ONLY,
      positionals: { min: 2, max: 2, labels: ['<base.json>', '<head.json>'] },
      positionalKinds: [
        { index: 0, kind: 'file', label: '<base.json>' },
        { index: 1, kind: 'file', label: '<head.json>' },
      ],
      flags: mergeFlags({
        limit: flag('int', { min: 1, max: 1000, desc: '热点差异条数（默认 10）' }),
        ...SESSION_FLAGS,
      }),
    }),
    view: planSub('view', {
      usage: 'bridge trace view <trace.json> [--debug <archive.json>] [--out <viewer.html>] [--limit N] [--max-bytes N] [--max-chars N] [--dry-run]',
      summary: '把 Trace v3 渲染成离线 HTML 查看器',
      examples: [
        'bridge trace view trace.json',
        'bridge trace view trace.json --debug debug-archive.json --out viewer.html',
        'bridge trace view trace.json --out viewer.html --dry-run',
      ],
      risk: RISK.LOCAL_WRITE,
      positionals: { min: 0, max: 1, labels: ['<trace.json>'] },
      positionalKinds: [{ index: 0, kind: 'optional-string', label: '<trace.json>' }],
      flags: {
        file: pathFlag('trace 文件（等价位置参数）'),
        debug: pathFlag('debug 归档 JSON（把请求投影进网络面板）'),
        out: pathFlag('HTML 输出路径'),
        limit: flag('int', { min: 1, max: 1000, desc: 'span 分页大小' }),
        'max-bytes': flag('int', { min: 1024, desc: 'HTML 字节上限（超出降级渲染）' }),
        'max-chars': flag('int', { min: 16, desc: '状态正文单条字符上限' }),
      },
      checks: [(flags, pos, context) => {
        if (!pos[2] && !isSet(flags, 'file')) {
          throw new ContractError('E_ARG_MISSING', 'trace view 需要 <trace.json>', {
            hint: '例如 bridge trace view trace.json。', usage: context.usage,
          });
        }
      }],
    }),
  }),
  order: ['start', 'status', 'stop', 'diff', 'summary', 'view'],
});

const DEBUG_SPEC = Object.freeze({
  command: 'debug',
  summary: '调试采集：请求/控制台/WS/性能/规则/HAR/证据/归档/操作审计',
  topic: 'debug',
  notes: [
    'debug start 要在导航/复现之前；--bodies 才取请求/响应正文（需挂 debugger）。',
    '读证据（requests/request/console/pages/performance/aggregate/duplicates）是只读的，不会改页面。',
    '改页面的子是 rule_add/rule_import/rule_clear/pin/replay/fetch_probe：风险列按方法在协议 catalog 里的 effect 推导。',
    '所有子命令支持 --dry-run：只打印将要发出的 RPC（含参数）与本机读写路径，不触达 daemon、不写文件。',
  ],
  subs: Object.freeze({
    start: planSub('start', {
      usage: 'bridge debug start [--name <名字>] [--bodies] [--session <id>] [--dry-run]',
      summary: '开始网络/控制台采集（可选含正文）',
      examples: ['bridge debug start', 'bridge debug start --name repro --bodies --session a1b2', 'bridge debug start --bodies --dry-run'],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({
        name: flag('name', { desc: '采集名字（历史列表里可读）' }),
        bodies: bool('采集请求/响应正文（会挂 debugger，单条上限 1MB）'),
        ...SESSION_FLAGS,
      }),
    }),
    stop: planSub('stop', {
      usage: 'bridge debug stop [--session <id>] [--dry-run]',
      summary: '停止采集并落库',
      examples: ['bridge debug stop', 'bridge debug stop --session a1b2 --dry-run'],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    status: planSub('status', {
      usage: 'bridge debug status [--session <id>] [--dry-run]',
      summary: '当前采集快照（没在采集时列最近历史）',
      examples: ['bridge debug status', 'bridge debug status --json'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    requests: planSub('requests', {
      usage: 'bridge debug requests [--filter <子串>] [--method GET] [--status 200] [--kind all|business|resource|extension] [--state all|pending|complete|failed] [--resource-type <t>] [--offset N] [--limit N] [--fields a,b] [--session <id>] [--dry-run]',
      summary: '列出采集到的请求（本地过滤/分页/裁剪）',
      examples: [
        'bridge debug requests',
        'bridge debug requests --filter /api/ --method POST --limit 20 --session a1b2',
        'bridge debug requests --filter /api/ --dry-run',
      ],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({ ...DEBUG_FILTER_FLAGS, ...SESSION_FLAGS }),
    }),
    'har-import': planSub('har-import', {
      usage: 'bridge debug har-import <har.json> --output <archive.json> [--name <id>] [--dry-run]',
      summary: '把 HAR 1.2 转成 debug 归档（离线）',
      examples: [
        'bridge debug har-import net.har --output archive.json',
        'bridge debug har-import net.har --output archive.json --name imported --dry-run',
      ],
      risk: RISK.LOCAL_WRITE,
      positionals: { min: 0, max: 1, labels: ['<har.json>'] },
      positionalKinds: [{ index: 0, kind: 'optional-string', label: '<har.json>' }],
      flags: {
        file: pathFlag('HAR 文件（等价位置参数）'),
        output: pathFlag('输出归档 JSON'),
        name: flag('name', { desc: '归档 id（默认由内容生成）' }),
        ...SESSION_FLAGS,
      },
      checks: [(flags, pos, context) => {
        if (!pos[2] && !isSet(flags, 'file')) {
          throw new ContractError('E_ARG_MISSING', 'debug har-import 需要 <har.json>', {
            hint: '例如 bridge debug har-import net.har --output archive.json。', usage: context.usage,
          });
        }
        if (!isSet(flags, 'output')) {
          throw new ContractError('E_ARG_MISSING', 'debug har-import 需要 --output <archive.json>', {
            hint: '例如 bridge debug har-import net.har --output archive.json。', usage: context.usage,
          });
        }
      }],
    }),
    ws: planSub('ws', {
      usage: 'bridge debug ws [--output <file>] [--limit N] [--session <id>] [--dry-run]',
      summary: '查看 WebSocket 帧索引',
      examples: ['bridge debug ws', 'bridge debug ws --output ws.json --limit 50 --session a1b2'],
      risk: RISK.LOCAL_WRITE,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({
        output: pathFlag('帧索引 JSON 输出路径'),
        limit: flag('int', { min: 1, desc: '每个 socket 打印的帧数（默认 20）' }),
        ...SESSION_FLAGS,
      }),
    }),
    har: planSub('har', {
      usage: 'bridge debug har --output <har.json> [--limit 100] [--session <id>] [--dry-run]',
      summary: '把当前采集导出成 HAR 1.2',
      examples: ['bridge debug har --output net.har', 'bridge debug har --output net.har --limit 50 --dry-run'],
      risk: RISK.LOCAL_WRITE,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({
        output: pathFlag('HAR 输出路径'),
        limit: flag('int', { min: 1, max: 500, desc: '最多导出的请求数（默认 100）' }),
        ...SESSION_FLAGS,
      }),
      checks: [requireOutput('har')],
    }),
    request: planSub('request', {
      usage: 'bridge debug request <id> [--part all|headers|timing|request|response|metadata] [--pointer <jsonPointer>] [--max-chars N] [--offset N] [--session <id>] [--dry-run]',
      summary: '查看单条请求详情（可截取正文/取 JSON 子节点）',
      examples: [
        'bridge debug request 5',
        'bridge debug request 5 --part headers --session a1b2',
        'bridge debug request 5 --pointer /data/items --json',
      ],
      risk: RISK.READ_ONLY,
      positionals: { min: 1, max: 1, labels: ['<id>'] },
      positionalKinds: [{ index: 0, kind: 'int', label: '<id>' }],
      flags: mergeFlags({
        part: flag('enum', { values: ['all', 'headers', 'timing', 'request', 'response', 'metadata'], desc: '只看某一部分（默认 all）' }),
        pointer: text('JSON Pointer（对正文取子节点）'),
        'max-chars': flag('int', { min: 1, max: 16384, desc: '正文最多打印字符数（默认 4096）' }),
        offset: flag('int', { min: 0, max: 65536, desc: '正文起始偏移' }),
        ...SESSION_FLAGS,
      }),
    }),
    console: planSub('console', {
      usage: 'bridge debug console [--session <id>] [--dry-run]',
      summary: '查看采集到的控制台输出',
      examples: ['bridge debug console', 'bridge debug console --json --session a1b2'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    pages: planSub('pages', {
      usage: 'bridge debug pages [--session <id>] [--dry-run]',
      summary: '查看页面上下文（url/title/视口/滚动/dpr）',
      examples: ['bridge debug pages', 'bridge debug pages --json'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    performance: planSub('performance', {
      usage: 'bridge debug performance [--insight] [--session <id>] [--dry-run]',
      summary: '性能指标（TTFB/DCL/load/FCP/LCP/CLS/长任务）',
      examples: ['bridge debug performance', 'bridge debug performance --insight --session a1b2'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({
        insight: bool('同时输出阈值结论（性能洞察）'),
        ...SESSION_FLAGS,
      }),
    }),
    aggregate: planSub('aggregate', {
      usage: 'bridge debug aggregate [--filter <子串>] [--slow-ms N] [--session <id>] [--dry-run]',
      summary: '按 method+path 聚合请求（次数/均值/最大/慢请求/状态分布）',
      examples: ['bridge debug aggregate', 'bridge debug aggregate --filter /api/ --slow-ms 500 --session a1b2'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({
        filter: text('按 URL 子串过滤'),
        'slow-ms': flag('int', { min: 1, desc: '慢请求阈值毫秒（默认 1000）' }),
        ...SESSION_FLAGS,
      }),
    }),
    operations: planSub('operations', {
      usage: 'bridge debug operations [--limit N] [--since 1h] [--session <id>] [--dry-run]',
      summary: '最近 RPC 操作审计（含耗时/结果）',
      examples: ['bridge debug operations', 'bridge debug operations --limit 10 --since 1h'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({
        limit: flag('int', { min: 1, desc: '返回条数（默认 20）' }),
        since: text('只看最近一段时间（1h / 30m / 日期）'),
        ...SESSION_FLAGS,
      }),
    }),
    operation: planSub('operation', {
      usage: 'bridge debug operation <id> [--with-requests] [--session <id>] [--dry-run]',
      summary: '单条操作审计；--with-requests 按时间窗标出请求',
      examples: ['bridge debug operation op-a1b2', 'bridge debug operation op-a1b2 --with-requests'],
      risk: RISK.READ_ONLY,
      positionals: { min: 1, max: 1, labels: ['<id>'] },
      positionalKinds: [{ index: 0, kind: 'string', label: '<id>' }],
      flags: mergeFlags({
        'with-requests': bool('按时间窗关联采集到的请求'),
        ...SESSION_FLAGS,
      }),
    }),
    coverage: planSub('coverage', {
      usage: 'bridge debug coverage [--session <id>] [--dry-run]',
      summary: '采集覆盖度与缺口根因分类',
      examples: ['bridge debug coverage', 'bridge debug coverage --json'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    duplicates: planSub('duplicates', {
      usage: 'bridge debug duplicates [--window-ms N] [--filter <子串>] [--session <id>] [--dry-run]',
      summary: '窗口内相邻重复请求聚簇',
      examples: ['bridge debug duplicates', 'bridge debug duplicates --window-ms 10000 --filter /api/ --session a1b2'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({
        'window-ms': flag('int', { min: 1, desc: '聚簇时间窗毫秒（默认 1000）' }),
        filter: text('按 URL 子串过滤'),
        ...SESSION_FLAGS,
      }),
    }),
    fetch_probe: planSub('fetch_probe', {
      usage: 'bridge debug fetch_probe [--ms 1500] [--session <id>] [--dry-run]',
      summary: '短暂挂起页面 fetch，看谁在发请求',
      examples: ['bridge debug fetch_probe', 'bridge debug fetch_probe --ms 3000 --session a1b2'],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({
        ms: flag('int', { min: 200, desc: '挂起窗口毫秒（默认 1500）' }),
        ...SESSION_FLAGS,
      }),
    }),
    capabilities: planSub('capabilities', {
      usage: 'bridge debug capabilities [--session <id>] [--dry-run]',
      summary: '扩展支持的 debug 动作与 parts',
      examples: ['bridge debug capabilities', 'bridge debug capabilities --json'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    pin: planSub('pin', {
      usage: 'bridge debug pin <id> [--session <id>] [--dry-run]',
      summary: '钉住一条请求（后续采集不淘汰）',
      examples: ['bridge debug pin req-test', 'bridge debug pin 5 --session a1b2'],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 1, max: 1, labels: ['<id>'] },
      positionalKinds: [{ index: 0, kind: 'string', label: '<id>' }],
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    unpin: planSub('unpin', {
      usage: 'bridge debug unpin <id> [--session <id>] [--dry-run]',
      summary: '取消钉住',
      examples: ['bridge debug unpin req-test', 'bridge debug unpin 5 --dry-run'],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 1, max: 1, labels: ['<id>'] },
      positionalKinds: [{ index: 0, kind: 'string', label: '<id>' }],
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    pinned: planSub('pinned', {
      usage: 'bridge debug pinned [--session <id>] [--dry-run]',
      summary: '列出钉住的请求',
      examples: ['bridge debug pinned', 'bridge debug pinned --json'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    activity: planSub('activity', {
      usage: 'bridge debug activity [--limit N] [--session <id>] [--dry-run]',
      summary: '调试/操作记录表',
      examples: ['bridge debug activity', 'bridge debug activity --limit 50 --session a1b2'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({
        limit: flag('int', { min: 1, desc: '返回条数（默认 20）' }),
        ...SESSION_FLAGS,
      }),
    }),
    rule_add: planSub('rule_add', {
      usage: 'bridge debug rule_add --rule \'<json>\' | --rule-file <file> [--session <id>] [--dry-run]',
      summary: '添加请求拦截规则（fulfill/block/modify）',
      examples: [
        'bridge debug rule_add --rule \'{"urlPattern":"*/api/ping*","action":"block"}\'',
        'bridge debug rule_add --rule-file rule.json --session a1b2',
        'bridge debug rule_add --rule-file rule.json --dry-run',
      ],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({
        rule: flag('json', { desc: '规则 JSON（action/urlPattern 等）' }),
        'rule-file': pathFlag('规则 JSON 文件（与 --rule 二选一）'),
        ...SESSION_FLAGS,
      }),
      checks: [(flags, pos, context) => {
        if (isSet(flags, 'rule') && isSet(flags, 'rule-file')) {
          throw new ContractError('E_ARG_CONFLICT', '--rule 与 --rule-file 只能给一个', {
            hint: '内联用 --rule \'<json>\'，文件用 --rule-file <file>。', usage: context.usage,
          });
        }
        if (!isSet(flags, 'rule') && !isSet(flags, 'rule-file')) {
          throw new ContractError('E_ARG_MISSING', 'debug rule_add 需要 --rule 或 --rule-file', {
            hint: '例如 bridge debug rule_add --rule \'{"urlPattern":"*/api/*","action":"block"}\'。', usage: context.usage,
          });
        }
      }],
    }),
    rule_enable: planSub('rule_enable', {
      usage: 'bridge debug rule_enable <id> [--session <id>] [--dry-run]',
      summary: '启用一条规则',
      examples: ['bridge debug rule_enable 3', 'bridge debug rule_enable 3 --dry-run'],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 1, max: 1, labels: ['<id>'] },
      positionalKinds: [{ index: 0, kind: 'int', label: '<id>' }],
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    rule_disable: planSub('rule_disable', {
      usage: 'bridge debug rule_disable <id> [--session <id>] [--dry-run]',
      summary: '停用一条规则',
      examples: ['bridge debug rule_disable 3', 'bridge debug rule_disable 3 --dry-run'],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 1, max: 1, labels: ['<id>'] },
      positionalKinds: [{ index: 0, kind: 'int', label: '<id>' }],
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    rule_remove: planSub('rule_remove', {
      usage: 'bridge debug rule_remove <id> [--session <id>] [--dry-run]',
      summary: '删除一条规则',
      examples: ['bridge debug rule_remove 3', 'bridge debug rule_remove 3 --dry-run'],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 1, max: 1, labels: ['<id>'] },
      positionalKinds: [{ index: 0, kind: 'int', label: '<id>' }],
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    rule_list: planSub('rule_list', {
      usage: 'bridge debug rule_list [--session <id>] [--dry-run]',
      summary: '列出当前规则（含 dnr/fetch 挂载状态）',
      examples: ['bridge debug rule_list', 'bridge debug rule_list --json'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    rule_clear: planSub('rule_clear', {
      usage: 'bridge debug rule_clear [--session <id>] [--dry-run]',
      summary: '清空全部规则',
      examples: ['bridge debug rule_clear', 'bridge debug rule_clear --dry-run'],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    rule_export: planSub('rule_export', {
      usage: 'bridge debug rule_export --output <file> [--session <id>] [--dry-run]',
      summary: '导出当前规则快照',
      examples: ['bridge debug rule_export --output rules.json', 'bridge debug rule_export --output rules.json --dry-run'],
      risk: RISK.LOCAL_WRITE,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({
        output: pathFlag('规则快照 JSON 输出路径'),
        ...SESSION_FLAGS,
      }),
      checks: [requireOutput('rule_export')],
    }),
    rule_import: planSub('rule_import', {
      usage: 'bridge debug rule_import --file <rules.json> [--session <id>] [--dry-run]',
      summary: '导入规则快照（替换当前规则集）',
      examples: ['bridge debug rule_import --file rules.json', 'bridge debug rule_import --file rules.json --dry-run'],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 0, max: 1, labels: ['[rules.json]'] },
      positionalKinds: [{ index: 0, kind: 'optional-string', label: '[rules.json]' }],
      flags: mergeFlags({
        file: pathFlag('规则快照 JSON（等价位置参数）'),
        ...SESSION_FLAGS,
      }),
      checks: [(flags, pos, context) => {
        if (!pos[2] && !isSet(flags, 'file')) {
          throw new ContractError('E_ARG_MISSING', 'debug rule_import 需要 --file <rules.json>', {
            hint: '例如 bridge debug rule_import --file rules.json。', usage: context.usage,
          });
        }
      }],
    }),
    export: planSub('export', {
      usage: 'bridge debug export --output <file> [--session <id>] [--dry-run]',
      summary: '把当前采集快照导出成本机 JSON',
      examples: ['bridge debug export --output debug.json', 'bridge debug export --output debug.json --dry-run'],
      risk: RISK.LOCAL_WRITE,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({
        output: pathFlag('快照 JSON 输出路径'),
        ...SESSION_FLAGS,
      }),
      checks: [requireOutput('export')],
    }),
    archives: planSub('archives', {
      usage: 'bridge debug archives --dir <dir> [--prune] [--max N] [--session <id>] [--dry-run]',
      summary: '列出目录里的归档索引（可清理旧文件）',
      examples: ['bridge debug archives --dir out', 'bridge debug archives --dir out --prune --max 20'],
      risk: RISK.LOCAL_WRITE,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({
        dir: pathFlag('归档目录'),
        prune: bool('删除已过期的归档文件'),
        max: flag('int', { min: 1, desc: '只保留最新的 N 条归档' }),
        ...SESSION_FLAGS,
      }),
      checks: [(flags, pos, context) => {
        if (!isSet(flags, 'dir')) {
          throw new ContractError('E_ARG_MISSING', 'debug archives 需要 --dir <dir>', {
            hint: '例如 bridge debug archives --dir out。', usage: context.usage,
          });
        }
      }],
    }),
    archive: planSub('archive', {
      usage: 'bridge debug archive --output <file> [--name <id>] [--max-requests N] [--max-console N] [--max-bytes N] [--session <id>] [--dry-run]',
      summary: '归档当前采集（带 coverage/gaps 与预算）',
      examples: [
        'bridge debug archive --output archive.json',
        'bridge debug archive --output archive.json --max-requests 500 --dry-run',
      ],
      risk: RISK.LOCAL_WRITE,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({
        output: pathFlag('归档 JSON 输出路径'),
        name: flag('name', { desc: '归档 id' }),
        'max-requests': flag('int', { min: 1, desc: '请求数预算' }),
        'max-console': flag('int', { min: 1, desc: '控制台条数预算' }),
        'max-bytes': flag('int', { min: 1, desc: '归档字节预算' }),
        ...SESSION_FLAGS,
      }),
      checks: [requireOutput('archive')],
    }),
    query: planSub('query', {
      usage: 'bridge debug query --file <archive.json> | --dir <dir> [--filter <子串>] [--method GET] [--status 200] [--kind all|business|resource|extension] [--min-duration N] [--limit N] [--dry-run]',
      summary: '在归档里离线查询请求',
      examples: [
        'bridge debug query --file archive.json --filter /api/',
        'bridge debug query --dir out --status 500 --limit 20',
        'bridge debug query --file archive.json --dry-run',
      ],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 0 },
      flags: {
        file: pathFlag('单个归档 JSON'),
        dir: pathFlag('归档目录（与 --file 二选一）'),
        filter: text('按 URL 子串过滤'),
        url: text('同 --filter（兼容写法）'),
        method: text('按 HTTP 方法过滤'),
        status: flag('int', { min: 100, max: 599, desc: '按状态码过滤' }),
        kind: flag('enum', { values: ['all', 'business', 'resource', 'extension'], desc: '按请求分类过滤' }),
        'min-duration': flag('int', { min: 0, desc: '只保留耗时 ≥ N 毫秒的请求' }),
        limit: flag('int', { min: 1, desc: '最多返回条数（默认 100）' }),
        ...SESSION_FLAGS,
      },
      checks: [(flags, pos, context) => {
        if (pos[2]) {
          throw new ContractError('E_ARG_UNEXPECTED', 'debug query 不接受位置参数：多余的 ' + pos[2], {
            hint: '用 --file <archive.json> 或 --dir <dir> 指定查询目标。', usage: context.usage,
          });
        }
        if (isSet(flags, 'file') && isSet(flags, 'dir')) {
          throw new ContractError('E_ARG_CONFLICT', '--file 与 --dir 只能给一个', {
            hint: '单文件用 --file，目录用 --dir。', usage: context.usage,
          });
        }
        if (!isSet(flags, 'file') && !isSet(flags, 'dir')) {
          throw new ContractError('E_ARG_MISSING', 'debug query 需要 --file <archive.json> 或 --dir <dir>', {
            hint: '例如 bridge debug query --file debug-export.json --filter /api/。', usage: context.usage,
          });
        }
      }],
    }),
    evidence: planSub('evidence', {
      usage: 'bridge debug evidence [--file <archive.json>] [--output <file>] [--session <id>] [--dry-run]',
      summary: '生成证据包（请求/控制台/页面/完整性摘要）',
      examples: [
        'bridge debug evidence',
        'bridge debug evidence --output evidence.json --session a1b2',
        'bridge debug evidence --file archive.json --output evidence.json --dry-run',
      ],
      risk: RISK.LOCAL_WRITE,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({
        file: pathFlag('离线快照文件（不触达 daemon）'),
        output: pathFlag('证据包 JSON 输出路径'),
        ...SESSION_FLAGS,
      }),
    }),
    analyze: planSub('analyze', {
      usage: 'bridge debug analyze [--file <archive.json>] [--min-duration N] [--session <id>] [--dry-run]',
      summary: '分析失败/慢请求/重复 URL（可离线）',
      examples: ['bridge debug analyze', 'bridge debug analyze --file archive.json --min-duration 300'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({
        file: pathFlag('离线快照文件（不触达 daemon）'),
        'min-duration': flag('int', { min: 0, desc: '慢请求阈值毫秒（默认 500）' }),
        ...SESSION_FLAGS,
      }),
    }),
    journal: planSub('journal', {
      usage: 'bridge debug journal [--limit N] [--merged] [--session <id>] [--dry-run]',
      summary: '调试 + 操作事件时间线（--merged 合并成带 elapsedMs 的时间轴）',
      examples: ['bridge debug journal', 'bridge debug journal --merged --limit 50 --session a1b2'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({
        limit: flag('int', { min: 1, desc: '最多事件数（默认 100）' }),
        merged: bool('把 debug/operation 两条时间线合并成时间轴'),
        ...SESSION_FLAGS,
      }),
    }),
    replay: planSub('replay', {
      usage: 'bridge debug replay <id> [--session <id>] [--dry-run]',
      summary: '用当前页面同源 fetch 重放请求（会真实改服务端数据）',
      examples: ['bridge debug replay 5', 'bridge debug replay 5 --dry-run'],
      risk: RISK.BROWSER_MUTATION,
      positionals: { min: 1, max: 1, labels: ['<id>'] },
      positionalKinds: [{ index: 0, kind: 'int', label: '<id>' }],
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
    history: planSub('history', {
      usage: 'bridge debug history [--session <id>] [--dry-run]',
      summary: '最近的采集历史',
      examples: ['bridge debug history', 'bridge debug history --json'],
      risk: RISK.READ_ONLY,
      positionals: { min: 0, max: 0 },
      flags: mergeFlags({ ...SESSION_FLAGS }),
    }),
  }),
  order: [
    'start', 'stop', 'status', 'requests', 'request', 'console', 'pages', 'performance',
    'aggregate', 'duplicates', 'coverage', 'capabilities', 'pinned', 'pin', 'unpin', 'activity',
    'operations', 'operation', 'journal', 'history',
    'har', 'har-import', 'ws', 'export', 'archive', 'archives', 'query', 'evidence', 'analyze',
    'rule_add', 'rule_list', 'rule_enable', 'rule_disable', 'rule_remove', 'rule_clear',
    'rule_export', 'rule_import', 'fetch_probe', 'replay',
  ],
});

export const COMMAND_SPECS = Object.freeze({
  session: SESSION_SPEC,
  tab: TAB_SPEC,
  plan: PLAN_SPEC,
  replay: REPLAY_SPEC,
  step: STEP_SPEC,
  view: VIEW_SPEC,
  recipe: RECIPE_SPEC,
  open: OPEN_SPEC,
  extract: EXTRACT_SPEC,
  'wait-for-element': WAIT_ELEMENT_SPEC,
  'wait-for-navigation': WAIT_NAV_SPEC,
  video: VIDEO_SPEC,
  longshot: LONGSHOT_SPEC,
  record: RECORD_SPEC,
  debug: DEBUG_SPEC,
  trace: TRACE_SPEC,
});

export const COMMAND_TOPICS = Object.freeze(Object.keys(COMMAND_SPECS));

/** 全局帮助里的“可直接执行”示例（与 README 的高频命令一致）。 */
export const COMMON_EXAMPLES = Object.freeze([
  'bridge status',
  'bridge session start --browser edge',
  'bridge open https://example.com/ --observe',
  'bridge tab list --scope all',
  'bridge tab new https://example.com/',
  'bridge observe --json',
  'bridge plan --steps \'[{"method":"click","params":{"selector":"#go"}}]\'',
  'bridge session run-log a1b2 --limit 50',
  'bridge recipe list',
  'bridge recipe run checkout --param city=上海',
  'bridge extract table --target 1 --json',
  'bridge extract --selector table --format csv --out people.csv',
  'bridge wait-for-element "#submit" --timeout 20s',
  'bridge tab close 123 --dry-run',
  'bridge video start --duration 5s --dry-run',
  'bridge video save rec-a1b2 --out demo.webm',
  'bridge record start --include-agent --session a1b2',
  'bridge debug requests --filter /api/ --limit 20 --session a1b2',
  'bridge debug start --bodies --session a1b2 --dry-run',
  'bridge trace stop --out trace.json --session a1b2',
  'bridge trace view trace.json --dry-run',
  'bridge longshot recover ls-a1b2 --out shot.png --session a1b2',
]);

// ---------------------------------------------------------------------------
// 解析与校验
// ---------------------------------------------------------------------------

export function specFor(command) {
  return COMMAND_SPECS[String(command || '')] || null;
}

function subAliasTable(spec) {
  const table = new Map();
  for (const [name, subSpec] of Object.entries(spec.subs)) {
    table.set(name, name);
    for (const alias of subSpec.aliases || []) table.set(alias, name);
  }
  return table;
}

/** 解析子命令：不认识的子命令按 spec 的策略报错（E_BAD_SUBCOMMAND）。 */
export function resolveSub(spec, flags, pos) {
  const aliases = subAliasTable(spec);
  const requested = pos[1] !== undefined && pos[1] !== '' ? String(pos[1]) : null;
  if (requested && aliases.has(requested)) {
    const name = aliases.get(requested);
    return { name, subSpec: spec.subs[name] };
  }
  if (typeof spec.subOf === 'function') {
    const custom = spec.subOf(pos, flags);
    if (custom && spec.subs[custom]) return { name: custom, subSpec: spec.subs[custom] };
  }
  const fallback = spec.defaultSub || (spec.subs.default ? 'default' : null);
  if (fallback) {
    // 单子命令命令（plan/open/wait-*）不允许任意位置参数被当成子命令；
    // 剩余位置参数由 positionals 规则判定（多出来的会报 E_ARG_UNEXPECTED）。
    return { name: fallback, subSpec: spec.subs[fallback] };
  }
  if (!requested) {
    throw new ContractError('E_BAD_SUBCOMMAND', 'bridge ' + spec.command + ' 需要子命令：' + spec.order.join('|'), {
      hint: '用法：bridge ' + spec.command + ' <子命令>；用 bridge help ' + spec.command + ' 查看每个子命令的参数。',
      usage: 'bridge ' + spec.command + ' <子命令>',
      details: { subcommands: spec.order },
    });
  }
  throw new ContractError('E_BAD_SUBCOMMAND', 'bridge ' + spec.command + ' 没有子命令 "' + requested + '"', {
    hint: '可用子命令：' + spec.order.join('|') + '。用 bridge help ' + spec.command + ' 查看用法。',
    usage: 'bridge ' + spec.command + ' <子命令>',
    details: { subcommands: spec.order },
  });
}

function allowedFlagSet(spec, subSpec) {
  return new Set([
    ...GLOBAL_FLAGS,
    ...Object.keys(spec.flags || {}),
    ...Object.keys(subSpec.flags || {}),
  ]);
}

function allowedFlagList(spec, subSpec) {
  return [...allowedFlagSet(spec, subSpec)].sort().map((name) => '--' + name).join(' ');
}

function validateFlagValues(spec, subSpec, flags, context) {
  const definitions = { ...(spec.flags || {}), ...(subSpec.flags || {}) };
  for (const [name, definition] of Object.entries(definitions)) {
    if (!isSet(flags, name)) continue;
    checkValue(name, flags[name], definition, context);
  }
}

function applyPositionalKinds(subSpec, args, context) {
  for (const rule of subSpec.positionalKinds || []) {
    const value = args[rule.index];
    if (value === undefined) continue;
    checkPositional(value, rule.kind, rule.label || '<arg>', context);
  }
}

/**
 * 校验一次调用：返回 { command, sub, spec, subSpec, args, usage }。
 * 非目标命令返回 null（不做任何限制）。
 */
export function validateInvocation(command, flags, pos) {
  const spec = specFor(command);
  if (!spec) return null;
  const subName = (() => {
    try {
      return resolveSub(spec, flags, pos);
    } catch (error) {
      if (error instanceof ContractError && !error.usage) error.usage = 'bridge ' + spec.command + ' <子命令>';
      throw error;
    }
  })();
  const { subSpec } = subName;
  const usage = subSpec.usage || ('bridge ' + spec.command);
  const label = 'bridge ' + spec.command + (subName.name !== 'default' ? ' ' + subName.name : '');
  const context = { usage, label, topic: spec.command, sub: subName.name };
  assertAllowedFlags(flags, allowedFlagSet(spec, subSpec), {
    ...context,
    allowedList: allowedFlagList(spec, subSpec),
  });
  const offset = subSpec.posOffset !== undefined
    ? subSpec.posOffset
    : (subName.name === 'default' ? 1 : 2);
  const args = assertPositionals(pos, offset, subSpec.positionals || { min: 0, max: 0 }, context);
  applyPositionalKinds(subSpec, args, context);
  validateFlagValues(spec, subSpec, flags, context);
  assertRequires(flags, subSpec.requires || [], context);
  assertExclusive(flags, subSpec.exclusive || [], context);
  if (typeof spec.checks === 'function') spec.checks(flags, pos, context);
  for (const check of subSpec.checks || []) {
    try {
      check(flags, pos, context);
    } catch (error) {
      // 自定义检查可能没带 usage：统一补上，保证 --json 的 error.usage 恒有值。
      if (error instanceof ContractError && !error.usage) error.usage = usage;
      throw error;
    }
  }
  return { command: spec.command, sub: subName.name, spec, subSpec, args, usage };
}

// ---------------------------------------------------------------------------
// 帮助渲染（`bridge help <命令>` / `bridge <命令> --help`）
// ---------------------------------------------------------------------------

function renderFlagRows(definitions) {
  const rows = [];
  for (const [name, definition] of Object.entries(definitions || {})) {
    const kind = definition.kind || 'string';
    let value = '';
    if (kind === 'int' || kind === 'positive-int') value = ' <n>';
    else if (kind === 'tab-id') value = ' <tabId>';
    else if (kind === 'duration') value = ' <500ms|20s|2m>';
    else if (kind === 'enum') value = ' <' + definition.values.join('|') + '>';
    else if (kind === 'url') value = ' <url>';
    else if (kind === 'path' || kind === 'last-segment') value = ' <path>';
    else if (kind === 'json') value = ' <json>';
    else if (kind === 'key-value') value = ' <k=v>';
    else if (kind === 'name' || kind === 'string' || kind === 'session-id' || kind === 'color') value = ' <value>';
    else if (kind === 'alias') value = ' <alias>';
    rows.push(['--' + name + value, definition.desc || '']);
  }
  return rows;
}

function renderRiskLine(risks) {
  return risks.map((risk) => {
    const info = RISK_INFO[risk] || RISK_INFO.read_only;
    return risk + '（' + info.label + '）';
  }).join('、');
}

/** 渲染单个命令的完整帮助（用法 + 参数 + 风险 + 可执行示例）。 */
export function renderCommandHelp(command) {
  const spec = specFor(command);
  if (!spec) return '';
  const lines = [];
  lines.push('bridge ' + spec.command + ' —— ' + spec.summary);
  lines.push('');
  lines.push('用法：');
  for (const name of spec.order) {
    const subSpec = spec.subs[name];
    if (!subSpec) continue;
    lines.push('  ' + subSpec.usage);
    if (subSpec.summary && name !== 'default') lines.push('      ' + subSpec.summary);
  }
  lines.push('');
  lines.push('全局参数（所有子命令）：');
  const globalDefinitions = {};
  for (const name of GLOBAL_FLAGS) {
    const kind = name === 'port' ? 'int' : (name === 'timeout' ? 'duration' : 'bool');
    globalDefinitions[name] = { kind, desc: GLOBAL_FLAG_DOCS[name] };
  }
  for (const [syntax, desc] of renderFlagRows(globalDefinitions)) {
    lines.push('  ' + syntax + (desc ? '    ' + desc : ''));
  }
  const seen = new Set();
  for (const name of spec.order) {
    const subSpec = spec.subs[name];
    if (!subSpec) continue;
    const rows = renderFlagRows(subSpec.flags || {}).filter(([syntax]) => !seen.has(syntax));
    if (!rows.length) continue;
    lines.push('');
    lines.push((name === 'default' ? '本命令' : name) + ' 参数：');
    for (const [syntax, desc] of rows) {
      seen.add(syntax);
      lines.push('  ' + syntax + (desc ? '    ' + desc : ''));
    }
  }
  lines.push('');
  lines.push('风险：');
  const risks = [...new Set(spec.order.map((name) => spec.subs[name] && spec.subs[name].risk).filter(Boolean))];
  lines.push('  ' + renderRiskLine(risks) + '；risk=browser_mutation 的子命令建议先 --dry-run。');
  const examples = [];
  for (const name of spec.order) {
    const subSpec = spec.subs[name];
    for (const example of subSpec && subSpec.examples || []) examples.push(example);
  }
  if (examples.length) {
    lines.push('');
    lines.push('示例（可直接执行，<id> 替换成真实值）：');
    for (const example of examples) lines.push('  ' + example);
  }
  if (spec.notes && spec.notes.length) {
    lines.push('');
    lines.push('说明：');
    for (const note of spec.notes) lines.push('  - ' + note);
  }
  return lines.join('\n');
}

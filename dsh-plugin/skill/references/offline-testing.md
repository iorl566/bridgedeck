# 离线测试插件：fake adapter、矩阵与直连回退

> 摘要：不连 daemon/浏览器验证 37 个工具的方法：fake adapter 脚本化、四类场景、直连回退边界、profile 组合与生成物校验。

本文件说明如何**离线**验证 BridgeDeck DSH 插件。适用前提：本机可能没有独立 node，
用 Electron-as-node 跑（见 environment 参考）。所有命令在仓库根执行。

## 1. 三层测试金字塔（插件侧）

| 层 | 入口 | 覆盖 |
| --- | --- | --- |
| 工具定义/参数映射 | `tests/plugin/selftest.mjs` | 37 工具、参数→argv、apply() 注册、CLI 运行器 |
| 单元/离线矩阵 | `tests/unit/plugin-*.test.mjs`、`dsh-*.test.mjs` | 元数据、148 格矩阵、错误恢复、profile、直连 RPC、journal |
| 真实浏览器 | 仓库 `tools/e2e.mjs`（由统一门禁跑） | 端到端动作；插件不重复实现 |

## 2. fake adapter：可脚本化假 daemon

`dsh-plugin/lib/fake-adapter.mjs` 与 `daemonRpc` 同形：`call(method, params, {timeoutMs})`。

```js
import { createFakeAdapter } from './dsh-plugin/lib/fake-adapter.mjs';
import { buildToolSpecs } from './dsh-plugin/lib/tools.mjs';

const adapter = createFakeAdapter({
  handlers: {
    observe: { result: { url: 'https://example.test/', title: 'T', refs: 1, observation: '- document' } },
    click: { error: { code: 'E_STALE_REF', message: 'ref 失效' } },
    screenshot: { result: {}, delayMs: 90000 }, // 超过 timeoutMs 时按真实超时抛 E_TIMEOUT
  },
});
const cliCalls = [];
const run = async (argv) => { cliCalls.push(argv); return {}; };
const specs = buildToolSpecs(run, { rpc: adapter.call });
const observe = specs.find((spec) => spec.name === 'browser_observe');
const result = await observe.execute({ sessionId: 's1' }, {});
adapter.callsFor('observe'); // 调用序列，可断言 method/params/options
adapter.toJSON();            // 可序列化的复现记录
```

能力：按方法注册 `{result}`/`{error}`/`{delayMs}`/函数；`unavailable:true` 模拟 daemon 未运行
（全部抛 `E_DAEMON`）；`reset()` 清调用序列；未注册方法抛 `E_UNKNOWN_METHOD`。

## 3. 四类场景矩阵

`dsh-plugin/lib/tool-matrix.mjs` 为每个工具定义代表性调用（参数/通道/假结果/结果断言），
`runMatrix()` 跑 37 × 4 = 148 格：

- **success**：返回值经过工具自己的整形（`browser_read` 的 fields、`browser_status` 的 port 等）。
- **error**：`E_FORBIDDEN` 原样上抛；直连工具**不得**回退 CLI（否则业务错误会被静默替换）。
- **timeout**：`E_TIMEOUT` 不触发回退；`browser_session_start` 用同一 request-id 重试 2 次后上抛。
- **offline**：`E_DAEMON` 时只允许直连工具回退 CLI；纯 CLI 工具上抛 `E_DAEMON`。

```powershell
node dsh-plugin/scripts/tool-matrix.mjs           # 跑矩阵 + 写 TOOLS-MATRIX.md
node dsh-plugin/scripts/tool-matrix.mjs --check   # 校验报告与实现一致
node dsh-plugin/scripts/tool-matrix.mjs --json     # 只输出汇总
```

新增工具时：在 `TOOL_SCENARIOS` 加一条代表性调用与 `expect`，矩阵/文档/测试会一起覆盖。

## 4. 直连 RPC 回退边界

插件优先直连 daemon；回退判定单源在 `dsh-plugin/lib/error-recovery.mjs` 的
`canFallbackToCli`：

```js
import { canFallbackToCli, FALLBACK_CODES } from './dsh-plugin/lib/error-recovery.mjs';
canFallbackToCli({ code: 'E_DAEMON' });              // true
canFallbackToCli({ code: 'E_DIRECT_RPC_DISABLED' }); // true
canFallbackToCli({ code: 'E_TIMEOUT' });             // false（请求可能已执行）
canFallbackToCli({ code: 'E_FORBIDDEN' });           // false（业务错误原样交给模型）
```

`BB_PLUGIN_DIRECT_RPC=0` 时 `daemonRpc` 直接抛 `E_DIRECT_RPC_DISABLED`，插件回退 CLI——这是
“关闭直连”的受支持方式，不是故障。`tests/unit/plugin-direct-rpc.test.mjs` 用本机临时 HTTP
服务器验证：成功信封、错误信封、非 JSON、超时、连接拒绝、token 头与 `/rpc` 路径。

## 5. profile 组合（apply 契约）

`dsh-plugin/lib/index.mjs` 的 `apply(ctx, config)`：

- 配置项：`bridgeCli/nodePath/home/sessionScope/timeoutMs`（见 `cordis.patch.yml`）。
- **CLI 缺失不拖垮 profile**：只告警、不注册工具，技能仍注册。
- 技能注册：根 ctx 与每个 `agent/created` 的 agent ctx 各注册一次，`agent/disposed` 时释放。
- 37 个工具各自 `ctx.effect` 注册，返回 disposer；`apply` 返回后由 DSH 管理生命周期。
- 启动后台回收：`recoverOrphanStarts` 用 journal 的 stale 记录清理上次崩溃遗留的会话。

`tests/unit/plugin-profile.test.mjs` 用 stub 的 schemastery/dsh-tools 验证以上契约（离线）。

## 6. 启动 journal

`dsh-plugin/lib/start-journal.mjs`（`BB_HOME/dsh-starts.json`，version 1）：

- `add → ready/failed`；7 天过期、最多 100 条；原子写（tmp + rename）。
- 损坏/缺失文件从空开始；`reload()` 读回其它进程写入。
- `recoverOrphanStarts`：过期 starting → `session request --request-id` → ready 则 stop 并标
  `recovered`，否则 `stale`；查询失败记入结果但不崩。

`tests/unit/plugin-journal-depth.test.mjs` 覆盖上述边界（含 100 条上限与 7 天过期）。

## 7. 错误恢复输出

工具失败时入口把异常转成 `{ok:false, error:{code,retry,steps,docs}}`，`output.render` 渲染为：

```text
[失败] browser_act：E_STALE_REF — ...
重试语义：先完成一个具体动作，再重试（不要自动重试）
下一步：
  1. [工具] browser_observe —— 重新 observe 取新的 @eN，旧 ref 已失效
  2. [工具] browser_act —— 用新 ref 重新执行原动作；不要重放旧 ref
参考：references/actions-guide.md
```

错误码 → 动作表在 `lib/error-recovery.mjs`，测试逐条对照仓库 `lib/error-codes.mjs` 的 122 个码。

## 8. 生成物与守卫

```powershell
node dsh-plugin/scripts/build-skill-content.mjs           # 同步技能内容 + references
node dsh-plugin/scripts/build-skill-content.mjs --check   # 未同步即 exit 1
node dsh-plugin/scripts/build-tools-doc.mjs --check       # TOOLS.md 与 spec 一致
node tools/source-guard.mjs                               # 语法/编码/焦点守卫
```

生成物：`TOOLS.md`、`TOOLS-MATRIX.md`、`skill-content.generated.mjs`、`skill/`（含本文件）。
不要手改生成物；改实现后重跑生成器并提交 diff。

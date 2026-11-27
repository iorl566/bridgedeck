// cli/help.mjs —— `bridge help` 文本（命令总览 + 由协议 schema 生成的 flag 用法）。
import { COMMAND_TOPICS, COMMON_EXAMPLES } from './lib/command-specs.mjs';

export function createHelpCommand({ print, VERSION, loadSchemaInfo }) {
  return async function printHelp() {
  const { renderFlagUsage } = await loadSchemaInfo();
  const clickFlags = renderFlagUsage('click').join(' ');
  const fillFlags = renderFlagUsage('fill').join(' ');
  const topicLine = COMMAND_TOPICS.join(' | ');
  const examples = COMMON_EXAMPLES.map((example) => '  ' + example).join('\n');
  print(`BridgeDeck CLI v${VERSION}（bridge）

用法：
  bridge <命令> [参数] [--session <id>] [--json] [--port <n>] [--timeout <ms>]
  bridge help [method]   带 method 时由协议 schema 生成该方法的参数帮助

总览：
  open [url] [--observe]             新建会话（可带 URL 直接导航）；--observe 同时返回观察结果
  sync                             同步当前会话的控制上下文，≈ cooperate sync
  close [sessionId]                结束会话，≈ session stop
  ledger status                    查看预写意图账本（待确认/最近记录）
  ledger resolve <id> [--outcome abandoned|done]
                                   确认一条账本记录，解除同标签页的重放拦截
  status                           daemon + 浏览器 + session 总览
  diagnose [--session <id>]        只报告页面自动化痕迹（webdriver/扩展 DOM/CDP）
  agent brief --session <id>       面向 agent 的页面简报（引用/截断/对话框/下一步）
  cancel <commandId>               取消进行中的命令（协作式取消，需扩展支持）
  browsers                         已连接浏览器实例（含实例名）
  doctor                           环境自检
  settings [--json]                查看扩展设置
  ui [--page popup|options|preview|quick|record|debug|longshot|ops|audit] [--query k=v] [--diagnostics]
                                  在浏览器里打开扩展页面
  settings set [--label <名字>] [--allow-help on|off] [--control-hint on|off]
               [--page-guard on|off] [--long-shot auto|manual]
               [--daemon-url ws://host:port/ws] [--daemon-token <token>]
                                 借用前确认（--borrow-confirm）只能在扩展设置页改，CLI 不可改
  audit list [--since 24h] [--limit N] [--offset N]
  audit export --out <file> [--since 24h] [--format jsonl|json]
  audit prune --older-than 30d | --before <日期> [--dry-run]
  audit clear --yes
  install-skill [--harness <name>] [--dir <path>] [--force] [--list] [--all] [--source <dir>] [--embedded] [--mcp] [--commands]
                                  --mcp 同时写入 Codex/Cursor/Claude 的 MCP 客户端配置；--commands 同时写 Claude/Codex/Cursor 的斜杠命令
  mcp-install [--client claude|claude-desktop|cursor|opencode|vscode|windsurf|kilo|amp|copilot|kiro|qwen|all] [--dry-run]
                                  把 browser-bridge MCP server 写入客户端配置（JSON/JSONC；不覆盖不同配置）
  update check|verify|stage|fetch|state|auto [--manifest <path>] [--source <url>] [--out <path>] [--key <file>] [--force] [--download] [--apply --target <dir>]
                                  校验/暂存 dist/release.json（不自动替换当前安装）
  update install --from <zip|tar.gz> [--manifest <release.json>] [--dest <dir>] [--port <n>] [--no-restart] | --rollback <备份目录>
                                  装新 → 试跑 → 原端口重启；失败自动回滚到上一版本
  daemon start|stop|restart|status|log [--tail [N]] | logs [--tail N] [--follow]
  daemon start --foreground           沙箱宿主：前台运行，不 detach/unref
  daemon start --mode server --listen 0.0.0.0 --port 52900 --public-url wss://host:52900/ws --tls-pfx cert.pfx [--tls-passphrase ...]
  daemon pair [--replace <browserId>] | devices | revoke <code>|--all | rotate | trust-local on|off
  daemon pair [--replace <browserId>]      生成本机配对链接（5 分钟）
  daemon trust-local on|off                本机未配对连接是否允许（off=严格模式）
  daemon ledger [status] | snapshot [--out <file>] | restore | reconcile <tabId>|--all [--outcome confirmed|not-applied|reconciled] [--dry-run]
                                           意图账本：待确认/快照/恢复对账/批量和解（真实调用 ledger.*）
  daemon transfer [--limit N]              传输配额与 staging 诊断（并发/字节上限、续传进度、校验/清理计数）
  daemon queue [--limit N]                 命令队列诊断（排队/等待 P50·P95/拒绝原因/tab 公平性）
  daemon doctor [--json]                   daemon 侧自检（ledger/transfer/queue/recovery/storage），有 fail 时退出码 1
  daemon batch plan|start [--file <spec.json>]... [--items <json>] [--url <url>] [--on-error continue|abort|rollback]
                         [--concurrency N] [--retries N] [--max N] [--batch-id <id>] [--group <name>] [--dry-run] [--json] [--strict]
                                      批处理会话：配额准入/并发启动/失败回滚（退出码 0 成功、1 失败、3 部分成功、4 配额拒绝、5 取消）
  daemon batch status [<batchId>] | list [--state <state>] [--limit N] | cancel <batchId> | quota | schema [<schemaId>]
                                      批次状态/列表/取消/配额池/JSON schema 列表
  daemon lease report|conflicts [--strategy fifo|lru|priority|holder] [--limit N] [--tab <tabId>] [--json] [--strict]
                                      多会话 tab 所有权冲突的跨会话裁决计划（只读）
  daemon lease arbitrate [--apply --yes]  执行裁决步骤（默认 dry-run；--apply 需要 --yes 确认）

会话：
  session start [--browser <id|名字|edge|chrome>] [--tab <tabId>] [--share] [--control open|exclusive] [--focus] [--incognito] [--request-id <token>] [--allow-domains a,b] [--deny-domains x,y] [--min-interval 300ms]
  session prepare|claim|cancel|request --request-id <token>
                [--agent-name <name>] [--project <name>] [--controller-color <#rrggbb>]
                默认在后台新建 Agent Window（不抢焦点）；--focus 才置前
  session rebind <id> --tab <tabId> [--release-old]
  session stop <id> [--keep] | session stop --all           停止一个/所有会话
  session run-log <id> [--limit N]                        会话步骤日志（目标描述，不含输入值；recipe draft 的来源）
  session list
  session control <id> [--mode open|exclusive]     共享 tab 的控制权/租约状态（--mode 改仲裁模式）
  session claim-control <id> [--lease 60s] [--expect-epoch N]      认领/续租控制权（主会话可收回）
  session release-control <id> [--expect-epoch N]                 主动放弃控制权
  session handoff <id> --to <targetSessionId> [--lease 60s] [--expect-epoch N]
                                    把控制权显式转交给同一 tab 上的另一个会话（主会话停止会自动转交）

页面（省略 --session 且只有一个 session 时自动选用）：
  navigate <url> [--wait-until load|domcontentloaded|commit] | reload | back|navigate-back | forward|navigate-forward
  observe [--probe-hover] [--max-depth N] [--debug-surfaces] [--cdp-frames] [--save-full <path>] [--max-tokens N] [--cursor <token>] [--frames] [--closed-shadow] [--vom] [--actions] [--ax] [--facts] [--fallback-ax] [--compare-ax] [--pipeline page-lib|ax]
          [--delta --baseline <observationId>] [--out <path>]
                                   只读观察；文本原地变化时可用增量补丁，未命中基线自动回退整页
  snapshot
  get-html [--ref @eN | --selector css] [--out <file>]
  view [--grep <文本>] [--offset N] [--limit N]
  view <file> [--find <文本>] [--start-line N] [--line-count N]
  read [--ref @eN | --selector css] [--all] [--fields-json '<...>'] [--closed-shadow-text <文本>]
  extract discover [--max-targets N] [--preview-columns N] [--json]
  extract table|list --target <id> | --selector css [--item-selector css] [--fields-json <json>]
               [--max-rows N] [--max-bytes N] [--max-cells N] [--format json|csv] [--csv-safe] [--out <path>]
  screenshot --out <path> [--mode visible|auto|manual] [--scope viewport|document|follow|current] [--region x,y,w,h] [--overlap px]
             [--ref @eN | --selector css] [--annotate]
             [--grid [--grid-step 50]] [--profile x|y]   坐标网格 / 差分剖面（帮助"看图取坐标"）
  visuals                                       列出视觉候选（canvas / 图片 / 自绘区域）
  visual-drag --visual N --image-x X --image-y Y --image-dx N [--image-dy N] [--out p.png]
  visual-click --visual N --image-x X --image-y Y   一步式区域动作（截图→派发→命中校验）
  visual-gesture --visual N --points "x,y;x,y" | --plan f.json   多段手势（点选序列 / 多把手 / 长按）
  screenshot --mode manual --stitch --out <path>
  click <ref|selector> ${clickFlags} | click --capture <id> --image-x X --image-y Y | click --closed-shadow-text <文本>
  click-backend --backend <backendNodeId>   点击 AX/DOMSnapshot 发现但没有 ref 的元素（closed shadow 等）
  动作通用：--context <id> --observation <id> --expect '<json>' --depends-on '<json>' --settle 300ms --wait-timeout 5s
            --node-scope             节点级校验：只校验目标节点自身（detached/文本/值/属性），页面别处变化不拦（可配合 read）
            --focus                  显式置前（默认后台执行，不抢用户焦点；可信输入一般不需要）
  click --wait-navigation           点击后等 URL 变化且 document readyState=complete（最多 8s）
  hover | focus | scroll-to <ref|selector>
  fill <ref|selector> [--value <text>|--secret <NAME>] [--heal] [--synthetic] ${fillFlags}
  press <key> [--ref <ref>]
  select <ref|selector> --value <value> [--heal]
  drag <from> --to <to> | --dx N --dy N [--mode hold|click-move-click] [--hold 500ms] [--duration 800ms] [--modifiers ctrl+shift]
  drag --capture <id> --image-x X --image-y Y --image-dx N --image-dy N   视觉坐标拖拽（截图像素，强制原生输入）
  wheel --delta-y <n> [--delta-x <n>] [--ref @eN | --selector css]
  blur [--ref @eN | --selector css]
  upload <ref|selector> --file <path> [--file <path> ...]
  download <ref|selector> [--out <path>] [--overwrite] | download --url <url>
  evaluate <expression> [--unverified]
  wait-for-element <selector|@ref> [--state visible] [--timeout 20s]   # 超时 satisfied=false，退出码 0
  wait-for-navigation [--wait-until load|domcontentloaded|networkidle|commit] [--timeout 30s]
  wait-ms <ms>
  console [--since N] [--limit N] [--cursor N]

对话框 / 网络 / 仿真 / 协助：
  dialog arm [--alert accept|dismiss] [--confirm accept|dismiss] [--prompt accept|dismiss]
             [--prompt-text <t>] [--queue]
  dialog status | dialog accept <id> [--text <t>] | dialog dismiss <id>
  dialog arm|disarm | dialog list | dialog handle <id> --accept|--dismiss [--prompt-text <t>]
  operation await <id> [--timeout 60s] | operation cancel <id>
  cooperate sync [--policy auto|strict] [--probe-hover] [--match-text <t>] [--context-lines N]
  cooperate wait [--timeout 5s] | cooperate handback
  pair create [--ttl 10m] [--label x] [--host ip] [--scope read|control] [--replace] | devices | list | redeem <code> | renew <deviceId> [--scope read|control] | revoke <code|deviceId>
  video start [--duration 60s] [--quality standard|high] | status <id> | stop <id> | recover
  video save <id> --out <path> [--overwrite] | list | discard <id> | prune [--ttl 24h]
  record start [--screenshots] [--include-agent] | stop | status | list | export [id] [--out <dir>] [--screenshot]
  trace view <trace.json> [--debug <archive.json>] [--out <viewer.html>]   把 Trace v3 渲染成离线 HTML 查看器
  schema [method]   列出方法/作用域/effect/参数 schema（单一来源）
  debug start [--name <t>] [--bodies] | stop | status | export --output <file> | query --file <json> --filter <text>
  debug requests [--filter <子串>] | request <id> [--part headers|timing|request|response|all]
  debug console | pages | performance [--insight] | aggregate [--filter <子串>] [--slow-ms N]
  debug operations [--limit N] | operation <id> [--with-requests]
  debug capabilities | activity [--limit N] | pin <id> | unpin <id> | pinned
  debug fetch_probe [--ms 1500] | duplicates [--window-ms N] | rule_add --rule '<json>'|--rule-file <f>
  debug rule_export --output <file> | rule_import --file <rules.json> | rule_clear
  debug evidence [--output <file>] [--file <archive.json>] | archive --output <file> | archives --dir <dir> [--prune] [--max N] | analyze [--file <archive.json>] | query --file <archive.json>|--dir <dir> [--filter q] | journal [--limit N]
  debug rule_list | rule_enable <id> | rule_disable <id> | rule_remove <id> | rule_clear
  debug export --output <file> | replay <id> | history
  network start [--bodies] | stop
  network list [--filter <子串>] [--status <n>] [--method GET] [--limit N]
  network detail <id> | network replay <id>
  emulate [--device iphone-14|pixel-7|ipad-mini|...] [--width N --height N] [--dpr 2] [--mobile] [--ua ...] [--touch|--no-touch]
          [--timezone Asia/Shanghai]
          [--locale zh-CN] [--geolocation <lat>,<lon>] [--reset]
  request-help --reason <text> [--timeout ms] [--until '<json criteria>']

tab / window：
  tab list [--scope agent|user|all]
  tab new [url] [--focus] [--window]
  tab close <tabId> | tab select <tabId> | tab move <tabId> --to-window <windowId>
  tab borrow <tabId> | tab return <tabId>
  window list | window focus <windowId> | window ensure | window resize --width <n> --height <n>

流程：
  plan --steps '[{"method":"fill","params":{"ref":"@e1","value":"x"}},{"method":"click","params":{"ref":"@e2"}}]' | --steps-file <json> [--until-visible <selector>] [--wait-timeout-ms N] [--save-full <path>]
  step <method> [参数...] [--until-visible <selector>] [--wait-timeout-ms N] [--save-full <path>]
  recipe list | show <name> | save <name> --file <json>
  recipe draft --name <name> --session <id> [--limit N] [--max-steps N]
                                   从会话 run log 草拟 recipe（只含可回放步骤；值/参数不记录）
  recipe approve <name> --confirm-human [--by x]
  recipe run <name> [--param k=v ...] | rm <name>   # 支持 if/human/loop 块
                                   默认只回放只读/可逆步骤；含 click/fill 等风险步骤需先
                                   recipe approve <name> --confirm-human

全局参数：
  --session <id>   指定会话；只有一个 session 时可省略
  --session-scope <名字>  按 controller name/project 选唯一会话；优先级低于 --session
  BB_SESSION=<id> 环境变量兜底；未给 --session/--session-scope 时生效
  --json           stdout 输出单行 JSON（{"ok":true,"result":...} / {"ok":false,"error":{...}}）
  --quiet          抑制人类可读输出（JSON/错误不受影响）
  --verbose        把每次 RPC 的耗时打到 stderr
  --port <n>       daemon 未运行时自动拉起所用端口（默认 BB_PORT → 52900）
  --timeout <ms|20s|2m>   RPC 超时（默认 60000）
  -h, --help       显示本帮助

命令主题帮助（含参数表、风险与可直接执行的示例）：
  bridge help <命令>      命令主题：${topicLine}
  bridge <命令> --help    等价写法：bridge tab --help
  bridge help <method>    协议方法：由 schema 生成参数说明，例如 bridge help click

常用示例（可直接执行；<id> 换成真实值）：
${examples}

MCP：node mcp/server.mjs（stdio，50 个 browser_* 工具）

退出码：0 成功；1 业务失败；2 参数错误；6 对话框待处理（dialog_pending）`);
  };
}

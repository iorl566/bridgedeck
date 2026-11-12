# 网站调试

先开采集，再导航/复现，最后停止并保存。普通浏览、单次 console/network 读取不需要开采集。

```sh
bridge debug start [--bodies] [--name 复现登录问题] --session <id>
bridge debug status --session <id>
bridge debug stop --session <id>
bridge debug export --output debug.json --session <id>
bridge debug history
```

- `start` 必须在导航/复现之前，之前的流量不会补录；只有调查需要时才 reload。
- `--bodies` 挂 debugger 取请求/响应正文（单条上限 1MB，会出现“正在调试”提示条）；只采元数据不挂。
- `status` 采集中显示请求/控制台计数与 url；没在采集时列最近历史（扩展侧最多 10 条）。
- `stop` 落库并返回请求/控制台条数；`export` 把当前采集导出到本机 JSON。
- 采集有上限；不要把含凭据的请求体重放或导出。

## 读证据

```sh
bridge debug requests [--filter api] [--method POST] --session <id>
bridge debug request <id> [--part headers|timing|request|response|all] --session <id>
bridge debug console --session <id>
bridge debug pages --session <id>
bridge debug performance --session <id>
```

- `requests` 列 id/method/status/ms/type/url；没开 `--bodies` 时 `request` 只有 headers/timing。
- `pages` 给 url/title/视口/滚动尺寸/dpr；`performance` 给 TTFF、DOMContentLoaded、load、FCP、LCP、资源/传输字节、CLS、长任务。
- 列表省略正文是“没采到”，不是空响应；不要把 HTTP 200 当业务成功，也不要只凭时间相邻判定因果。

## 聚合与重复

```sh
bridge debug aggregate [--filter /api/] [--slow-ms 1000] --session <id>
bridge debug duplicates [--window-ms 1000] [--filter /api/] --session <id>
```

`aggregate` 按 method+origin/path 聚合次数/均值/最大/慢请求数/状态分布；`duplicates` 把窗口内相邻的同 method+path 请求聚簇，输出 count/span/first——合法重试与轮询也会命中。

## 命令时间线

```sh
bridge debug operations [--limit 20] [--since 1h]
bridge debug operation <id> [--with-requests]
```

审计里每条 RPC 有稳定 id 与耗时；有采集时按时间窗标注请求数（并发命令可能互相包含对方请求）。用它把失败/慢命令与请求对上，但这只是时间窗关联，不是精确归属。

## 网络与规则

```sh
bridge network start [--bodies] --session <id>
bridge network list [--filter api] [--method GET] [--status 500] [--limit 50] --session <id>
bridge network detail <id> --session <id>
bridge network replay <id> --session <id>

bridge debug rule_add --rule '{"urlPattern":"*/api/ping*","action":"fulfill","status":200,"body":"{\"ok\":false}"}'
bridge debug rule_add --rule-file rule.json --session <id>
bridge debug rule_list --session <id>
bridge debug rule_clear --session <id>
```

- 规则 `action` 为 `fulfill|block|modify`；`urlPattern` 支持 `*` 通配，同 tab 按添加顺序取第一条命中。
- 页面 fetch/XHR 由 MAIN world 包裹拦截；block/redirect 还同步为 DNR 子资源规则；`rule_list` 的 `dnr`/`fetch` 字段用于排查规则是否挂上。
- `network.replay` / `debug replay` 用当前页面同源 fetch 发**新请求**，会真实修改服务端数据；先看清请求再决定重放。
- 改完要验证页面行为；mock 成功不等于修复成功。`rule_clear` 清空规则并卸载拦截。

## Console

```sh
bridge console --session <id>
bridge console --since <ts> --session <id>
```

`--since` 是按时间戳过滤的数字，不是“3s”这种时长。开启 console 上报后页面可能自检到调试行为，敏感站点只在需要时用，并在导航前先读一遍。调试记录默认保存在浏览器本地，常见凭据脱敏；只有用户要求才导出。

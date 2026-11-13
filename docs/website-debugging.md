# 网站调试

网站调试把页面动作、网络请求、控制台、性能与页面快照关联起来，用于定位失败、慢请求和重复请求。

## 开始与停止

```powershell
node cli/bridge.mjs debug start --name "checkout" --bodies
node cli/bridge.mjs debug status
node cli/bridge.mjs debug stop
```

`--bodies` 保留响应体；默认只保留元数据，减少体积与敏感数据。

## 请求与响应

```powershell
node cli/bridge.mjs debug requests --filter checkout
node cli/bridge.mjs debug request <id> --part all
node cli/bridge.mjs debug operations --limit 50
node cli/bridge.mjs debug operation <id> --with-requests
```

- 请求带方法、URL、状态、资源类型、耗时、发起者与关联操作。
- 响应体按上限保留；超限标记截断。
- 密码、token、cookie 等敏感字段在采集时脱敏。

## 控制台与页面

```powershell
node cli/bridge.mjs debug console
node cli/bridge.mjs debug pages
node cli/bridge.mjs debug performance
node cli/bridge.mjs debug aggregate --slow-ms 800
```

控制台区分 log/exception；页面快照记录标题、URL、DOM 结构与 frame 归属。

## 重复请求

```powershell
node cli/bridge.mjs debug duplicates --window-ms 2000
```

按 URL、方法、时间窗口聚类，帮助发现重复提交或轮询风暴。

## 规则与重放

```powershell
node cli/bridge.mjs debug rule_add --rule '{"url":"/api/*","action":"block"}'
node cli/bridge.mjs debug rule_list
node cli/bridge.mjs debug rule_export --output rules.json
node cli/bridge.mjs debug replay <id>
```

规则可阻断、改写响应或重定向子资源；规则只在当前调试会话内生效。重放会重新发起一次已记录请求，并记录结果。

## 导出与归档

```powershell
node cli/bridge.mjs debug export --output debug.json
node cli/bridge.mjs debug archive --output debug-archive.json
node cli/bridge.mjs debug query --file debug-archive.json --filter error
node cli/bridge.mjs debug history
```

导出的证据包含请求、响应、控制台、操作、页面与性能；敏感字段保持脱敏。

## 弹窗面板

弹窗中的“网站调试”是内嵌面板：开始/停止当前标签页采集，显示请求/输出计数，并可直接打开完整调试页。

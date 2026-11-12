# 操作审计

操作审计记录 Agent 任务期间的操作，用于事后复盘。它和网站调试是两套独立数据：审计关注“谁在什么任务里做了什么”，调试关注“页面/网络发生了什么”。

## 开关

```powershell
node cli/bridge.mjs audit list --limit 20
```

弹窗“操作审计”面板可直接开关审计。开关保存在扩展本地设置，对之后到达的会话生效。

## 运行列表

```powershell
node cli/bridge.mjs audit list --since 24h --limit 20 --offset 0
```

每条运行包含：

| 字段 | 说明 |
| --- | --- |
| `id` | 运行 id |
| `browser_id` | 浏览器实例 |
| `session_id` | 会话 |
| `started_at` | 开始时间 |
| `updated_at` | 最后状态变化 |
| `status` | `running` / `ended` / `interrupted` |
| `name` / `site` | 任务名与站点 |
| `operations` / `errors` | 操作数与失败数 |
| `partial` | 是否已知不完整 |

## 查看与导出

```powershell
node cli/bridge.mjs ui --page audit
```

完整审计页可按运行查看事件时间线、操作详情与错误；支持导出。弹窗面板只显示最近 5 条，点击进入完整页。

## 隐私

- 审计文件只落在本机。
- 输入值、请求头、响应体按调试同一套脱敏规则处理。
- 关闭审计后不再写入新运行；已有记录保留到保留期结束。
- 删除运行会同时删除其事件。

## 与其他记录的区别

| 记录 | 用途 |
| --- | --- |
| 操作审计 | 任务级操作复盘 |
| 操作录制 | 用户操作序列，供 Agent 参考 |
| 网站调试 | 页面/网络证据 |
| Trace v3 | 录制步骤与状态导出 |
| 视频 | 任务过程视频 |

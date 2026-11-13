# 操作审计

操作审计记录 Agent 任务期间的方法调用元数据，用于事后复盘。它和网站调试是两套独立数据：审计关注“谁在什么任务里做了什么”，调试关注“页面/网络发生了什么”。

## 存储

- 位置：`~/.browser-bridge/audit/`（或 `BB_HOME/audit/`）
- 格式：按天一个 `YYYY-MM-DD.jsonl`，每行一条记录
- 默认开启；`BB_AUDIT=0` 可关闭
- 只记方法名、成功/失败、耗时、sessionId、tabId、结果 URL；**不记输入值、页面正文、请求头、响应体**

弹窗“操作审计”面板可查看最近记录；完整数据用 CLI。

## 列表

```powershell
bridge audit list --since 24h --limit 20 --offset 0
```

字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 记录 id |
| `ts` | 时间戳（毫秒） |
| `method` | 协议方法名 |
| `ok` / `code` | 成功或失败错误码 |
| `durationMs` | 耗时 |
| `sessionId` / `tabId` | 会话与标签页 |
| `url` | 结果 URL（若有） |

## 导出

```powershell
bridge audit export --out .\audit-export.jsonl
bridge audit export --out .\audit-export.json --format json --since 7d
```

导出文件权限尽量收紧到 0600；导出内容仍然是脱敏后的元数据。

## 清理

```powershell
# 删除 30 天前的记录（先 dry-run 看数量）
bridge audit prune --older-than 30d --dry-run
bridge audit prune --older-than 30d

# 或按日期
bridge audit prune --before 2026-10-01

# 清空全部（需要确认）
bridge audit clear --yes
```

`prune` 会保留时间戳不早于截止时间的记录；整天没有记录的文件会被删除。

## 隐私

- 审计文件只落在本机。
- 输入值、请求头、响应体不进入审计；URL 会做脱敏。
- 关闭审计后不再写入新记录；已有记录不会自动删除，需要手动 `prune` / `clear`。
- 删除文件不可恢复，清理前建议先 `audit export`。

## 与其他记录的区别

| 记录 | 用途 |
| --- | --- |
| 操作审计 | 方法级操作复盘 |
| 操作录制 | 用户操作序列，供 Agent 参考 |
| 网站调试 | 页面/网络证据 |
| Trace v3 | 录制步骤与状态导出 |
| 视频 | 任务过程视频 |

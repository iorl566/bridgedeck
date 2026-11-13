# 审计与 recipe 审批

## 审计

```sh
bridge audit list [--since 24h] [--limit 100] [--offset 0]
```

- daemon 侧审计只记录方法、耗时、结果码、会话、标签页、URL；不记录输入值、页面正文、截图。
- 扩展侧任务审计默认关闭，可在弹窗“操作审计”开启；审计页可清空。

## recipe（人工审批）

```sh
bridge recipe save <name> --file steps.json
bridge recipe approve <name> --confirm-human [--by 姓名]
bridge recipe run <name> --session <id> [--param k=v]
```

- 审批绑定步骤内容哈希，审批后改步骤返回 `E_RECIPE_CHANGED`。
- 审批 24 小时有效，过期返回 `E_RECIPE_EXPIRED`，需重新审批。
- 只有人类可以审批；Agent 不要伪造 `--confirm-human`。

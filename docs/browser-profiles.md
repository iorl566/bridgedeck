# 浏览器 Profile 绑定

BridgeDeck 连接的是“已加载扩展的那个浏览器 profile”；连接成功不等于识别到你想要的 profile。
CLI 不启动 Chrome/Edge，也不接受 `--profile-directory`。

## 绑定步骤

1. 在目标 profile 打开浏览器，进入目标网站并确认登录态。
2. 打开该 profile 里的 BridgeDeck 弹窗，确认显示“已连接”。
3. 用弹窗里的“复制指令”把带 `--browser` 的启动命令发给 Agent；或复制“实例 ID”：
   ```sh
   bridge browsers --json
   bridge session start --browser <instance-id> --json
   ```
4. 也可以用弹窗里保存的“浏览器名称”：
   ```sh
   bridge session start --browser "Work profile" --json
   ```

`--browser` 的顺序：instanceId 精确匹配 → 名称精确匹配 → `edge|chrome` 前缀唯一匹配。
如果多个实例同名，返回 `E_BROWSER_AMBIGUOUS`，必须改用 instanceId；不再静默选第一个。
未指定 `--browser` 时保留原有默认：优先 Edge，其次 Chrome，同类取最近连上的。

## Incognito

在扩展详情里开启“允许 InPrivate/隐身”，然后：

```sh
bridge session start --browser <instance-id> --incognito --json
```

Incognito 会话不能借用普通标签页；普通会话也不能借用 incognito 标签页。
缺少权限或旧协议会明确报错，不会退回普通窗口。

## 限制

- 没有自动 profile 发现，也没有持久化“任务必须用某个 profile”的约束；
- 名称是路由提示，不是安全边界；不要用名称替代 instanceId 做严格绑定；
- 复制 profile 会复制扩展存储，instanceId 可能相同，不能当作独立身份证明。

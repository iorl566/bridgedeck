# 排障

按“daemon → 扩展 → 会话 → 页面”的顺序排查，先确认下层状态，再看具体命令。

## 1. 先跑自检

```powershell
node cli/bridge.mjs doctor
node cli/bridge.mjs status
```

`doctor` 会检查 daemon、token、扩展 UI 与浏览器连接。

## 2. daemon

| 现象 | 处理 |
| --- | --- |
| `E_DAEMON` | 运行 `node cli/bridge.mjs daemon start`，或让 CLI 自动拉起 |
| 端口占用 | `daemon stop`，或换 `--port` / 设置本机端口 |
| 连接超时 | 检查防火墙、回环地址、`daemon.json` 是否指向当前进程 |
| 重启后 session 丢失 | 用 `session list` 查看；支持恢复的场景会保留 session |

## 3. 扩展

| 现象 | 处理 |
| --- | --- |
| `browsers` 为空 | 重新加载扩展；确认扩展已开启连接 |
| 实例号变化 | 扩展重连会沿用 `instanceId`；若变化，检查是否换了浏览器 profile |
| 无痕不可用 | 在扩展详情页允许 InPrivate；否则会返回 `E_INCOGNITO_UNAVAILABLE` |
| 弹窗空白 | 打开扩展详情页检查 service worker 是否报错；重新加载扩展 |

## 4. 会话

| 现象 | 处理 |
| --- | --- |
| `E_NO_SESSION` | `session list`，然后 `--session <id>` |
| 多 session 歧义 | 命令必须带 `--session` |
| 标签页不属于任务 | 先借用标签页，或让 Agent 开新窗口 |
| `E_CONTEXT_STALE` | 页面已导航；重新 `observe` 取新引用 |

## 5. 页面动作

| 现象 | 处理 |
| --- | --- |
| 元素找不到 | 重新 `observe`；selector 不跨 shadow/iframe |
| 点击无效果 | 用 `--trusted`；检查是否被遮挡、是否在 iframe |
| 填写被清空 | 用 `--no-clear` 追加，或检查页面受控组件 |
| 对话框阻塞 | `dialog status` / `dialog accept|dismiss` |
| 上传失败 | 文件路径必须存在；部分页面只接受文件选择器，用按钮触发 |
| 下载被拒绝 | 默认不覆盖；显式 `--overwrite` |

## 6. 录制与截图

| 现象 | 处理 |
| --- | --- |
| 视频一直 `finalizing` | 等编码完成；检查扩展是否被回收 |
| 视频保存失败 | 必须 `ready` 后保存；MP4 需要编码器支持 |
| 长截图重复/缺失 | 调整 `--overlap`；固定头尾用可见区域或手动模式 |
| 截图太小/空白 | 确认标签页可见；无痕/受限页需要权限 |

## 7. 提交问题时

附上：

```powershell
node cli/bridge.mjs doctor --json
node cli/bridge.mjs status --json
node cli/bridge.mjs daemon log --tail 100
```

并说明命令、session、页面类型与复现步骤。不要在日志里贴 token 或密码。

# 沙箱宿主下的 daemon

适配“宿主会在命令结束时杀掉子进程”的环境（bubblewrap、Windows Job Object、CI sandbox）。

## 前台模式

```powershell
bridge daemon start --foreground
```

- 不 `detach`、不 `unref`，daemon 进程归宿主任务所有。
- stdout/stderr 直接继承，宿主能收到退出原因。
- 宿主任务不结束时，其他 CLI 调用通过 `daemon.json` / 端口复用同一 daemon。
- 宿主任务结束，daemon 一起结束，这是预期行为。

## 后台模式与 Job 边界

默认 `bridge daemon start` 使用 detached 子进程。Windows 上 Node 没有暴露
`CREATE_BREAKAWAY_FROM_JOB`，所以如果宿主把命令放进 Job Object，detached 子进程仍可能随 Job 被杀。
当前实现不声称能绕过该 Job；需要跨任务常驻时，用宿主提供的持久执行上下文运行
`--foreground`，让宿主决定生命周期。

## 自动拉起

`BB_AUTO_START=0` 禁止 CLI 隐式启动 daemon：

```powershell
$env:BB_AUTO_START='0'
bridge daemon status
```

没有可达 daemon 时返回 `E_DAEMON`，提示先在主机上下文启动，不会静默起一个很快被宿主杀掉的进程。

## 验证

```powershell
$env:BB_HOME='...'
bridge daemon start --foreground   # 另一个终端/后台任务
bridge daemon status --json        # running=true
```

E2E/单测不覆盖 Windows Job breakaway（Node 无此 API）；这是明确的平台边界，不是宣称已支持。

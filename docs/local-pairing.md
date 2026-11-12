# 本地配对

配对把“本机浏览器实例”和一个 daemon 凭据绑定起来。未配对连接仍可用，但会显示身份警告；严格模式会关闭这个回退。

## 生成链接

```powershell
node cli/bridge.mjs daemon pair
```

输出一条 5 分钟有效的配对链接，形如：

```text
ws://127.0.0.1:52900/ws#<token>
```

在弹窗的“连接设置 → 配对链接”中粘贴并保存。保存后弹窗显示“已验证”。

## 远端配对

远程访问使用单独的配对码：

```powershell
node cli/bridge.mjs pair create --ttl 10m
node cli/bridge.mjs pair list
node cli/bridge.mjs pair redeem <code>
node cli/bridge.mjs pair revoke <code>
```

`pair redeem` 返回可写入扩展的 `wss://` 地址与 token。撤销会断开已经连接的实例。

## 严格模式

```powershell
node cli/bridge.mjs daemon trust-local off
```

- `on`：本机未配对连接可用，界面显示身份警告。
- `off`：只接受已配对连接；未配对请求直接拒绝。

配对成功后，凭据在扩展本地保存；升级和重启不会丢失。配对失败不会自动降级。

## 凭据与边界

- token 只出现在配对链接/本地存储，不写入日志或导出证据。
- 远端只接受 WSS；WS 仅允许回环地址。
- 配对码有时效，可撤销；撤销会踢掉已连接实例。
- 本机 daemon 默认只监听回环地址。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 链接过期 | 重新执行 `daemon pair` |
| 保存后仍显示未配对 | 检查弹窗是否收到 `localAuth` 状态；刷新弹窗 |
| 严格模式下连不上 | 先配对，或 `trust-local on` 恢复本机回退 |
| 远端连接被拒 | 确认 token、WSS 地址与 daemon 的 TLS 状态 |

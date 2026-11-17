# 远程 server 模式

默认 daemon 只监听 `127.0.0.1`。远程模式是**显式 opt-in**：需要自己提供 TLS 证书、
公开的 `wss://` 地址和网络入口；没有默认公网监听。

## 1. 准备证书

远程必须用 TLS。准备一个浏览器信任的 PFX（推荐由公司 CA/受信证书导出），例如：

```sh
# 本机测试可生成自签 PFX（远程浏览器需要先信任它）
powershell -NoProfile -ExecutionPolicy Bypass -File tools/make-cert.ps1 -OutFile C:\certs\bridge.pfx
```

自签证书只适合内网测试；正式使用请用受信证书，或把 daemon 放在 TLS 反代后面。
PFX 默认口令是 `browser-bridge`，可用 `--tls-passphrase` 覆盖。

## 2. 启动

```sh
bridge daemon start --mode server \
  --listen 0.0.0.0 --port 52900 \
  --public-url wss://browser.example.com:52900/ws \
  --tls-pfx C:\certs\bridge.pfx
```

- `--listen`：绑定地址；`0.0.0.0` 表示所有网卡，务必配防火墙/安全组。
- `--public-url`：扩展实际连接的完整 `wss://.../ws` 地址；NAT/反代时填外部地址。
- `--tls-pfx` / `--tls-passphrase`：服务端证书。
- server 模式会先停掉本机 daemon，再以新监听地址启动；本机扩展会短暂断开并重连。

## 3. 生成配对

```sh
bridge pair create --label "家里 MacBook" --ttl 10m [--scope read|control]
```

`--scope read` 生成只读设备：远端只能 observe/read/screenshot 等被动读，
click/fill/navigate/session.start 等变更命令返回 `E_FORBIDDEN`；默认 `control`。

输出：

- `link`：`wss://.../ws#<token>`，粘贴到另一台浏览器的扩展“连接设置 → 配对链接”；
- `code`：6 位配对码，也可在扩展里填写。

远程扩展必须能访问 `--public-url`，并且信任服务端证书。自签证书未导入信任库时，
扩展会拒绝连接，这是预期行为。

## 4. 管理与撤销

```sh
bridge pair list
bridge pair devices
bridge pair revoke <code>
bridge pair revoke --all
```

`pair.revoke` 会断开使用该 token 的远程实例。token 是 bearer 凭据，不要贴到公开日志；
`pair create` 有 TTL（默认 10 分钟，最长 24 小时）。

## 4.1 已记住的设备

远程扩展第一次成功连接后，daemon 会把设备凭据写入 `devices.json`（权限尽量 0600），
这样 daemon 重启后同一 token 仍可重连，不需要重新配对。

```sh
bridge pair devices
```

会列出已记住的设备 `deviceId/label/browser/instance/lastSeen`。撤销：

```sh
bridge pair revoke <deviceId>
```

也可以继续用 `pair.revoke <code>`；两种方式都会断开当前连接并删除设备记录。
`devices.json` 里保存恢复 HMAC 所需的 token 明文，和 `local-trust.json` 同级别，
不要把该目录同步到不可信位置。

续期（轮换 token，旧 token 立即失效）：

```sh
bridge pair renew <deviceId> [--scope read|control]
```

输出新的 `link`，需要粘贴到远端扩展；当前连接会被断开，远端必须用新 token 重连。

## 5. 反向代理 / 网关

推荐把 daemon 绑在 `127.0.0.1`，由 Caddy/Nginx 终止 TLS 并转发 `/ws`：

```sh
BB_BIND=127.0.0.1 BB_TLS=0 \
BB_PUBLIC_URL=wss://browser.example.com/ws \
bridge daemon start
```

Caddy：

```caddy
browser.example.com {
  reverse_proxy 127.0.0.1:52900
}
```

Nginx（需要 Upgrade 头）：

```nginx
location /ws {
  proxy_pass http://127.0.0.1:52900;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_read_timeout 3600s;
}
```

- 反代终止 TLS 时，daemon 用 `BB_TLS=0`，`BB_PUBLIC_URL` 仍写 `wss://`；
- 不要让 daemon 同时对外暴露明文端口；
- 需要按 IP/身份限流时，在反代层加 mTLS/登录网关；
- `/health` 可按需只在内网开放。

## 5.1 远程 viewer（只读预览）

daemon 提供只读预览页，用配对 token 或本机 token 鉴权：

```text
GET  /preview?session=<sessionId>&token=<pairToken|localToken>
GET  /preview/meta?session=<sessionId>&token=<pairToken|localToken>
GET  /preview/shot?session=<sessionId>&token=<pairToken|localToken>
POST /preview/click?session=<sessionId>&token=<pairToken|localToken>
POST /preview/key?session=<sessionId>&token=<pairToken|localToken>
POST /preview/focus?session=<sessionId>&token=<pairToken|localToken>
```

- 页面每 2s 拉一张 viewport 截图，`/preview/meta` 返回 viewport 尺寸用于坐标换算；
- 点击截图会映射到页面坐标，再按元素 selector 走 trusted click；
- `key` 发送按键（Enter/Tab 等）；read scope 设备返回 403；
- “聚焦标签页”调用 window.focus；
- token 放在 URL query，必须走 TLS/反代并设置 `Referrer-Policy: no-referrer`；
- 只读，不提供输入/点击；需要完整控制时仍用 CLI/扩展。

真机验证：`/preview` 返回 HTML，`/preview/shot` 返回 41KB PNG，
`/preview/meta` 返回 921×872，`/preview/click` 返回 selector `#submit-btn` 并触发页面结果，`/preview/key` 返回 `{"ok":true}`，`/preview/focus` 返回 `{"ok":true}`，错误 token 返回 401。

## 6. 验证


在 daemon 主机：

```sh
curl -k https://127.0.0.1:52900/health
```

应看到 `"tls":true`、`"bind"` 和 `"publicUrl"`。再执行 `bridge status` 确认 daemon 与扩展状态。

设备持久化可用集成测试验证（本机 loopback alias 模拟远端来源）：

```sh
node --test tests/integration/remote-device.test.mjs
```

覆盖：首次配对记录设备 → daemon 重启后同 token 重连 → 撤销后 token 被拒。

## 限制

- 没有自动公网 CA、DDNS、端口映射；这些由部署方负责。
- 配对 token 是对 bearer 凭据的简单授权，没有设备级细粒度权限/自动续期；
  需要更强设备管理时，应在反代层加 mTLS/身份网关。
- 远程文件上传/下载会被拒绝（daemon 与浏览器不在同一台机器），
  需在浏览器本机运行 CLI 处理文件。
- 远程连接同样受会话借用、暂停、审计策略约束。

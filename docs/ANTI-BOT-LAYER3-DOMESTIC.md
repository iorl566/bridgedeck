# 国内平台门槛实测：没有代理时的"真实站点"平替

> 实测时间：2026-11-16 15:05–15:25。环境同前两层：Edge 157 + BridgeDeck 0.1.3、出口 IP `110.80.15.22`（China Telecom，厦门）、**浏览器未登录任何平台**。
> 原则：只读。不登录、不加购、不点任何验证控件。原始数据 `.tmp-bench/layer3/out/`、`.tmp-bench/layer3/deep/`。

## 1. 这轮要回答的问题

第二层的结论是"浏览器环境已经干净，瓶颈在出口 IP"，但手里没有代理，做不了住宅 ↔ 机房对照。于是换一个问法：

- 同一台机器、同一个 IP，**换一批国内真实站点**，看门槛落在哪一层；
- 更关键的是：**这些门槛是不是我的自动化引来的**？用一个非浏览器客户端做对照就能分开。

## 2. 结果

### 首页（未登录）

| 站点 | Document | 页面 | 门槛 |
| --- | --- | --- | --- |
| taobao.com | 200 | 真实首页，商品瀑布流正常 | 只有"亲，请登录"入口 |
| jd.com | 200 | 真实首页，频道/搜索词齐全 | 只有"你好，请登录"入口 |
| dianping.com | 200 | 内容流正常（含城市、榜单） | "请登录/注册" + "去APP查看更多" |
| xiaohongshu.com/explore | 200 | 推荐流正常 | "登录后推荐更懂你的笔记" |

**结论：四家首页对未登录的真实浏览器全放行，没有滑块、没有风控页。**

### 深层路径（搜索）

| 站点 | 跳转链 | 最终表现 |
| --- | --- | --- |
| 淘宝 | `s.taobao.com/search` → `login.taobao.com/member/login.jhtml` → `main.m.tmall.com/app/vip/h5-webapp/third-party-cookie.html` → 回到 `s.taobao.com/search` | 页面壳在，列表区"加载中…"，XHR 拿不到数据 |
| 京东 | `search.jd.com/Search` → **`cfe.m.jd.com/privatedomain/risk_handler/03101900/`**（标题「京东验证」）→ `passport.jd.com/new/login.aspx?…&czLogin=1` | 直接停在登录页 |
| 大众点评 | `dianping.com/search/...` → `account.dianping.com/pclogin?redir=…` | 扫码登录页 |
| 小红书 | `search_result` → `search_result/`（同一页） | 页面内"登录后查看搜索结果" |

四家的"搜索"全部导向登录。淘宝是**客户端 JS 导流**（文档本身 200，壳能拿到），京东和点评是**服务端 302**，小红书是**页面内登录墙**。

## 3. 关键对照：JD 的 `risk_handler` 不是我引来的

京东这条最有信息量——它不是普通登录页，而是先经过 `risk_handler`（风控处理器，标题写「京东验证」）。要判断这算"风控识别了自动化"还是"这个 IP/会话本来就这样"，用**不带浏览器、不带 JS 的 curl** 打同一个 URL：

```
HEAD/GET https://search.jd.com/Search?keyword=耳机&enc=utf-8   (UA 与浏览器一致)
-> HTTP/1.1 302 Found
   Location: https://cfe.m.jd.com/privatedomain/risk_handler/03101900/?evtype=3&lgid=2193&returnurl=…
```

同一个 `risk_handler/03101900`，同样的跳转。作为补充，淘宝搜索对 curl 返回 **200**（说明它的导流是页面 JS 做的，不是服务端拒绝），点评对 curl 也是 302 到 `pclogin`。

**结论：京东的风控判定来自 IP / 无 cookie 会话，与浏览器指纹、CDP 附着、扩展注入都无关。** 这与第二层"cars/imf/g2 直接 403"的归因一致——把第一层修干净之后，出口 IP 和会话新鲜度成了主要变量。

另外，直接打开 `risk_handler` 那个页面，它只活了几百毫秒就被 JS 弹到 `passport.jd.com` 登录页（截图 `.tmp-bench/layer3/jd-verify.png`），**并没有出现滑块**。也就是说这条路径不是"验证码"，是"请你登录"。

## 4. 登录后深层路径（2026-11-16 补测）

用户用本人账号扫码登录淘宝后，同一 profile、同一会话、同一 IP 再跑一遍深层路径。登录由真人完成（`request-help` 等 180s），全程只读：没有进购物车、没有下单、没有改任何账号设置。

| 目标 | 未登录（第 2 节） | 登录后 |
| --- | --- | --- |
| `s.taobao.com/search?q=耳机` | 壳 + "加载中…"，列表不渲染 | **正常**：15 个商品链接，`1/100` 分页 |
| 搜索第 2/3/4 页 | 不可达 | **正常**：每页 20 个链接，导航 2.8–3.7s |
| `detail.tmall.com/item.htm?id=…` | 不可达 | **正常**：标题、价格（￥16.02）、店铺、评价数都渲染，导航 ~3.7s |
| 触发滑块 / 安全验证 | — | **4 页搜索 + 2 个详情页，0 次** |

结论很明确：**国内平台的门槛主要就是登录态**。有了登录 cookie，同一个"工具驱动的真实浏览器"在淘宝/天猫的深层路径上没有任何额外阻击——没有滑块、没有二次验证、没有风控页。

对比第 2 节：未登录时淘宝给的是"壳 + 永远加载中"，登录后立刻正常。这说明之前看到的"反爬"其实是"未授权"，两件事别混为一谈。

京东仍卡在登录：`search.jd.com` 依旧 302 到 `risk_handler/03101900` → `passport.jd.com`。这个 profile 没有京东登录态，本轮 `request-help` 请求 180s 未获响应，按规矩不重复请求，留待下次。大众点评、小红书同理。

## 5. 机制分类（对写自动化的人有用）

| 形态 | 判据 | 应对方向 |
| --- | --- | --- |
| 服务端风控 302 | 首包 302 到 `risk_handler` / `verify` / `punish` 一类路径 | 换 IP、养会话；改浏览器特征没用 |
| 客户端 JS 导流 | 首包 200，页面脚本跳登录，列表区长时间"加载中" | 需要登录态 cookie；签名在 XHR 里 |
| 服务端登录 302 | 302 到 `passport` / `pclogin` | 先解决登录，谈不上反爬 |
| 页面内登录墙 | 200 + "登录后查看" | 同上 |

四家本次都落在"登录/风控导流"，**没有一家给出滑块或点选验证码**。所以想测第三层（行为轨迹、滑块），真实站点是不合适的靶子——要么你已经登着录，要么直接被挡在门外。

## 6. 建议

1. **第三层请用靶场**，不要拿真实站点练手：Spiderbuf 的 C05/C02（拖拽滑块）、C06/C04（行为检测）、SpiderDemo 的滑块/点选/拼图题。它们本来就是为"测你的轨迹像不像人"设计的，也没有封号风险。
2. 真实站点即使登录了也测不到第三层：淘宝 4 页搜索 + 2 个详情页全程无滑块（第 4 节）。要逼出验证码得靠高频/异常节奏，那属于"制造风控"，不适合拿个人账号做。
3. 国内平台的正确测法不是"绕过"，而是"能不能在已登录的前提下稳定读到数据"——这属于后续的会话维持 + 动态签名课题，不是环境指纹课题。

## 7. 复现

```powershell
# 首页门槛
powershell -NoProfile -ExecutionPolicy Bypass -File .tmp-bench/layer3/domestic-probe.ps1 -Browser <instanceId>
# 深层搜索 + 跳转链
powershell -NoProfile -ExecutionPolicy Bypass -File .tmp-bench/layer3/domestic-deep.ps1 -Browser <instanceId>

# 非浏览器对照（证明风控与自动化无关）
curl.exe -sS -o NUL -D - --max-redirs 0 -A "<Chrome UA>" "https://search.jd.com/Search?keyword=%E8%80%B3%E6%9C%BA&enc=utf-8"
```

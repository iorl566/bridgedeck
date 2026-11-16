# tools/enumerate-spiderdemo.ps1 —— 遍历 SpiderDemo 全部挑战（需已登录）
#
# 该站的 sitemap 已大面积失效（/captcha/slideStitch 等旧路径全 404），
# 真实题目清单来自站内接口 /admin_I/api/challenges，必须带登录 Cookie。
# 所以本脚本先开页面、用页面内 fetch 取清单，再逐题导航采集。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/enumerate-spiderdemo.ps1 -Browser <id>
#   ... -Filter '验证码'      只跑某一类的 categoryDisplay
param(
  [string]$Browser = '',
  [string]$Out = '',
  [string]$Filter = ''
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\regression-helpers.ps1')
$root = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $root 'cli/bridge.mjs'
if (-not $Out) { $Out = Join-Path $root '.tmp-bench\spiderdemo' }
New-Item -ItemType Directory -Force -Path $Out | Out-Null

function B {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Command)
  $json = & node $cli @Command --json 2>&1 | Out-String
  $line = ($json -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -First 1)
  if (-not $line) { throw "bridge 无 JSON 输出：$($Command -join ' ')`n$json" }
  return ($line | ConvertFrom-Json)
}

$startArgs = @('session', 'start', '--no-focus')
if ($Browser) { $startArgs += @('--browser', $Browser) }
$sid = (B @startArgs).result.sessionId
Write-Host "session=$sid"

B navigate 'https://www.spiderdemo.cn/' --session $sid | Out-Null
Start-Sleep -Seconds 4

# 不用 await 表达式（某些页面 evel/awaitPromise 路径会返回 null），
# 改成"发起 fetch → 轮询 window 上的结果"，对环境更稳。
B evaluate "window.__sdChallenges = null; fetch('/admin_I/api/challenges').then(r => r.json()).then(j => { window.__sdChallenges = j && j.challenges ? j.challenges : []; }).catch(() => { window.__sdChallenges = []; }); 'started'" --session $sid | Out-Null
$catalog = $null
for ($i = 0; $i -lt 10; $i++) {
  Start-Sleep -Seconds 1
  $probeCount = "(window.__sdChallenges ? window.__sdChallenges.length : -1)"
  $n = (B evaluate $probeCount --session $sid).result.value
  if ($n -gt 0) { break }
}
$catalog = (B evaluate "window.__sdChallenges" --session $sid).result.value
if (-not $catalog) { B session stop $sid | Out-Null; throw "取挑战清单失败（多半是没登录）；请先在浏览器里登录 SpiderDemo 再跑" }
# 接口返回的是原始字段名，这里统一成脚本内部用的短名
$catalog = @($catalog | ForEach-Object {
  [pscustomobject]@{ id = $_.id; title = $_.title; cat = $_.categoryDisplay; diff = $_.difficulty; score = $_.score; url = $_.url }
})
if ($Filter) { $catalog = @($catalog | Where-Object { $_.cat -match $Filter }) }
Write-Host "challenges: $($catalog.Count)"

$probe = "(() => {
  const t = document.body ? document.body.innerText : '';
  return {
    title: document.title,
    len: t.length,
    canvas: document.querySelectorAll('canvas').length,
    imgs: document.querySelectorAll('img').length,
    inputs: document.querySelectorAll('input').length,
    sliders: document.querySelectorAll('[class*=slide], [class*=slider], [class*=drag], [class*=rotate]').length,
    notFound: /页面不存在/.test(t),
    needLogin: /请先登录/.test(t),
    head: t.replace(/\s+/g, ' ').slice(0, 80)
  };
})()"

# 真实 URL 映射从 main.js 的字面量里抽（站内清单的 url 字段对部分题不可靠）
$urlMap = @{}
try {
  $bundle = (Invoke-WebRequest 'https://www.spiderdemo.cn/static/js/main.js' -TimeoutSec 30 -UseBasicParsing).Content
  foreach ($m in [regex]::Matches($bundle, "['""](/(?:captcha|ob|ob1|css_anti|font_anti|sec1|sec2)/[^'""]+)['""]")) {
    $p = $m.Groups[1].Value
    $ct = [regex]::Match($p, 'challenge_type=([A-Za-z0-9_]+)').Groups[1].Value
    if ($ct -and -not $urlMap.ContainsKey($ct)) { $urlMap[$ct] = $p }
  }
  Write-Host ("main.js 抽取到 {0} 条挑战路径" -f $urlMap.Count)
} catch {
  Write-Warning "拉取 main.js 失败，退回候选 URL 试探：$($_.Exception.Message)"
}

$results = @()
foreach ($c in $catalog) {
  # 站内清单里的 url 字段对部分题不可靠（例如 cap1 写成 /css_anti/css_challenge），
  # 真实规则是「路径 + challenge_type=<id>」，验证码类还统一挂在 /captcha/ 下。
  # 因此按候选顺序逐个试，取第一个不是 404 的。
  $candidates = @()
  if ($urlMap.ContainsKey($c.id)) { $candidates += ('https://www.spiderdemo.cn' + $urlMap[$c.id]) }
  $candidates += ('https://www.spiderdemo.cn/captcha/' + $c.id + '?challenge_type=' + $c.id)
  $candidates += ('https://www.spiderdemo.cn/authentication/' + $c.id + '?challenge_type=' + $c.id)
  $candidates += ('https://www.spiderdemo.cn/ob1/' + $c.id + '?challenge_type=' + $c.id)
  $sep = if ($c.url -match '\?') { '&' } else { '?' }
  $candidates += ('https://www.spiderdemo.cn' + $c.url + $sep + 'challenge_type=' + $c.id)
  $candidates += ('https://www.spiderdemo.cn' + $c.url)
  $candidates = @($candidates | Select-Object -Unique)

  $chosen = $null; $v = $null; $sw = [System.Diagnostics.Stopwatch]::StartNew()
  foreach ($u in $candidates) {
    try {
      B navigate $u --session $sid | Out-Null
      Start-Sleep -Seconds 2
      $v = (B evaluate $probe --session $sid).result.value
      if ($v -and -not $v.notFound) { $chosen = $u; break }
    } catch { }
  }
  $sw.Stop()

  if ($chosen -and $v) {
    $state = if ($v.needLogin) { '需登录' } else { 'ok' }
    $results += [pscustomobject]@{
      id = $c.id; title = $c.title; cat = $c.cat; diff = $c.diff; score = $c.score; url = ($chosen -replace '^https://www\.spiderdemo\.cn','')
      state = $state; navMs = [int]$sw.ElapsedMilliseconds; len = $v.len
      canvas = $v.canvas; imgs = $v.imgs; inputs = $v.inputs; sliders = $v.sliders; head = $v.head
    }
    Write-Host ("{0,-4} {1,-22} {2,-6} nav={3,5}ms canvas={4,-2} imgs={5,-3} inputs={6,-3} slider={7} len={8}" -f $state, $c.title, $c.cat, $sw.ElapsedMilliseconds, $v.canvas, $v.imgs, $v.inputs, $v.sliders, $v.len)
  } else {
    $results += [pscustomobject]@{ id = $c.id; title = $c.title; cat = $c.cat; diff = $c.diff; score = $c.score; url = $c.url; state = '404'; navMs = [int]$sw.ElapsedMilliseconds; len = 0; canvas = 0; imgs = 0; inputs = 0; sliders = 0; head = '' }
    Write-Host ("404  {0,-22} 所有候选 URL 都 404" -f $c.title)
  }
}

try { B session stop $sid | Out-Null } catch { Write-Warning "停止会话失败" }
$results | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 (Join-Path $Out 'matrix.json')
Write-Host ("done -> " + (Join-Path $Out 'matrix.json'))

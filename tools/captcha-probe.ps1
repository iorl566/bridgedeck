# tools/captcha-probe.ps1 —— 验证码题型识别 + 输入通道自检（不解题）
#
# 对 SpiderDemo 的验证码题：导航 → 点「下一页」触发验证码 → 量几何 / 读指令 →
# （可选）-ChannelCheck 拖 100px 看滑块是否真的位移，再重载复位。
# 只做"题型是什么、需要什么手势、通道通不通"，不做图像识别、不提交答案。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/captcha-probe.ps1 -Browser <id>
#   ... -Filter 'slide|puzzle|rotate'    只跑匹配的题
#   ... -ChannelCheck                    额外做 100px 拖拽位移自检
param(
  [string]$Browser = '',
  [string]$Out = '',
  [string]$Filter = '',
  [switch]$ChannelCheck
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $root 'cli/bridge.mjs'
if (-not $Out) { $Out = Join-Path $root '.tmp-bench\captcha' }
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

# 1) 取题目清单（需登录）+ main.js 的路径映射
B navigate 'https://www.spiderdemo.cn/' --session $sid | Out-Null
Start-Sleep -Seconds 4
B evaluate "window.__capList = null; fetch('/admin_I/api/challenges').then(r => r.json()).then(j => { window.__capList = (j && j.challenges) ? j.challenges : []; }).catch(() => { window.__capList = []; }); 'started'" --session $sid | Out-Null
for ($i = 0; $i -lt 10; $i++) {
  Start-Sleep -Seconds 1
  if ((B evaluate "(window.__capList ? window.__capList.length : -1)" --session $sid).result.value -gt 0) { break }
}
$list = (B evaluate "window.__capList" --session $sid).result.value
if (-not $list) { B session stop $sid | Out-Null; throw '取不到题目清单（多半是没登录 SpiderDemo）' }

$urlMap = @{}
try {
  $bundle = (Invoke-WebRequest 'https://www.spiderdemo.cn/static/js/main.js' -TimeoutSec 30 -UseBasicParsing).Content
  foreach ($m in [regex]::Matches($bundle, "['""](/captcha/[^'""]+)['""]")) {
    $p = $m.Groups[1].Value
    $ct = [regex]::Match($p, 'challenge_type=([A-Za-z0-9_]+)').Groups[1].Value
    if ($ct -and -not $urlMap.ContainsKey($ct)) { $urlMap[$ct] = $p }
  }
} catch { Write-Warning "main.js 拉取失败：$($_.Exception.Message)" }

$targets = @($list | Where-Object { $_.categoryDisplay -eq '验证码' -and $_.enabled })
if ($Filter) { $targets = @($targets | Where-Object { $_.id -match $Filter -or $_.title -match $Filter }) }
Write-Host "验证码题：$($targets.Count)"

# 2) 逐题探针
$nextJs = "(() => { const b = Array.from(document.querySelectorAll('button')).find(x => /下一页/.test(x.innerText)); if (!b) return 'no-btn'; b.click(); return 'clicked'; })()"
$probe = "(() => {
  const t = document.body ? document.body.innerText : '';
  const tr = document.querySelector('.slider-move-track');
  const hd = document.querySelector('#sliderMoveBtn');
  const img = document.querySelector('.captcha-image, #captchaImage');
  const box = document.querySelector('.puzzle-captcha, [class*=captcha-container], [class*=verify-box]');
  const w = e => e ? Math.round(e.getBoundingClientRect().width) : 0;
  return {
    hint: (t.match(/请拖[^\n]{0,40}/) || [''])[0],
    instruction: box ? (box.innerText || '').replace(/\s+/g, ' ').slice(0, 60) : '',
    hasImage: !!img,
    imgIsBase64: img ? /^url\(.data:image/.test(getComputedStyle(img).backgroundImage) : false,
    trackW: w(tr), handleW: w(hd),
    canvas: document.querySelectorAll('canvas').length,
    nums: (t.match(/\d{4}/g) || []).length
  };
})()"
$posJs = "(() => { const h = document.querySelector('#sliderMoveBtn'); if (!h) return null; const r = h.getBoundingClientRect(); return Math.round(r.x); })()"

$rows = @()
foreach ($c in $targets) {
  $url = if ($urlMap.ContainsKey($c.id)) { 'https://www.spiderdemo.cn' + $urlMap[$c.id] } else { 'https://www.spiderdemo.cn/captcha/' + $c.id + '?challenge_type=' + $c.id }
  $row = [pscustomobject]@{ title = $c.title; id = $c.id; url = $url -replace '^https://www\.spiderdemo\.cn', ''; appeared = $false; hint = ''; instruction = ''; hasImage = $false; trackW = 0; handleW = 0; canvas = 0; channel = 'n/a' }
  try {
    B navigate $url --session $sid | Out-Null
    Start-Sleep -Seconds 3
    B evaluate $nextJs --session $sid | Out-Null
    Start-Sleep -Seconds 2
    $v = (B evaluate $probe --session $sid).result.value
    $row.appeared = [bool]$v.hint
    $row.hint = $v.hint; $row.instruction = $v.instruction
    $row.hasImage = $v.hasImage; $row.trackW = $v.trackW; $row.handleW = $v.handleW; $row.canvas = $v.canvas

    if ($ChannelCheck -and $v.trackW -gt 0 -and $v.handleW -gt 0) {
      $x0 = (B evaluate $posJs --session $sid).result.value
      B drag '#sliderMoveBtn' --dx 100 --duration 600ms --session $sid | Out-Null
      Start-Sleep -Milliseconds 400
      $x1 = (B evaluate $posJs --session $sid).result.value
      $row.channel = if ($null -ne $x0 -and $null -ne $x1 -and $x1 -ne $x0) { "moved $($x1 - $x0)px" } else { 'no-move' }
      B reload --session $sid | Out-Null
      Start-Sleep -Seconds 2
    }
    Write-Host ("{0,-16} appear={1,-5} track={2,-4} handle={3,-3} canvas={4} img={5,-5} | {6}" -f $c.title, $row.appeared, $row.trackW, $row.handleW, $row.canvas, $row.hasImage, $row.instruction)
  } catch {
    $row.hint = 'ERROR: ' + $_.Exception.Message
    Write-Host ("FAIL {0} {1}" -f $c.title, $_.Exception.Message)
  }
  $rows += $row
}

try { B session stop $sid | Out-Null } catch { }
$rows | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 (Join-Path $Out 'captcha-types.json')
Write-Host ("done -> " + (Join-Path $Out 'captcha-types.json'))

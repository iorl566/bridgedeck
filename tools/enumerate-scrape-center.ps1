# tools/enumerate-scrape-center.ps1 —— 遍历 Scrape Center 靶场案例，采集基线特征
#
# 该站（《Python3 网络爬虫开发实战》配套）分类清晰：
#   ssr1-4 / spa1-16 / captcha1-8 / login1-3 / websocket1 / antispider1-10
# App 系列（app1-9、appbasic）需要真机 App，浏览器测不了，默认排除。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/enumerate-scrape-center.ps1 -Browser <id>
#   ... -Filter 'antispider'        只跑反爬组
#   ... -Baseline .tmp-bench/scrape-center/matrix.json   与基线比对（回归模式）
param(
  [string]$Browser = '',
  [string]$Out = '',
  [string]$Filter = '',
  [string]$Baseline = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $root 'cli/bridge.mjs'
if (-not $Out) { $Out = Join-Path $root '.tmp-bench\scrape-center' }
New-Item -ItemType Directory -Force -Path $Out | Out-Null

function B {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Command)
  $json = & node $cli @Command --json 2>&1 | Out-String
  $line = ($json -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -First 1)
  if (-not $line) { throw "bridge 无 JSON 输出：$($Command -join ' ')`n$json" }
  return ($line | ConvertFrom-Json)
}

$cases = @(
  'ssr1','ssr2','ssr3','ssr4',
  'spa1','spa2','spa3','spa4','spa5','spa6','spa7','spa8','spa9','spa10','spa11','spa12','spa13','spa14','spa15','spa16',
  'captcha1','captcha2','captcha3','captcha4','captcha5','captcha6','captcha7','captcha8',
  'login1','login2','login3','websocket1',
  'antispider1','antispider2','antispider3','antispider4','antispider5','antispider6','antispider7','antispider8','antispider9','antispider10'
)
if ($Filter) { $cases = @($cases | Where-Object { $_ -match $Filter }) }

$startArgs = @('session', 'start', '--no-focus')
if ($Browser) { $startArgs += @('--browser', $Browser) }
$sid = (B @startArgs).result.sessionId
Write-Host "session=$sid  cases=$($cases.Count)"

$probe = "(() => {
  const t = document.body ? document.body.innerText : '';
  const rows = document.querySelectorAll('table tr').length;
  const cards = document.querySelectorAll('.el-card, .item, [class*=card]').length;
  const canvases = document.querySelectorAll('canvas').length;
  const imgs = document.querySelectorAll('img').length;
  return {
    title: document.title,
    len: t.length,
    rows: rows,
    cards: cards,
    canvas: canvases,
    imgs: imgs,
    evidence: rows + cards,
    blocked: /403|拒绝|访问受限|频率|封禁|过于频繁|Forbidden/.test(t),
    captcha: /验证码|滑动|拖动|点选|拼图/.test(t),
    login: /登录|Sign in|Username|密码/.test(t),
    head: t.replace(/\s+/g, ' ').slice(0, 90)
  };
})()"

$results = @()
foreach ($name in $cases) {
  $url = "https://$name.scrape.center/"
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    B navigate $url --session $sid | Out-Null
    $sw.Stop()
    Start-Sleep -Seconds 3
    $v = (B evaluate $probe --session $sid).result.value
    $results += [pscustomobject]@{
      case = $name; status = 'ok'; navMs = [int]$sw.ElapsedMilliseconds
      evidence = $v.evidence; rows = $v.rows; cards = $v.cards; len = $v.len
      canvas = $v.canvas; imgs = $v.imgs
      blocked = $v.blocked; captcha = $v.captcha; login = $v.login; title = $v.title; head = $v.head
    }
    Write-Host ("ok   {0,-12} nav={1,5}ms rows={2,-3} cards={3,-3} canvas={4,-2} len={5,-5} block={6} cap={7}" -f $name, $sw.ElapsedMilliseconds, $v.rows, $v.cards, $v.canvas, $v.len, $v.blocked, $v.captcha)
  } catch {
    $sw.Stop()
    $results += [pscustomobject]@{
      case = $name; status = 'error: ' + $_.Exception.Message; navMs = [int]$sw.ElapsedMilliseconds
      evidence = 0; rows = 0; cards = 0; len = 0; canvas = 0; imgs = 0
      blocked = $false; captcha = $false; login = $false; title = ''; head = ''
    }
    Write-Host ("FAIL {0,-12} {1}" -f $name, $_.Exception.Message)
  }
}

try { B session stop $sid | Out-Null } catch { Write-Warning "停止会话失败：$($_.Exception.Message)" }

$matrixPath = Join-Path $Out 'matrix.json'
$results | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $matrixPath
Write-Host "matrix -> $matrixPath"

# 回归模式：与基线比对（只看能否取到内容，以及证据数量是否退化）
if ($Baseline -and (Test-Path $Baseline)) {
  $base = Get-Content $Baseline -Raw | ConvertFrom-Json
  $baseMap = @{}
  foreach ($b in $base) { $baseMap[$b.case] = $b }
  $drift = @()
  foreach ($r in $results) {
    if (-not $baseMap.ContainsKey($r.case)) { continue }
    $b = $baseMap[$r.case]
    if ($b.status -ne 'ok') { continue }
    if ($r.status -ne 'ok') { $drift += "$($r.case): 基线可访问，现在报错（$($r.status)）"; continue }
    if ($b.evidence -ge 5 -and $r.evidence -lt 5) { $drift += "$($r.case): 证据数 $($b.evidence) -> $($r.evidence)" }
  }
  if ($drift.Count -gt 0) {
    Write-Host ("基线漂移 {0} 条：" -f $drift.Count)
    $drift | ForEach-Object { Write-Host "  - $_" }
    exit 1
  }
  Write-Host '与基线一致'
}

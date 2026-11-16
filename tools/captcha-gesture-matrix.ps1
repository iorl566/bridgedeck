# tools/captcha-gesture-matrix.ps1 —— 验证码"手势可行性"矩阵（不解题、不追求正确解）
#
# 对每种验证码依次试三种手势，只记录"页面是否受理"这个可观测量：
#   teleport : JS 直接改滑块位置 + 派发 input/change（完全不走鼠标事件）
#   fast     : CDP 原生拖拽，80ms（少点、瞬时）
#   slow     : CDP 原生拖拽，2000ms（多点、匀速）
#
# 判定用页面自己的反馈，不猜答案：
#   - 出现第 2 页数字 / 验证码消失  → accepted（罕见，说明蒙对了位置或该题不校验）
#   - 出现"失败/错误/请重试"文案      → rejected
#   - 无变化、滑块复位                → ignored / rejected
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/captcha-gesture-matrix.ps1 -Browser <id>
#   ... -Filter 'slide|puzzle|rotate'   只跑匹配题
param(
  [string]$Browser = '',
  [string]$Out = '',
  [string]$Filter = 'slide|puzzle|rotate|cap'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $root 'cli/bridge.mjs'
if (-not $Out) { $Out = Join-Path $root '.tmp-bench\captcha-gesture' }
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

# 清单 + 路径映射
B navigate 'https://www.spiderdemo.cn/' --session $sid | Out-Null
Start-Sleep -Seconds 4
B evaluate "window.__gList = null; fetch('/admin_I/api/challenges').then(r => r.json()).then(j => { window.__gList = (j && j.challenges) ? j.challenges : []; }).catch(() => { window.__gList = []; }); 'go'" --session $sid | Out-Null
for ($i = 0; $i -lt 10; $i++) { Start-Sleep -Seconds 1; if ((B evaluate "(window.__gList ? window.__gList.length : -1)" --session $sid).result.value -gt 0) { break } }
$list = (B evaluate "window.__gList" --session $sid).result.value
if (-not $list) { B session stop $sid | Out-Null; throw '取不到题目清单（需登录 SpiderDemo）' }

$urlMap = @{}
try {
  $bundle = (Invoke-WebRequest 'https://www.spiderdemo.cn/static/js/main.js' -TimeoutSec 30 -UseBasicParsing).Content
  foreach ($m in [regex]::Matches($bundle, "['""](/captcha/[^'""]+)['""]")) {
    $p = $m.Groups[1].Value
    $ct = [regex]::Match($p, 'challenge_type=([A-Za-z0-9_]+)').Groups[1].Value
    if ($ct -and -not $urlMap.ContainsKey($ct)) { $urlMap[$ct] = $p }
  }
} catch { Write-Warning "main.js 拉取失败：$($_.Exception.Message)" }

$targets = @($list | Where-Object { $_.categoryDisplay -eq '验证码' -and $_.id -match $Filter })
Write-Host "目标题：$($targets.Count)"

$nextJs = "(() => { const b = Array.from(document.querySelectorAll('button')).find(x => /下一页/.test(x.innerText)); if (!b) return 'no-btn'; b.click(); return 'clicked'; })()"
# 各题滑块类名不统一（#sliderMoveBtn / .slider-btn / ...），先找出来打个临时 id，后面统一拖它
$markHandleJs = "(() => {
  const cands = Array.from(document.querySelectorAll('[id*=slider], [class*=slider-btn], [class*=slider-handle], [class*=move-btn], [class*=handle], [class*=drag-btn]'));
  const el = cands.find(e => { const r = e.getBoundingClientRect(); return r.width >= 10 && r.width <= 90 && r.height >= 10; });
  if (!el) return null;
  el.id = '__bb_handle';
  const r = el.getBoundingClientRect();
  return { cls: String(el.className).slice(0, 40), w: Math.round(r.width), x: Math.round(r.x) };
})()"
$stateJs = "(() => {
  const t = document.body ? document.body.innerText : '';
  const h = document.getElementById('__bb_handle');
  const captchaOpen = /请拖|按住|依次点击|完成验证|完成拼图/.test(t);
  return {
    captchaOpen: captchaOpen,
    nums: (t.match(/\d{4}/g) || []).length,
    handleX: h ? Math.round(h.getBoundingClientRect().x) : null,
    feedback: (t.match(/(验证失败|验证成功|错误|请重试|重试|不正确)[^\n]{0,20}/) || [''])[0],
    pageNo: (t.match(/(\d+)\s*当前页/) || [])[1] || null
  };
})()"
$teleportJs = "(() => {
  const h = document.getElementById('__bb_handle');
  if (!h) return 'no-handle';
  h.style.transform = 'translateX(200px)';
  h.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  h.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  h.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return 'set';
})()"

function Try-Gesture {
  param([string]$Name, [string]$Title, [string]$Url)
  $out = [ordered]@{}
  # 每个手势都从干净页面开始
  B navigate $Url --session $sid | Out-Null
  Start-Sleep -Seconds 3
  B evaluate $nextJs --session $sid | Out-Null
  Start-Sleep -Seconds 2
  B evaluate $markHandleJs --session $sid | Out-Null
  $before = (B evaluate $stateJs --session $sid).result.value
  if (-not $before.captchaOpen) { return @{ gesture = $Name; state = 'no-captcha'; nums = $before.nums; feedback = ''; moved = 0 } }

  switch ($Name) {
    'teleport' { B evaluate $teleportJs --session $sid | Out-Null }
    'fast' { B drag '#__bb_handle' --dx 200 --duration 80ms --session $sid 2>&1 | Out-Null }
    'slow' { B drag '#__bb_handle' --dx 200 --duration 2000ms --session $sid 2>&1 | Out-Null }
  }
  Start-Sleep -Milliseconds 1200
  B evaluate $markHandleJs --session $sid | Out-Null
  $after = (B evaluate $stateJs --session $sid).result.value
  $moved = if ($null -ne $before.handleX -and $null -ne $after.handleX) { $after.handleX - $before.handleX } else { 0 }
  $state = if (-not $after.captchaOpen -and $after.nums -gt 0) { 'accepted' } elseif ($after.feedback) { 'rejected:' + $after.feedback } else { 'no-feedback' }
  return @{ gesture = $Name; state = $state; nums = $after.nums; feedback = $after.feedback; moved = $moved }
}

$rows = @()
foreach ($c in $targets) {
  $url = if ($urlMap.ContainsKey($c.id)) { 'https://www.spiderdemo.cn' + $urlMap[$c.id] } else { 'https://www.spiderdemo.cn/captcha/' + $c.id + '?challenge_type=' + $c.id }
  foreach ($g in @('teleport', 'fast', 'slow')) {
    try {
      $r = Try-Gesture -Name $g -Title $c.title -Url $url
      $rows += [pscustomobject]@{ title = $c.title; gesture = $g; state = $r.state; moved = $r.moved; nums = $r.nums; feedback = $r.feedback }
      Write-Host ("{0,-18} {1,-9} {2,-28} moved={3}" -f $c.title, $g, $r.state, $r.moved)
    } catch {
      $rows += [pscustomobject]@{ title = $c.title; gesture = $g; state = 'error: ' + $_.Exception.Message; moved = 0; nums = 0; feedback = '' }
      Write-Host ("{0,-18} {1,-9} ERROR {2}" -f $c.title, $g, $_.Exception.Message)
    }
  }
}

try { B session stop $sid | Out-Null } catch { }
$rows | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 (Join-Path $Out 'gesture-matrix.json')
Write-Host ("done -> " + (Join-Path $Out 'gesture-matrix.json'))

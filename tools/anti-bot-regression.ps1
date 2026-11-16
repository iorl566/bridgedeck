# tools/anti-bot-regression.ps1 —— 反爬回归（Spiderbuf 靶场三条）
#
# 3 条用例，包含一条"预期失败"：
#   C14 主流模拟浏览器检测  预期通过
#   C02 拖拽式滑块          预期通过（只校验位移）
#   C04 用户行为检测        预期不通过（行为门是当前能力边界）
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/anti-bot-regression.ps1 -Browser <instanceId>
# 退出码：0 全部符合预期；1 有偏差（含 C04 意外通过）
param(
  [string]$Browser = '',
  [string]$Out = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $root 'cli/bridge.mjs'
if (-not $Out) {
  $Out = Join-Path $root ('.tmp-bench/regression/' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
New-Item -ItemType Directory -Force -Path $Out | Out-Null

function B {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Command)
  $json = & node $cli @Command --json 2>&1 | Out-String
  $line = ($json -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -First 1)
  if (-not $line) { throw "bridge 无 JSON 输出：$($Command -join ' ')`n$json" }
  return ($line | ConvertFrom-Json)
}

function B-Checked {
  param([string[]]$Command, [string]$SessionId)
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    $argv = @($Command)
    if ($SessionId) { $argv += @('--session', $SessionId) }
    $reply = B @argv
    if ($reply.ok -eq $true) { return $reply }
    $code = if ($reply.error) { $reply.error.code } else { '' }
    if ($code -eq 'E_SESSION_PAUSED' -and $attempt -eq 1) {
      B session resume --session $SessionId | Out-Null
      continue
    }
    $msg = if ($reply.error) { "$code $($reply.error.message)" } else { ($reply | ConvertTo-Json -Compress) }
    throw "bridge $($Command[0]) 失败：$msg"
  }
}

$startArgs = @('session', 'start', '--no-focus')
if ($Browser) { $startArgs += @('--browser', $Browser) }
$sid = (B @startArgs).result.sessionId
Write-Host "session=$sid  out=$Out"

$results = @()

# ---------- C14：模拟浏览器检测，预期通过 ----------
try {
  B-Checked -Command @('navigate', 'https://spiderbuf.cn/challenge/anti-simulate-web-browser') -SessionId $sid | Out-Null
  Start-Sleep -Seconds 3
  # 单行表达式：多行 JS 经 PowerShell 5.1 的原生参数转发会丢引号，这里保持一行
  $extract = "(() => { const cps = Array.from(document.querySelectorAll('.data-cpc')).map(e => parseFloat(String(e.textContent).replace(/[^0-9.]/g, ''))); return { n: cps.length, sum: cps.reduce((a, b) => a + b, 0) }; })()"
  $data = $null
  $loads = 0
  # C14 的数据下发不稳定：同一 URL 连续加载会出现"有数据/无数据"交替，
  # 所以整页重载重试，而不是只轮询 DOM。
  for ($i = 0; $i -lt 4; $i++) {
    $loads = $i + 1
    if ($i -gt 0) {
      B-Checked -Command @('reload') -SessionId $sid | Out-Null
    }
    Start-Sleep -Seconds 4
    $data = (B-Checked -Command @('evaluate', $extract) -SessionId $sid).result.value
    if ($data -and $data.n -ge 5) { break }
  }
  if (-not $data -or $data.n -lt 5) {
    $diag = (B-Checked -Command @('evaluate', "(() => ({ title: document.title, url: location.href, cards: document.querySelectorAll('.data-cpc').length, len: document.body ? document.body.innerText.length : -1 }))()") -SessionId $sid).result.value
    throw "C14 数据未取到（loads=$loads n=$($data.n)） page=[$($diag.title)] cards=$($diag.cards) len=$($diag.len)"
  }
  $avg = [math]::Round($data.sum / $data.n, 2).ToString('0.##', [System.Globalization.CultureInfo]::InvariantCulture)
  Write-Host ("C14 抓到 {0} 条（第 {1} 次加载），均值 {2}" -f $data.n, $loads, $avg)

  B-Checked -Command @('navigate', 'https://spiderbuf.cn/challenge/verify/anti-simulate-web-browser') -SessionId $sid | Out-Null
  Start-Sleep -Seconds 3
  $refs = B-Checked -Command @('observe', '--max-tokens', '600') -SessionId $sid
  $obs = [string]$refs.result.observation
  $inputRef = ([regex]::Match($obs, 'spinbutton "[^"]*" \[(@e\d+)\]')).Groups[1].Value
  $buttonRef = ([regex]::Match($obs, 'button "提交验证" \[(@e\d+)\]')).Groups[1].Value
  if (-not $inputRef -or -not $buttonRef) { throw 'C14 验证页没找到输入框/提交按钮' }
  B-Checked -Command @('fill', $inputRef, '--value', $avg) -SessionId $sid | Out-Null
  B-Checked -Command @('click', $buttonRef, '--settle', '1500ms') -SessionId $sid | Out-Null
  Start-Sleep -Seconds 3
  $verdictExpr = "document.body.innerText.includes('恭喜你答对啦')"
  $verdict = (B-Checked -Command @('evaluate', $verdictExpr) -SessionId $sid).result.value
  $results += [pscustomobject]@{ case = 'C14 模拟浏览器检测'; expect = 'pass'; actual = if ($verdict) { 'pass' } else { 'fail' } }
} catch {
  $results += [pscustomobject]@{ case = 'C14 模拟浏览器检测'; expect = 'pass'; actual = 'error: ' + $_.Exception.Message }
}

# ---------- C02：滑块，预期通过 ----------
try {
  B-Checked -Command @('navigate', 'https://spiderbuf.cn/challenge/scraper-practice-c02') -SessionId $sid | Out-Null
  Start-Sleep -Seconds 3
  $geo = "(() => { const h = document.querySelector('[id=slider]'); if (!h) return { found: false }; const r = h.getBoundingClientRect(); const t = h.parentElement ? h.parentElement.getBoundingClientRect() : null; return { found: true, dx: t ? Math.round(t.width - r.width) : 250 }; })()"
  $g = (B-Checked -Command @('evaluate', $geo) -SessionId $sid).result.value
  if (-not $g.found) { throw 'C02 没找到滑块' }
  B-Checked -Command @('drag', '[id=slider]', '--dx', ([string]$g.dx), '--duration', '80ms') -SessionId $sid | Out-Null
  Start-Sleep -Seconds 3
  $rows = (B-Checked -Command @('evaluate', "document.querySelectorAll('table tr').length") -SessionId $sid).result.value
  Write-Host ("C02 拖动 dx={0}，表格行数={1}" -f $g.dx, $rows)
  $results += [pscustomobject]@{ case = 'C02 拖拽滑块'; expect = 'pass'; actual = if ($rows -gt 5) { 'pass' } else { "fail(rows=$rows)" } }
} catch {
  $results += [pscustomobject]@{ case = 'C02 拖拽滑块'; expect = 'pass'; actual = 'error: ' + $_.Exception.Message }
}

# ---------- C04：行为门，预期不通过 ----------
try {
  B-Checked -Command @('navigate', 'https://spiderbuf.cn/challenge/scraper-practice-c04') -SessionId $sid | Out-Null
  Start-Sleep -Seconds 3
  $check = "(() => { const cb = document.querySelector('input[type=checkbox]'); if (!cb) return null; const r = cb.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()"
  $pt = (B-Checked -Command @('evaluate', $check) -SessionId $sid).result.value
  if (-not $pt) { throw 'C04 没找到复选框' }
  # 确认点击点确实落在复选框上，避免"点歪了"被误读成"行为门拒绝"
  $hit = "(() => { const cb = document.querySelector('input[type=checkbox]'); const el = document.elementFromPoint($($pt.x), $($pt.y)); return { onTarget: el === cb, checked: cb.checked }; })()"
  $before = (B-Checked -Command @('evaluate', $hit) -SessionId $sid).result.value
  B-Checked -Command @('click', 'input[type=checkbox]', '--trusted', '--settle', '1200ms') -SessionId $sid | Out-Null
  Start-Sleep -Seconds 2
  $after = (B-Checked -Command @('evaluate', $hit) -SessionId $sid).result.value
  Write-Host ("C04 命中目标={0} checked: {1} -> {2}" -f $before.onTarget, $before.checked, $after.checked)
  if (-not $before.onTarget) {
    $results += [pscustomobject]@{ case = 'C04 行为门'; expect = 'fail'; actual = 'error: 点击点不在复选框上，判定不成立' }
  } else {
    $results += [pscustomobject]@{ case = 'C04 行为门'; expect = 'fail'; actual = if ($after.checked) { 'pass(意外通过)' } else { 'fail' } }
  }
} catch {
  $results += [pscustomobject]@{ case = 'C04 行为门'; expect = 'fail'; actual = 'error: ' + $_.Exception.Message }
}

B session stop $sid | Out-Null

$results | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 (Join-Path $Out 'result.json')
$results | Format-Table -AutoSize | Out-String | Write-Host

$bad = @($results | Where-Object { $_.expect -ne $_.actual })
if ($bad.Count -gt 0) {
  Write-Host ("偏差 {0} 条：{1}" -f $bad.Count, (($bad | ForEach-Object { $_.case + '=' + $_.actual }) -join '; '))
  exit 1
}
Write-Host '全部符合预期'
exit 0

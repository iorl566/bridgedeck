# tools/captcha-drive-matrix.ps1 —— 验证码交互通道矩阵：只看"能不能驱动"，不判对错。
#
# 每题只发一次刻意无解的手势，记录页面反馈类型：
#   rejected  -> 明确报错 / 题目被重置（说明事件被接收并判定）
#   no-feedback -> 无任何反应（通道可能没打通，或需要别的动作）
#   advanced  -> 页面推进（极少见，说明那一步不需要解）
#
# 手势按题型分开（2026-11-16 重写）：
#   drag   ：拖滑块手柄（滑动拼图 / 刮刮乐 / 圆柱）
#   hold   ：按住再拖（按压旋转：先按住 .press-btn 800ms 再动）
#   points ：点选序列（点击拼图：两块拼图各点一次，再点「提交」触发判定）
#   dual   ：两个手柄依次拖（双滑块）
#
# 反馈不只看动作后那一刻：失败文案可能 1 秒后才出现、几百毫秒就换掉。
# 所以动作后按 300ms 粒度采样一个窗口，命中任一信号就提前结束。
#
# 不解验证码、不重试、不试错扫描：一次一题，结果写进 JSON。
param(
  [string]$Browser = '',
  [string]$Session = '',
  [int]$Limit = 0,
  [string]$Only = '',
  [string]$Out = '.tmp-bench/captcha-drive'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
. (Join-Path $PSScriptRoot 'lib\regression-helpers.ps1')
New-Item -ItemType Directory -Force -Path $Out | Out-Null

$cli = Join-Path $root 'cli\bridge.mjs'
$sid = $Session
$startedByUs = $false
if (-not $sid) {
  $sid = New-BridgeSession -Cli $cli -Browser $Browser
  $startedByUs = $true
}

$cases = @(
  @{ id = 'slide_puzzle_challenge';  title = '滑动拼图'; gesture = 'drag'; dx = 60 },
  @{ id = 'slide_scratch_challenge'; title = '滑动刮刮乐'; gesture = 'drag'; dx = 80 },
  @{ id = 'slide_cylinder_challenge'; title = '圆柱验证码'; gesture = 'drag'; dx = 60 },
  # 长按类：按住 .press-btn 800ms 再拖 20px。按压旋转的控件是按钮，不是题图；
  # 题图按下去什么都不发生（已核对命中元素），必须走按钮。走可信指针流，长按时序才准。
  @{ id = 'press_rotate_challenge';  title = '按压旋转'; gesture = 'hold'; selector = '.press-btn'; dx = 20; hold = '800ms'; trusted = $true },
  # 点选类：visuals 在这一页返回的是四块 140x140 的 .piece，不是整张 280x280 图。
  # 所以按"不同候选各点一次"做序列；点完再点「提交」才会判定（判定文案延迟约 1.2s）。
  @{ id = 'click_stitch_challenge';  title = '点击拼图'; gesture = 'points'; confirm = '.submit' },
  # 多把手类：两个手柄依次右移。第二个别用负位移：轨道起点会夹住，等于没动。
  @{ id = 'cap6_challenge'; title = '双滑块';     gesture = 'dual'; dx1 = 50; dx2 = 40 }
)
if ($Only) { $cases = @($cases | Where-Object { $_.id -match $Only }) }
if ($cases.Count -eq 0) { throw "没有匹配 -Only 的题型：$Only" }
if ($Limit -gt 0) { $cases = @($cases | Select-Object -First $Limit) }

function ConvertTo-OneLine {
  param([string]$Text)
  return (($Text -split "`r?`n" | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() }) -join ' ')
}

function Get-HandleSelector {
  param($Handle)
  if ($Handle.id) { return '#' + $Handle.id }
  $first = ([string]$Handle.cls -split ' ')[0]
  if (-not $first) { return '' }
  return '.' + $first
}

$nextProbe = ConvertTo-OneLine @'
(() => {
  const b = Array.from(document.querySelectorAll('button')).find((x) => /下一页/.test(x.innerText));
  if (b) b.click();
  return 'ok';
})()
'@

# 前置断言：先确认控件真的渲染出来了，再谈通道。
# 该站同一题型在不同时间可能完全不出控件，把"没渲染"记成"没反应"会得出错误结论。
$widgetProbe = ConvertTo-OneLine @'
(() => {
  const img = document.querySelector('#captchaImage');
  const ir = img ? img.getBoundingClientRect() : null;
  const handleSel = '[class*=slider-btn],[class*=slider-move],[id*=slider-btn],[id*=sliderMove],[class*=handle],[class*=press-btn]';
  let handle = null;
  for (const el of document.querySelectorAll(handleSel)) {
    const r = el.getBoundingClientRect();
    if (r.width >= 6 && r.height >= 6) { handle = { w: Math.round(r.width), h: Math.round(r.height) }; break; }
  }
  return { image: ir ? { w: Math.round(ir.width), h: Math.round(ir.height) } : null, handle, canvases: document.querySelectorAll('canvas').length };
})()
'@

# 反馈探针：一次采样同时读"失败/成功文案、是否在重新加载、题图是否换了、页码/已采集页是否推进"。
# 页码只认"第 N 页，共 M 页"和"已采集页数"前面的数字：题面里还有别的地方出现数字。
$stateProbe = ConvertTo-OneLine @'
(() => {
  const t = document.body ? document.body.innerText : '';
  const img = document.querySelector('#captchaImage');
  const bg = img ? String(getComputedStyle(img).backgroundImage || '').slice(0, 160) : '';
  const toast = (t.match(/验证失败|验证不通过|请重试|验证成功|通过验证|验证通过/g) || []);
  const loading = /正在加载验证码/.test(t);
  const collected = (t.match(/(\d+)\s*\n\s*已采集页数/) || [])[1] || '';
  const page = (t.match(/第\s*(\d+)\s*页，共\s*(\d+)\s*页/) || [])[1] || '';
  return { bg, toast, loading, collected, page };
})()
'@

$results = @()
foreach ($case in $cases) {
  $url = 'https://www.spiderdemo.cn/captcha/' + $case.id + '?challenge_type=' + $case.id
  & node $cli navigate $url --session $sid --json 2>&1 | Out-Null
  Start-Sleep -Milliseconds 2600
  & node $cli evaluate $nextProbe --session $sid --json 2>&1 | Out-Null

  $widget = $null
  for ($attempt = 0; $attempt -lt 5; $attempt += 1) {
    $w = Invoke-BridgeJson -Cli $cli -BridgeArgs @('evaluate', $widgetProbe, '--session', $sid, '--json')
    if ($w.ok -and $w.result.value) {
      $widget = $w.result.value
      $ready = ($widget.image -and $widget.image.w -ge 40) -or ($widget.handle -and $widget.handle.w -ge 6) -or ($widget.canvases -gt 0)
      if ($ready) { break }
    }
    Start-Sleep -Milliseconds 1200
  }
  $widgetReady = $false
  if ($widget) {
    $widgetReady = ($widget.image -and $widget.image.w -ge 40) -or ($widget.handle -and $widget.handle.w -ge 6) -or ($widget.canvases -gt 0)
  }

  if (-not $widgetReady) {
    $results += [pscustomobject]@{
      id = $case.id; title = $case.title; gesture = $case.gesture
      candidates = 0; target = ''; action = 'none'; detail = 'widget-not-rendered'
      trust = ''; verdict = 'no-widget'; feedback = ''; signals = @('widget-not-rendered')
    }
    Write-Host ("{0,-28} {1,-8} {2,-14} {3}" -f $case.id, $case.gesture, 'no-widget', '控件未渲染')
    continue
  }

  $vis = Invoke-BridgeJson -Cli $cli -BridgeArgs @('visuals', '--session', $sid, '--json')
  $candidates = @()
  if ($vis.ok -and $vis.result) { $candidates = @($vis.result.candidates) }
  $target = $candidates | Sort-Object { $_.rect.width * $_.rect.height } -Descending | Select-Object -First 1

  # 显式给了选择器的题型不猜；其余按类名/id 找手柄。
  $handles = @()
  if (-not ($case.ContainsKey('selector') -and $case.selector)) {
    $handleProbe = ConvertTo-OneLine @'
(() => {
  const out = [];
  const sel = '[class*=slider],[class*=handle],[class*=thumb],[id*=slider],[id*=handle],[class*=move],[id*=move]';
  const deco = /shadow|mask|track|line|bg|背景/i;
  const grip = /btn|button|handle|thumb|knob/i;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) continue;
    if (r.width > 420 || r.height > 160) continue;
    const key = (el.id || '') + ' ' + String(el.className || '');
    if (deco.test(key)) continue;
    out.push({ id: el.id || '', cls: String(el.className || '').slice(0, 40), w: Math.round(r.width), h: Math.round(r.height), score: grip.test(key) ? 0 : 1 });
  }
  out.sort((a, b) => a.score - b.score || a.w - b.w);
  return out.slice(0, 3);
})()
'@
    $hres = Invoke-BridgeJson -Cli $cli -BridgeArgs @('evaluate', $handleProbe, '--session', $sid, '--json')
    if ($hres.ok -and $hres.result.value) { $handles = @($hres.result.value) }
  }

  $beforeRes = Invoke-BridgeJson -Cli $cli -BridgeArgs @('evaluate', $stateProbe, '--session', $sid, '--json')
  $before = $null
  if ($beforeRes.ok -and $beforeRes.result.value) { $before = $beforeRes.result.value }
  $beforeBg = if ($before) { [string]$before.bg } else { '' }
  $beforePage = if ($before -and $before.page) { [int]$before.page } else { $null }
  $beforeCollected = if ($before -and $before.collected) { [int]$before.collected } else { $null }

  $action = 'none'
  $detail = ''
  $trust = ''
  try {
    switch ($case.gesture) {
      'hold' {
        $sel = if ($case.ContainsKey('selector') -and $case.selector) { $case.selector } else { '' }
        if (-not $sel) { $action = 'none'; $detail = 'no-selector'; break }
        $dragArgs = @('drag', $sel, '--dx', [string]$case.dx, '--hold', [string]$case.hold, '--steps', '8', '--session', $sid, '--json')
        if ($case.ContainsKey('trusted') -and $case.trusted) { $dragArgs += '--trusted'; $trust = 'trusted' }
        $body = Invoke-BridgeJson -Cli $cli -BridgeArgs $dragArgs
        if ($body.ok) { $action = 'dispatched'; $detail = 'hold:' + $sel + '@' + $case.hold } else { $action = 'error'; $detail = $body.error.code }
      }
      'drag' {
        if ($handles.Count -eq 0) { $action = 'none'; $detail = 'no-handle'; break }
        $sel = Get-HandleSelector $handles[0]
        $dragArgs = @('drag', $sel, '--dx', [string]$case.dx, '--steps', '8', '--session', $sid, '--json')
        if ($case.ContainsKey('hold') -and $case.hold) { $dragArgs += @('--hold', [string]$case.hold) }
        if ($case.ContainsKey('trusted') -and $case.trusted) { $dragArgs += '--trusted'; $trust = 'trusted' }
        $body = Invoke-BridgeJson -Cli $cli -BridgeArgs $dragArgs
        if ($body.ok) { $action = 'dispatched'; $detail = 'handle:' + $sel } else { $action = 'error'; $detail = $body.error.code }
      }
      'dual' {
        if ($handles.Count -lt 2) { $action = 'none'; $detail = 'handles<' + [string]$handles.Count; break }
        $s1 = Get-HandleSelector $handles[0]
        $s2 = Get-HandleSelector $handles[1]
        $r1 = Invoke-BridgeJson -Cli $cli -BridgeArgs @('drag', $s1, '--dx', [string]$case.dx1, '--steps', '8', '--session', $sid, '--json')
        Start-Sleep -Milliseconds 400
        $r2 = Invoke-BridgeJson -Cli $cli -BridgeArgs @('drag', $s2, '--dx', [string]$case.dx2, '--steps', '8', '--session', $sid, '--json')
        if ($r1.ok -and $r2.ok) { $action = 'dispatched'; $detail = 'dual:' + $s1 + '+' + $s2 } else { $action = 'error'; $detail = if (-not $r1.ok) { $r1.error.code } else { $r2.error.code } }
      }
      'points' {
        $pieces = @($candidates | Where-Object { ([string]$_.cls) -match 'piece' -and $_.rect.width -ge 40 })
        $steps = @()
        if ($pieces.Count -ge 2) {
          foreach ($p in @($pieces | Select-Object -First 2)) {
            $steps += @{ type = 'click'; visual = [int]$p.index; x = [int][math]::Round($p.rect.width / 2); y = [int][math]::Round($p.rect.height / 2) }
          }
        } elseif ($target) {
          $tw = [int]$target.rect.width
          $th = [int]$target.rect.height
          $steps += @{ type = 'click'; visual = [int]$target.index; x = [int][math]::Floor($tw / 3); y = [int][math]::Floor($th / 2) }
          $steps += @{ type = 'click'; visual = [int]$target.index; x = [int][math]::Floor($tw * 2 / 3); y = [int][math]::Floor($th / 2) }
        }
        if ($steps.Count -eq 0) { $action = 'none'; $detail = 'no-candidate'; break }
        $planPath = Join-Path $Out ('plan-' + $case.id + '.json')
        # 不带 BOM：CLI 直接 fs.readFileSync + JSON.parse，BOM 会解析失败。
        $planJson = @{ steps = $steps } | ConvertTo-Json -Depth 6
        [System.IO.File]::WriteAllText($planPath, $planJson, (New-Object System.Text.UTF8Encoding($false)))
        $body = Invoke-BridgeJson -Cli $cli -BridgeArgs @('visual-gesture', '--plan', $planPath, '--session', $sid, '--json')
        if ($body.ok) { $action = 'dispatched'; $detail = 'points:' + [string]@($body.result.steps).Count } else { $action = 'error'; $detail = $body.error.code }
        if ($action -eq 'dispatched' -and $case.ContainsKey('confirm') -and $case.confirm) {
          Start-Sleep -Milliseconds 500
          $confirmBody = Invoke-BridgeJson -Cli $cli -BridgeArgs @('click', $case.confirm, '--session', $sid, '--json')
          $detail += if ($confirmBody.ok) { '+confirm' } else { '+confirm-error' }
        }
      }
      default { $action = 'none'; $detail = 'unknown-gesture' }
    }
  } catch {
    $action = 'error'
    $detail = $_.Exception.Message
  }

  # 反馈采样窗口：命中失败/成功文案、题图换图、页码推进、重新加载，任一出现就收工。
  $failPattern = '验证失败|验证不通过|请重试'
  $okPattern = '验证成功|通过验证|验证通过'
  $feedback = @()
  $signals = @()
  $failSeen = $false
  $okSeen = $false
  $resetSeen = $false
  $bgAfter = $beforeBg
  $pageAfter = $beforePage
  $collectedAfter = $beforeCollected
  if ($action -eq 'dispatched') {
    for ($i = 0; $i -lt 8; $i += 1) {
      Start-Sleep -Milliseconds 300
      $snapRes = Invoke-BridgeJson -Cli $cli -BridgeArgs @('evaluate', $stateProbe, '--session', $sid, '--json')
      if (-not ($snapRes.ok -and $snapRes.result.value)) { continue }
      $snap = $snapRes.result.value
      if ($snap.toast) {
        foreach ($toast in @($snap.toast)) {
          if ($toast -and ($feedback -notcontains [string]$toast)) { $feedback += [string]$toast }
        }
        if (@($snap.toast) -match $failPattern) { $failSeen = $true }
        if (@($snap.toast) -match $okPattern) { $okSeen = $true }
      }
      if ($snap.loading) { $resetSeen = $true }
      $bgAfter = [string]$snap.bg
      $pageAfter = if ($snap.page) { [int]$snap.page } else { $null }
      $collectedAfter = if ($snap.collected) { [int]$snap.collected } else { $null }
      $bgChanged = $beforeBg -and $bgAfter -and $beforeBg -ne $bgAfter
      $pageAdvanced = ($null -ne $beforePage -and $null -ne $pageAfter -and $pageAfter -gt $beforePage)
      $collectedAdvanced = ($null -ne $beforeCollected -and $null -ne $collectedAfter -and $collectedAfter -gt $beforeCollected)
      if ($failSeen -or $okSeen -or $resetSeen -or $bgChanged -or $pageAdvanced -or $collectedAdvanced) { break }
    }
  }
  $bgChangedFinal = $beforeBg -and $bgAfter -and $beforeBg -ne $bgAfter
  $pageAdvancedFinal = ($null -ne $beforePage -and $null -ne $pageAfter -and $pageAfter -gt $beforePage)
  $collectedAdvancedFinal = ($null -ne $beforeCollected -and $null -ne $collectedAfter -and $collectedAfter -gt $beforeCollected)

  if ($failSeen) { $signals += 'toast-fail' }
  if ($okSeen) { $signals += 'toast-ok' }
  if ($resetSeen) { $signals += 'reset-loading' }
  if ($bgChangedFinal) { $signals += 'bg-changed' }
  if ($pageAdvancedFinal) { $signals += 'page-advanced' }
  if ($collectedAdvancedFinal) { $signals += 'collected-advanced' }

  $verdict = 'no-feedback'
  if ($action -eq 'none') {
    $verdict = 'no-target'
  } elseif ($action -eq 'error') {
    $verdict = 'dispatch-error'
  } elseif ($okSeen -or $pageAdvancedFinal -or $collectedAdvancedFinal) {
    $verdict = 'advanced'
  } elseif ($failSeen -or $resetSeen -or $bgChangedFinal) {
    $verdict = 'rejected'
  }

  $results += [pscustomobject]@{
    id = $case.id; title = $case.title; gesture = $case.gesture
    candidates = $candidates.Count
    target = if ($target) { $target.tag + '#' + $target.id } else { '' }
    action = $action; detail = $detail; trust = $trust
    verdict = $verdict; feedback = ($feedback -join '|'); signals = @($signals)
  }
  Write-Host ("{0,-28} {1,-8} {2,-14} {3}  [{4}]" -f $case.id, $case.gesture, $verdict, ($feedback -join '|'), ($signals -join ','))
}

$matrix = [pscustomobject]@{
  suite = 'captcha-drive'
  at = (Get-Date).ToString('o')
  session = $sid
  total = $results.Count
  rejected = @($results | Where-Object { $_.verdict -eq 'rejected' }).Count
  none = @($results | Where-Object { $_.verdict -eq 'no-feedback' }).Count
  noWidget = @($results | Where-Object { $_.verdict -eq 'no-widget' }).Count
  other = @($results | Where-Object { $_.verdict -notin @('rejected', 'no-feedback', 'no-widget') }).Count
  cases = $results
}
$target = Join-Path $Out 'matrix.json'
$matrixJson = $matrix | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($target, $matrixJson, (New-Object System.Text.UTF8Encoding($false)))
if ($startedByUs) { Stop-BridgeSession -Cli $cli -Session $sid }
Write-Host ("rejected={0} no-feedback={1} no-widget={2} other={3} -> {4}" -f $matrix.rejected, $matrix.none, $matrix.noWidget, $matrix.other, $target)

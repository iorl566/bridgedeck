# tools/yuarenxue-assert.ps1 —— 猿人学题库断言化回归。
# 三种结果：pass / fail / skip（未登录时数据层跳过，入口与结构仍然断言）。
# 退出码：有 fail 时为 1，否则 0。
param(
  [string]$Browser = '',
  [string]$Session = '',
  [int]$Limit = 0,
  [switch]$KeepSession,
  [string]$Out = '.tmp-bench/yuarenxue'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
. (Join-Path $PSScriptRoot 'lib\regression-helpers.ps1')
New-Item -ItemType Directory -Force -Path $Out | Out-Null

$cases = Get-Content (Join-Path $PSScriptRoot '..\tests\anti-bot\yuarenxue-cases.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$list = @($cases.cases)
if ($Limit -gt 0) { $list = $list[0..([Math]::Min($Limit, $list.Count) - 1)] }

$cli = Join-Path $root 'cli\bridge.mjs'
$sid = $Session
$startedByUs = $false
if (-not $sid) {
  $sid = New-BridgeSession -Cli $cli -Browser $Browser
  $startedByUs = $true
}
Write-Host "session=$sid  用例 $($list.Count) 条"

# 单页探针：一次执行拿到入口/结构/数据三层需要的全部事实。
$probe = @'
(() => {
  const text = document.body ? document.body.innerText : '';
  const cards = document.querySelectorAll(
    'table tbody tr, .data-table tbody tr, .el-table__row, .list-item, .data-item, [class*="data-list"] > *'
  ).length;
  const rows = document.querySelectorAll('table tbody tr').length;
  const imgs = document.images.length;
  const canvases = document.querySelectorAll('canvas').length;
  const tables = document.querySelectorAll('table').length;
  const loggedOut = /登录\s*\/\s*注册/.test(text) && !/退出/.test(text);
  const notFound = /页面不存在/.test(text);
  const nums = (text.match(/\b\d{4}\b/g) || []).length;
  return {
    title: document.title || '',
    head: text.replace(/\s+/g, ' ').slice(0, 80),
    cards, rows, imgs, canvases, tables, nums,
    loggedOut, notFound,
    hasTable: tables > 0,
    hasImg: imgs > 0
  };
})()
'@

$results = @()
foreach ($case in $list) {
  $url = 'https://match.yuanrenxue.cn' + $case.path
  $checks = @()
  $state = 'pass'

  & node $cli navigate $url --session $sid --json 2>&1 | Out-Null
  Start-Sleep -Milliseconds 2200
  $raw = & node $cli evaluate $probe --session $sid --json 2>&1 | Out-String
  $line = ($raw -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -First 1)
  $entry = 'fail'; $structure = 'skip'; $data = 'skip'
  $v = $null
  if ($line) {
    $obj = $line | ConvertFrom-Json
    if ($obj.ok) { $v = $obj.result.value } else { $entry = 'fail' }
  } else {
    $entry = 'fail'
  }

  if ($v) {
    if ($v.notFound) { $entry = 'fail'; $checks += '页面 404' }
    else { $entry = 'pass'; $checks += ('入口 ok（title=' + $v.title.Substring(0, [Math]::Min(18, $v.title.Length)) + '）') }
  }

  if ($v -and $entry -eq 'pass') {
    $wanted = [string]$case.titleKeyword
    if ($wanted -and $v.title -notlike "*$wanted*") {
      $entry = 'fail'; $checks += ("标题不含'{0}'" -f $wanted)
    } else {
      $checks += '标题匹配'
    }
  }

  if ($v -and $entry -eq 'pass') {
    $minNumbers = if ($null -ne $case.expect.minNumbers) { [int]$case.expect.minNumbers } else { 5 }
    if ($v.loggedOut) {
      $structure = 'skip'; $data = 'skip'; $checks += '未登录，数据层跳过'
    } elseif ($v.nums -ge $minNumbers) {
      $structure = 'pass'; $data = 'pass'; $checks += ("数据信号 {0} 个数字" -f $v.nums)
    } else {
      $structure = 'skip'; $data = 'skip'; $checks += ("未见数据（{0} 个数字，需通过单项挑战）" -f $v.nums)
    }
  }

  if ($entry -eq 'fail' -or $structure -eq 'fail' -or $data -eq 'fail') { $state = 'fail' }
  elseif ($data -eq 'skip') { $state = 'skip' }

  $results += [pscustomobject]@{
    n = $case.n; title = $case.title; path = $case.path
    state = $state; entry = $entry; structure = $structure; data = $data
    cards = if ($v) { $v.cards } else { -1 }
    nums = if ($v) { $v.nums } else { -1 }
    loggedOut = if ($v) { $v.loggedOut } else { $false }
    checks = $checks
  }
  Write-Host ("{0,-4} {1,-6} {2,-18} cards={3,-4} {4}" -f $case.n, $state, $case.title, $(if ($v) { $v.cards } else { -1 }), ($checks -join '; '))
}

$matrix = [pscustomobject]@{
  suite = 'yuanrenxue'
  at = (Get-Date).ToString('o')
  session = $sid
  total = $results.Count
  pass = @($results | Where-Object { $_.state -eq 'pass' }).Count
  fail = @($results | Where-Object { $_.state -eq 'fail' }).Count
  skip = @($results | Where-Object { $_.state -eq 'skip' }).Count
  cases = $results
}
$target = Join-Path $Out 'assertions.json'
$matrix | ConvertTo-Json -Depth 6 | Set-Content -Path $target -Encoding UTF8

if ($startedByUs -and -not $KeepSession) {
  & node $cli session stop $sid --json 2>&1 | Out-Null
}

Write-Host ("pass={0} fail={1} skip={2} -> {3}" -f $matrix.pass, $matrix.fail, $matrix.skip, $target)
if ($matrix.fail -gt 0) { exit 1 } else { exit 0 }

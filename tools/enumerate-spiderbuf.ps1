# .tmp-bench/layer5/enumerate-spiderbuf.ps1 —— 遍历 Spiderbuf 全部靶场题，采集题型特征
param(
  [string]$Browser = 'f745d380',
  [string]$Out = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $root 'cli/bridge.mjs'
if (-not $Out) { $Out = Join-Path $root '.tmp-bench\layer5\spiderbuf' }
New-Item -ItemType Directory -Force -Path $Out | Out-Null

function B {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Command)
  $json = & node $cli @Command --json 2>&1 | Out-String
  $line = ($json -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -First 1)
  if (-not $line) { throw "no json: $($Command -join ' ')" }
  return ($line | ConvertFrom-Json)
}

$sid = (B session start --browser $Browser --no-focus).result.sessionId
Write-Host "session=$sid"

# 1) 先拿列表页的所有 challenge 链接
B navigate 'https://spiderbuf.cn/challenges' --session $sid | Out-Null
Start-Sleep -Seconds 4
$listJs = "(() => { const seen = new Set(); const out = []; for (const a of document.querySelectorAll('a')) { if (!a.href.includes('/challenge/')) continue; if (seen.has(a.href)) continue; seen.add(a.href); out.push(a.href); } return out; })()"
$urls = (B evaluate $listJs --session $sid).result.value
Write-Host ("challenges: " + $urls.Count)

# 2) 逐题采集特征
$probe = "(() => {
  const t = document.body ? document.body.innerText : '';
  const m = t.match(/爬取目标[^\n]*\n([^\n]+)/);
  const codeM = t.match(/^([A-Z]\d{2})\b/m);
  return {
    title: document.title,
    code: codeM ? codeM[1] : null,
    target: m ? m[1].trim().slice(0, 60) : null,
    len: t.length,
    rows: document.querySelectorAll('table tr').length,
    cards: document.querySelectorAll('[class*=data-]').length,
    inputs: document.querySelectorAll('input, textarea').length,
    sliders: document.querySelectorAll('[id=slider], [class*=slider], [class*=drag]').length,
    canvas: document.querySelectorAll('canvas').length,
    verifyLink: Array.from(document.querySelectorAll('a')).some(a => a.href.includes('/challenge/verify/')),
    captchaHint: /滑块|拖动|验证码|人机验证|安全验证/.test(t),
    blocked: /访问受限|拒绝访问|异常流量|请登录/.test(t)
  };
})()"

$results = @()
foreach ($u in $urls) {
  $slug = ($u -split '/')[-1]
  try {
    B navigate $u --session $sid | Out-Null
    Start-Sleep -Seconds 3
    $v = (B evaluate $probe --session $sid).result.value
    $results += [pscustomobject]@{
      slug = $slug; code = $v.code; title = ($v.title -replace ' \| SpiderBuf$',''); target = $v.target
      rows = $v.rows; cards = $v.cards; inputs = $v.inputs; sliders = $v.sliders; canvas = $v.canvas
      captcha = $v.captchaHint; blocked = $v.blocked; verify = $v.verifyLink
    }
    Write-Host ("ok   {0,-6} rows={1,-4} cards={2,-4} inputs={3} slider={4} canvas={5} cap={6}" -f $v.code, $v.rows, $v.cards, $v.inputs, $v.sliders, $v.canvas, $v.captchaHint)
  } catch {
    $results += [pscustomobject]@{ slug = $slug; code = 'ERR'; title = ''; target = $_.Exception.Message; rows = 0; cards = 0; inputs = 0; sliders = 0; canvas = 0; captcha = $false; blocked = $false; verify = $false }
    Write-Host ("FAIL {0} {1}" -f $slug, $_.Exception.Message)
  }
}

$results | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 (Join-Path $Out 'matrix.json')
B session stop $sid | Out-Null
Write-Host ("done -> " + (Join-Path $Out 'matrix.json'))

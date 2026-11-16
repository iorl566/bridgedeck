# tools/anti-bot-bench.ps1 —— 反爬第一层（静态检测站）采集器
#
# 只读访问 6 个检测页，逐站落盘：页面全文 + 截图 + 主世界原生函数状态。
# 判定不在这里做——原始证据先落盘，结论写进 docs/ANTI-BOT-LAYER1-BENCH.md。
#
# 用法：
#   pwsh -NoProfile -File tools/anti-bot-bench.ps1                     # 用默认浏览器实例
#   pwsh -NoProfile -File tools/anti-bot-bench.ps1 -Browser f745d380 -Out .tmp-bench/anti-bot/after
param(
  [string]$Browser = '',
  [string]$Out = '',
  [string]$BridgeCli = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $BridgeCli) { $BridgeCli = Join-Path $root 'cli/bridge.mjs' }
if (-not $Out) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $Out = Join-Path $root ".tmp-bench/anti-bot/$stamp"
}
New-Item -ItemType Directory -Force -Path $Out | Out-Null

function Invoke-Bridge {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  $json = & node $BridgeCli @Args --json 2>&1 | Out-String
  $line = ($json -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -First 1)
  if (-not $line) { throw "bridge 无 JSON 输出：$($Args -join ' ')`n$json" }
  return ($line | ConvertFrom-Json)
}

# 人一旦在受控标签页里敲键盘/点鼠标，会话会自动暂停。采样是只读的，
# 遇到 E_SESSION_PAUSED 就恢复后重试一次，别让整轮采集静默失败。
function Invoke-Checked {
  param([Parameter(Mandatory = $true)][string[]]$Command, [string]$SessionId = '')
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    $argv = @($Command)
    if ($SessionId) { $argv += @('--session', $SessionId) }
    $reply = Invoke-Bridge @argv
    if ($reply.ok -eq $true) { return $reply }
    $code = if ($reply.error) { $reply.error.code } else { '' }
    if ($code -eq 'E_SESSION_PAUSED' -and $attempt -eq 1) {
      Write-Host "  session 已暂停，尝试 resume 后重试"
      Invoke-Bridge session resume --session $SessionId | Out-Null
      continue
    }
    $msg = if ($reply.error) { "$code $($reply.error.message)" } else { ($reply | ConvertTo-Json -Compress) }
    throw "bridge $($Command[0]) 失败：$msg"
  }
}

# 1) 会话
$startArgs = @('session', 'start', '--no-focus')
if ($Browser) { $startArgs += @('--browser', $Browser) }
$session = Invoke-Bridge @startArgs
$sid = $session.result.sessionId
Write-Host "session=$sid out=$Out"

$sites = @(
  @{ name = 'rebrowser'; url = 'https://bot-detector.rebrowser.net/'; wait = 9 },
  @{ name = 'sannysoft'; url = 'https://bot.sannysoft.com/'; wait = 8 },
  @{ name = 'creepjs'; url = 'https://creepjs.org/checker'; wait = 25 },
  @{ name = 'pixelscan'; url = 'https://pixelscan.net/bot-check'; wait = 14 },
  @{ name = 'browserscan'; url = 'https://www.browserscan.net/bot-detection'; wait = 12 },
  @{ name = 'fingerprint-scan'; url = 'https://fingerprint-scan.com/'; wait = 40 }
)

# 2) 原生函数基线（与检测站无关，用来判断补丁是否存在）
try {
  Invoke-Checked -Command @('navigate', 'https://example.com/') -SessionId $sid | Out-Null
  Start-Sleep -Seconds 2
  $probe = Invoke-Checked -Command @('evaluate', "(() => { const n=f=>/native code/.test(Function.prototype.toString.call(f)); return { bbLog: typeof window.__BB_MAIN_LOG__, bbRestore: typeof window.__BB_RESTORE_HOOKS__, consoleLogNative: n(console.log), fetchNative: n(window.fetch), xhrOpenNative: n(XMLHttpRequest.prototype.open), xhrSendNative: n(XMLHttpRequest.prototype.send) }; })()") -SessionId $sid
  $probe.result.value | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 (Join-Path $Out 'native-check.json')
  Write-Host ('native-check: ' + ($probe.result.value | ConvertTo-Json -Compress))
} catch {
  Write-Warning "native 基线采集失败：$($_.Exception.Message)"
}

# 3) 逐站采集
foreach ($site in $sites) {
  $name = $site.name
  try {
    Invoke-Checked -Command @('navigate', $site.url) -SessionId $sid | Out-Null
    Start-Sleep -Seconds $site.wait
    $text = Invoke-Checked -Command @('evaluate', "({ url: location.href, title: document.title, text: document.body ? document.body.innerText : '' })") -SessionId $sid
    $obj = $text.result.value
    if (-not $obj -or -not $obj.url) { throw '页面采集为空（evaluate 未返回 url）' }
    @{ url = $obj.url; title = $obj.title; text = $obj.text } | ConvertTo-Json -Depth 4 |
      Out-File -Encoding utf8 (Join-Path $Out "$name.json")
    Invoke-Checked -Command @('screenshot', '--out', (Join-Path $Out "$name.png")) -SessionId $sid | Out-Null
    Write-Host ("ok   {0,-16} {1}  textLen={2}" -f $name, $obj.url, $obj.text.Length)
  } catch {
    $msg = $_.Exception.Message
    @{ url = $site.url; error = $msg } | ConvertTo-Json | Out-File -Encoding utf8 (Join-Path $Out "$name.error.json")
    Write-Host ("FAIL {0,-16} {1}" -f $name, $msg)
  }
}

# 4) 收尾
Invoke-Bridge session stop $sid | Out-Null
Write-Host "done -> $Out"

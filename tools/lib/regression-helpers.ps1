# tools/lib/regression-helpers.ps1 —— 靶场回归脚本的公共判定与调用封装。
# 约定：错误页/登录墙/数据信号都只按"页面文案"判定，绝不用裸数字（题面里常有随机四位数）。
Set-StrictMode -Version Latest

# 判定用的规范文案。JS 探针里也用同一组字符串，避免两边漂移。
$script:NotFoundText = '页面不存在'
$script:LoginWallText = '登录/注册'

function Get-NotFoundPattern { $script:NotFoundText }
function Get-LoginWallPattern { $script:LoginWallText }

# 从 bridge 的混合输出里取出最后一行 JSON 并解析。
function Invoke-BridgeJson {
  param(
    [Parameter(Mandatory = $true)][string]$Cli,
    [Parameter(Mandatory = $true)][string[]]$BridgeArgs
  )
  $raw = & node $Cli @BridgeArgs 2>&1 | Out-String
  $line = ($raw -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
  if (-not $line) { throw ("bridge 没有返回 JSON：" + $raw.Trim()) }
  return ($line | ConvertFrom-Json)
}

function New-BridgeSession {
  param(
    [Parameter(Mandatory = $true)][string]$Cli,
    [string]$Browser = ''
  )
  $args = @('session', 'start', '--no-focus', '--json')
  if ($Browser) { $args += @('--browser', $Browser) }
  $obj = Invoke-BridgeJson -Cli $Cli -BridgeArgs $args
  if (-not $obj.ok) { throw ("创建会话失败：" + ($obj.error.message)) }
  return $obj.result.sessionId
}

function Stop-BridgeSession {
  param(
    [Parameter(Mandatory = $true)][string]$Cli,
    [Parameter(Mandatory = $true)][string]$Session
  )
  & node $Cli session stop $Session --json 2>&1 | Out-Null
}

# 页面是不是"不存在"：只认文案，不认 404 这类裸数字。
function Test-PageNotFound {
  param([string]$Text)
  if (-not $Text) { return $false }
  return $Text.Contains($script:NotFoundText)
}

# 是否停在登录墙：出现登录/注册入口且没有退出入口。
function Test-LoginWall {
  param([string]$Text)
  if (-not $Text) { return $false }
  return ($Text -match '登录\s*/\s*注册') -and ($Text -notmatch '退出')
}

# 数据信号：三位以上数字的个数。题目数据渲染出来时这个值会明显上升。
function Get-NumberSignal {
  param([string]$Text)
  if (-not $Text) { return 0 }
  return ([regex]::Matches($Text, '\b\d{3,}\b')).Count
}

# 三态判定：任一层 fail 即 fail；有 skip 则 skip；否则 pass。
function Get-CaseState {
  param(
    [string]$Entry = 'pass',
    [string]$Structure = 'pass',
    [string]$Data = 'pass'
  )
  if ($Entry -eq 'fail' -or $Structure -eq 'fail' -or $Data -eq 'fail') { return 'fail' }
  if ($Entry -eq 'skip' -or $Structure -eq 'skip' -or $Data -eq 'skip') { return 'skip' }
  return 'pass'
}

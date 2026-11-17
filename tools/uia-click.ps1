# tools/uia-click.ps1 - find and invoke a Windows UIA control in a real Edge window.
# Used for local acceptance of overlays rendered in closed shadow DOM.
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$ControlType = 'Button',
  [string]$WindowText = '',
  [switch]$List,
  [int]$TimeoutMs = 5000
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$script:UiaType = switch ($ControlType) {
  'Button' { [System.Windows.Automation.ControlType]::Button }
  'Text' { [System.Windows.Automation.ControlType]::Text }
  'Edit' { [System.Windows.Automation.ControlType]::Edit }
  default { $null }
}

$edgePids = @(Get-Process msedge -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$root = [System.Windows.Automation.AutomationElement]::RootElement
$top = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
$candidates = @()
foreach ($win in $top) {
  try {
    if ($edgePids -notcontains $win.Current.ProcessId) { continue }
    if ($WindowText) {
      $textCond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $WindowText)
      $marker = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $textCond)
      if (-not $marker) { continue }
    }
    $candidates += $win
  } catch { }
}

if ($List) {
  foreach ($win in $candidates) {
    Write-Output ('WINDOW: ' + $win.Current.Name)
    $all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($el in $all) {
      try {
        if ($el.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button) {
          Write-Output ('  BUTTON: ' + $el.Current.Name + '  rect=' + $el.Current.BoundingRectangle)
        }
      } catch { }
    }
  }
  exit 0
}

$nameCond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $Name)
$cond = $nameCond
if ($script:UiaType) {
  $typeCond = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $script:UiaType)
  $cond = [System.Windows.Automation.AndCondition]::new($nameCond, $typeCond)
}

$deadline = (Get-Date).AddMilliseconds($TimeoutMs)
$target = $null
$targetWindow = $null
while (-not $target -and (Get-Date) -lt $deadline) {
  foreach ($win in $candidates) {
    try {
      $found = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
      if ($found) { $target = $found; $targetWindow = $win; break }
    } catch { }
  }
  if (-not $target) { Start-Sleep -Milliseconds 200 }
}
if (-not $target) {
  Write-Output ('NOT_FOUND: ' + $Name)
  exit 2
}

$rect = $target.Current.BoundingRectangle
Write-Output ('FOUND: ' + $target.Current.Name + ' in "' + $targetWindow.Current.Name + '" rect=' + $rect)
try {
  $pattern = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $pattern.Invoke()
  Write-Output 'INVOKED'
} catch {
  Write-Output ('INVOKE_FALLBACK: ' + $_.Exception.Message)
  $x = [int]($rect.Left + $rect.Width / 2)
  $y = [int]($rect.Top + $rect.Height / 2)
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class UiaClickNative {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@
  [UiaClickNative]::SetCursorPos($x, $y) | Out-Null
  [UiaClickNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [UiaClickNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Write-Output ('CLICKED: ' + $x + ',' + $y)
}

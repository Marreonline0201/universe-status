# Probe 8 (worker-office plan 5.6): what does one spool-hook firing cost on this machine?
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\spool-hook-cost.ps1 [-Runs 30]
#
# Measured from OUTSIDE the hook (the hook itself never prints): node.exe is started directly through
# ProcessStartInfo, the way the exec-form hook entry starts it, with stdin/stdout/stderr redirected.
#  - wall ms: Stopwatch from Process.Start() to exit, per firing (first firing reported apart as "cold")
#  - CPU ms: the process's TotalProcessorTime, read after exit
#  - peak working set and peak private bytes: the OS-maintained counters (GetProcessMemoryInfo on the process
#    handle, read after exit), cross-checked by a separate polling pass that reads PeakWorkingSet64 until exit
#  - baseline: the same, for node.exe running an EMPTY .mjs file (the floor any node hook pays)
#  - worst cases, 5 firings each: the costliest command the hook still classifies (a 65,534-char chain of
#    assignments, just under the 65,536-char classification cap) and the longest STRING it still parses (a valid
#    PostToolBatch just under the 32 MB stdin cap: one Read call with about 32 MB of text). These two do NOT bound
#    what one firing can cost (corrected 2026-10-01, step-4 review finding 3): memory also grows with the NUMBER of
#    JSON values, about 120-300 bytes each, so tiny objects cost far more per byte than text (a Batch of 1M empty
#    calls is 2.9 MB of stdin and took ~340 MB; 11M would fit under 32 MB). Since that review the hook refuses a stdin
#    with more than 100,000 values ('{' '[' ',' outside strings: a parse_error record, nothing parsed), and
#    spool-hook-test.mjs measures a Batch of tiny objects at that cap and one over it (its memory section)
# The hook runs from a throwaway install in %TEMP% (install-hook.mjs with UNIVERSE_OFFICE_HOME), so the real spool
# is never touched; the temp folder is removed at the end. Refuses to run on battery or with < 0.8 GB free RAM.
param([int]$Runs = 30, [string]$Node = '')

$ErrorActionPreference = 'Stop'
if (-not $Node) { $Node = (Get-Command node).Source }
$repo = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $repo 'office\observer\install-hook.mjs'

$power = (Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus -ErrorAction SilentlyContinue | Select-Object -First 1).PowerOnline
if ($power -eq $false) { Write-Output 'On battery: timing probes wait for AC power.'; exit 2 }
$freeGb = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB, 2)
if ($freeGb -lt 0.8) { Write-Output "Free RAM $freeGb GB < 0.8 GB: not running."; exit 2 }

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class WoPsapi {
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_MEMORY_COUNTERS {
    public uint cb; public uint PageFaultCount;
    public UIntPtr PeakWorkingSetSize; public UIntPtr WorkingSetSize;
    public UIntPtr QuotaPeakPagedPoolUsage; public UIntPtr QuotaPagedPoolUsage;
    public UIntPtr QuotaPeakNonPagedPoolUsage; public UIntPtr QuotaNonPagedPoolUsage;
    public UIntPtr PagefileUsage; public UIntPtr PeakPagefileUsage;
  }
  [DllImport("psapi.dll", SetLastError = true)]
  public static extern bool GetProcessMemoryInfo(IntPtr hProcess, out PROCESS_MEMORY_COUNTERS counters, uint size);
}
"@

$tmp = Join-Path $env:TEMP ('wo-probe8-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$officeHome = Join-Path $tmp 'home'
New-Item -ItemType Directory -Force $officeHome | Out-Null
$emptyScript = Join-Path $tmp 'empty.mjs'
Set-Content -Path $emptyScript -Value '' -Encoding ascii

function New-Psi([string]$script) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Node
  $psi.Arguments = '"' + $script + '"'
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables['UNIVERSE_OFFICE_HOME'] = $officeHome
  if ($psi.EnvironmentVariables.ContainsKey('OFFICE_AGENT_ID')) { $psi.EnvironmentVariables.Remove('OFFICE_AGENT_ID') }
  return $psi
}

# realistic PreToolUse from a helper (about 0.8 KB, a multi-step shell command)
$payload = (@{
  session_id = '00000000-0000-4000-8000-0000000c0571'
  transcript_path = 'C:\Users\someone\.claude\projects\C--work-example\00000000-0000-4000-8000-0000000c0571.jsonl'
  cwd = 'C:\work\example'
  permission_mode = 'default'
  hook_event_name = 'PreToolUse'
  agent_id = 'agent-a0123456789abcdef'
  agent_type = 'workflow-subagent'
  tool_name = 'Bash'
  tool_input = @{
    command = 'cd "C:/dev/universe-status-wo" && git log --oneline -5 && npx tsc -p tsconfig.app.json --noEmit 2>&1 | tail -20 && grep -rn "classify" office/observer/*.mjs | head -40'
    description = 'Type-check the app and list recent commits'
    timeout = 120000
  }
  tool_use_id = 'toolu_01HkF8x3Qm9VbN2rT5yWcLpZ'
} | ConvertTo-Json -Compress -Depth 5)

# worst case the classifier still runs on: a 65,534-char chain of PowerShell assignments, just under the hook's
# 65,536-char classification cap (each `$a =` level was one more re-tokenisation before the nesting bound)
$capPayload = (@{
  session_id = '00000000-0000-4000-8000-0000000c0571'; hook_event_name = 'PreToolUse'; agent_id = 'agent-a0123456789abcdef'
  tool_name = 'Bash'; tool_input = @{ command = ('$a = ' * 13106) + 'rm x' }; tool_use_id = 'toolu_cap'
} | ConvertTo-Json -Compress -Depth 5)
# the largest payload IN BYTES the hook parses: a valid PostToolBatch just under the 32 MB stdin cap (one Read call
# whose tool_response is about 32 MB of text); a bigger stdin is a parse_error record without being parsed. Not the
# most memory one firing can take: see the header (values, not bytes)
$bigPrefix = '{"session_id":"00000000-0000-4000-8000-0000000c0571","hook_event_name":"PostToolBatch","agent_id":"agent-a0123456789abcdef","tool_calls":[{"tool_name":"Read","tool_input":{"file_path":"C:/x/big.txt"},"tool_use_id":"toolu_big","tool_response":"'
$bigSuffix = '"}]}'
$bigPayload = $bigPrefix + ('x' * (32MB - 1024 - $bigPrefix.Length - $bigSuffix.Length)) + $bigSuffix

function Invoke-Firing([string]$script, [bool]$poll, [string]$stdin = $payload) {
  $psi = New-Psi $script
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $p = [System.Diagnostics.Process]::Start($psi)
  $h = $p.Handle
  $p.StandardInput.Write($stdin)
  $p.StandardInput.Close()
  $polledPeak = [long]0
  if ($poll) {
    while (-not $p.HasExited) {
      try { $p.Refresh(); if ($p.PeakWorkingSet64 -gt $polledPeak) { $polledPeak = $p.PeakWorkingSet64 } } catch { }
    }
  }
  $p.WaitForExit()
  $sw.Stop()
  $out = $p.StandardOutput.ReadToEnd()
  $err = $p.StandardError.ReadToEnd()
  $c = New-Object WoPsapi+PROCESS_MEMORY_COUNTERS
  $okMem = [WoPsapi]::GetProcessMemoryInfo($h, [ref]$c, [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($c))
  $r = [pscustomobject]@{
    WallMs = $sw.Elapsed.TotalMilliseconds
    CpuMs = $p.TotalProcessorTime.TotalMilliseconds
    PeakWsMB = $(if ($okMem) { [double]$c.PeakWorkingSetSize.ToUInt64() / 1MB } else { [double]::NaN })
    PeakPrivMB = $(if ($okMem) { [double]$c.PeakPagefileUsage.ToUInt64() / 1MB } else { [double]::NaN })
    PolledPeakWsMB = [double]$polledPeak / 1MB
    Exit = $p.ExitCode
    OutBytes = $out.Length + $err.Length
  }
  $p.Dispose()
  return $r
}

function Get-P90([double[]]$xs) {           # nearest-rank 90th percentile
  $s = $xs | Sort-Object
  return $s[[math]::Ceiling(0.9 * $s.Count) - 1]
}
function Show([string]$name, $rs) {
  $w = [double[]]($rs | ForEach-Object { $_.WallMs })
  $cpu = [double[]]($rs | ForEach-Object { $_.CpuMs })
  $ws = [double[]]($rs | ForEach-Object { $_.PeakWsMB })
  $pv = [double[]]($rs | ForEach-Object { $_.PeakPrivMB })
  '{0,-34} n={1,2}  wall mean {2,6:N1} ms  p50 {3,6:N1}  p90 {4,6:N1}  max {5,6:N1} | CPU mean {6,5:N1} ms | peak WS mean {7,5:N1} MB max {8,5:N1} MB | peak private max {9,5:N1} MB' -f `
    $name, $w.Count, ($w | Measure-Object -Average).Average, ($w | Sort-Object)[[int][math]::Floor(($w.Count - 1) / 2)], (Get-P90 $w), ($w | Measure-Object -Maximum).Maximum, `
    ($cpu | Measure-Object -Average).Average, ($ws | Measure-Object -Average).Average, ($ws | Measure-Object -Maximum).Maximum, ($pv | Measure-Object -Maximum).Maximum
}

try {
  $env:UNIVERSE_OFFICE_HOME = $officeHome
  & $Node $installer | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "install-hook.mjs failed ($LASTEXITCODE)" }
  Remove-Item Env:\UNIVERSE_OFFICE_HOME
  $hook = Join-Path $officeHome 'bin\spool-hook.mjs'

  Write-Output ("probe 8 | {0} | node {1} | {2} | AC power {3} | free RAM {4} GB | payload {5} bytes" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), (& $Node --version), $Node, $power, $freeGb, $payload.Length)

  $hookRuns = @(); for ($i = 0; $i -lt $Runs; $i++) { $hookRuns += Invoke-Firing $hook $false }
  $baseRuns = @(); for ($i = 0; $i -lt $Runs; $i++) { $baseRuns += Invoke-Firing $emptyScript $false }
  $pollRuns = @(); for ($i = 0; $i -lt 10; $i++) { $pollRuns += Invoke-Firing $hook $true }

  $cold = $hookRuns[0]
  Write-Output ('cold first hook firing                 wall {0:N1} ms | CPU {1:N1} ms | peak WS {2:N1} MB | peak private {3:N1} MB' -f $cold.WallMs, $cold.CpuMs, $cold.PeakWsMB, $cold.PeakPrivMB)
  Show "hook, all $Runs firings" $hookRuns
  Show "hook, warm (firings 2..$Runs)" ($hookRuns | Select-Object -Skip 1)
  Show "baseline: node + empty .mjs" $baseRuns
  Show 'hook, polling pass (cross-check)' $pollRuns
  $pollMax = ($pollRuns | ForEach-Object { $_.PolledPeakWsMB } | Measure-Object -Maximum).Maximum
  $apiMax = ($pollRuns | ForEach-Object { $_.PeakWsMB } | Measure-Object -Maximum).Maximum
  Write-Output ('polling cross-check: max polled PeakWorkingSet64 {0:N1} MB vs OS peak counter after exit {1:N1} MB' -f $pollMax, $apiMax)

  # worst cases (5 firings each): the per-firing ceiling, not the typical cost
  $capRuns = @(); for ($i = 0; $i -lt 5; $i++) { $capRuns += Invoke-Firing $hook $false $capPayload }
  Show ('worst classified: {0:N0}-byte chain' -f $capPayload.Length) $capRuns
  $freeNow = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB, 2)
  $bigRuns = @()
  if ($freeNow -lt 1.0) { Write-Output "free RAM $freeNow GB < 1.0 GB: the 32 MB payload row is skipped" }
  else {
    for ($i = 0; $i -lt 5; $i++) { $bigRuns += Invoke-Firing $hook $false $bigPayload }
    Show ('worst parsed: {0:N1} MB PostToolBatch' -f ($bigPayload.Length / 1MB)) $bigRuns
  }

  $all = $hookRuns + $pollRuns + $capRuns + $bigRuns
  $bad = @($all | Where-Object { $_.Exit -ne 0 -or $_.OutBytes -ne 0 })
  $lines = @(Get-ChildItem (Join-Path $officeHome 'spool') -Filter 'events-*.jsonl' | Get-Content | Where-Object { $_ })
  Write-Output ('hook firings {0}: exit codes all 0 and no output: {1}; spool lines written {2} (expected {0})' -f $all.Count, ($bad.Count -eq 0), $lines.Count)
} finally {
  if ((Split-Path -Leaf $tmp) -like 'wo-probe8-*' -and $tmp.StartsWith($env:TEMP)) { Remove-Item -Recurse -Force $tmp }
}

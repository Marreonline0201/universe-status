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
  session_id = '944994c0-d7e9-4be1-a2a7-032471f945b2'
  transcript_path = 'C:\Users\ddogr\.claude\projects\C--Users-ddogr-OneDrive-Desktop-Questions\944994c0-d7e9-4be1-a2a7-032471f945b2.jsonl'
  cwd = 'C:\Users\ddogr\OneDrive\Desktop\Questions\universe-status'
  permission_mode = 'default'
  hook_event_name = 'PreToolUse'
  agent_id = 'agent-a8451ad399c9231e2'
  agent_type = 'workflow-subagent'
  tool_name = 'Bash'
  tool_input = @{
    command = 'cd "C:/dev/universe-status-wo" && git log --oneline -5 && npx tsc -p tsconfig.app.json --noEmit 2>&1 | tail -20 && grep -rn "classify" office/observer/*.mjs | head -40'
    description = 'Type-check the app and list recent commits'
    timeout = 120000
  }
  tool_use_id = 'toolu_01HkF8x3Qm9VbN2rT5yWcLpZ'
} | ConvertTo-Json -Compress -Depth 5)

function Invoke-Firing([string]$script, [bool]$poll) {
  $psi = New-Psi $script
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $p = [System.Diagnostics.Process]::Start($psi)
  $h = $p.Handle
  $p.StandardInput.Write($payload)
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

  $all = $hookRuns + $pollRuns
  $bad = @($all | Where-Object { $_.Exit -ne 0 -or $_.OutBytes -ne 0 })
  $lines = @(Get-ChildItem (Join-Path $officeHome 'spool') -Filter 'events-*.jsonl' | Get-Content | Where-Object { $_ })
  Write-Output ('hook firings {0}: exit codes all 0 and no output: {1}; spool lines written {2} (expected {0})' -f $all.Count, ($bad.Count -eq 0), $lines.Count)
} finally {
  if ((Split-Path -Leaf $tmp) -like 'wo-probe8-*' -and $tmp.StartsWith($env:TEMP)) { Remove-Item -Recurse -Force $tmp }
}

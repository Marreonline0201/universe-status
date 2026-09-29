// The machine's power state — a validity condition of every timing run. On battery this laptop switches to its
// power-limited scheme (ASUS "Silent"; "Turbo" on AC) and the GPU clock hops between states within seconds: an
// nvidia-smi log on 2026-09-29 read 720–1987 MHz over 3 s, and a 120-frame render timing plateaued at 2.5 ms during
// an 847 MHz window and fell to 1.9 ms when the clock returned to 1860 MHz. A timing taken on battery measures the
// power policy, not the code.
//
// AC: root/wmi BatteryStatus.PowerOnline ("running on AC power"; observed True on AC, False on battery), falling back
// to Win32_Battery.BatteryStatus (1 = discharging, 2 = on AC — Microsoft Learn, Win32_Battery). No battery at all
// (a desktop) counts as AC.
import { execFileSync } from 'node:child_process'

const ps = cmd => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: 30_000 }).trim()

/** { ac: true | false | null (unknown), batteryPct: number | null, scheme: string | null } */
export function powerState() {
  if (process.platform !== 'win32') return { ac: null, batteryPct: null, scheme: null }
  let ac = null, batteryPct = null, scheme = null
  try {
    const b = JSON.parse(ps('@(Get-CimInstance Win32_Battery | Select-Object BatteryStatus, EstimatedChargeRemaining) | ConvertTo-Json -Compress') || '[]')
    const one = Array.isArray(b) ? b[0] : b
    if (!one) ac = true
    else {
      batteryPct = one.EstimatedChargeRemaining ?? null
      const online = ps('(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object -First 1).PowerOnline')
      ac = online === 'True' ? true : online === 'False' ? false : one.BatteryStatus === 2 ? true : one.BatteryStatus === 1 ? false : null
    }
  } catch { ac = null }
  try { scheme = ps('powercfg /getactivescheme').match(/\(([^)]+)\)\s*$/)?.[1] ?? null } catch { scheme = null }
  return { ac, batteryPct, scheme }
}

export const describePower = p => `${p.ac === true ? 'AC' : p.ac === false ? 'BATTERY' : 'unknown power source'}${p.batteryPct != null ? ` (battery ${p.batteryPct} %)` : ''}${p.scheme ? `, scheme ${p.scheme}` : ''}`

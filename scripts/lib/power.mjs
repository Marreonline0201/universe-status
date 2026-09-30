// The machine's power state — a validity condition of every timing run. On battery this laptop switches to its
// power-limited scheme (ASUS "Silent"; "Turbo" on AC) and the GPU clock hops between states within seconds: an
// nvidia-smi log on 2026-09-29 read 720–1987 MHz over 3 s, and a 120-frame render timing plateaued at 2.5 ms during
// an 847 MHz window and fell to 1.9 ms when the clock returned to 1860 MHz. A timing taken on battery measures the
// power policy, not the code.
//
// AC: root/wmi BatteryStatus.PowerOnline ("running on AC power"; observed True on AC, False on battery), falling back
// to Win32_Battery.BatteryStatus (1 = discharging, 2 = on AC — Microsoft Learn, Win32_Battery).
// Review fixes (2026-09-29, the evening-commit review): the state FAILS CLOSED — no readable battery reads as unknown
// (ac: null), which no timing run accepts; a machine without a battery (a desktop) sets FLUID_ASSUME_AC=1 and the
// state says so (assumed: true). A power-limited scheme (Silent, power/battery saver, eco) invalidates a timing run
// even on AC (timingValid). watchPower() samples the state DURING a run (async: the timing loop is never blocked), so
// an unplug between the start and end checks is seen.
import { execFileSync, execFile } from 'node:child_process'

const PS_ARGS = cmd => ['-NoProfile', '-NonInteractive', '-Command', cmd]
const ps = cmd => execFileSync('powershell.exe', PS_ARGS(cmd), { encoding: 'utf8', timeout: 30_000 }).trim()
const psAsync = cmd => new Promise(res => execFile('powershell.exe', PS_ARGS(cmd), { encoding: 'utf8', timeout: 30_000 }, (err, out) => res(err ? null : String(out).trim())))
const LIMITED_SCHEME = /silent|saver|eco/i
const schemeOf = txt => txt?.match(/\(([^)]+)\)\s*$/)?.[1] ?? null

/** { ac: true | false | null (unknown), batteryPct, scheme, assumed? } */
export function powerState() {
  if (process.env.FLUID_ASSUME_AC === '1') return { ac: true, batteryPct: null, scheme: null, assumed: true }
  if (process.platform !== 'win32') return { ac: null, batteryPct: null, scheme: null }
  let ac = null, batteryPct = null, scheme = null
  try {
    const b = JSON.parse(ps('@(Get-CimInstance Win32_Battery | Select-Object BatteryStatus, EstimatedChargeRemaining) | ConvertTo-Json -Compress') || '[]')
    const one = Array.isArray(b) ? b[0] : b
    batteryPct = one?.EstimatedChargeRemaining ?? null
    const online = ps('(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object -First 1).PowerOnline')
    ac = online === 'True' ? true : online === 'False' ? false : one?.BatteryStatus === 2 ? true : one?.BatteryStatus === 1 ? false : null
  } catch { ac = null }
  try { scheme = schemeOf(ps('powercfg /getactivescheme')) } catch { scheme = null }
  return { ac, batteryPct, scheme }
}

/** A timing run is valid on AC (known, not assumed-unknown) and outside a power-limited scheme. */
export const timingValid = p => p.ac === true && !(p.scheme && LIMITED_SCHEME.test(p.scheme))

export const describePower = p => `${p.ac === true ? (p.assumed ? 'AC (assumed: FLUID_ASSUME_AC=1)' : 'AC') : p.ac === false ? 'BATTERY' : 'unknown power source'}${p.batteryPct != null ? ` (battery ${p.batteryPct} %)` : ''}${p.scheme ? `, scheme ${p.scheme}${LIMITED_SCHEME.test(p.scheme) ? ' (power-limited)' : ''}` : ''}`

/** Samples the power state every intervalMs until stop(); stop() resolves to { samples, allValid, bad }. */
export function watchPower(intervalMs = 10_000) {
  const samples = []
  let stopped = false, timer = null, wake = null
  const once = async () => {
    if (process.env.FLUID_ASSUME_AC === '1') { samples.push({ t: Date.now(), ac: true, scheme: null, assumed: true }); return }
    const out = await psAsync("$o = (Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object -First 1).PowerOnline; $s = (powercfg /getactivescheme); \"$o|$s\"")
    const [online, schemeTxt] = (out ?? '|').split('|')
    samples.push({ t: Date.now(), ac: online === 'True' ? true : online === 'False' ? false : null, scheme: schemeOf(schemeTxt) })
  }
  // the sleep is cancellable (stop() does not wait out an interval) and unref'd (a watcher left running never keeps the
  // process alive)
  const sleep = () => new Promise(r => { wake = r; timer = setTimeout(r, intervalMs); timer.unref?.() })
  const running = (async () => { while (!stopped) { await once(); if (!stopped) await sleep() } })()
  return {
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      wake?.()
      await running
      const bad = samples.filter(s => !timingValid(s))
      return { samples: samples.length, allValid: samples.length > 0 && bad.length === 0, bad: bad.map(s => ({ t: new Date(s.t).toISOString(), ac: s.ac, scheme: s.scheme })) }
    },
  }
}

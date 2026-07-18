// Money-guard verification. Run: npx tsx scripts/office-usage-guard-sim.ts
// Exercises the REAL UsageMonitor + Scheduler through every money path with a
// fake usage source (OFFICE_FAKE_USAGE_FILE) and injected fake activations —
// no real endpoint calls, no real agent sessions, zero spend.
//
// Asserts:
//   1. healthy 50%  → no rest, no hard stop
//   2. session 95%  → soft rest (threshold 90)
//   3. BLIND + reset time passed → STAYS resting (regression: the 2026-07-17
//      incident auto-resumed on stale data the moment the reset time passed)
//   4. session 100% → hard stop decision (fresh data only)
//   5. scheduler hard stop: kills in-flight, writes the lock, sticky pause,
//      no double-kill, second monitor tick can't revive it
//   6. owner resume() → lock cleared, unpaused
//   7. a REBOOTED scheduler with a lock present boots paused
//   8. blind monitor → holdingBlind (spawn hold); allowWhenBlind waives it
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'office-guard-'))
const fakeUsageFile = path.join(tmp, 'fake-usage.json')
process.env.OFFICE_FAKE_USAGE_FILE = fakeUsageFile

// Imports AFTER the env var so the monitor sees the fake source.
const { UsageMonitor, STALE_MS } = await import('../office/server/usage.ts')
const { Scheduler } = await import('../office/server/scheduler.ts')
const { resolvePaths } = await import('../office/server/store.ts')
import type { HardStopDecision, RestDecision, UsageState } from '../office/server/usage.ts'
import type { OfficeConfig, SchedulerEvents } from '../office/server/scheduler.ts'

let failures = 0
const check = (cond: boolean, label: string) => {
  console.log(`${cond ? 'ok ' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}
const writeFake = (sessionPct: number, resetsInMs: number) => fs.writeFileSync(fakeUsageFile, JSON.stringify({
  five_hour: { utilization: sessionPct, resets_at: new Date(Date.now() + resetsInMs).toISOString() },
  seven_day: { utilization: 10, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
}))

// ── Monitor decisions ────────────────────────────────────────────────────────
{
  let last: { state: UsageState; rest: RestDecision; hard: HardStopDecision } | null = null
  const mon = new UsageMonitor(
    { sessionThresholdPct: 90, weeklyThresholdPct: 95, pollSeconds: 60 },
    (state, rest, hard) => { last = { state, rest, hard } },
    () => {},
  )
  const poll = () => (mon as unknown as { poll(): Promise<void> }).poll()

  writeFake(50, 3_600_000)
  await mon.prime()
  check(last!.state.ok && !last!.rest.resting && !last!.hard.stop, 'monitor: 50% → healthy, no rest, no hard stop')

  writeFake(95, 3_600_000)
  await poll()
  check(last!.rest.resting && last!.rest.reason === 'session' && !last!.hard.stop, 'monitor: 95% → soft rest, still no hard stop')

  // Regression: blind + reset time in the past must NOT auto-resume.
  const m = mon as unknown as { lastOkAt: number; state: UsageState }
  m.lastOkAt = Date.now() - STALE_MS - 60_000
  m.state = { ...m.state, ok: false, sessionResetsAt: new Date(Date.now() - 1_000).toISOString() }
  const stale = mon.shouldRest()
  check(stale.resting, 'monitor: BLIND past reset time → STAYS resting (no auto-resume on stale data)')
  check(!mon.shouldHardStop().stop, 'monitor: blind 95% → hard stop NOT tripped on stale data')

  writeFake(100, 3_600_000)
  await poll()
  check(last!.hard.stop && last!.hard.reason === 'session', 'monitor: fresh 100% → HARD STOP decision')

  // Adaptive cadence: calm+healthy → 5× slower; hot or blind → base rate.
  writeFake(9, 3_600_000)
  await poll()
  check(mon.nextPollMs() === 300_000, 'monitor: calm 9% → gentle 5-min polls (shared-bucket friendly)')
  writeFake(75, 3_600_000)
  await poll()
  check(mon.nextPollMs() === 60_000, 'monitor: hot 75% → full-rate 60s polls')
  ;(mon as unknown as { state: UsageState }).state.ok = false
  check(mon.nextPollMs() === 60_000, 'monitor: blind → full-rate 60s polls (recover fast)')
  mon.stop() // clear the armed resume timer so the test process can exit
}

// ── Scheduler hard stop / sticky pause / boot lock / blind hold ─────────────
{
  // Repo skeleton the scheduler can boot against — no agents, no watchers.
  fs.mkdirSync(path.join(tmp, 'company', 'tasks'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'company', 'mail'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'office', 'state'), { recursive: true })
  const paths = resolvePaths(tmp)
  const lockFile = path.join(tmp, 'office', 'state', 'usage-hardstop.lock')
  const logs: string[] = []
  const events: SchedulerEvents = {
    onStatus: () => {}, onActivity: () => {}, onTranscript: () => {},
    onPool: () => {}, onLimitHit: () => {}, log: (l) => logs.push(l),
  }
  const cfg = { maxConcurrent: 8, agentCooldownMs: 0, noProgressBackoffMs: 0, usageRest: { sessionThresholdPct: 90, weeklyThresholdPct: 95, pollSeconds: 60 } } as unknown as OfficeConfig

  const sch = new Scheduler(paths, [], cfg, events)
  const kills: string[] = []
  const fakeAct = { kill: (r: string) => kills.push(r) }
  ;(sch as unknown as { live: Map<string, unknown> }).live.set('engine-lead', fakeAct)
  ;(sch as unknown as { live: Map<string, unknown> }).live.set('fluid-lead', fakeAct)

  const at = (pct: number, ok = true, lastOkAt = Date.now()): UsageState => ({
    ok, sessionPct: pct, weeklyPct: 10,
    sessionResetsAt: new Date(Date.now() + 3_600_000).toISOString(),
    weeklyResetsAt: new Date(Date.now() + 86_400_000).toISOString(),
    lastChecked: Date.now(), lastOkAt,
  })
  const resting: RestDecision = { resting: true, reason: 'session', resumeAt: new Date(Date.now() + 3_600_000).toISOString() }

  sch.setUsage(at(100), resting, { stop: true, reason: 'session' })
  check(kills.length === 2, `scheduler: hard stop killed both in-flight sessions (got ${kills.length})`)
  check(sch.paused && sch.hardStopped, 'scheduler: hard stop → paused + hardStopped')
  check(fs.existsSync(lockFile), 'scheduler: hard stop persisted the lock file')

  sch.setUsage(at(100), resting, { stop: true, reason: 'session' })
  check(kills.length === 2, 'scheduler: second 100% tick does not double-kill')

  // Window reset arrives while hard-stopped → must NOT resume.
  sch.setUsage(at(5), { resting: false, reason: null, resumeAt: null }, { stop: false, reason: null })
  check(sch.paused && sch.hardStopped, 'scheduler: window reset does NOT clear a hard stop (owner-gated)')

  sch.resume()
  check(!sch.paused && !sch.hardStopped && !fs.existsSync(lockFile), 'scheduler: owner resume clears pause + lock')

  // Boot with a lock present → starts paused.
  fs.writeFileSync(lockFile, JSON.stringify({ reason: 'session', at: new Date().toISOString() }))
  const rebooted = new Scheduler(paths, [], cfg, events)
  check(rebooted.paused && rebooted.hardStopped, 'scheduler: reboot with lock present boots PAUSED until owner resumes')
  fs.rmSync(lockFile)

  // Blind hold, tiered: calm readings stay spawn-worthy 12 min, hot ones 5 min.
  const noRest: RestDecision = { resting: false, reason: null, resumeAt: null }
  const noStop = { stop: false, reason: null } as HardStopDecision
  const sch2 = new Scheduler(paths, [], cfg, events)
  sch2.setUsage(at(50, false, Date.now() - 10 * 60_000), noRest, noStop)
  check(!sch2.poolState().holdingBlind, 'scheduler: blind but last reading CALM 50% + 10 min old → still spawning (12-min window)')
  sch2.setUsage(at(50, false, Date.now() - 13 * 60_000), noRest, noStop)
  check(sch2.poolState().holdingBlind, 'scheduler: calm reading 13 min old → held')
  sch2.setUsage(at(80, false, Date.now() - 6 * 60_000), noRest, noStop)
  check(sch2.poolState().holdingBlind, 'scheduler: blind with last reading HOT 80% + 6 min old → held (5-min window)')
  const cfg2 = { ...cfg, usageRest: { ...cfg.usageRest!, allowWhenBlind: true } } as OfficeConfig
  const sch3 = new Scheduler(paths, [], cfg2, events)
  sch3.setUsage(at(50, false, Date.now() - STALE_MS - 60_000), noRest, noStop)
  check(!sch3.poolState().holdingBlind, 'scheduler: allowWhenBlind waives the blind hold')

  check(logs.some(l => l.includes('HARD STOP')), 'scheduler: hard stop logged loudly')
}

fs.rmSync(tmp, { recursive: true, force: true })
if (failures > 0) { console.error(`\n${failures} guard check(s) FAILED`); process.exit(1) }
console.log('\nOK — hard stop, sticky owner-gated resume, boot lock, and blind hold all verified.')
process.exit(0)

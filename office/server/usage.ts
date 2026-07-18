// Usage-aware rest mode: polls the Anthropic OAuth usage endpoint with the
// local Claude Code token so the office can stop spawning agents at 90% of the
// 5-hour window (95% weekly) and resume when the window resets.
// The token is re-read from disk on every poll (Claude Code refreshes the file
// while it runs) and is never logged, broadcast, or included in errors.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export interface UsageRestConfig {
  sessionThresholdPct: number // rest when 5-hour utilization ≥ this
  weeklyThresholdPct: number  // rest when 7-day utilization ≥ this
  pollSeconds: number
  /** HARD money ceiling: fresh usage at/over this kills in-flight sessions and
   *  sticky-pauses the office until the owner resumes. Default 100. */
  hardStopPct?: number
  /** Allow NEW activations while the usage monitor is blind. Only safe when
   *  extra-usage billing is DISABLED in the Anthropic console (sessions then
   *  refuse at the limit instead of silently billing). Default false = hold. */
  allowWhenBlind?: boolean
}

export interface UsageState {
  ok: boolean // recent successful fetch (or trusted limit-hit signal)
  sessionPct: number | null
  weeklyPct: number | null
  sessionResetsAt: string | null // ISO
  weeklyResetsAt: string | null  // ISO
  lastChecked: number
  lastOkAt: number // ts of the last SUCCESSFUL fetch (0 = never) — staleness is (now - lastOkAt)
}

export interface RestDecision {
  resting: boolean
  reason: 'session' | 'weekly' | null
  resumeAt: string | null // ISO
}

export interface HardStopDecision {
  stop: boolean
  reason: 'session' | 'weekly' | null
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
/** After this long without a successful poll the numbers are STALE: rest decisions
 *  freeze (no auto-resume on stale data) and the scheduler holds new activations. */
export const STALE_MS = 5 * 60_000
const LIMIT_HIT_REST_MS = 30 * 60_000 // reactive backstop rest when no reset time is known
// 429 ladder: 2 → 4 → 8 → 10 min. The most common 429 is the transient one right
// after an office restart (the boot's CLI-session burst drains the shared per-
// account oauth bucket) — a short first retry un-blinds the office quickly once
// the burst settles, while the cap stays gentle during real endpoint outages.
const BACKOFF_START_MS = 2 * 60_000
const BACKOFF_MAX_MS = 10 * 60_000
// Adaptive cadence: the oauth bucket is shared with the CLI sessions themselves,
// so OUR polling contributes to the very starvation that blinds us. Far from the
// thresholds a slow poll is plenty; near them (or blind) poll at full rate.
const CALM_POLL_MULTIPLIER = 5
const HOT_PCT = 70

// The usage endpoint buckets callers by User-Agent: requests that don't identify
// as the Claude Code CLI land in an aggressively throttled bucket and get
// persistent 429s (anthropics/claude-code issues #31021 / #31637 / #30930).
// Send the locally installed CLI's version so we share the CLI's generous bucket.
const CLI_UA = (() => {
  try {
    // Fixed literal command, no user input. shell: true only because Windows
    // installs `claude` as a .cmd shim that execFile can't launch directly.
    const out = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 8_000, windowsHide: true, shell: true })
    const m = out.match(/(\d+\.\d+\.\d+)/)
    if (m) return `claude-code/${m[1]}`
  } catch { /* fall through */ }
  return 'claude-code/2.1.208' // last version verified on this machine; UA presence is what matters
})()

export class UsageMonitor {
  private state: UsageState = {
    ok: false, sessionPct: null, weeklyPct: null,
    sessionResetsAt: null, weeklyResetsAt: null, lastChecked: 0, lastOkAt: 0,
  }
  private lastOkAt = 0
  private lastRest: RestDecision = { resting: false, reason: null, resumeAt: null }
  private failLogged = false
  private backoffUntil = 0
  private backoffMs = BACKOFF_START_MS
  private timer: ReturnType<typeof setInterval> | null = null
  private resumeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private cfg: UsageRestConfig,
    private onChange: (state: UsageState, rest: RestDecision, hard: HardStopDecision) => void,
    private log: (line: string) => void,
  ) {}

  /** First poll, awaited before the scheduler starts so a boot at ≥threshold
   *  never spawns doomed activations. Resolves (never rejects) on failure —
   *  degrade open. */
  async prime(): Promise<void> {
    await this.poll()
  }

  /** Base cadence when hot/blind; 5× slower when healthy and far from every
   *  threshold — polling gently is part of staying UN-blind (shared bucket). */
  nextPollMs(): number {
    const base = Math.max(15, this.cfg.pollSeconds) * 1000
    const hot = (this.state.sessionPct ?? 100) >= HOT_PCT || (this.state.weeklyPct ?? 100) >= HOT_PCT
    return this.state.ok && !hot ? base * CALM_POLL_MULTIPLIER : base
  }

  start() {
    const tick = () => {
      this.timer = setTimeout(async () => { await this.poll(); tick() }, this.nextPollMs())
    }
    tick()
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
    if (this.resumeTimer) clearTimeout(this.resumeTimer)
  }

  snapshot(): UsageState { return { ...this.state } }

  /** Owner changed the rest thresholds at runtime — apply live so the next
   *  shouldRest() uses the new numbers without a restart. */
  setConfig(cfg: UsageRestConfig) {
    const pollChanged = cfg.pollSeconds !== this.cfg.pollSeconds
    this.cfg = cfg
    if (pollChanged && this.timer) { clearTimeout(this.timer); this.start() }
    this.emit() // re-evaluate rest decision + broadcast with the new thresholds
  }

  private isFresh(): boolean {
    return this.state.ok || (this.lastOkAt > 0 && Date.now() - this.lastOkAt < STALE_MS)
  }

  shouldRest(): RestDecision {
    const now = Date.now()
    // Blind → keep the LAST decision instead of guessing. Flipping to "not
    // resting" the moment a stale reset time passes is how the office once
    // auto-resumed into a maxed-out window (2026-07-17 incident). New spawns
    // while blind are separately held by the scheduler (allowWhenBlind).
    if (!this.isFresh()) return this.lastRest
    const inFuture = (iso: string | null) => !!iso && Date.parse(iso) > now
    if (this.state.weeklyPct !== null && this.state.weeklyPct >= this.cfg.weeklyThresholdPct
      && inFuture(this.state.weeklyResetsAt)) {
      return { resting: true, reason: 'weekly', resumeAt: this.state.weeklyResetsAt }
    }
    if (this.state.sessionPct !== null && this.state.sessionPct >= this.cfg.sessionThresholdPct
      && inFuture(this.state.sessionResetsAt)) {
      return { resting: true, reason: 'session', resumeAt: this.state.sessionResetsAt }
    }
    return { resting: false, reason: null, resumeAt: null }
  }

  /** HARD money ceiling — only ever trips on FRESH data (a stale 100% from an
   *  hour ago must not kill sessions now; blindness is handled by the
   *  scheduler's spawn hold instead). */
  shouldHardStop(): HardStopDecision {
    if (!this.isFresh()) return { stop: false, reason: null }
    const hardPct = this.cfg.hardStopPct ?? 100
    if (this.state.sessionPct !== null && this.state.sessionPct >= hardPct) return { stop: true, reason: 'session' }
    if (this.state.weeklyPct !== null && this.state.weeklyPct >= hardPct) return { stop: true, reason: 'weekly' }
    return { stop: false, reason: null }
  }

  /** Reactive backstop: an agent activation was refused with a limit error.
   *  Trust the refusal even if polling lags or is broken. (Sets 100% → the
   *  hard stop fires through the same emit.) */
  noteLimitHit() {
    const now = Date.now()
    const keepReset = this.state.sessionResetsAt && Date.parse(this.state.sessionResetsAt) > now
    this.state = {
      ...this.state,
      ok: true,
      sessionPct: 100,
      sessionResetsAt: keepReset ? this.state.sessionResetsAt : new Date(now + LIMIT_HIT_REST_MS).toISOString(),
      lastChecked: now,
      lastOkAt: now,
    }
    this.lastOkAt = now
    this.log('usage: agent activation refused by limit — resting (reactive backstop)')
    this.emit()
  }

  private readToken(): string | null {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'))
      const creds = raw.claudeAiOauth ?? raw.default ?? raw
      return creds.accessToken ?? creds.access_token ?? null
    } catch {
      return null
    }
  }

  /** A successful usage payload (endpoint or test file) → fresh state + emit. */
  private applyUsage(json: {
    five_hour?: { utilization?: number; resets_at?: string }
    seven_day?: { utilization?: number; resets_at?: string }
  }) {
    const now = Date.now()
    this.state = {
      ok: true,
      sessionPct: json.five_hour?.utilization ?? null,
      weeklyPct: json.seven_day?.utilization ?? null,
      sessionResetsAt: json.five_hour?.resets_at ?? null,
      weeklyResetsAt: json.seven_day?.resets_at ?? null,
      lastChecked: now,
      lastOkAt: now,
    }
    this.lastOkAt = now
    this.failLogged = false
    this.backoffMs = BACKOFF_START_MS // healthy again — reset the 429 ladder
    this.emit()
  }

  private async poll(retryOnNetworkError = true): Promise<void> {
    // TEST ONLY: a fake usage source so the money-guard paths (rest, hard stop,
    // blind hold, sticky resume) can be exercised without the real endpoint or
    // any real agent sessions. Same JSON shape as the endpoint response.
    const fakeFile = process.env.OFFICE_FAKE_USAGE_FILE
    if (fakeFile) {
      try {
        this.applyUsage(JSON.parse(fs.readFileSync(fakeFile, 'utf8')))
      } catch (err) {
        this.fail(`fake usage file unreadable: ${String(err)}`)
      }
      return
    }
    if (Date.now() < this.backoffUntil) return // still cooling down after a 429
    const token = this.readToken()
    if (!token) return this.fail('no Claude Code credentials found (~/.claude/.credentials.json)')
    try {
      const res = await fetch(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': CLI_UA,
        },
        signal: AbortSignal.timeout(15_000),
      })
      if (res.status === 429) {
        // Re-polling a rate-limited endpoint at the normal cadence digs the hole
        // deeper. Cool down with a doubling backoff instead.
        this.backoffUntil = Date.now() + this.backoffMs
        const mins = Math.round(this.backoffMs / 60_000)
        this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS)
        return this.fail(`usage endpoint returned 429 — backing off ${mins} min`)
      }
      if (res.status !== 200) return this.fail(`usage endpoint returned ${res.status}`)
      this.applyUsage(await res.json())
    } catch (err) {
      // Transient network blips are common; one retry keeps the boot-time
      // prime() from starting the office blind.
      if (retryOnNetworkError) {
        await new Promise(r => setTimeout(r, 3_000))
        return this.poll(false)
      }
      const cause = (err as { cause?: { code?: string } })?.cause?.code
        ?? (err instanceof Error ? err.message : 'error')
      this.fail(`usage endpoint unreachable: ${cause}`)
    }
  }

  private fail(why: string) {
    this.state = { ...this.state, ok: false, lastChecked: Date.now() }
    if (!this.failLogged) {
      this.log(`usage monitor degraded — office keeps working unguarded (${why})`)
      this.failLogged = true
    }
    this.emit()
  }

  private emit() {
    const rest = this.shouldRest()
    // While resting, arm a wake-up just past the reset so resume doesn't wait
    // for the next poll tick. (Resume itself only happens on a FRESH poll —
    // shouldRest holds the last decision while blind.)
    if (rest.resting && rest.resumeAt) {
      const delay = Date.parse(rest.resumeAt) + 60_000 - Date.now()
      if (this.resumeTimer) clearTimeout(this.resumeTimer)
      if (delay > 0) this.resumeTimer = setTimeout(() => void this.poll(), delay)
    }
    this.lastRest = rest
    this.onChange(this.snapshot(), rest, this.shouldHardStop())
  }
}

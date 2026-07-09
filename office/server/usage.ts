// Usage-aware rest mode: polls the Anthropic OAuth usage endpoint with the
// local Claude Code token so the office can stop spawning agents at 90% of the
// 5-hour window (95% weekly) and resume when the window resets.
// The token is re-read from disk on every poll (Claude Code refreshes the file
// while it runs) and is never logged, broadcast, or included in errors.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface UsageRestConfig {
  sessionThresholdPct: number // rest when 5-hour utilization ≥ this
  weeklyThresholdPct: number  // rest when 7-day utilization ≥ this
  pollSeconds: number
}

export interface UsageState {
  ok: boolean // recent successful fetch (or trusted limit-hit signal)
  sessionPct: number | null
  weeklyPct: number | null
  sessionResetsAt: string | null // ISO
  weeklyResetsAt: string | null  // ISO
  lastChecked: number
}

export interface RestDecision {
  resting: boolean
  reason: 'session' | 'weekly' | null
  resumeAt: string | null // ISO
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const STALE_MS = 5 * 60_000       // after 5 min of failures, stop trusting old numbers
const LIMIT_HIT_REST_MS = 30 * 60_000 // reactive backstop rest when no reset time is known

export class UsageMonitor {
  private state: UsageState = {
    ok: false, sessionPct: null, weeklyPct: null,
    sessionResetsAt: null, weeklyResetsAt: null, lastChecked: 0,
  }
  private lastOkAt = 0
  private lastRest: RestDecision = { resting: false, reason: null, resumeAt: null }
  private failLogged = false
  private timer: ReturnType<typeof setInterval> | null = null
  private resumeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private cfg: UsageRestConfig,
    private onChange: (state: UsageState, rest: RestDecision) => void,
    private log: (line: string) => void,
  ) {}

  /** First poll, awaited before the scheduler starts so a boot at ≥threshold
   *  never spawns doomed activations. Resolves (never rejects) on failure —
   *  degrade open. */
  async prime(): Promise<void> {
    await this.poll()
  }

  start() {
    this.timer = setInterval(() => void this.poll(), Math.max(15, this.cfg.pollSeconds) * 1000)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    if (this.resumeTimer) clearTimeout(this.resumeTimer)
  }

  snapshot(): UsageState { return { ...this.state } }

  /** Owner changed the rest thresholds at runtime — apply live so the next
   *  shouldRest() uses the new numbers without a restart. */
  setConfig(cfg: UsageRestConfig) {
    const pollChanged = cfg.pollSeconds !== this.cfg.pollSeconds
    this.cfg = cfg
    if (pollChanged && this.timer) { clearInterval(this.timer); this.start() }
    this.emit() // re-evaluate rest decision + broadcast with the new thresholds
  }

  shouldRest(): RestDecision {
    const now = Date.now()
    const fresh = this.state.ok || (this.lastOkAt > 0 && now - this.lastOkAt < STALE_MS)
    // Degrade open: a broken monitor must never brick the office. The UI shows
    // "USAGE ?" so the owner knows the guard is blind.
    if (!fresh) return { resting: false, reason: null, resumeAt: null }
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

  /** Reactive backstop: an agent activation was refused with a limit error.
   *  Trust the refusal even if polling lags or is broken. */
  noteLimitHit() {
    const now = Date.now()
    const keepReset = this.state.sessionResetsAt && Date.parse(this.state.sessionResetsAt) > now
    this.state = {
      ...this.state,
      ok: true,
      sessionPct: 100,
      sessionResetsAt: keepReset ? this.state.sessionResetsAt : new Date(now + LIMIT_HIT_REST_MS).toISOString(),
      lastChecked: now,
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

  private async poll(retryOnNetworkError = true): Promise<void> {
    const token = this.readToken()
    if (!token) return this.fail('no Claude Code credentials found (~/.claude/.credentials.json)')
    try {
      const res = await fetch(USAGE_URL, {
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
        signal: AbortSignal.timeout(15_000),
      })
      if (res.status !== 200) return this.fail(`usage endpoint returned ${res.status}`)
      const json = await res.json() as {
        five_hour?: { utilization?: number; resets_at?: string }
        seven_day?: { utilization?: number; resets_at?: string }
      }
      this.state = {
        ok: true,
        sessionPct: json.five_hour?.utilization ?? null,
        weeklyPct: json.seven_day?.utilization ?? null,
        sessionResetsAt: json.five_hour?.resets_at ?? null,
        weeklyResetsAt: json.seven_day?.resets_at ?? null,
        lastChecked: Date.now(),
      }
      this.lastOkAt = Date.now()
      this.failLogged = false
      this.emit()
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
    // for the next poll tick.
    if (rest.resting && rest.resumeAt) {
      const delay = Date.parse(rest.resumeAt) + 60_000 - Date.now()
      if (this.resumeTimer) clearTimeout(this.resumeTimer)
      if (delay > 0) this.resumeTimer = setTimeout(() => void this.poll(), delay)
    }
    this.lastRest = rest
    this.onChange(this.snapshot(), rest)
  }
}

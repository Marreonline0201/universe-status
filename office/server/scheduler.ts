// Demand-driven scheduler (user decision: no quality-degrading rationing).
// Every agent with runnable work gets a live session; the only limit is a
// machine-stability soft cap (maxConcurrent). Safety valves: pause, per-agent
// cooldown, and a no-progress backoff so a stuck task can't spin forever.
import fs from 'node:fs'
import path from 'node:path'
import type { Paths, AgentProfile } from './store.ts'
import { loadInbox, loadTasks } from './store.ts'
import { Activation, SessionStore, type ActivationConfig } from './session.ts'
import type { AgentVisualStatus, PoolState, TaskSummary } from './protocol.ts'
import { STALE_MS, type HardStopDecision, type RestDecision, type UsageRestConfig, type UsageState } from './usage.ts'

export interface OfficeConfig {
  port: number
  maxConcurrent: number
  maxTurns: number
  activationTimeoutMs: number
  agentCooldownMs: number
  noProgressBackoffMs: number
  allowedTools: string
  fableFallbackModel?: string
  autoCommit: boolean
  autoCommitBranch: string
  autoCommitIntervalMs: number
  /** Absolute path in the user's Obsidian vault that mirrors company/reports/**. */
  vaultMirrorDir?: string
  /** Rest thresholds for the subscription usage guard (see usage.ts). */
  usageRest?: Partial<UsageRestConfig>
  /** Owner-request run whitelist + limits (see runner.ts). */
  runner?: import('./runner.ts').RunnerConfig
  /** Public-share exposure: browser origins allowed when OFFICE_OWNER_TOKEN is set
   *  (e.g. the deployed site's URL). The token itself is an env var, never config. */
  publicShare?: { allowedOrigins?: string[] }
  /** Token-cost control: cap how large a resumed transcript may grow before the
   *  session is reset (agents re-hydrate from their MEMORY.md notepad). Absent =
   *  legacy resume-always behavior. See session.ts / the token-burn measurement. */
  session?: { maxContextTokens?: number; injectMemory?: 'fresh' | 'always' | 'never' }
}

export interface SchedulerEvents {
  onStatus: (id: string, status: AgentVisualStatus, task?: TaskSummary | null) => void
  onActivity: (id: string, kind: 'tool_use' | 'text' | 'thinking' | 'turn_end', tool?: string, detail?: string) => void
  onTranscript: (id: string, line: string) => void
  onPool: (pool: PoolState) => void
  /** An activation was refused because the subscription limit is exhausted. */
  onLimitHit: () => void
  log: (line: string) => void
}

interface Runnable {
  agent: AgentProfile
  reason: string
  priority: number // lower = first
  task: TaskSummary | null
  sig: string // "work signature" — same value two wakes in a row ⇒ nothing new to do
}

const STATUS_PRIORITY: Record<string, number> = {
  inbox: 0,      // unrouted user task (director)
  revise: 1,
  assigned: 2,
  'in-progress': 3,
}

// Cap for the escalating no-progress backoff. A task blocked on an external gate (e.g. a
// survey waiting on the owner's lab runs) leaves its agent perpetually "runnable" — an
// in-progress task never leaves the runnable set. Without this, the agent re-wakes every
// cooldown, burns a full session re-verifying an unchanged blocker, and appends another
// identical "hold" log line (which counts as wroteFiles, defeating the plain no-progress
// backoff). The fix: when we re-wake an agent on the SAME work signature, escalate the
// backoff up to this cap so a stuck agent settles to one heartbeat wake per ~30 min. Any
// real change (new mail, task status change, new task) resets it → instant wake.
const SPIN_BACKOFF_CAP_MS = 30 * 60_000

export class Scheduler {
  paused = false
  /** Usage hard stop tripped: in-flight sessions were killed and the office is
   *  sticky-paused (survives restarts via the lock file) until the owner resumes. */
  hardStopped = false
  private usage: UsageState | null = null
  private rest: RestDecision = { resting: false, reason: null, resumeAt: null }
  private live = new Map<string, Activation>()
  private lastEnd = new Map<string, number>()     // agentId → ts of last activation end
  private backoffUntil = new Map<string, number>() // agentId → ts before which not runnable
  private lastSig = new Map<string, string>()     // agentId → work signature at last activation
  private spinCount = new Map<string, number>()   // consecutive re-wakes on an unchanged signature
  private queued: Runnable[] = []
  private sessions: SessionStore
  private scanTimer: ReturnType<typeof setInterval> | null = null
  private blindHoldLogged = false
  private readonly hardStopLock: string

  constructor(
    private paths: Paths,
    private roster: AgentProfile[],
    private cfg: OfficeConfig,
    private events: SchedulerEvents,
  ) {
    this.sessions = new SessionStore(paths.repoRoot)
    // A hard stop survives restarts: the lock keeps a rebooted office paused
    // until the OWNER resumes — "it restarted, so it's spending again" is the
    // exact incident this exists to prevent.
    this.hardStopLock = path.join(paths.repoRoot, 'office', 'state', 'usage-hardstop.lock')
    if (fs.existsSync(this.hardStopLock)) {
      this.paused = true
      this.hardStopped = true
    }
  }

  start() {
    if (this.hardStopped) {
      this.events.log('🛑 booting PAUSED — a usage hard-stop lock is present; resume requires the owner (office/state/usage-hardstop.lock)')
    }
    // Watcher calls poke() on file changes; the interval is a safety net.
    this.scanTimer = setInterval(() => this.poke(), 10_000)
    this.poke()
  }

  stop() {
    if (this.scanTimer) clearInterval(this.scanTimer)
    for (const [id, act] of this.live) {
      act.kill('office shutdown')
      this.events.onStatus(id, 'idle')
    }
    this.live.clear()
  }

  pause() { this.paused = true; this.emitPool() }

  /** Owner resume: clears the manual pause AND a usage hard stop (lock file
   *  included). Only reachable through the owner-token-gated /api/resume. */
  resume() {
    if (this.hardStopped) {
      this.hardStopped = false
      try { fs.rmSync(this.hardStopLock) } catch { /* already gone */ }
      this.events.log('▶ owner resume — usage hard-stop lock cleared')
    }
    this.paused = false
    this.blindHoldLogged = false
    this.poke()
  }

  /** Called by the UsageMonitor whenever usage data (or its absence) updates. */
  setUsage(state: UsageState, rest: RestDecision, hard: HardStopDecision) {
    const wasResting = this.rest.resting
    this.usage = state
    this.rest = rest
    if (hard.stop && !this.hardStopped) {
      this.hardStop(hard.reason)
      return
    }
    if (rest.resting && !wasResting) {
      this.events.log(`😴 resting — ${rest.reason} limit reached, agents resume ~${rest.resumeAt ?? 'soon'} (in-flight turns finish)`)
      this.emitPool()
    } else if (!rest.resting && wasResting) {
      this.events.log('▶ rest over — usage window reset (fresh poll), resuming queued work')
      this.poke()
    } else {
      this.emitPool() // fresh percentages for the HUD
    }
  }

  /** The money ceiling. Unlike the soft rest (which lets in-flight turns finish
   *  inside the threshold headroom), a fresh at-the-limit signal means every
   *  further minute of any session can bill extra-usage credits — so in-flight
   *  sessions are KILLED, not graced. All office work is file-based and
   *  resumable; a re-done turn later costs subscription, a finished turn now
   *  costs money. Sticky until the owner resumes. */
  private hardStop(reason: 'session' | 'weekly' | null) {
    this.hardStopped = true
    this.paused = true
    const killed = this.live.size
    for (const [id, act] of this.live) {
      act.kill(`usage hard stop (${reason ?? 'limit'} ceiling)`)
      this.events.onStatus(id, 'idle')
    }
    this.live.clear()
    try {
      fs.mkdirSync(path.dirname(this.hardStopLock), { recursive: true })
      fs.writeFileSync(this.hardStopLock, JSON.stringify({ reason, at: new Date().toISOString() }, null, 2))
    } catch { /* lock is belt-and-suspenders; the in-memory pause still holds */ }
    this.events.log(`🛑 HARD STOP — ${reason ?? 'usage'} window at the ceiling: killed ${killed} in-flight session(s); office stays paused until the OWNER resumes`)
    this.emitPool()
  }

  /** True while new activations must be held because the usage monitor is
   *  blind. With extra-usage billing enabled, sessions past the limit BILL
   *  rather than refuse — an unverifiable window is a money risk, so spawning
   *  needs a confirmed number. The owner may waive this (allowWhenBlind) after
   *  disabling extra-usage billing in the Anthropic console. */
  private holdingBlind(): boolean {
    if (this.cfg.usageRest?.allowWhenBlind) return false
    if (!this.usage) return true
    return !this.usage.ok && Date.now() - this.usage.lastOkAt > STALE_MS
  }

  poolState(): PoolState {
    return {
      cap: this.cfg.maxConcurrent,
      active: [...this.live.keys()],
      queued: this.queued.map(r => r.agent.id),
      paused: this.paused,
      hardStopped: this.hardStopped,
      holdingBlind: this.holdingBlind(),
      resting: this.rest.resting,
      restReason: this.rest.reason,
      restResumeAt: this.rest.resumeAt,
      usagePct: this.usage?.sessionPct ?? null,
      weeklyPct: this.usage?.weeklyPct ?? null,
      usageMonitorOk: this.usage?.ok ?? false,
      usageAgeMs: this.usage && this.usage.lastOkAt > 0 ? Date.now() - this.usage.lastOkAt : null,
      sessionThresholdPct: this.cfg.usageRest?.sessionThresholdPct ?? 90,
      weeklyThresholdPct: this.cfg.usageRest?.weeklyThresholdPct ?? 95,
      allowWhenBlind: this.cfg.usageRest?.allowWhenBlind ?? false,
    }
  }

  /** Re-evaluate who has work and fill free slots. Cheap; called on every file event. */
  poke() {
    if (this.paused) { this.emitPool(); return }
    const now = Date.now()
    const tasks = loadTasks(this.paths)
    const runnable: Runnable[] = []

    for (const agent of this.roster) {
      if (this.live.has(agent.id)) continue

      const myTasks = tasks
        .filter(t => t.assignee === agent.id && t.status in STATUS_PRIORITY)
        .sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]
          || (a.priority === 'high' ? -1 : 0) - (b.priority === 'high' ? -1 : 0))
      // Unrouted tasks belong to the director even if unassigned.
      if (agent.id === 'director') {
        myTasks.push(...tasks.filter(t => t.status === 'inbox' && t.assignee !== 'director'))
      }
      const inbox = loadInbox(this.paths, agent.id)

      if (myTasks.length === 0 && inbox.length === 0) continue
      const top = myTasks[0] ?? null

      // Does this agent actually have anything NEW since we last woke it? Same top task +
      // status + unread-mail count ⇒ nothing changed. Fresh/changed work clears any active
      // backoff (wake now); unchanged work must serve out its escalating backoff so a task
      // blocked on an external gate can't spin. (loadInbox already excludes archived mail,
      // so inbox.length is the genuine unread count.)
      const sig = this.workSig(top, inbox.length)
      if (sig !== this.lastSig.get(agent.id)) {
        this.backoffUntil.delete(agent.id)
      } else if ((this.backoffUntil.get(agent.id) ?? 0) > now) {
        continue
      }
      // Always honor the minimum inter-activation cooldown.
      if (now - (this.lastEnd.get(agent.id) ?? 0) < this.cfg.agentCooldownMs) continue

      runnable.push({
        agent,
        task: top,
        sig,
        reason: [
          inbox.length ? `${inbox.length} unread mail` : '',
          top ? `task ${top.id} (${top.status})` : '',
        ].filter(Boolean).join(', '),
        priority: top ? STATUS_PRIORITY[top.status] : 4,
      })
    }

    runnable.sort((a, b) => a.priority - b.priority)

    // Usage guard: near the subscription limit everything waits in the queue;
    // in-flight activations finish naturally (the 10% headroom absorbs them).
    if (this.rest.resting) {
      this.queued = runnable
      this.emitPool()
      return
    }

    // Blind-hold: no NEW activations without a confirmed usage number.
    if (this.holdingBlind()) {
      if (!this.blindHoldLogged && runnable.length > 0) {
        this.blindHoldLogged = true
        this.events.log(`⏸ usage UNKNOWN (endpoint unreachable/rate-limited) — holding ${runnable.length} activation(s); in-flight finish. Owner: set allowWhenBlind only if extra-usage billing is OFF`)
      }
      this.queued = runnable
      this.emitPool()
      return
    }
    this.blindHoldLogged = false

    this.queued = runnable.slice(Math.max(0, this.cfg.maxConcurrent - this.live.size))

    for (const r of runnable) {
      if (this.live.size >= this.cfg.maxConcurrent) break
      this.activate(r)
    }
    this.emitPool()
  }

  /** A cheap fingerprint of an agent's runnable state. Two wakes with the same signature
   *  mean nothing actionable changed in between (same top task + status, same unread-mail
   *  count) — the trigger for the escalating spin backoff. */
  private workSig(top: TaskSummary | null, unreadMail: number): string {
    return `${top?.id ?? '-'}:${top?.status ?? '-'}|mail:${unreadMail}`
  }

  private activate(r: Runnable) {
    const { agent } = r
    const inbox = loadInbox(this.paths, agent.id)
    const resume = this.sessions.get(agent.id)

    // Count consecutive wakes on an unchanged work signature (reset when it changes).
    const spins = r.sig === this.lastSig.get(agent.id) ? (this.spinCount.get(agent.id) ?? 0) + 1 : 0
    this.lastSig.set(agent.id, r.sig)
    this.spinCount.set(agent.id, spins)
    const lines = [
      `Office activation for ${agent.id} (${agent.role}).`,
      inbox.length
        ? `You have ${inbox.length} unread mail(s) in company/mail/${agent.id}/inbox/ — process them first (oldest first), then archive them.`
        : `Your inbox is empty.`,
      r.task
        ? `Your current task: ${r.task.id} — "${r.task.title}" (status: ${r.task.status}). The task file is in company/tasks/. Work it as far as you can this turn, update its status and ## Log.`
        : `You have no assigned task. Only act on your mail; do not invent work.`,
      `Follow the "Every activation, in order" checklist in your role instructions. Finish cleanly.`,
    ]
    // On a FRESH/post-reset start the transcript is gone, so hand the agent its durable
    // notepad up front — it never wakes up blank. (On a resume it already holds it, and
    // re-injecting would just re-bloat the transcript.) Injected in the user prompt so the
    // cached AGENT.md system prompt stays byte-identical.
    const mode = this.cfg.session?.injectMemory ?? 'fresh'
    if (mode !== 'never' && (mode === 'always' || !resume)) {
      const memFile = path.join(this.paths.repoRoot, '.claude', 'agent-memory', agent.id, 'MEMORY.md')
      try {
        if (fs.existsSync(memFile)) {
          const mem = fs.readFileSync(memFile, 'utf8').slice(0, 8000) // cap so a runaway file can't re-bloat
          if (mem.trim()) lines.push(`\nYour durable memory notepad (from prior activations — treat as ground truth for where things stand):\n${mem}`)
        }
      } catch { /* no memory yet — the agent will create it this activation */ }
    }
    const prompt = lines.join('\n')

    const cfg: ActivationConfig = {
      maxTurns: this.cfg.maxTurns,
      timeoutMs: this.cfg.activationTimeoutMs,
      fableFallbackModel: this.cfg.fableFallbackModel,
      allowedTools: this.cfg.allowedTools,
    }

    const act = new Activation(this.paths, agent, prompt, resume, {
      onStatus: (s) => this.events.onStatus(agent.id, agent.role === 'Reviewer / Editor' && s === 'working' ? 'reviewing' : s, r.task),
      onActivity: (kind, tool, detail) => this.events.onActivity(agent.id, kind, tool, detail),
      onTranscript: (line) => this.events.onTranscript(agent.id, line),
      onEnd: (res) => {
        this.live.delete(agent.id)
        this.lastEnd.set(agent.id, Date.now())
        if (res.sessionId) {
          // Compact: once a session's replay size exceeds the cap, drop it so the NEXT
          // wake starts fresh + re-hydrates from MEMORY.md. Gate on wroteMemory so a reset
          // only lands right AFTER the agent saved its notes (except the cap*2 hard ceiling).
          const cap = this.cfg.session?.maxContextTokens
          if (cap && res.contextTokens != null && res.contextTokens > cap && (res.wroteMemory || res.contextTokens > cap * 2)) {
            this.sessions.clear(agent.id)
            this.events.log(`↺ ${agent.id} session reset at ${Math.round(res.contextTokens / 1000)}k tok (cap ${Math.round(cap / 1000)}k, memSaved=${res.wroteMemory})`)
          } else {
            this.sessions.set(agent.id, res.sessionId)
          }
        }
        // Escalating no-progress backoff: doubles each consecutive wake on an unchanged
        // signature, capped, so a blocked or repeatedly-failing agent settles to a heartbeat
        // instead of spinning. spins === 0 (fresh work) keeps the original single interval.
        const backoff = Math.min(this.cfg.noProgressBackoffMs * 2 ** Math.min(spins, 4), SPIN_BACKOFF_CAP_MS)
        if (!res.ok) {
          if (res.limitHit) this.events.onLimitHit()
          // A failed resume is the most common failure: drop the session and retry fresh later.
          if (res.error && /resume|session/i.test(res.error)) this.sessions.clear(agent.id)
          this.events.onStatus(agent.id, 'blocked', r.task)
          this.events.log(`✗ ${agent.id} activation failed: ${res.error?.slice(0, 200)}`)
          this.backoffUntil.set(agent.id, Date.now() + backoff)
        } else {
          this.events.onStatus(agent.id, 'idle')
          if (!res.wroteFiles || spins > 0) {
            // Nothing genuinely new this turn — either no writes at all, or a re-wake on the
            // same work state (a task blocked on an external gate). Back off (escalating).
            this.backoffUntil.set(agent.id, Date.now() + backoff)
            if (spins > 0) this.events.log(`⏸ ${agent.id} nothing new on ${r.task?.status ?? 'inbox'} (spin ${spins}) — next check in ~${Math.round(backoff / 60000)}m`)
          }
        }
        this.poke()
      },
    }, cfg)

    this.live.set(agent.id, act)
    this.events.log(`▶ ${agent.id} activated (${r.reason})`)
    this.events.onStatus(agent.id, 'working', r.task)
    act.start()
  }

  private emitPool() { this.events.onPool(this.poolState()) }
}

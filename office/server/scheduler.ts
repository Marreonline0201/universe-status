// Demand-driven scheduler (user decision: no quality-degrading rationing).
// Every agent with runnable work gets a live session; the only limit is a
// machine-stability soft cap (maxConcurrent). Safety valves: pause, per-agent
// cooldown, and a no-progress backoff so a stuck task can't spin forever.
import type { Paths, AgentProfile } from './store.ts'
import { loadInbox, loadTasks } from './store.ts'
import { Activation, SessionStore, type ActivationConfig } from './session.ts'
import type { AgentVisualStatus, PoolState, TaskSummary } from './protocol.ts'
import type { RestDecision, UsageRestConfig, UsageState } from './usage.ts'

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
}

export interface SchedulerEvents {
  onStatus: (id: string, status: AgentVisualStatus, task?: TaskSummary | null) => void
  onActivity: (id: string, kind: 'tool_use' | 'text' | 'turn_end', tool?: string, detail?: string) => void
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
}

const STATUS_PRIORITY: Record<string, number> = {
  inbox: 0,      // unrouted user task (director)
  revise: 1,
  assigned: 2,
  'in-progress': 3,
}

export class Scheduler {
  paused = false
  private usage: UsageState | null = null
  private rest: RestDecision = { resting: false, reason: null, resumeAt: null }
  private live = new Map<string, Activation>()
  private lastEnd = new Map<string, number>()     // agentId → ts of last activation end
  private backoffUntil = new Map<string, number>() // agentId → ts before which not runnable
  private queued: Runnable[] = []
  private sessions: SessionStore
  private scanTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private paths: Paths,
    private roster: AgentProfile[],
    private cfg: OfficeConfig,
    private events: SchedulerEvents,
  ) {
    this.sessions = new SessionStore(paths.repoRoot)
  }

  start() {
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
  resume() { this.paused = false; this.poke() }

  /** Called by the UsageMonitor whenever fresh usage data arrives. */
  setUsage(state: UsageState, rest: RestDecision) {
    const wasResting = this.rest.resting
    this.usage = state
    this.rest = rest
    if (rest.resting && !wasResting) {
      this.events.log(`😴 resting — ${rest.reason} limit reached, agents resume ~${rest.resumeAt ?? 'soon'} (in-flight turns finish)`)
      this.emitPool()
    } else if (!rest.resting && wasResting) {
      this.events.log('▶ rest over — usage window reset, resuming queued work')
      this.poke()
    } else {
      this.emitPool() // fresh percentages for the HUD
    }
  }

  poolState(): PoolState {
    return {
      cap: this.cfg.maxConcurrent,
      active: [...this.live.keys()],
      queued: this.queued.map(r => r.agent.id),
      paused: this.paused,
      resting: this.rest.resting,
      restReason: this.rest.reason,
      restResumeAt: this.rest.resumeAt,
      usagePct: this.usage?.sessionPct ?? null,
      weeklyPct: this.usage?.weeklyPct ?? null,
      usageMonitorOk: this.usage?.ok ?? false,
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
      if ((this.backoffUntil.get(agent.id) ?? 0) > now) continue
      if (now - (this.lastEnd.get(agent.id) ?? 0) < this.cfg.agentCooldownMs) continue

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
      runnable.push({
        agent,
        task: top,
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

    this.queued = runnable.slice(Math.max(0, this.cfg.maxConcurrent - this.live.size))

    for (const r of runnable) {
      if (this.live.size >= this.cfg.maxConcurrent) break
      this.activate(r)
    }
    this.emitPool()
  }

  private activate(r: Runnable) {
    const { agent } = r
    const inbox = loadInbox(this.paths, agent.id)
    const prompt = [
      `Office activation for ${agent.id} (${agent.role}).`,
      inbox.length
        ? `You have ${inbox.length} unread mail(s) in company/mail/${agent.id}/inbox/ — process them first (oldest first), then archive them.`
        : `Your inbox is empty.`,
      r.task
        ? `Your current task: ${r.task.id} — "${r.task.title}" (status: ${r.task.status}). The task file is in company/tasks/. Work it as far as you can this turn, update its status and ## Log.`
        : `You have no assigned task. Only act on your mail; do not invent work.`,
      `Follow the "Every activation, in order" checklist in your role instructions. Finish cleanly.`,
    ].join('\n')

    const cfg: ActivationConfig = {
      maxTurns: this.cfg.maxTurns,
      timeoutMs: this.cfg.activationTimeoutMs,
      fableFallbackModel: this.cfg.fableFallbackModel,
      allowedTools: this.cfg.allowedTools,
    }

    const act = new Activation(this.paths, agent, prompt, this.sessions.get(agent.id), {
      onStatus: (s) => this.events.onStatus(agent.id, agent.role === 'Reviewer / Editor' && s === 'working' ? 'reviewing' : s, r.task),
      onActivity: (kind, tool, detail) => this.events.onActivity(agent.id, kind, tool, detail),
      onTranscript: (line) => this.events.onTranscript(agent.id, line),
      onEnd: (res) => {
        this.live.delete(agent.id)
        this.lastEnd.set(agent.id, Date.now())
        if (res.sessionId) this.sessions.set(agent.id, res.sessionId)
        if (!res.ok) {
          if (res.limitHit) this.events.onLimitHit()
          // A failed resume is the most common failure: drop the session and retry fresh later.
          if (res.error && /resume|session/i.test(res.error)) this.sessions.clear(agent.id)
          this.events.onStatus(agent.id, 'blocked', r.task)
          this.events.log(`✗ ${agent.id} activation failed: ${res.error?.slice(0, 200)}`)
          this.backoffUntil.set(agent.id, Date.now() + this.cfg.noProgressBackoffMs)
        } else {
          this.events.onStatus(agent.id, 'idle')
          if (!res.wroteFiles) {
            // No file changes: fine for pure routing turns, but back off so an agent
            // that keeps "finishing" without output doesn't spin.
            this.backoffUntil.set(agent.id, Date.now() + this.cfg.noProgressBackoffMs)
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

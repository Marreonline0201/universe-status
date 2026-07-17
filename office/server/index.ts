// Office server boot: roster + scheduler + watcher + auto-commit + WebSocket.
// Everything lives and dies with this process (SIGINT kills all agent sessions).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  resolvePaths, loadRoster, loadTeams, loadTasks, loadReports, buildAgents, createTaskFile,
  readCompanyFile, readCompanyBlob, listLab, loadRequests,
} from './store.ts'
import { Scheduler, type OfficeConfig } from './scheduler.ts'
import { Runner } from './runner.ts'
import { UsageMonitor } from './usage.ts'
import { startWatcher } from './watcher.ts'
import { AutoCommitter } from './autocommit.ts'
import { VaultMirror } from './vault-mirror.ts'
import { OfficeWs } from './ws.ts'
import type { ChatMsg, OfficeAgent, ServerMsg, TaskSummary } from './protocol.ts'

const CHAT_RING = 200
const TRANSCRIPT_RING = 80

export function loadConfig(repoRoot: string): OfficeConfig {
  const file = path.join(repoRoot, 'office', 'config', 'office.json')
  return JSON.parse(fs.readFileSync(file, 'utf8')) as OfficeConfig
}

export async function startOffice(opts: { mock?: boolean } = {}) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const paths = resolvePaths(repoRoot)
  const cfg = loadConfig(repoRoot)

  const roster = loadRoster(paths)
  if (roster.length === 0) {
    console.error('No agents found — run `npm --prefix office run scaffold` first.')
    process.exit(1)
  }
  // Forward-declared (same pattern as scheduler): snapshot/ws handlers close over it.
  type RunnerLike = Pick<Runner, 'list' | 'approve' | 'deny' | 'kill' | 'output' | 'decorate' | 'stop' | 'bootRecover'>
  let runner: RunnerLike | null = null
  let mockFile: ((p: unknown) => ReturnType<typeof readCompanyFile>) | null = null
  let mockLab: import('./protocol.ts').LabExperiment[] | null = null
  const teams = loadTeams(paths)
  // Public-share auth: setting OFFICE_OWNER_TOKEN opts the office into "public read +
  // owner-token write" mode (for internet exposure via a tunnel). Unset → local-only.
  const tokenFile = path.join(repoRoot, 'office', 'config', 'owner-token.txt')
  const ownerToken = process.env.OFFICE_OWNER_TOKEN?.trim()
    || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '')
    || null
  const allowedOrigins = [
    ...(process.env.OFFICE_ALLOWED_ORIGINS?.split(',') ?? []),
    ...(cfg.publicShare?.allowedOrigins ?? []),
  ].map(o => o.trim()).filter(Boolean)
  const wsAuth = { ownerToken, allowedOrigins }
  // If the site is built (dist/), the office serves it so one tunnel exposes everything.
  const distDir = path.join(repoRoot, 'dist')
  const staticDir = fs.existsSync(path.join(distDir, 'index.html')) ? distDir : null
  const agents = new Map<string, OfficeAgent>(buildAgents(roster).map(a => [a.id, a]))
  const chat: ChatMsg[] = []
  const transcripts = new Map<string, string[]>()
  const log = (line: string) => console.log(`[office] ${line}`)

  if (!opts.mock) {
    // Boot check: subscription auth present? (cheapest possible probe)
    try {
      execFileSync('claude', ['--version'], { encoding: 'utf8' })
    } catch {
      console.error('`claude` CLI not found on PATH — install Claude Code and /login first.')
      process.exit(1)
    }
  }

  // Public (non-owner) viewers get a CURATED snapshot: the live office (agents +
  // statuses) + approved reports metadata only. Mail feed, task list, and pending
  // requests are owner-only. Owner viewers (valid token) get the full snapshot.
  const snapshot = (owner: boolean): ServerMsg => {
    const pool = scheduler?.poolState() ?? {
      cap: cfg.maxConcurrent, active: [], queued: [], paused: false,
      hardStopped: false, holdingBlind: false,
      resting: false, restReason: null, restResumeAt: null,
      usagePct: null, weeklyPct: null, usageMonitorOk: false, usageAgeMs: null,
      sessionThresholdPct: cfg.usageRest?.sessionThresholdPct ?? 90,
      weeklyThresholdPct: cfg.usageRest?.weeklyThresholdPct ?? 95,
      allowWhenBlind: cfg.usageRest?.allowWhenBlind ?? false,
    }
    const reports = loadReports(paths)
    return {
      type: 'OFFICE_SNAPSHOT',
      mock: !!opts.mock,
      owner,
      teams,
      agents: [...agents.values()],
      tasks: owner ? loadTasks(paths) : [],
      chat: owner ? chat.slice(-50) : [],
      reports: owner ? reports : reports.filter(r => r.status === 'approved'),
      requests: owner ? (runner?.list() ?? []) : [],
      pool,
    }
  }

  const ws = new OfficeWs(cfg.port, {
    snapshot,
    agentDetail: (id) => {
      const agent = agents.get(id)
      if (!agent) return null
      const profileFile = path.join(paths.companyDir, 'agents', id, 'profile.json')
      const tasks = loadTasks(paths)
      return {
        type: 'AGENT_DETAIL',
        id,
        profile: fs.existsSync(profileFile) ? JSON.parse(fs.readFileSync(profileFile, 'utf8')) : {},
        task: tasks.find(t => t.id === agent.task) ?? tasks.find(t => t.assignee === id && t.status !== 'done' && t.status !== 'archived') ?? null,
        transcriptTail: transcripts.get(id) ?? [],
        reports: loadReports(paths).filter(r => r.team === agent.team),
      }
    },
    assign: (body) => {
      const id = createTaskFile(paths, { ...body, createdBy: 'user' })
      log(`task ${id} created by user for team ${body.team}`)
      scheduler?.poke()
      return id
    },
    pause: () => { scheduler?.pause(); log('paused') },
    resume: () => { scheduler?.resume(); log('resumed') },
    status: () => ({
      mock: !!opts.mock,
      agents: agents.size,
      pool: scheduler?.poolState() ?? null,
      tasks: loadTasks(paths).filter(t => t.status !== 'done' && t.status !== 'archived').length,
      pendingRequests: (runner?.list() ?? []).filter(r => r.status === 'pending').length,
    }),
    requests: () => runner?.list() ?? [],
    file: (p) => {
      // Mock mode: serve canned bodies for mock paths, real disk for everything else.
      if (mockFile) {
        const r = mockFile(p)
        if (r.ok) return r
      }
      return readCompanyFile(paths, p)
    },
    blob: (p) => readCompanyBlob(paths, p),
    lab: () => mockLab ?? listLab(paths),
    approveRequest: (id) => runner?.approve(id) ?? { ok: false, error: 'runner not ready' },
    denyRequest: (id, reason) => runner?.deny(id, reason) ?? { ok: false, error: 'runner not ready' },
    killRequest: (id) => runner?.kill(id) ?? { ok: false, error: 'runner not ready' },
    runOutput: (id) => runner?.output(id) ?? null,
    setUsageLimits: ({ session, weekly, allowWhenBlind }) => {
      const clampPct = (v: number) => Number.isFinite(v) ? Math.min(100, Math.max(10, Math.round(v))) : null
      const s = clampPct(session), w = clampPct(weekly)
      if (s === null || w === null) return { ok: false, error: 'session and weekly must be numbers 10–100' }
      const blind = typeof allowWhenBlind === 'boolean' ? { allowWhenBlind } : {}
      // Persist to office.json (survives restart)…
      const cfgFile = path.join(repoRoot, 'office', 'config', 'office.json')
      try {
        const j = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
        j.usageRest = { ...(j.usageRest ?? {}), sessionThresholdPct: s, weeklyThresholdPct: w, ...blind }
        fs.writeFileSync(cfgFile, JSON.stringify(j, null, 2) + '\n')
      } catch { return { ok: false, error: 'could not write office.json' } }
      // …then apply live: mutate the shared cfg (poolState + blind-hold read it) + push into the monitor.
      cfg.usageRest = { ...(cfg.usageRest ?? {}), sessionThresholdPct: s, weeklyThresholdPct: w, ...blind }
      usage?.setConfig({ ...cfg.usageRest, sessionThresholdPct: s, weeklyThresholdPct: w, pollSeconds: cfg.usageRest?.pollSeconds ?? 60 })
      ws.broadcast({ type: 'POOL_STATE', pool: scheduler.poolState() })
      log(`usage limits set by owner → session ${s}% / weekly ${w}%${'allowWhenBlind' in blind ? ` / allowWhenBlind ${blind.allowWhenBlind}` : ''}`)
      return { ok: true }
    },
  }, wsAuth, staticDir, log)

  const pushChat = (msg: ChatMsg) => {
    chat.push(msg)
    if (chat.length > CHAT_RING) chat.shift()
    ws.broadcast({ type: 'CHAT', msg })
    // The sender "talks" in the office when their mail lands.
    const sender = agents.get(msg.from)
    if (sender) ws.broadcast({ type: 'AGENT_STATUS', id: sender.id, status: sender.status, task: sender.task, taskTitle: sender.taskTitle })
  }

  const scheduler = new Scheduler(paths, roster, cfg, {
    onStatus: (id, status, task) => {
      const a = agents.get(id)
      if (!a) return
      a.status = status
      a.task = task?.id ?? (status === 'idle' ? null : a.task)
      a.taskTitle = task?.title ?? (status === 'idle' ? null : a.taskTitle)
      ws.broadcast({ type: 'AGENT_STATUS', id, status, task: a.task, taskTitle: a.taskTitle })
    },
    onActivity: (id, kind, tool, detail) => {
      ws.broadcast({ type: 'AGENT_ACTIVITY', id, kind, tool, detail, ts: Date.now() })
    },
    onTranscript: (id, line) => {
      const buf = transcripts.get(id) ?? []
      buf.push(line)
      if (buf.length > TRANSCRIPT_RING) buf.shift()
      transcripts.set(id, buf)
    },
    onPool: (pool) => ws.broadcast({ type: 'POOL_STATE', pool }),
    onLimitHit: () => usage?.noteLimitHit(),
    log,
  })

  // Subscription usage guard: rest near the limit, resume on window reset.
  const usage: UsageMonitor | null = opts.mock ? null : new UsageMonitor(
    {
      sessionThresholdPct: 90,
      weeklyThresholdPct: 95,
      pollSeconds: 60,
      ...(cfg.usageRest ?? {}),
    },
    (state, rest, hard) => scheduler.setUsage(state, rest, hard),
    log,
  )

  const vaultMirror = cfg.vaultMirrorDir ? new VaultMirror(paths, cfg.vaultMirrorDir, log) : null
  vaultMirror?.sweep()

  const watcher = startWatcher(paths, {
    onMail: pushChat,
    onTask: (task: TaskSummary) => ws.broadcast({ type: 'TASK_UPDATE', task }),
    onReport: (report) => ws.broadcast({ type: 'REPORT_ADDED', report }),
    onReportFile: (file) => vaultMirror?.mirrorFile(file),
    onRequest: (id) => {
      const raw = loadRequests(paths).find(r => r.id === id)
      if (raw && runner) ws.broadcast({ type: 'REQUEST_UPDATE', request: runner.decorate(raw) })
    },
    onLab: (rel) => ws.broadcast({ type: 'LAB_UPDATED', path: rel }),
    poke: () => scheduler.poke(),
  })

  let committer: AutoCommitter | null = null
  if (cfg.autoCommit && !opts.mock) {
    committer = new AutoCommitter(repoRoot, cfg.autoCommitBranch, log)
    committer.start(cfg.autoCommitIntervalMs)
  }

  await ws.listen()

  if (opts.mock) {
    const { runMock, createMockRunner, mockCompanyFile, MOCK_LAB } = await import('./mock.ts')
    runner = createMockRunner({ broadcast: (m) => ws.broadcast(m), log })
    mockFile = mockCompanyFile
    mockLab = MOCK_LAB
    runMock({ agents, teams, ws, pushChat })
    log('MOCK MODE — scripted office activity, no real sessions')
  } else {
    runner = new Runner(paths, repoRoot, cfg.runner, {
      broadcast: (m) => ws.broadcast(m),
      poke: () => scheduler.poke(),
      log,
    })
    runner.bootRecover()
    // Prime the usage guard before the first poke() so a boot near the limit
    // rests immediately instead of racing doomed activations.
    await usage?.prime()
    usage?.start()
    scheduler.start()
    log(`${roster.length} agents across ${teams.length} teams ready — demand-driven, soft cap ${cfg.maxConcurrent}`)
  }

  const shutdown = () => {
    log('shutting down…')
    runner?.stop()
    usage?.stop()
    scheduler.stop()
    void watcher.close()
    committer?.stop()
    ws.close()
    setTimeout(() => process.exit(0), 500)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

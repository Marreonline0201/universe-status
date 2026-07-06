// Office server boot: roster + scheduler + watcher + auto-commit + WebSocket.
// Everything lives and dies with this process (SIGINT kills all agent sessions).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  resolvePaths, loadRoster, loadTeams, loadTasks, loadReports, buildAgents, createTaskFile,
} from './store.ts'
import { Scheduler, type OfficeConfig } from './scheduler.ts'
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
  const teams = loadTeams(paths)
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

  const snapshot = (): ServerMsg => ({
    type: 'OFFICE_SNAPSHOT',
    mock: !!opts.mock,
    teams,
    agents: [...agents.values()],
    tasks: loadTasks(paths),
    chat: chat.slice(-50),
    reports: loadReports(paths),
    pool: scheduler?.poolState() ?? { cap: cfg.maxConcurrent, active: [], queued: [], paused: false },
  })

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
    }),
  }, log)

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
    log,
  })

  const vaultMirror = cfg.vaultMirrorDir ? new VaultMirror(paths, cfg.vaultMirrorDir, log) : null
  vaultMirror?.sweep()

  const watcher = startWatcher(paths, {
    onMail: pushChat,
    onTask: (task: TaskSummary) => ws.broadcast({ type: 'TASK_UPDATE', task }),
    onReport: (report) => ws.broadcast({ type: 'REPORT_ADDED', report }),
    onReportFile: (file) => vaultMirror?.mirrorFile(file),
    poke: () => scheduler.poke(),
  })

  let committer: AutoCommitter | null = null
  if (cfg.autoCommit && !opts.mock) {
    committer = new AutoCommitter(repoRoot, cfg.autoCommitBranch, log)
    committer.start(cfg.autoCommitIntervalMs)
  }

  await ws.listen()

  if (opts.mock) {
    const { runMock } = await import('./mock.ts')
    runMock({ agents, teams, ws, pushChat })
    log('MOCK MODE — scripted office activity, no real sessions')
  } else {
    scheduler.start()
    log(`${roster.length} agents across ${teams.length} teams ready — demand-driven, soft cap ${cfg.maxConcurrent}`)
  }

  const shutdown = () => {
    log('shutting down…')
    scheduler.stop()
    void watcher.close()
    committer?.stop()
    ws.close()
    setTimeout(() => process.exit(0), 500)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

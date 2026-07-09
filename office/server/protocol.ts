// Wire protocol between the office orchestrator and the website.
// src/hooks/useOfficeSocket.ts mirrors these types on the frontend — keep in sync.

export type AgentVisualStatus =
  | 'offline'   // orchestrator down (client-derived) — empty desk
  | 'idle'      // no live session — sitting at desk
  | 'working'   // live session, thinking
  | 'reading'   // live session, Read/Grep/Glob tool running
  | 'typing'    // live session, Write/Edit tool running
  | 'talking'   // just sent mail / assistant text — speech bubble
  | 'reviewing' // reviewer working a review task
  | 'blocked'   // activation failed / needs the owner

export interface OfficeAgent {
  id: string
  name: string
  team: string
  role: string
  model: string
  status: AgentVisualStatus
  task: string | null // current task id
  taskTitle: string | null
}

export interface OfficeTeam {
  id: string
  name: string
  color: string
}

export interface TaskSummary {
  id: string
  title: string
  team: string
  assignee: string | null
  status: string
  priority: string
  createdBy: string
  parent: string | null
  updatedAt: number
}

export interface ChatMsg {
  from: string
  to: string | null
  subject: string
  kind: string // fyi | request | review-comment | handoff | say
  taskId: string | null
  ts: number
}

export interface ReportMeta {
  team: string
  path: string // repo-relative
  title: string
  status: string // draft | approved
  reviewedBy: string | null
  date: string
}

export interface PoolState {
  cap: number
  active: string[] // agent ids with live sessions
  queued: string[] // runnable agent ids waiting for a slot
  paused: boolean
  // Usage-aware rest mode: office stops spawning agents near the subscription
  // limits (session window / weekly cap) and resumes when the window resets.
  resting: boolean
  restReason: 'session' | 'weekly' | null
  restResumeAt: string | null // ISO — when agents are expected to resume
  usagePct: number | null     // 5-hour window utilization, 0-100
  weeklyPct: number | null    // 7-day window utilization, 0-100
  usageMonitorOk: boolean     // false → guard is blind (creds/endpoint problem)
  sessionThresholdPct: number // owner-set: rest when session usage ≥ this
  weeklyThresholdPct: number  // owner-set: rest when weekly usage ≥ this
}

// ── Owner requests: agents file them; the owner approves/denies in the UI; ──
// the orchestrator executes approved runs and reports back.
export type RequestKind = 'run' | 'decision' | 'access'
export type RequestStatus = 'pending' | 'approved' | 'running' | 'done' | 'failed' | 'denied'

export interface OwnerRequest {
  id: string
  title: string
  kind: RequestKind
  requestedBy: string
  team: string
  taskId: string | null
  status: RequestStatus
  command: string[] | null      // exact argv — the UI renders this verbatim
  cwd: string | null            // symbolic key from runner config ("universe-engine")
  runsIn: 'worktree' | 'repo' | null // engine runs execute in the lab worktree, never main
  valid: boolean                // whitelist check result at load time
  invalidReason: string | null
  warn: string | null           // e.g. "cargo run launches the app window…"
  createdAt: number
  resolvedAt: number | null
  exitCode: number | null
  durationMs: number | null
  resultTail: string | null     // last lines of output, for the card
  path: string                  // repo-relative, feed to GET /api/file
}

export interface LabExperiment {
  id: string        // directory name under company/lab/
  name: string
  path: string      // repo-relative directory
  hasScenario: boolean
  hasNotes: boolean
  updatedAt: number
}

export type ServerMsg =
  | { type: 'OFFICE_SNAPSHOT'; mock: boolean; owner: boolean; teams: OfficeTeam[]; agents: OfficeAgent[]; tasks: TaskSummary[]; chat: ChatMsg[]; reports: ReportMeta[]; pool: PoolState; requests: OwnerRequest[] }
  | { type: 'AGENT_STATUS'; id: string; status: AgentVisualStatus; task?: string | null; taskTitle?: string | null }
  | { type: 'AGENT_ACTIVITY'; id: string; kind: 'tool_use' | 'text' | 'turn_end'; tool?: string; detail?: string; ts: number }
  | { type: 'CHAT'; msg: ChatMsg }
  | { type: 'TASK_UPDATE'; task: TaskSummary }
  | { type: 'REPORT_ADDED'; report: ReportMeta }
  | { type: 'POOL_STATE'; pool: PoolState }
  | { type: 'AGENT_DETAIL'; id: string; profile: Record<string, unknown>; task: TaskSummary | null; transcriptTail: string[]; reports: ReportMeta[] }
  | { type: 'REQUEST_UPDATE'; request: OwnerRequest }
  | { type: 'RUN_OUTPUT'; requestId: string; stream: 'stdout' | 'stderr'; line: string; ts: number }
  | { type: 'LAB_UPDATED'; path: string }
  | { type: 'OFFICE_SHUTDOWN' }

export type ClientMsg =
  | { type: 'HELLO'; token?: string }
  | { type: 'GET_AGENT_DETAIL'; id: string }

export const OFFICE_PORT = 4571

// WebSocket feed from the local office orchestrator (office/ package).
// Mirrors office/server/protocol.ts — keep the two in sync.
// Pattern (backoff reconnect, env-driven URL) follows useStatusSocket.ts.
import { useEffect, useRef, useState } from 'react'

export type AgentVisualStatus =
  | 'offline' | 'idle' | 'working' | 'reading' | 'typing' | 'talking' | 'reviewing' | 'blocked'

export interface OfficeAgent {
  id: string
  name: string
  team: string
  role: string
  model: string
  status: AgentVisualStatus
  task: string | null
  taskTitle: string | null
}

export interface OfficeTeam { id: string; name: string; color: string }

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
  kind: string
  taskId: string | null
  ts: number
}

export interface ReportMeta {
  team: string
  path: string
  title: string
  status: string
  reviewedBy: string | null
  date: string
}

export interface PoolState {
  cap: number
  active: string[]
  queued: string[]
  paused: boolean
  hardStopped: boolean  // money ceiling tripped: in-flight killed, sticky pause until owner resume
  holdingBlind: boolean // monitor blind → new activations held
  // Usage-aware rest mode (mirrors office/server/protocol.ts)
  resting: boolean
  restReason: 'session' | 'weekly' | null
  restResumeAt: string | null
  usagePct: number | null     // LAST GOOD poll — check usageAgeMs before trusting
  weeklyPct: number | null
  usageMonitorOk: boolean
  usageAgeMs: number | null   // ms since the last successful usage poll
  sessionThresholdPct: number // owner-set nap threshold for the 5-hour window
  weeklyThresholdPct: number  // owner-set nap threshold for the 7-day window
  allowWhenBlind: boolean     // owner-set: spawn even while blind (extra-usage billing must be OFF)
}

export interface AgentDetail {
  id: string
  profile: Record<string, unknown>
  task: TaskSummary | null
  transcriptTail: string[]
  reports: ReportMeta[]
}

// ── Owner requests (mirrors office/server/protocol.ts) ──
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
  command: string[] | null
  cwd: string | null
  runsIn: 'worktree' | 'repo' | null
  valid: boolean
  invalidReason: string | null
  warn: string | null
  createdAt: number
  resolvedAt: number | null
  exitCode: number | null
  durationMs: number | null
  resultTail: string | null
  path: string
}

export interface RunLine { stream: 'stdout' | 'stderr'; line: string; ts: number }

export type OfficeServerMsg =
  | { type: 'OFFICE_SNAPSHOT'; mock?: boolean; owner?: boolean; teams: OfficeTeam[]; agents: OfficeAgent[]; tasks: TaskSummary[]; chat: ChatMsg[]; reports: ReportMeta[]; pool: PoolState; requests?: OwnerRequest[] }
  | { type: 'AGENT_STATUS'; id: string; status: AgentVisualStatus; task?: string | null; taskTitle?: string | null }
  | { type: 'AGENT_ACTIVITY'; id: string; kind: 'tool_use' | 'text' | 'thinking' | 'turn_end'; tool?: string; detail?: string; ts: number }
  | { type: 'CHAT'; msg: ChatMsg }
  | { type: 'TASK_UPDATE'; task: TaskSummary }
  | { type: 'REPORT_ADDED'; report: ReportMeta }
  | { type: 'POOL_STATE'; pool: PoolState }
  | ({ type: 'AGENT_DETAIL' } & AgentDetail)
  | { type: 'REQUEST_UPDATE'; request: OwnerRequest }
  | { type: 'RUN_OUTPUT'; requestId: string; stream: 'stdout' | 'stderr'; line: string; ts: number }
  | { type: 'LAB_UPDATED'; path: string }
  | { type: 'OFFICE_SHUTDOWN' }

const TOKEN_KEY = 'office-owner-token'
const readToken = (): string => { try { return sessionStorage.getItem(TOKEN_KEY) ?? '' } catch { return '' } }

export interface OfficeState {
  connected: boolean
  /** True when the orchestrator runs scripted mock activity instead of real agent sessions. */
  mock: boolean
  /** True when this client is authenticated as the owner (full data + controls).
   *  Public viewers are false and receive only the curated view. */
  owner: boolean
  teams: OfficeTeam[]
  agents: OfficeAgent[]
  tasks: TaskSummary[]
  chat: ChatMsg[]
  reports: ReportMeta[]
  requests: OwnerRequest[]
  /** Live run output per request id — batched (100ms) and capped (500 lines) to
   *  avoid a setState per cargo line; raw subscribe() listeners fire per-line. */
  runOutput: Record<string, RunLine[]>
  pool: PoolState
  detail: AgentDetail | null
}

// The office backend runs on the owner's machine and is reached over a permanent
// ngrok tunnel. The Vercel-hosted site is just the window — it connects to that
// tunnel. (Its origin is allowlisted in office/config/office.json publicShare.)
const OFFICE_TUNNEL_HOST = 'graves-ladies-condone.ngrok-free.dev'

// Where the office WS lives:
//  1. VITE_OFFICE_WS_URL if the build sets it (explicit override).
//  2. localhost dev (vite :5173) → the office on :4571.
//  3. the page IS served by the office through the tunnel (same host) → same origin.
//  4. anywhere else (the Vercel site) → the permanent tunnel.
function officeWsUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_OFFICE_WS_URL
  if (env) return env
  if (typeof window === 'undefined') return 'ws://localhost:4571'
  const { protocol, hostname, host } = window.location
  if (hostname === 'localhost' || hostname === '127.0.0.1') return 'ws://localhost:4571'
  if (hostname === OFFICE_TUNNEL_HOST) return (protocol === 'https:' ? 'wss://' : 'ws://') + host
  return 'wss://' + OFFICE_TUNNEL_HOST
}
const OFFICE_URL: string = officeWsUrl()

const INITIAL: OfficeState = {
  connected: false,
  mock: false,
  owner: false,
  teams: [],
  agents: [],
  tasks: [],
  chat: [],
  reports: [],
  requests: [],
  runOutput: {},
  pool: {
    cap: 0, active: [], queued: [], paused: false,
    hardStopped: false, holdingBlind: false,
    resting: false, restReason: null, restResumeAt: null,
    usagePct: null, weeklyPct: null, usageMonitorOk: false, usageAgeMs: null,
    sessionThresholdPct: 90, weeklyThresholdPct: 95, allowWhenBlind: false,
  },
  detail: null,
}

export interface OfficeSocket {
  state: OfficeState
  /** Subscribe to raw protocol messages (used by the canvas engine). Returns unsubscribe. */
  subscribe: (fn: (msg: OfficeServerMsg) => void) => () => void
  requestDetail: (id: string | null) => void
  /** Store the owner password and re-announce on the live socket to upgrade to owner
   *  access (full data + controls). Empty string clears it back to public. Resolves
   *  true if the server accepted it (owner granted), false if rejected/timed out. */
  unlock: (token: string) => Promise<boolean>
}

export function useOfficeSocket(): OfficeSocket {
  const [state, setState] = useState<OfficeState>(INITIAL)
  const wsRef = useRef<WebSocket | null>(null)
  const backoffRef = useRef(1_000)
  const destroyedRef = useRef(false)
  const listenersRef = useRef(new Set<(msg: OfficeServerMsg) => void>())
  const apiRef = useRef<OfficeSocket | null>(null)
  // RUN_OUTPUT batching: buffer lines and flush at most every 100ms.
  const runBufRef = useRef<Record<string, RunLine[]>>({})
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Pending unlock(): resolved with the owner flag when the next snapshot arrives
  // after a HELLO, so the password modal can report accepted / incorrect.
  const unlockResolverRef = useRef<((ok: boolean) => void) | null>(null)

  useEffect(() => {
    function connect() {
      if (destroyedRef.current) return
      try {
        const ws = new WebSocket(OFFICE_URL)
        wsRef.current = ws

        ws.onopen = () => {
          backoffRef.current = 1_000
          setState(s => ({ ...s, connected: true }))
          // Announce ourselves with the stored owner token (if any). Empty token →
          // the server keeps us on the public curated feed.
          ws.send(JSON.stringify({ type: 'HELLO', token: readToken() }))
        }

        ws.onmessage = (evt) => {
          let msg: OfficeServerMsg
          try { msg = JSON.parse(evt.data as string) } catch { return }
          for (const fn of listenersRef.current) fn(msg)

          // A snapshot following a HELLO tells us whether the password was accepted.
          if (msg.type === 'OFFICE_SNAPSHOT' && unlockResolverRef.current) {
            const resolve = unlockResolverRef.current
            unlockResolverRef.current = null
            resolve(!!msg.owner)
          }

          if (msg.type === 'RUN_OUTPUT') {
            const buf = runBufRef.current[msg.requestId] ?? (runBufRef.current[msg.requestId] = [])
            buf.push({ stream: msg.stream, line: msg.line, ts: msg.ts })
            if (!flushTimerRef.current) {
              flushTimerRef.current = setTimeout(() => {
                flushTimerRef.current = null
                const pending = runBufRef.current
                runBufRef.current = {}
                setState(s => {
                  const runOutput = { ...s.runOutput }
                  for (const [id, lines] of Object.entries(pending)) {
                    runOutput[id] = [...(runOutput[id] ?? []), ...lines].slice(-500)
                  }
                  return { ...s, runOutput }
                })
              }, 100)
            }
            return
          }

          setState(s => {
            switch (msg.type) {
              case 'OFFICE_SNAPSHOT':
                // Keep runOutput across reconnects — console history survives.
                return { ...s, connected: true, mock: !!msg.mock, owner: !!msg.owner, teams: msg.teams, agents: msg.agents, tasks: msg.tasks, chat: msg.chat, reports: msg.reports, requests: msg.requests ?? [], pool: msg.pool }
              case 'AGENT_STATUS':
                return {
                  ...s,
                  agents: s.agents.map(a => a.id === msg.id
                    ? { ...a, status: msg.status, task: msg.task !== undefined ? msg.task : a.task, taskTitle: msg.taskTitle !== undefined ? msg.taskTitle : a.taskTitle }
                    : a),
                }
              case 'CHAT':
                return { ...s, chat: [...s.chat.slice(-199), msg.msg] }
              case 'TASK_UPDATE': {
                const rest = s.tasks.filter(t => t.id !== msg.task.id)
                return { ...s, tasks: [msg.task, ...rest] }
              }
              case 'REPORT_ADDED':
                return { ...s, reports: [msg.report, ...s.reports.filter(r => r.path !== msg.report.path)] }
              case 'REQUEST_UPDATE':
                return { ...s, requests: [msg.request, ...s.requests.filter(r => r.id !== msg.request.id)] }
              case 'POOL_STATE':
                return { ...s, pool: msg.pool }
              case 'AGENT_DETAIL':
                return { ...s, detail: msg }
              case 'OFFICE_SHUTDOWN':
                return { ...s, connected: false, agents: s.agents.map(a => ({ ...a, status: 'offline' as const })) }
              default:
                return s
            }
          })
        }

        ws.onclose = () => {
          setState(s => ({ ...s, connected: false, agents: s.agents.map(a => ({ ...a, status: 'offline' as const })) }))
          if (!destroyedRef.current) {
            setTimeout(connect, backoffRef.current)
            backoffRef.current = Math.min(backoffRef.current * 2, 30_000)
          }
        }
        ws.onerror = () => { /* onclose fires after onerror */ }
      } catch {
        setTimeout(connect, backoffRef.current)
        backoffRef.current = Math.min(backoffRef.current * 2, 30_000)
      }
    }

    connect()
    return () => {
      destroyedRef.current = true
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
      wsRef.current?.close()
    }
  }, [])

  if (!apiRef.current) {
    apiRef.current = {
      state,
      subscribe: (fn) => {
        listenersRef.current.add(fn)
        return () => listenersRef.current.delete(fn)
      },
      requestDetail: (id) => {
        if (id === null) {
          setState(s => ({ ...s, detail: null }))
          return
        }
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'GET_AGENT_DETAIL', id }))
        }
      },
      unlock: (token) => {
        try {
          if (token) sessionStorage.setItem(TOKEN_KEY, token)
          else sessionStorage.removeItem(TOKEN_KEY)
        } catch { /* storage unavailable */ }
        const open = wsRef.current?.readyState === WebSocket.OPEN
        // Empty token = drop to viewer; always "succeeds". Re-announce either way.
        if (open) wsRef.current!.send(JSON.stringify({ type: 'HELLO', token }))
        if (!token) return Promise.resolve(true)
        if (!open) return Promise.resolve(false) // can't verify while disconnected
        // Resolve when the server's next snapshot reports owner (or false on timeout).
        return new Promise<boolean>((resolve) => {
          const done = (ok: boolean) => {
            if (unlockResolverRef.current === done) unlockResolverRef.current = null
            clearTimeout(timer)
            if (!ok) { try { sessionStorage.removeItem(TOKEN_KEY) } catch { /* ignore */ } }
            resolve(ok)
          }
          const timer = setTimeout(() => done(false), 4000)
          unlockResolverRef.current = done
        })
      },
    }
  }
  apiRef.current.state = state
  return { ...apiRef.current, state }
}

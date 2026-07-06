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

export interface PoolState { cap: number; active: string[]; queued: string[]; paused: boolean }

export interface AgentDetail {
  id: string
  profile: Record<string, unknown>
  task: TaskSummary | null
  transcriptTail: string[]
  reports: ReportMeta[]
}

export type OfficeServerMsg =
  | { type: 'OFFICE_SNAPSHOT'; mock?: boolean; teams: OfficeTeam[]; agents: OfficeAgent[]; tasks: TaskSummary[]; chat: ChatMsg[]; reports: ReportMeta[]; pool: PoolState }
  | { type: 'AGENT_STATUS'; id: string; status: AgentVisualStatus; task?: string | null; taskTitle?: string | null }
  | { type: 'AGENT_ACTIVITY'; id: string; kind: 'tool_use' | 'text' | 'turn_end'; tool?: string; detail?: string; ts: number }
  | { type: 'CHAT'; msg: ChatMsg }
  | { type: 'TASK_UPDATE'; task: TaskSummary }
  | { type: 'REPORT_ADDED'; report: ReportMeta }
  | { type: 'POOL_STATE'; pool: PoolState }
  | ({ type: 'AGENT_DETAIL' } & AgentDetail)
  | { type: 'OFFICE_SHUTDOWN' }

export interface OfficeState {
  connected: boolean
  /** True when the orchestrator runs scripted mock activity instead of real agent sessions. */
  mock: boolean
  teams: OfficeTeam[]
  agents: OfficeAgent[]
  tasks: TaskSummary[]
  chat: ChatMsg[]
  reports: ReportMeta[]
  pool: PoolState
  detail: AgentDetail | null
}

const OFFICE_URL: string =
  ((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_OFFICE_WS_URL) ?? 'ws://localhost:4571'

const INITIAL: OfficeState = {
  connected: false,
  mock: false,
  teams: [],
  agents: [],
  tasks: [],
  chat: [],
  reports: [],
  pool: { cap: 0, active: [], queued: [], paused: false },
  detail: null,
}

export interface OfficeSocket {
  state: OfficeState
  /** Subscribe to raw protocol messages (used by the canvas engine). Returns unsubscribe. */
  subscribe: (fn: (msg: OfficeServerMsg) => void) => () => void
  requestDetail: (id: string | null) => void
}

export function useOfficeSocket(): OfficeSocket {
  const [state, setState] = useState<OfficeState>(INITIAL)
  const wsRef = useRef<WebSocket | null>(null)
  const backoffRef = useRef(1_000)
  const destroyedRef = useRef(false)
  const listenersRef = useRef(new Set<(msg: OfficeServerMsg) => void>())
  const apiRef = useRef<OfficeSocket | null>(null)

  useEffect(() => {
    function connect() {
      if (destroyedRef.current) return
      try {
        const ws = new WebSocket(OFFICE_URL)
        wsRef.current = ws

        ws.onopen = () => {
          backoffRef.current = 1_000
          setState(s => ({ ...s, connected: true }))
        }

        ws.onmessage = (evt) => {
          let msg: OfficeServerMsg
          try { msg = JSON.parse(evt.data as string) } catch { return }
          for (const fn of listenersRef.current) fn(msg)

          setState(s => {
            switch (msg.type) {
              case 'OFFICE_SNAPSHOT':
                return { ...s, connected: true, mock: !!msg.mock, teams: msg.teams, agents: msg.agents, tasks: msg.tasks, chat: msg.chat, reports: msg.reports, pool: msg.pool }
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
    }
  }
  apiRef.current.state = state
  return { ...apiRef.current, state }
}

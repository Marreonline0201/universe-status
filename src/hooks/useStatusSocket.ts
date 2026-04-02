import { useState, useEffect, useRef } from 'react'

export interface StatusPlayer {
  userId: string
  username: string
  x: number
  y: number
  z: number
  health: number
}

export interface StatusNpc {
  id: number
  x: number
  y: number
  z: number
  state: 'wander' | 'gather' | 'eat' | 'rest' | 'socialize' | string
  hunger: number
}

export interface AgentEntry {
  status: 'active' | 'idle' | 'blocked' | 'done' | string
  task: string
  lastSeen: number
}

export interface AgentMessage {
  from: string
  to: string | null
  text: string
  ts: number
  heartbeat?: boolean
}

export interface AgentState {
  agents: Record<string, AgentEntry>
  messages: AgentMessage[]
}

export interface WorldStatus {
  connected: boolean
  epoch: string
  simTime: number
  timeScale: number
  paused: boolean
  bootstrapPhase: boolean
  bootstrapProgress: number
  players: StatusPlayer[]
  npcs: StatusNpc[]
  agentState: AgentState
}

const VIEWER_ID   = '__status_viewer__'
const VIEWER_NAME = '~observer'

const WS_URL = (import.meta as any).env?.VITE_WS_URL as string | undefined

const AGENT_IDS = [
  'director',
  'status-worker', 'gp-agent', 'knowledge-director',
  'cqa', 'car',
  'ui-worker', 'interaction', 'ai-npc',
  'physics-prof', 'chemistry-prof', 'biology-prof',
]
const EMPTY_AGENTS: AgentState = {
  agents: Object.fromEntries(AGENT_IDS.map(id => [id, { status: 'idle', task: '', lastSeen: 0 }])),
  messages: [],
}

const INITIAL: WorldStatus = {
  connected:         false,
  epoch:             'stellar',
  simTime:           0,
  timeScale:         1,
  paused:            false,
  bootstrapPhase:    false,
  bootstrapProgress: 1,
  players:           [],
  npcs:              [],
  agentState:        EMPTY_AGENTS,
}

export function useStatusSocket(): WorldStatus {
  const [state, setState] = useState<WorldStatus>(INITIAL)
  const wsRef          = useRef<WebSocket | null>(null)
  const backoffRef     = useRef(1_000)
  const destroyedRef   = useRef(false)

  useEffect(() => {
    if (!WS_URL) {
      console.warn('[StatusSocket] VITE_WS_URL not set — showing offline state')
      return
    }

    function connect() {
      if (destroyedRef.current) return

      try {
        const ws = new WebSocket(WS_URL!)
        wsRef.current = ws

        ws.onopen = () => {
          backoffRef.current = 1_000
          setState(s => ({ ...s, connected: true }))
          ws.send(JSON.stringify({ type: 'JOIN', userId: VIEWER_ID, username: VIEWER_NAME }))
        }

        ws.onmessage = (evt) => {
          let msg: Record<string, unknown>
          try { msg = JSON.parse(evt.data as string) } catch { return }

          if (msg.type === 'WORLD_SNAPSHOT') {
            const allPlayers = (msg.players ?? []) as StatusPlayer[]
            setState(s => ({
              connected:         true,
              epoch:             (msg.epoch as string)            ?? 'stellar',
              simTime:           (msg.simTime as number)          ?? 0,
              timeScale:         (msg.timeScale as number)        ?? 1,
              paused:            !!(msg.paused),
              bootstrapPhase:    !!(msg.bootstrapPhase),
              bootstrapProgress: (msg.bootstrapProgress as number) ?? 1,
              players:           allPlayers.filter(p => p.userId !== VIEWER_ID),
              npcs:              (msg.npcs as StatusNpc[])        ?? [],
              agentState:        (msg.agentState as AgentState)   ?? s.agentState,
            }))
          }

          if (msg.type === 'AGENT_UPDATE') {
            setState(s => ({
              ...s,
              agentState: {
                agents:   (msg.agents   as AgentState['agents'])   ?? s.agentState.agents,
                messages: (msg.messages as AgentState['messages']) ?? s.agentState.messages,
              },
            }))
          }
        }

        ws.onclose = () => {
          setState(s => ({ ...s, connected: false }))
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

  return state
}

// Scripted office activity for UI development (M2): drives the real WS protocol
// with fake statuses, chat, and activity — no Claude sessions, no tokens.
import type { ChatMsg, OfficeAgent, OfficeTeam } from './protocol.ts'
import type { OfficeWs } from './ws.ts'

interface MockCtx {
  agents: Map<string, OfficeAgent>
  teams: OfficeTeam[]
  ws: OfficeWs
  pushChat: (msg: ChatMsg) => void
}

const SUBJECTS = [
  'does this framing hold?',
  'draft ready for review',
  'revision: cite the actual shader file',
  'handoff: subtask for viscosity sweep',
  'fyi: charter updated',
  'blocked on parameter ranges',
  'approved — nice work',
  'can you sanity-check §3?',
]
const TOOLS = ['Read', 'Grep', 'Write', 'Edit', 'Glob']
const STATUSES = ['working', 'reading', 'typing', 'talking', 'idle', 'reviewing'] as const

export function runMock(ctx: MockCtx) {
  const ids = [...ctx.agents.keys()]
  let seed = 42
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const pick = <T,>(arr: T[] | readonly T[]): T => arr[Math.floor(rand() * arr.length)]

  // A rotating subset is "live"; others idle at their desks.
  setInterval(() => {
    const id = pick(ids)
    const a = ctx.agents.get(id)!
    const status = pick(STATUSES)
    a.status = status
    a.taskTitle = status === 'idle' ? null : 'Mock research task'
    a.task = status === 'idle' ? null : 'TASK-mock'
    ctx.ws.broadcast({ type: 'AGENT_STATUS', id, status, task: a.task, taskTitle: a.taskTitle })
    if (status === 'reading' || status === 'typing') {
      ctx.ws.broadcast({ type: 'AGENT_ACTIVITY', id, kind: 'tool_use', tool: pick(TOOLS), detail: 'src/gpu-sim/MpmGpuSimulator.ts', ts: Date.now() })
    }
  }, 900)

  // Mail between random pairs → speech bubbles + walking in the UI.
  setInterval(() => {
    const from = pick(ids)
    let to = pick(ids)
    if (to === from) to = ids[(ids.indexOf(from) + 1) % ids.length]
    ctx.pushChat({ from, to, subject: pick(SUBJECTS), kind: pick(['fyi', 'request', 'review-comment', 'handoff']), taskId: null, ts: Date.now() })
  }, 2500)

  // Pool churn for the HUD meter, with a fake usage ramp so the RESTING
  // banner/chip can be developed without spending a single token:
  // climbs 60→100 (resting from 90), then drops back to 60.
  let usagePct = 60
  setInterval(() => {
    usagePct = usagePct >= 100 ? 60 : usagePct + 4
    const resting = usagePct >= 90
    const active = resting ? [] : ids.filter(() => rand() < 0.12).slice(0, 8)
    ctx.ws.broadcast({
      type: 'POOL_STATE',
      pool: {
        cap: 8,
        active,
        queued: ids.filter(() => rand() < 0.05).slice(0, 4),
        paused: false,
        resting,
        restReason: resting ? 'session' : null,
        restResumeAt: resting ? new Date(Date.now() + ((104 - usagePct) / 4) * 4000).toISOString() : null,
        usagePct,
        weeklyPct: 18,
        usageMonitorOk: true,
      },
    })
  }, 4000)
}

// Scripted office activity for UI development (M2): drives the real WS protocol
// with fake statuses, chat, and activity — no Claude sessions, no tokens.
import type { ChatMsg, OfficeAgent, OfficeTeam, OwnerRequest, ServerMsg } from './protocol.ts'
import type { RawRequest } from './store.ts'
import type { RunOutputLine } from './runner.ts'
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

// ── Mock owner-request runner: the REPORTS/LAB pages are fully demoable at ──
// zero spend. approve() streams canned cargo output; files never touch disk.
const CARGO_LINES = [
  '    Updating crates.io index',
  '   Compiling proc-macro2 v1.0.86',
  '   Compiling bevy_math v0.15.1',
  '   Compiling bevy_ecs v0.15.1',
  '   Compiling wgpu v23.0.1',
  '   Compiling bevy_render v0.15.1',
  '   Compiling universe-core v0.1.0 (C:\\lab\\universe-engine\\crates\\universe-core)',
  '   Compiling universe-gpu v0.1.0 (C:\\lab\\universe-engine\\crates\\universe-gpu)',
  '   Compiling universe-world v0.1.0 (C:\\lab\\universe-engine\\crates\\universe-world)',
  'warning: unused variable: `dt`',
  '  --> crates/universe-world/src/simulation.rs:812:9',
  '   Compiling universe-render v0.1.0 (C:\\lab\\universe-engine\\crates\\universe-render)',
  '   Compiling universe-editor v0.1.0 (C:\\lab\\universe-engine\\crates\\universe-editor)',
  '   Compiling universe-app v0.1.0 (C:\\lab\\universe-engine\\crates\\universe-app)',
  '    Finished `dev` profile [unoptimized + debuginfo] target(s) in 42.31s',
]

export function createMockRunner(events: { broadcast: (m: ServerMsg) => void; log: (l: string) => void }) {
  const now = Date.now()
  const reqs = new Map<string, OwnerRequest>([
    ['REQ-mock-1', {
      id: 'REQ-mock-1', title: 'cargo check after MC water-surface wiring', kind: 'run',
      requestedBy: 'fluid-engineer', team: 'fluid', taskId: 'TASK-mock', status: 'pending',
      command: ['cargo', 'check'], cwd: 'universe-engine', runsIn: 'worktree',
      valid: true, invalidReason: null, warn: null,
      createdAt: now - 5 * 60_000, resolvedAt: null, exitCode: null, durationMs: null,
      resultTail: null, path: 'company/requests/REQ-mock-1.md',
    }],
    ['REQ-mock-2', {
      id: 'REQ-mock-2', title: 'May the bio team cite external textbook scans in reports?', kind: 'decision',
      requestedBy: 'bio-lead', team: 'bio', taskId: null, status: 'pending',
      command: null, cwd: null, runsIn: null, valid: true, invalidReason: null, warn: null,
      createdAt: now - 40 * 60_000, resolvedAt: null, exitCode: null, durationMs: null,
      resultTail: null, path: 'company/requests/REQ-mock-2.md',
    }],
    ['REQ-mock-3', {
      id: 'REQ-mock-3', title: 'node office/spikes/04-write-guard.mjs regression run', kind: 'run',
      requestedBy: 'ml-engineer', team: 'ml', taskId: null, status: 'done',
      command: ['node', 'office/spikes/04-write-guard.mjs'], cwd: 'universe-status', runsIn: 'repo',
      valid: true, invalidReason: null, warn: null,
      createdAt: now - 3 * 3600_000, resolvedAt: now - 3 * 3600_000 + 9000, exitCode: 0, durationMs: 8400,
      resultTail: '[PASS] deny outside repo\n[PASS] deny absolute path\n[PASS] allow company/ write\n6/6 boundary cases pass', path: 'company/requests/REQ-mock-3.md',
    }],
  ])
  let streamTimer: ReturnType<typeof setInterval> | null = null

  const rebroadcast = (id: string) => { const r = reqs.get(id); if (r) events.broadcast({ type: 'REQUEST_UPDATE', request: { ...r } }) }

  return {
    list: () => [...reqs.values()],
    decorate: (raw: RawRequest) => reqs.get(raw.id) ?? ({ ...reqs.values().next().value as OwnerRequest, id: raw.id }),
    bootRecover: () => {},
    output: (id: string): { requestId: string; lines: RunOutputLine[]; running: boolean } | null =>
      reqs.get(id)?.status === 'running' ? { requestId: id, lines: [], running: true } : null,
    approve(id: string) {
      const r = reqs.get(id)
      if (!r) return { ok: false, error: 'unknown request' }
      if (r.status !== 'pending') return { ok: false, error: `request is ${r.status}` }
      if (r.kind !== 'run') {
        r.status = 'done'; r.resolvedAt = Date.now()
        rebroadcast(id)
        return { ok: true }
      }
      r.status = 'running'
      rebroadcast(id)
      let i = 0
      const started = Date.now()
      streamTimer = setInterval(() => {
        if (i < CARGO_LINES.length) {
          events.broadcast({ type: 'RUN_OUTPUT', requestId: id, stream: 'stdout', line: CARGO_LINES[i++], ts: Date.now() })
        } else {
          clearInterval(streamTimer!)
          streamTimer = null
          r.status = 'done'; r.exitCode = 0; r.durationMs = Date.now() - started; r.resolvedAt = Date.now()
          r.resultTail = CARGO_LINES.slice(-3).join('\n')
          rebroadcast(id)
        }
      }, 350)
      return { ok: true }
    },
    deny(id: string, reason?: string) {
      const r = reqs.get(id)
      if (!r) return { ok: false, error: 'unknown request' }
      if (r.status !== 'pending') return { ok: false, error: `request is ${r.status}` }
      r.status = 'denied'; r.resolvedAt = Date.now()
      events.log(`mock: denied ${id}${reason ? ` (${reason})` : ''}`)
      rebroadcast(id)
      return { ok: true }
    },
    kill(id: string) {
      const r = reqs.get(id)
      if (!r || r.status !== 'running') return { ok: false, error: 'request is not running' }
      if (streamTimer) { clearInterval(streamTimer); streamTimer = null }
      r.status = 'failed'; r.resolvedAt = Date.now()
      r.resultTail = '(killed by owner)'
      rebroadcast(id)
      return { ok: true }
    },
    stop() { if (streamTimer) clearInterval(streamTimer) },
  }
}

export const MOCK_LAB: import('./protocol.ts').LabExperiment[] = [
  { id: 'water-drop-splash', name: 'water drop splash', path: 'company/lab/water-drop-splash', hasScenario: true, hasNotes: true, updatedAt: Date.now() - 20 * 60_000 },
  { id: 'lava-into-water', name: 'lava into water', path: 'company/lab/lava-into-water', hasScenario: true, hasNotes: false, updatedAt: Date.now() - 2 * 3600_000 },
]

const MOCK_FILES: Record<string, string> = {
  'company/lab/water-drop-splash/scenario.json': JSON.stringify({
    name: 'Water drop splash',
    materials: [{ name: 'Water', formula: 'H2O', elements: { H: 0.111, O: 0.889 }, temperature: 20 }],
    spawns: [
      { material: 'Water', count: 20000, center: [0.5, 0.25, 0.5], spread: 0.22 },
      { material: 'Water', count: 6000, center: [0.5, 0.8, 0.5], spread: 0.06 },
    ],
    gravity: 0.3,
  }, null, 2),
  'company/lab/water-drop-splash/notes.md': '# Water drop splash\n\nBaseline splash-dynamics probe: a resting pool plus a dense droplet released from height.\n\n**What to watch:** crown formation on impact, secondary droplets, settle time.\n',
  'company/lab/lava-into-water/scenario.json': JSON.stringify({
    name: 'Lava into water',
    materials: [
      { name: 'Water', formula: 'H2O', elements: { H: 0.111, O: 0.889 }, temperature: 20 },
      { name: 'Lava', formula: 'SiO2', elements: { Si: 0.467, O: 0.533 }, temperature: 1200 },
    ],
    spawns: [
      { material: 'Water', count: 18000, center: [0.5, 0.2, 0.5], spread: 0.24 },
      { material: 'Lava', count: 5000, center: [0.3, 0.85, 0.5], spread: 0.05 },
    ],
    gravity: 0.3,
  }, null, 2),
  'company/requests/REQ-mock-1.md': '---\nid: REQ-mock-1\ntitle: "cargo check after MC water-surface wiring"\nrequested_by: fluid-engineer\ntask: TASK-mock\nkind: run\nstatus: pending\ncommand: ["cargo", "check"]\ncwd: universe-engine\n---\n## Why\nThe owner-plan wires marching cubes to the MPM packets; nothing has been compiled. A clean `cargo check` proves the 5 edits typecheck before the owner runs the app.\n\n## Expected outcome\nExit 0 → the fluid team marks the plan compile-verified and cites this request in the report. Non-zero → we file a revision with the error text.\n',
  'company/requests/REQ-mock-2.md': '---\nid: REQ-mock-2\ntitle: "May the bio team cite external textbook scans in reports?"\nrequested_by: bio-lead\nkind: decision\nstatus: pending\n---\n## Question\nSeveral metabolism claims are best supported by textbook figures. May we cite scanned pages (fair-use excerpts) in company reports, or should we restrict to open-access sources?\n\n## Options\n1. Allow with citation.\n2. Open-access only.\n',
  'company/requests/REQ-mock-3.md': '---\nid: REQ-mock-3\ntitle: "node office/spikes/04-write-guard.mjs regression run"\nrequested_by: ml-engineer\nkind: run\nstatus: done\ncommand: ["node", "office/spikes/04-write-guard.mjs"]\ncwd: universe-status\nexit_code: 0\nduration_ms: 8400\n---\n## Why\nRegression-check the write-guard after the runner landed.\n\n## Result\n- status: done (exit 0)\n- duration: 8.4s\n\n```text\n[PASS] 6/6 boundary cases\n```\n',
}

export function mockCompanyFile(p: unknown):
  | { ok: true; path: string; content: string; mtimeMs: number }
  | { ok: false; error: string; code: 400 | 403 | 404 | 413 } {
  const key = typeof p === 'string' ? p.replace(/\\/g, '/') : ''
  const content = MOCK_FILES[key]
  return content !== undefined
    ? { ok: true, path: key, content, mtimeMs: Date.now() }
    : { ok: false, error: 'not found (mock)', code: 404 }
}

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
        sessionThresholdPct: 90,
        weeklyThresholdPct: 95,
      },
    })
  }, 4000)
}

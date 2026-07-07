// The Agent Office: 2D pixel company view. Canvas world rendered by OfficeEngine
// (imperative, outside React); React owns only the HUD, sidebar, and detail panel.
import { useEffect, useRef, useState } from 'react'
import { OfficeEngine } from '../../office-render/OfficeEngine'
import type { OfficeSocket, TaskSummary } from '../../hooks/useOfficeSocket'

const MONO = '"IBM Plex Mono", monospace'

const KIND_COLORS: Record<string, string> = {
  fyi: '#5c6a8a',
  request: '#00d4ff',
  'review-comment': '#ffd700',
  handoff: '#ff6b35',
}

const TASK_STATUS_COLORS: Record<string, string> = {
  inbox: '#8a97b8',
  assigned: '#00d4ff',
  'in-progress': '#ff6b35',
  review: '#ffd700',
  revise: '#ff8787',
  done: '#00ff88',
  archived: '#3a4157',
}

export function PixelOffice({ office }: { office: OfficeSocket }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<OfficeEngine | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTab] = useState<'feed' | 'tasks' | 'reports'>('feed')
  const { state } = office

  useEffect(() => {
    const canvas = canvasRef.current!
    const wrap = wrapRef.current!
    const engine = new OfficeEngine(canvas)
    engineRef.current = engine
    engine.onAgentClick = (id) => {
      setSelectedId(id)
      office.requestDetail(id)
    }
    const ro = new ResizeObserver(() => engine.resize(wrap.clientWidth, wrap.clientHeight))
    ro.observe(wrap)
    engine.resize(wrap.clientWidth, wrap.clientHeight)

    const unsub = office.subscribe(msg => engine.apply(msg))
    return () => { unsub(); ro.disconnect(); engine.destroy() }
    // office.subscribe identity is stable for the socket's lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // If the snapshot arrived before the engine mounted, hydrate from state.
  useEffect(() => {
    const engine = engineRef.current
    if (engine && state.agents.length > 0) {
      engine.setWorld(state.teams, state.agents)
      for (const a of state.agents) engine.apply({ type: 'AGENT_STATUS', id: a.id, status: a.status, task: a.task, taskTitle: a.taskTitle })
      engine.setOffline(!state.connected)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.agents.length > 0])

  useEffect(() => {
    engineRef.current?.setOffline(!state.connected)
  }, [state.connected])

  const selected = state.agents.find(a => a.id === selectedId) ?? null
  const detail = state.detail?.id === selectedId ? state.detail : null
  const openTasks = state.tasks.filter(t => t.status !== 'done' && t.status !== 'archived')

  return (
    <div style={{ display: 'flex', height: '100%', fontFamily: MONO, color: '#cfe3ff' }}>
      {/* ── World ─────────────────────────────────────────────── */}
      <div ref={wrapRef} style={{ flex: 1, position: 'relative', overflow: 'hidden', minWidth: 0 }}>
        <canvas ref={canvasRef} style={{ display: 'block', imageRendering: 'pixelated', cursor: 'grab' }} />

        {/* mock-mode banner: scripted demo must never be mistaken for real agents */}
        {state.mock && state.connected && (
          <div style={{
            position: 'absolute', top: 34, left: '50%', transform: 'translateX(-50%)',
            zIndex: 10, pointerEvents: 'none', padding: '8px 18px', borderRadius: 4,
            background: 'rgba(120,10,10,0.92)', border: '2px solid #ff4444',
            color: '#ffdddd', fontSize: 13, fontWeight: 700, letterSpacing: 2, textAlign: 'center',
          }}>
            ⚠ MOCK MODE — scripted demo, real agents are NOT running
            <div style={{ fontSize: 9, fontWeight: 400, letterSpacing: 1, marginTop: 3, color: '#ff9999' }}>
              start the real company with: npm run office
            </div>
          </div>
        )}

        {/* offline banner: the orchestrator isn't reachable — never show a silent
            frozen office. This is the "something is actually wrong / do this" state. */}
        {!state.connected && (
          <div style={{
            position: 'absolute', top: 34, left: '50%', transform: 'translateX(-50%)',
            zIndex: 11, pointerEvents: 'none', padding: '10px 20px', borderRadius: 4,
            background: 'rgba(70,70,80,0.95)', border: '2px solid #ff6b6b',
            color: '#ffe0e0', fontSize: 13, fontWeight: 700, letterSpacing: 2, textAlign: 'center',
          }}>
            ⏻ OFFICE OFFLINE — can't reach the orchestrator
            <div style={{ fontSize: 9, fontWeight: 400, letterSpacing: 1, marginTop: 3, color: '#ffb3b3' }}>
              the office isn't running (or the session hosting it ended). start it in a terminal:&nbsp;
              <span style={{ fontFamily: MONO, color: '#ffd4d4' }}>npm run office</span>
            </div>
          </div>
        )}

        {/* usage-guard banner: the office naps near the subscription limit */}
        {state.connected && state.pool.resting && (
          <div style={{
            position: 'absolute', top: state.mock ? 96 : 34, left: '50%', transform: 'translateX(-50%)',
            zIndex: 10, pointerEvents: 'none', padding: '8px 18px', borderRadius: 4,
            background: 'rgba(110,85,10,0.92)', border: '2px solid #ffd700',
            color: '#fff3cc', fontSize: 13, fontWeight: 700, letterSpacing: 2, textAlign: 'center',
          }}>
            😴 RESTING — {state.pool.restReason === 'weekly'
              ? `weekly limit at ${Math.round(state.pool.weeklyPct ?? 0)}%`
              : `session limit at ${Math.round(state.pool.usagePct ?? 0)}%`}
            {state.pool.restResumeAt && ` · resumes ~${new Date(state.pool.restResumeAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
            <div style={{ fontSize: 9, fontWeight: 400, letterSpacing: 1, marginTop: 3, color: '#ffe699' }}>
              in-flight agents finish their turn — no new sessions until the usage window resets
            </div>
          </div>
        )}

        {/* HUD strip */}
        <div style={{
          position: 'absolute', top: 8, left: 8, right: 8, display: 'flex', gap: 8,
          alignItems: 'center', pointerEvents: 'none', flexWrap: 'wrap',
        }}>
          <Hud label={state.connected ? (state.mock ? 'MOCK' : 'OFFICE LIVE') : 'OFFICE OFFLINE'} color={state.connected ? (state.mock ? '#ff4444' : '#00ff88') : '#ff4444'} />
          <Hud label={`SESSIONS ${state.pool.active.length}/${state.pool.cap || '—'}`} color="#00d4ff" />
          {state.pool.queued.length > 0 && <Hud label={`QUEUED ${state.pool.queued.length}`} color="#ff6b35" />}
          {state.pool.paused && <Hud label="PAUSED" color="#ffd700" />}
          {state.pool.resting && <Hud label="RESTING" color="#ffd700" />}
          {state.requests.filter(r => r.status === 'pending').length > 0 && (
            <Hud label={`OWNER ${state.requests.filter(r => r.status === 'pending').length}`} color="#ffd700" />
          )}
          {state.pool.usagePct !== null ? (
            <Hud
              label={`USAGE ${Math.round(state.pool.usagePct)}%${state.pool.weeklyPct !== null ? ` · WK ${Math.round(state.pool.weeklyPct)}%` : ''}`}
              color={state.pool.usagePct >= 80 || (state.pool.weeklyPct ?? 0) >= 85 ? '#ffd700' : '#00d4ff'}
            />
          ) : state.connected && !state.mock && !state.pool.usageMonitorOk ? (
            <Hud label="USAGE ?" color="#8a97b8" />
          ) : null}
          <Hud label={`TASKS ${openTasks.length}`} color="#8a97b8" />
          <Hud label={`REPORTS ${state.reports.filter(r => r.status === 'approved').length}`} color="#00ff88" />
        </div>

        {/* team legend */}
        <div style={{
          position: 'absolute', bottom: 8, left: 8, display: 'flex', gap: 6, flexWrap: 'wrap',
          pointerEvents: 'none', maxWidth: '70%',
        }}>
          {state.teams.map(t => (
            <span key={t.id} style={{
              fontSize: 9, letterSpacing: 1, padding: '2px 6px', borderRadius: 3,
              background: 'rgba(8,12,24,0.85)', border: `1px solid ${t.color}55`, color: t.color,
            }}>
              ■ {t.name.toUpperCase()}
            </span>
          ))}
        </div>

        {/* agent detail panel */}
        {selected && (
          <div style={{
            position: 'absolute', top: 40, right: 8, width: 340, maxHeight: 'calc(100% - 60px)',
            overflowY: 'auto', background: 'rgba(6,10,22,0.96)', border: '1px solid rgba(0,180,255,0.35)',
            borderRadius: 4, padding: 12, fontSize: 11,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ color: '#00d4ff', fontWeight: 600, letterSpacing: 1 }}>{selected.name}</span>
              <button
                onClick={() => { setSelectedId(null); office.requestDetail(null); engineRef.current?.select(null) }}
                style={{ background: 'none', border: 'none', color: '#5c6a8a', cursor: 'pointer', fontFamily: MONO }}>✕</button>
            </div>
            <div style={{ color: '#8a97b8', marginTop: 2 }}>{selected.role} · {selected.team} · {selected.model}</div>
            <div style={{ marginTop: 6 }}>
              <StatusChip status={selected.status} />
            </div>

            {(detail?.task || selected.taskTitle) && (
              <Section title="CURRENT TASK">
                <div style={{ color: '#cfe3ff' }}>{detail?.task?.title ?? selected.taskTitle}</div>
                {detail?.task && <div style={{ color: '#5c6a8a', marginTop: 2 }}>{detail.task.id} · {detail.task.status} · {detail.task.priority}</div>}
              </Section>
            )}

            {detail && detail.transcriptTail.length > 0 && (
              <Section title="LIVE TRANSCRIPT">
                <div style={{ maxHeight: 180, overflowY: 'auto', background: '#05070f', borderRadius: 3, padding: 6 }}>
                  {detail.transcriptTail.slice(-30).map((l, i) => (
                    <div key={i} style={{ color: l.startsWith('[') ? '#5c6a8a' : '#a9c1e8', whiteSpace: 'pre-wrap', marginBottom: 2 }}>{l}</div>
                  ))}
                </div>
              </Section>
            )}

            {detail && detail.reports.length > 0 && (
              <Section title={`TEAM REPORTS (${detail.reports.length})`}>
                {detail.reports.slice(0, 8).map(r => (
                  <div key={r.path} style={{ marginBottom: 4 }}>
                    <span style={{ color: r.status === 'approved' ? '#00ff88' : '#ffd700' }}>{r.status === 'approved' ? '✓' : '…'}</span>{' '}
                    <span style={{ color: '#cfe3ff' }}>{r.title}</span>
                    <div style={{ color: '#5c6a8a' }}>{r.path}</div>
                  </div>
                ))}
              </Section>
            )}
          </div>
        )}
      </div>

      {/* ── Sidebar ───────────────────────────────────────────── */}
      <div style={{
        width: 300, flexShrink: 0, borderLeft: '1px solid rgba(0,180,255,0.15)',
        display: 'flex', flexDirection: 'column', background: 'rgba(4,8,18,0.92)',
      }}>
        <div style={{ display: 'flex', borderBottom: '1px solid rgba(0,180,255,0.15)' }}>
          {(['feed', 'tasks', 'reports'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              flex: 1, padding: '8px 0', background: tab === t ? 'rgba(0,180,255,0.08)' : 'none',
              border: 'none', borderBottom: tab === t ? '2px solid #00d4ff' : '2px solid transparent',
              color: tab === t ? '#00d4ff' : '#5c6a8a', fontFamily: MONO, fontSize: 10,
              letterSpacing: 2, cursor: 'pointer', textTransform: 'uppercase',
            }}>{t}</button>
          ))}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 8, fontSize: 10.5 }}>
          {tab === 'feed' && [...state.chat].reverse().map((m, i) => (
            <div key={i} style={{ marginBottom: 8, paddingBottom: 6, borderBottom: '1px solid rgba(100,150,200,0.08)' }}>
              <div>
                <span style={{ color: '#00d4ff' }}>{m.from}</span>
                {m.to && <span style={{ color: '#5c6a8a' }}> → {m.to}</span>}
                <span style={{ float: 'right', color: KIND_COLORS[m.kind] ?? '#5c6a8a', fontSize: 9 }}>{m.kind}</span>
              </div>
              <div style={{ color: '#a9c1e8', marginTop: 2 }}>{m.subject}</div>
            </div>
          ))}
          {tab === 'feed' && state.chat.length === 0 && <Empty text="No mail yet — assign a task to wake the company." />}

          {tab === 'tasks' && state.tasks.map(t => <TaskRow key={t.id} task={t} />)}
          {tab === 'tasks' && state.tasks.length === 0 && (
            <Empty text={'No tasks. Assign one:\nnpm run office:assign -- assign --team physics --title "..."'} />
          )}

          {tab === 'reports' && state.reports.map(r => (
            <div key={r.path} style={{ marginBottom: 8, paddingBottom: 6, borderBottom: '1px solid rgba(100,150,200,0.08)' }}>
              <div>
                <span style={{ color: r.status === 'approved' ? '#00ff88' : '#ffd700' }}>{r.status === 'approved' ? '✓ APPROVED' : '… DRAFT'}</span>
                <span style={{ float: 'right', color: '#5c6a8a' }}>{r.team}</span>
              </div>
              <div style={{ color: '#cfe3ff', marginTop: 2 }}>{r.title}</div>
              <div style={{ color: '#5c6a8a', marginTop: 2, fontSize: 9 }}>{r.path}{r.reviewedBy ? ` · reviewed by ${r.reviewedBy}` : ''}</div>
            </div>
          ))}
          {tab === 'reports' && state.reports.length === 0 && <Empty text="No reports yet." />}
        </div>
      </div>
    </div>
  )
}

function Hud({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      fontSize: 9, letterSpacing: 1.5, padding: '3px 8px', borderRadius: 3,
      background: 'rgba(8,12,24,0.85)', border: `1px solid ${color}44`, color,
    }}>{label}</span>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ color: '#5c6a8a', fontSize: 9, letterSpacing: 2, marginBottom: 4 }}>{title}</div>
      {children}
    </div>
  )
}

function StatusChip({ status }: { status: string }) {
  const colors: Record<string, string> = {
    offline: '#3a4157', idle: '#5c6a8a', working: '#00d4ff', reading: '#4d9fff',
    typing: '#ff6b35', talking: '#00ff88', reviewing: '#ffd700', blocked: '#ff4444',
  }
  const c = colors[status] ?? '#5c6a8a'
  return (
    <span style={{
      fontSize: 9, letterSpacing: 1.5, padding: '2px 8px', borderRadius: 3,
      border: `1px solid ${c}66`, color: c, textTransform: 'uppercase',
    }}>{status}</span>
  )
}

function TaskRow({ task }: { task: TaskSummary }) {
  const c = TASK_STATUS_COLORS[task.status] ?? '#8a97b8'
  return (
    <div style={{ marginBottom: 8, paddingBottom: 6, borderBottom: '1px solid rgba(100,150,200,0.08)' }}>
      <div>
        <span style={{ color: c, fontSize: 9, letterSpacing: 1 }}>{task.status.toUpperCase()}</span>
        {task.priority === 'high' && <span style={{ color: '#ff4444', fontSize: 9, marginLeft: 6 }}>HIGH</span>}
        <span style={{ float: 'right', color: '#5c6a8a', fontSize: 9 }}>{task.team}</span>
      </div>
      <div style={{ color: '#cfe3ff', marginTop: 2 }}>{task.title}</div>
      <div style={{ color: '#5c6a8a', marginTop: 2, fontSize: 9 }}>
        {task.assignee ? `→ ${task.assignee}` : 'unassigned'}{task.parent ? ` · sub of ${task.parent}` : ''}
      </div>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <div style={{ color: '#3a4157', padding: 12, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{text}</div>
}

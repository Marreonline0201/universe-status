// Top-level LABORATORY tab: agents' experiments (company/lab/) run in an
// embedded WebGPU fluid sim while the owner watches; a live console streams
// approved real-run output.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { OfficeSocket } from '../../hooks/useOfficeSocket'
import type { LabExperiment } from '../../lib/labTypes'
import { fetchCompanyFile, fetchLabExperiments } from '../../lib/officeApi'
import { parseScenario, type LabScenario } from '../../lab/scenario'
import { Markdown, stripFrontmatter } from '../../lib/markdown'
import { MockBanner } from '../common/MockBanner'
import { LabSim } from './LabSim'
import { RunConsole } from './RunConsole'
import { FluidControls, type FluidController } from '../fluid/FluidControls'
import { readBgBrightness, writeBgBrightness } from '../../fluid-render/bgBrightness'
import type { LabFluidEngine } from '../../lab/LabFluidEngine'
import type { NamedComposition } from '../../composition/CompositionTable'

const MONO = '"IBM Plex Mono", monospace'

function age(ts: number): string {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60_000))
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

export function LabPage({ office, focusRequestId, initialExperimentId = null }: {
  office: OfficeSocket
  focusRequestId: string | null
  /** From the ?exp= deep-link — auto-selected once when the list first contains it. */
  initialExperimentId?: string | null
}) {
  const { state } = office
  const [experiments, setExperiments] = useState<LabExperiment[]>([])
  const [listErr, setListErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<LabExperiment | null>(null)
  const [scenario, setScenario] = useState<LabScenario | null>(null)
  const [scenarioErr, setScenarioErr] = useState<string | null>(null)
  const [scenarioWarn, setScenarioWarn] = useState<string | null>(null)
  const [scenarioRaw, setScenarioRaw] = useState<string | null>(null)
  const [notes, setNotes] = useState<string | null>(null)
  const [notesOpen, setNotesOpen] = useState(false)
  const [runNonce, setRunNonce] = useState(0)
  const [stats, setStats] = useState({ fps: 0, count: 0 })
  const [consoleId, setConsoleId] = useState<string | null>(null)
  const notesCache = useRef(new Map<string, string>())

  // Hands-on control state (parity with FLUID TEST), driven by the shared FluidControls panel.
  const engineRef = useRef<LabFluidEngine | null>(null)
  const [engine, setEngine] = useState<LabFluidEngine | null>(null)
  const [compositions, setCompositions] = useState<NamedComposition[]>([])
  const [selectedComp, setSelectedComp] = useState(0)
  const [gravityVal, setGravityVal] = useState(0.3)
  const [temperatureVal, setTemperatureVal] = useState(20)
  const [ballActive, setBallActive] = useState(false)
  const [bgBrightVal, setBgBrightVal] = useState(readBgBrightness)

  const webgpu = typeof navigator !== 'undefined' && !!navigator.gpu

  const refresh = useCallback(() => {
    fetchLabExperiments()
      .then(list => { setExperiments(list); setListErr(null) })
      .catch(e => setListErr(e instanceof Error ? e.message : String(e)))
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 30_000)
    // Push-refresh on lab file changes.
    const unsub = office.subscribe(msg => { if (msg.type === 'LAB_UPDATED') refresh() })
    return () => { clearInterval(t); unsub() }
  }, [refresh, office])

  useEffect(() => {
    if (focusRequestId) setConsoleId(focusRequestId)
  }, [focusRequestId])

  const select = useCallback((exp: LabExperiment) => {
    setSelected(exp)
    setScenario(null)
    setScenarioErr(null)
    setScenarioWarn(null)
    setScenarioRaw(null)
    setNotes(null)
    const dir = exp.path.replace(/\\/g, '/')
    if (exp.hasScenario) {
      fetchCompanyFile(`${dir}/scenario.json`)
        .then(text => {
          setScenarioRaw(text)
          const parsed = parseScenario(text)
          if (parsed.ok) {
            setScenario(parsed.scenario)
            setScenarioWarn(parsed.warning)
            setRunNonce(n => n + 1)
          } else {
            setScenarioErr(parsed.error)
          }
        })
        .catch(e => setScenarioErr(e instanceof Error ? e.message : String(e)))
    }
    if (exp.hasNotes) {
      const cached = notesCache.current.get(dir)
      if (cached !== undefined) setNotes(cached)
      else {
        fetchCompanyFile(`${dir}/notes.md`)
          .then(text => {
            const { body } = stripFrontmatter(text)
            notesCache.current.set(dir, body)
            setNotes(body)
          })
          .catch(() => setNotes(null))
      }
    }
  }, [])

  // Deep-link auto-select: consume-once. Fires on the first experiments load that CONTAINS
  // the id; if the list loads non-empty without it, consume anyway (never retry on the 30s
  // poll / LAB_UPDATED refreshes, never fight the owner's own clicks).
  const deepLinkPending = useRef(!!initialExperimentId)
  useEffect(() => {
    if (!deepLinkPending.current || !initialExperimentId || experiments.length === 0) return
    deepLinkPending.current = false
    const exp = experiments.find(e => e.id === initialExperimentId)
    if (exp) select(exp)
  }, [experiments, initialExperimentId, select])

  const liveRuns = state.requests.filter(r => r.kind === 'run' && (r.status === 'running' || r.status === 'approved'))

  // ── hands-on controls wiring ──
  const onLabEngine = useCallback((e: LabFluidEngine | null) => {
    engineRef.current = e
    setEngine(e)
    if (e) setCompositions(e.getCompositions())
  }, [])
  const onLabLoaded = useCallback(() => {
    const e = engineRef.current
    if (!e) return
    // A scenario just (re)loaded — resync the panel to the engine's new state.
    setCompositions(e.getCompositions())
    setBallActive(e.ballActive)
    setGravityVal(e.gravity)
  }, [])
  const labController: FluidController | null = engine ? {
    gpuReady: true,
    compositions,
    selectedComposition: selectedComp,
    setSelectedComposition: (id) => { engine.setSelectedComposition(id); setSelectedComp(id) },
    spawnBatch: (n) => engine.spawnBatch(n),
    ballActive,
    dropBall: () => { engine.dropBall(); setBallActive(true) },
    removeBall: () => { engine.removeBall(); setBallActive(false) },
    gravity: gravityVal,
    setGravity: (g) => { engine.setGravity(g); setGravityVal(g) },
    temperature: temperatureVal,
    setTemperature: (t) => { engine.setTemperature(t); setTemperatureVal(t) },
    bgBrightness: bgBrightVal,
    setBgBrightness: (b) => { engine.setBgBrightness(b); setBgBrightVal(b); writeBgBrightness(b) },
    reset: () => { engine.reset(); setCompositions(engine.getCompositions()); setBallActive(engine.ballActive); setGravityVal(engine.gravity) },
  } : null

  const toolbarBtn = (label: string, onClick: () => void, active = false) => (
    <button
      onClick={onClick}
      style={{
        background: active ? 'rgba(0,180,255,0.12)' : 'transparent', border: '1px solid #00d4ff55',
        color: '#00d4ff', fontFamily: 'inherit', fontSize: 'calc(9px * var(--font-scale, 1))', letterSpacing: 1,
        padding: '3px 10px', borderRadius: 3, cursor: 'pointer',
      }}
    >{label}</button>
  )

  return (
    <div style={{ display: 'flex', height: '100%', fontFamily: MONO, color: '#cfe3ff', position: 'relative' }}>
      {state.mock && state.connected && <MockBanner sub="lab experiments below are scripted demo data" />}

      {/* ── experiment list ── */}
      <div style={{
        width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column',
        borderRight: '1px solid rgba(0,180,255,0.15)', background: 'rgba(4,8,18,0.92)',
      }}>
        <div style={{ padding: '10px 12px 4px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 'calc(9px * var(--font-scale, 1))', letterSpacing: 3, color: 'rgba(0,180,255,0.5)' }}>LABORATORY</span>
          <span style={{ marginLeft: 'auto' }}>{toolbarBtn('⟳ REFRESH', refresh)}</span>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px 24px' }}>
          <div style={{ color: '#5c6a8a', fontSize: 'calc(9px * var(--font-scale, 1))', letterSpacing: 2, margin: '8px 0 6px', fontWeight: 700 }}>EXPERIMENTS</div>
          {listErr && <div style={{ color: '#ff8787', fontSize: 'calc(9px * var(--font-scale, 1))', padding: 4 }}>✗ {listErr} {toolbarBtn('RETRY', refresh)}</div>}
          {!listErr && experiments.length === 0 && (
            <div style={{ color: '#3a4157', fontSize: 'calc(10px * var(--font-scale, 1))', padding: 4 }}>
              No experiments yet — agents write company/lab/&lt;name&gt;/scenario.json
            </div>
          )}
          {experiments.map(exp => (
            <div
              key={exp.id}
              onClick={() => select(exp)}
              style={{
                padding: '6px 8px', marginBottom: 4, borderRadius: 3, cursor: 'pointer',
                borderLeft: selected?.id === exp.id ? '2px solid #00d4ff' : '2px solid transparent',
                background: selected?.id === exp.id ? 'rgba(0,180,255,0.06)' : 'transparent',
              }}
            >
              <div style={{ color: '#cfe3ff', fontSize: 'calc(11px * var(--font-scale, 1))' }}>{exp.name}</div>
              <div style={{ display: 'flex', gap: 6, fontSize: 'calc(8px * var(--font-scale, 1))', marginTop: 2 }}>
                {exp.hasScenario && <span style={{ color: '#00ff88', border: '1px solid #00ff8844', borderRadius: 2, padding: '0 4px' }}>SCEN</span>}
                {exp.hasNotes && <span style={{ color: '#ffd700', border: '1px solid #ffd70044', borderRadius: 2, padding: '0 4px' }}>NOTES</span>}
                <span style={{ color: '#3a4157', marginLeft: 'auto' }}>{age(exp.updatedAt)}</span>
              </div>
            </div>
          ))}

          {liveRuns.length > 0 && (
            <>
              <div style={{ color: '#ff6b35', fontSize: 'calc(9px * var(--font-scale, 1))', letterSpacing: 2, margin: '14px 0 6px', fontWeight: 700 }}>LIVE RUNS</div>
              {liveRuns.map(r => (
                <div
                  key={r.id}
                  onClick={() => setConsoleId(r.id)}
                  style={{
                    padding: '5px 8px', marginBottom: 3, borderRadius: 3, cursor: 'pointer',
                    background: consoleId === r.id ? 'rgba(255,107,53,0.08)' : 'rgba(8,12,24,0.5)',
                  }}
                >
                  <div style={{ fontSize: 'calc(9px * var(--font-scale, 1))' }}>
                    <span style={{ color: '#ff6b35', fontWeight: 700 }}>{r.status.toUpperCase()}</span>
                    <span style={{ color: '#5c6a8a' }}> · {r.requestedBy}</span>
                  </div>
                  <div style={{ color: '#a9c1e8', fontSize: 'calc(10px * var(--font-scale, 1))' }}>{r.title}</div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {/* ── sim + console ── */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{
          height: 36, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px',
          borderBottom: '1px solid rgba(0,180,255,0.15)', background: 'rgba(4,8,18,0.9)',
        }}>
          <span data-testid="lab-experiment-name" style={{ fontSize: 'calc(11px * var(--font-scale, 1))', color: '#e8f4ff' }}>{selected ? selected.name : 'select an experiment'}</span>
          {selected?.hasScenario && scenario && toolbarBtn('▶ RE-RUN', () => setRunNonce(n => n + 1))}
          {selected?.hasNotes && toolbarBtn('NOTES', () => setNotesOpen(o => !o), notesOpen)}
          <span data-testid="lab-fps" style={{ marginLeft: 'auto', fontSize: 'calc(9px * var(--font-scale, 1))', color: stats.fps >= 30 ? '#00ff88' : '#ffd700' }}>{stats.fps} FPS</span>
          <span data-testid="lab-particles" style={{ fontSize: 'calc(9px * var(--font-scale, 1))', color: '#8a97b8' }}>{stats.count.toLocaleString()} particles</span>
          <span data-testid="lab-webgpu" style={{ fontSize: 'calc(9px * var(--font-scale, 1))', color: webgpu ? '#00ff88' : '#ff4444' }}>{webgpu ? 'WEBGPU' : 'NO WEBGPU'}</span>
        </div>

        <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          {webgpu
            ? <LabSim scenario={scenario} runNonce={runNonce} onStats={setStats} onEngine={onLabEngine} onLoaded={onLabLoaded} />
            : (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 }}>
                <div style={{ color: '#ff8787', fontSize: 'calc(12px * var(--font-scale, 1))', letterSpacing: 1 }}>WEBGPU UNAVAILABLE</div>
                <div style={{ color: '#8a97b8', fontSize: 'calc(10px * var(--font-scale, 1))', textAlign: 'center', maxWidth: 420 }}>
                  The lab sim needs a WebGPU browser (Chrome/Edge). The scenario definition is shown below; notes are still readable.
                </div>
                {scenarioRaw && (
                  <pre style={{ background: '#05070f', borderRadius: 4, padding: 12, fontSize: 'calc(10px * var(--font-scale, 1))', color: '#a9c1e8', maxWidth: '80%', maxHeight: '50%', overflow: 'auto' }}>
                    {scenarioRaw}
                  </pre>
                )}
              </div>
            )}

          {scenarioErr && (
            <div style={{
              position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 5,
              background: 'rgba(120,10,10,0.92)', border: '1px solid #ff4444', borderRadius: 4,
              padding: '6px 14px', color: '#ffdddd', fontSize: 'calc(10px * var(--font-scale, 1))', maxWidth: '80%',
            }}>
              ✗ scenario invalid: {scenarioErr}
            </div>
          )}
          {scenarioWarn && !scenarioErr && (
            <div style={{
              position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 5,
              background: 'rgba(110,85,10,0.92)', border: '1px solid #ffd700', borderRadius: 4,
              padding: '4px 12px', color: '#fff3cc', fontSize: 'calc(9px * var(--font-scale, 1))',
            }}>
              ⚠ {scenarioWarn}
            </div>
          )}

          {notesOpen && notes && (
            <div style={{
              position: 'absolute', top: 0, right: 0, bottom: 0, width: 400, zIndex: 6,
              background: 'rgba(6,10,22,0.97)', borderLeft: '1px solid rgba(0,180,255,0.35)',
              overflowY: 'auto', padding: '12px 18px',
            }}>
              <Markdown md={notes} />
            </div>
          )}
        </div>

        <RunConsole office={office} requestId={consoleId} />
      </div>

      {/* ── hands-on controls (same panel as FLUID TEST) ── */}
      {webgpu && labController && (
        <div style={{ width: 264, flexShrink: 0, display: 'flex', flexDirection: 'column', borderLeft: '1px solid rgba(0,180,255,0.15)', background: 'rgba(4,8,18,0.92)' }}>
          <div style={{ padding: '10px 12px 2px' }}>
            <span style={{ fontSize: 'calc(9px * var(--font-scale, 1))', letterSpacing: 3, color: 'rgba(0,180,255,0.5)' }}>CONTROLS</span>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            <FluidControls controller={labController} />
          </div>
        </div>
      )}
    </div>
  )
}

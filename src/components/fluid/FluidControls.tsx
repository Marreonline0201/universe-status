// ── FluidControls ────────────────────────────────────────────────────────────
// Shared hands-on control panel for the GPU fluid sim (incompressible solver, or the legacy MLS-MPM). Used by BOTH the
// FLUID TEST page and the LABORATORY page via the small `FluidController` seam,
// so the two stay identical instead of drifting. Presentational only — every
// action is delegated to `controller` (a plain object each page builds over its
// own sim owner: FluidTest's simRef, or the lab's LabFluidEngine).
import { useEffect, useState } from 'react'
import type { NamedComposition } from '../../composition/CompositionTable'
import type { MenuEntry } from '../../composition/liquidGate'
import type { FluidNotice } from '../../fluid-engine/FluidEngine'
import { G_STANDARD } from '../../fluid-engine/units'

/** The control surface both pages implement. Setters follow FluidTest's model:
 *  setGravity/setTemperature update the page's slider state (the live sim update
 *  happens in each page — gravity is applied to the sim, temperature affects the
 *  next spawn). spawnBatch/dropBall/removeBall/reset act on the sim immediately. */
export interface FluidController {
  gpuReady: boolean
  compositions: NamedComposition[]
  selectedComposition: number            // composition id (== array index for defaults)
  setSelectedComposition: (id: number) => void
  spawnBatch: (count: number) => void
  ballActive: boolean
  dropBall: () => void
  removeBall: () => void
  /** Downward gravity magnitude in m/s² (both fluid and ball). */
  gravity: number
  setGravity: (g: number) => void
  temperature: number
  setTemperature: (t: number) => void
  /** Background brightness: scales the fixed olive hue (1 = base #b1b366). Persisted, shared by both pages. */
  bgBrightness: number
  setBgBrightness: (b: number) => void
  reset: () => void
  /** Material menu from the material gates at the spawn temperature: 'show' spawnable, 'refused' listed but
   *  disabled with its physical reason (hidden entries are already removed). */
  menu?: MenuEntry[]
  /** Last refusal or warning from the gates, shown under the spawn buttons. */
  notice?: FluidNotice | null
  /** The running solver (the info panel states its model and validity limits). */
  solver?: 'mpm' | 'flip'
  /** The tank (TANK-RESIZE): grid cells per axis and size in metres; absent or not resizable: no TANK section. */
  tank?: TankInfo | null
  resizeTank?: (cells: [number, number, number]) => Promise<{ ok: boolean; reason?: string }>
}

export interface TankInfo { cells: [number, number, number]; sizeM: [number, number, number]; resizable: boolean }
/** One grid cell (dx fixed at 3.63 m / 64) and the tank's step: 8 cells (the multigrid halves every axis). */
const TANK_DX = 3.63 / 64
const TANK_STEP_CELLS = 8
const snapCells = (m: number) => Math.min(88, Math.max(16, Math.round(m / TANK_DX / TANK_STEP_CELLS) * TANK_STEP_CELLS))

/** A number for the info panel, or an honest dash when no sourced value exists at this state. */
const num = (v: number, digits: number, unit: string) => (Number.isFinite(v) ? `${v.toFixed(digits)} ${unit}` : '— (no sourced value)')

export function FluidControls({ controller }: { controller: FluidController }) {
  const [showInfo, setShowInfo] = useState(true)
  const { compositions, selectedComposition, gpuReady, ballActive, gravity, temperature, bgBrightness } = controller
  const selectedComp = compositions[selectedComposition]
  const menuById = new Map((controller.menu ?? []).map(m => [m.id, m]))
  const listed = controller.menu ? compositions.filter(c => menuById.has(c.id)) : compositions
  const selectedEntry = menuById.get(selectedComposition)

  return (
    <div style={{
      padding: 14,
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      overflowY: 'auto',
      height: '100%',
      boxSizing: 'border-box',
    }}>
      {/* Active Compositions List */}
      <div>
        <label style={labelStyle}>MATERIALS</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
          {listed.map((comp) => {
            const entry = menuById.get(comp.id)
            const refused = entry?.visibility === 'refused'
            return (
            <button
              key={comp.id}
              onClick={() => controller.setSelectedComposition(comp.id)}
              title={refused ? `Cannot spawn on the current solver: ${entry?.reason}` : undefined}
              style={{
                opacity: refused ? 0.45 : 1,
                display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', cursor: 'pointer',
                background: selectedComposition === comp.id ? 'rgba(0,180,255,0.15)' : 'rgba(0,180,255,0.03)',
                border: `1px solid ${selectedComposition === comp.id ? 'rgba(0,180,255,0.4)' : 'rgba(0,180,255,0.1)'}`,
                borderRadius: 3, color: '#c0d0e0', fontFamily: 'inherit', fontSize: 'calc(10px * var(--font-scale, 1))', textAlign: 'left', width: '100%',
              }}
            >
              <div style={{
                width: 10, height: 10, borderRadius: 2, flexShrink: 0,
                background: `rgb(${Math.round(comp.props.color[0] * 255)},${Math.round(comp.props.color[1] * 255)},${Math.round(comp.props.color[2] * 255)})`,
                boxShadow: comp.props.emissive > 0
                  ? `0 0 6px rgb(${Math.round(comp.props.color[0] * 255)},${Math.round(comp.props.color[1] * 255)},${Math.round(comp.props.color[2] * 255)})`
                  : 'none',
              }} />
              <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {comp.name}
              </div>
              <span style={{ fontSize: 'calc(8px * var(--font-scale, 1))', color: refused ? 'rgba(255,140,80,0.7)' : 'rgba(100,150,200,0.4)', flexShrink: 0 }}>{refused ? 'REFUSED' : comp.formula}</span>
            </button>
            )
          })}
        </div>
      </div>

      {/* Spawn buttons */}
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={() => controller.spawnBatch(10000)} disabled={!gpuReady}
          style={{
            flex: 1, padding: '7px 0',
            background: gpuReady ? 'rgba(0,180,255,0.1)' : 'rgba(0,180,255,0.03)',
            border: '1px solid rgba(0,180,255,0.3)', borderRadius: 3,
            color: gpuReady ? '#00d4ff' : 'rgba(100,150,200,0.3)',
            fontSize: 'calc(10px * var(--font-scale, 1))', fontFamily: 'inherit', letterSpacing: 2, cursor: gpuReady ? 'pointer' : 'default', transition: 'all 0.15s',
          }}
        >+10K</button>
        <button
          onClick={() => controller.spawnBatch(50000)} disabled={!gpuReady}
          style={{
            flex: 1, padding: '7px 0',
            background: gpuReady ? 'rgba(0,140,255,0.15)' : 'rgba(0,180,255,0.03)',
            border: '1px solid rgba(0,180,255,0.3)', borderRadius: 3,
            color: gpuReady ? '#00d4ff' : 'rgba(100,150,200,0.3)',
            fontSize: 'calc(10px * var(--font-scale, 1))', fontFamily: 'inherit', letterSpacing: 2, cursor: gpuReady ? 'pointer' : 'default', transition: 'all 0.15s',
          }}
        >+50K</button>
      </div>

      {selectedEntry?.visibility === 'refused' && (
        <div style={{ fontSize: 'calc(9px * var(--font-scale, 1))', color: 'rgba(255,160,100,0.85)', lineHeight: 1.5 }}>
          {selectedEntry.name} can't be spawned at {controller.temperature} °C on the current solver: {selectedEntry.reason}
        </div>
      )}
      {selectedEntry?.dataRangeC && selectedEntry.dataRangeC[0] === selectedEntry.dataRangeC[1] && (
        <div style={{ fontSize: 'calc(9px * var(--font-scale, 1))', color: 'rgba(100,150,200,0.6)' }}>
          Sourced data exist only at {selectedEntry.dataRangeC[0]} °C — spawns use that temperature.
        </div>
      )}
      {controller.notice && (
        <div style={{ fontSize: 'calc(9px * var(--font-scale, 1))', lineHeight: 1.5, color: controller.notice.kind === 'refused' ? 'rgba(255,120,90,0.9)' : 'rgba(255,200,90,0.85)' }}>
          {controller.notice.kind === 'refused' ? 'Refused: ' : 'Warning: '}{controller.notice.text}
        </div>
      )}

      {/* Drop ball button */}
      <button
        onClick={ballActive ? controller.removeBall : controller.dropBall} disabled={!gpuReady}
        style={{
          padding: '7px 0',
          background: gpuReady ? (ballActive ? 'rgba(255,160,0,0.15)' : 'rgba(180,180,180,0.1)') : 'rgba(180,180,180,0.03)',
          border: `1px solid ${ballActive ? 'rgba(255,160,0,0.4)' : 'rgba(180,180,180,0.3)'}`,
          borderRadius: 3,
          color: gpuReady ? (ballActive ? '#ffaa00' : '#aaaaaa') : 'rgba(100,150,200,0.3)',
          fontSize: 'calc(10px * var(--font-scale, 1))', fontFamily: 'inherit', letterSpacing: 2, cursor: gpuReady ? 'pointer' : 'default', transition: 'all 0.15s',
        }}
      >{ballActive ? 'REMOVE BALL' : 'DROP BALL'}</button>

      {/* Tank size */}
      {controller.tank?.resizable && controller.resizeTank && <TankPanel tank={controller.tank} resize={controller.resizeTank} disabled={!gpuReady} />}

      {/* Temperature slider */}
      <div>
        <label style={labelStyle}>TEMPERATURE</label>
        <input type="range" min={-50} max={2000} step={10} value={temperature}
          onChange={(e) => controller.setTemperature(Number(e.target.value))} style={sliderStyle} />
        <div style={valueStyle}>{temperature} C</div>
      </div>

      {/* Gravity slider */}
      <div>
        <label style={labelStyle}>GRAVITY</label>
        {/* step "any": a 0.01 step made the browser round 9.80665 to 9.81 the moment it was touched */}
        <input type="range" min={0} max={20} step="any" value={gravity}
          onChange={(e) => controller.setGravity(Number(e.target.value))} style={sliderStyle} />
        <div style={valueStyle}>{gravity.toFixed(2)} m/s²{Math.abs(gravity - G_STANDARD) < 0.005 ? ' (Earth)' : ''}</div>
      </div>

      {/* Background brightness slider — hue stays the owner's olive; only brightness scales */}
      <div>
        <label style={labelStyle}>BG BRIGHTNESS</label>
        <input type="range" min={0.2} max={1.5} step={0.01} value={bgBrightness}
          onChange={(e) => controller.setBgBrightness(Number(e.target.value))} style={sliderStyle} />
        <div style={valueStyle}>×{bgBrightness.toFixed(2)}</div>
      </div>

      {/* Reset button */}
      <button
        onClick={controller.reset}
        style={{
          padding: '7px 0', background: 'rgba(255,60,60,0.1)', border: '1px solid rgba(255,60,60,0.3)',
          borderRadius: 3, color: '#ff6666', fontSize: 'calc(10px * var(--font-scale, 1))', fontFamily: 'inherit', letterSpacing: 2, cursor: 'pointer', transition: 'all 0.15s',
        }}
      >RESET</button>

      <div style={{ height: 1, background: 'rgba(0,180,255,0.1)' }} />

      {/* Info panel */}
      <div>
        <button
          onClick={() => setShowInfo(!showInfo)}
          style={{ background: 'none', border: 'none', color: 'rgba(0,180,255,0.5)', fontSize: 'calc(9px * var(--font-scale, 1))', letterSpacing: 2, cursor: 'pointer', fontFamily: 'inherit', padding: 0, marginBottom: 8 }}
        >{showInfo ? '[-] MATERIAL INFO' : '[+] MATERIAL INFO'}</button>

        {showInfo && selectedComp && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'calc(10px * var(--font-scale, 1))', lineHeight: 1.6 }}>
            <div style={{ fontSize: 'calc(12px * var(--font-scale, 1))', fontWeight: 700, color: `rgb(${Math.round(selectedComp.props.color[0] * 255)},${Math.round(selectedComp.props.color[1] * 255)},${Math.round(selectedComp.props.color[2] * 255)})` }}>
              {selectedComp.name}
            </div>
            <div style={{ color: 'rgba(100,150,200,0.55)', fontSize: 'calc(9px * var(--font-scale, 1))' }}>{selectedComp.formula}</div>
            <div style={{ marginTop: 4 }}>
              <InfoRow label="Density" value={num(selectedComp.props.density, 0, 'kg/m3')} symbol={'ρ'} />
              <InfoRow label="Viscosity" value={num(selectedComp.props.viscosity, 4, 'Pa·s')} symbol={'μ'} />
              <InfoRow label="Surface Tension" value={num(selectedComp.props.surfaceTension, 4, 'N/m')} symbol={'σ'} />
              <InfoRow label="Melting Point" value={num(selectedComp.props.meltingPoint, 0, 'C')} symbol={'Tm'} />
              <InfoRow label="Boiling Point" value={num(selectedComp.props.boilingPoint, 0, 'C')} symbol={'Tb'} />
              <InfoRow label="Metalness" value={`${(selectedComp.props.metalness * 100).toFixed(0)}%`} symbol={'M'} />
              <InfoRow label="F0" value={selectedComp.props.F0.toFixed(3)} symbol={'F'} />
              <InfoRow label="IOR" value={selectedComp.props.IOR.toFixed(3)} symbol={'n'} />
            </div>
            <div style={{ marginTop: 8, padding: '6px 8px', background: 'rgba(0,180,255,0.05)', border: '1px solid rgba(0,180,255,0.1)', borderRadius: 3, fontSize: 'calc(9px * var(--font-scale, 1))', color: 'rgba(100,150,200,0.5)', lineHeight: 1.8 }}>
              {controller.solver === 'mpm' ? (<>
                <div style={{ color: 'rgba(0,180,255,0.6)', marginBottom: 2, letterSpacing: 1 }}>GPU MLS-MPM (legacy, weakly compressible)</div>
                <div>Tank: 3.29 m wall to wall, cells 5.67 cm</div>
                <div>Clock: real time, substeps ≤ 1/120 s</div>
                <div>Grid: 64x64x64, separating walls</div>
                <div>Render: SSFR (5-pass)</div>
                <div style={{ marginTop: 4, color: 'rgba(255,190,110,0.6)' }}>Water is still springy: a settled shallow pool measured ~17% denser than at rest (deeper water compresses more). The incompressible solver (plan S3) replaces this.</div>
              </>) : (<>
                <div style={{ color: 'rgba(0,180,255,0.6)', marginBottom: 2, letterSpacing: 1 }}>INCOMPRESSIBLE APIC-MAC (plan S3)</div>
                <div>Pressure: MGPCG; volume: Kugelstadt density projection</div>
                <div>Surface: ghost fluid (Zhu–Bridson level set)</div>
                <div>Density: per material (oil floats, mercury sinks)</div>
                <div>Viscosity: implicit variational solve (Batty & Bridson 2008), harmonic μ between liquids, while a liquid with ν ≥ 1e-5 m²/s is in the tank</div>
                <div>Tank: {controller.tank ? controller.tank.sizeM.map(v => v.toFixed(2)).join(' × ') : '3.63 × 3.63 × 3.63'} m (W × H × D), cells 5.67 cm, 8 particles/cell</div>
                <div>Clock: real time, 1–4 substeps per 1/60 s (CFL 1)</div>
                <div>Render: SSFR (5-pass)</div>
                <div>Ball: iron 7874 kg/m³ (NIST), moving solid with fractional face weights, weak coupling</div>
                <div style={{ marginTop: 4, color: 'rgba(255,190,110,0.6)' }}>Not yet real: at 5.67 cm cells the scheme damps motion by itself, ν ≈ 1.1e-3 m²/s — 1000× water's own viscosity, so thin liquids (water, oils, mercury) move more damped than real, and glycerol-level liquids about twice as viscous; the viscous solve visits the whole grid on every iteration, so a large block of honey or lava runs below real time (slow motion); liquids stirred together below one cell do not separate again; dam-break fronts run ~10 % ahead of experiments. Ball: weak coupling (the water's push back arrives one substep late; refused in liquids denser than iron until S3.7), no bounce or friction at the walls, no skin drag, drawn 1–2 frames late.</div>
              </>)}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Shared styles (moved from FluidTest) ──────────────────────────────────────
const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 'calc(9px * var(--font-scale, 1))', letterSpacing: 2, color: 'rgba(0,180,255,0.5)', marginBottom: 6,
}
const sliderStyle: React.CSSProperties = {
  width: '100%', height: 4, appearance: 'none' as const, background: 'rgba(0,180,255,0.15)', borderRadius: 2, outline: 'none', cursor: 'pointer',
}
const valueStyle: React.CSSProperties = {
  fontSize: 'calc(10px * var(--font-scale, 1))', color: 'rgba(100,150,200,0.6)', marginTop: 4, textAlign: 'right',
}

/** Width / height / depth in metres (snapped to 8-cell steps of 45.4 cm, 0.91–4.99 m), the cells and the cost it means,
 *  APPLY rebuilds the simulator (the liquid inside the new walls stays). Dragging the tank's faces, edges and corners in
 *  the view does the same. */
function TankPanel({ tank, resize, disabled }: { tank: TankInfo; resize: NonNullable<FluidController['resizeTank']>; disabled: boolean }) {
  const fmt = (c: number) => (c * TANK_DX).toFixed(2)
  const [draft, setDraft] = useState<string[]>(tank.cells.map(fmt))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => { setDraft(tank.cells.map(fmt)) }, [tank.cells[0], tank.cells[1], tank.cells[2]])
  const cells = draft.map(s => snapCells(Number(s))) as [number, number, number]
  const same = cells.every((c, a) => c === tank.cells[a])
  const cost = cells[0] * cells[1] * cells[2] / 64 ** 3
  const apply = async (c: [number, number, number]) => {
    setBusy(true); setMsg(null)
    const r = await resize(c)
    setBusy(false)
    setMsg(r.ok ? null : r.reason ?? 'refused')
  }
  const axes: [string, number][] = [['WIDTH (x)', 0], ['HEIGHT (y)', 1], ['DEPTH (z)', 2]]
  return (
    <div>
      <label style={labelStyle}>TANK (m) — or drag its faces, edges, corners</label>
      <div style={{ display: 'flex', gap: 6 }}>
        {axes.map(([name, a]) => (
          <div key={a} style={{ flex: 1 }}>
            <div style={{ fontSize: 'calc(8px * var(--font-scale, 1))', color: 'rgba(100,150,200,0.5)', marginBottom: 2 }}>{name}</div>
            <input type="number" min={0.91} max={4.99} step={0.45} value={draft[a]} disabled={disabled || busy}
              aria-label={`tank ${name}`} data-tank-axis={a}
              onChange={e => setDraft(d => d.map((v, k) => (k === a ? e.target.value : v)))}
              onKeyDown={e => { if (e.key === 'Enter' && !same) void apply(cells) }}
              style={{ width: '100%', boxSizing: 'border-box', background: 'rgba(0,180,255,0.06)', border: '1px solid rgba(0,180,255,0.25)', borderRadius: 3, color: '#c0d0e0', fontFamily: 'inherit', fontSize: 'calc(10px * var(--font-scale, 1))', padding: '3px 4px' }} />
          </div>
        ))}
      </div>
      <div style={valueStyle}>{cells.join(' × ')} cells = {cells.map(fmt).join(' × ')} m · work ×{cost.toFixed(2)} of the default</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <button data-tank-apply onClick={() => void apply(cells)} disabled={disabled || busy || same}
          style={{ flex: 1, padding: '5px 0', background: same ? 'rgba(0,180,255,0.03)' : 'rgba(0,180,255,0.15)', border: '1px solid rgba(0,180,255,0.3)', borderRadius: 3, color: same ? 'rgba(100,150,200,0.4)' : '#00bbff', fontSize: 'calc(9px * var(--font-scale, 1))', fontFamily: 'inherit', letterSpacing: 2, cursor: same ? 'default' : 'pointer' }}
        >{busy ? 'REBUILDING…' : 'APPLY'}</button>
        <button onClick={() => void apply([64, 64, 64])} disabled={disabled || busy || tank.cells.every(c => c === 64)}
          style={{ padding: '5px 8px', background: 'rgba(180,180,180,0.06)', border: '1px solid rgba(180,180,180,0.25)', borderRadius: 3, color: '#999', fontSize: 'calc(9px * var(--font-scale, 1))', fontFamily: 'inherit', letterSpacing: 1, cursor: 'pointer' }}
        >DEFAULT</button>
      </div>
      {msg && <div style={{ ...valueStyle, color: '#ff8866', textAlign: 'left' }}>{msg}</div>}
    </div>
  )
}

function InfoRow({ label, value, symbol }: { label: string; value: string; symbol: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0', fontSize: 'calc(10px * var(--font-scale, 1))' }}>
      <span style={{ color: 'rgba(100,150,200,0.5)' }}>
        <span style={{ color: 'rgba(0,180,255,0.5)', marginRight: 4 }}>{symbol}</span>
        {label}
      </span>
      <span style={{ color: '#c0d0e0', fontWeight: 500 }}>{value}</span>
    </div>
  )
}

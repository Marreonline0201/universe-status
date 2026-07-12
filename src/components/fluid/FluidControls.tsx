// ── FluidControls ────────────────────────────────────────────────────────────
// Shared hands-on control panel for the GPU MLS-MPM fluid sim. Used by BOTH the
// FLUID TEST page and the LABORATORY page via the small `FluidController` seam,
// so the two stay identical instead of drifting. Presentational only — every
// action is delegated to `controller` (a plain object each page builds over its
// own sim owner: FluidTest's simRef, or the lab's LabFluidEngine).
import { useState } from 'react'
import type { NamedComposition } from '../../composition/CompositionTable'

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
  gravity: number
  setGravity: (g: number) => void
  temperature: number
  setTemperature: (t: number) => void
  /** Background brightness: scales the fixed olive hue (1 = base #b1b366). Persisted, shared by both pages. */
  bgBrightness: number
  setBgBrightness: (b: number) => void
  reset: () => void
}

export function FluidControls({ controller }: { controller: FluidController }) {
  const [showInfo, setShowInfo] = useState(true)
  const { compositions, selectedComposition, gpuReady, ballActive, gravity, temperature, bgBrightness } = controller
  const selectedComp = compositions[selectedComposition]

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
          {compositions.map((comp) => (
            <button
              key={comp.id}
              onClick={() => controller.setSelectedComposition(comp.id)}
              style={{
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
              <span style={{ fontSize: 'calc(8px * var(--font-scale, 1))', color: 'rgba(100,150,200,0.4)', flexShrink: 0 }}>{comp.formula}</span>
            </button>
          ))}
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
        <input type="range" min={0} max={2.0} step={0.01} value={gravity}
          onChange={(e) => controller.setGravity(Number(e.target.value))} style={sliderStyle} />
        <div style={valueStyle}>{gravity.toFixed(2)}</div>
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
              <InfoRow label="Density" value={`${selectedComp.props.density.toFixed(0)} kg/m3`} symbol={'ρ'} />
              <InfoRow label="Viscosity" value={`${selectedComp.props.viscosity.toFixed(4)} Pa·s`} symbol={'μ'} />
              <InfoRow label="Surface Tension" value={`${selectedComp.props.surfaceTension.toFixed(4)} N/m`} symbol={'σ'} />
              <InfoRow label="Melting Point" value={`${selectedComp.props.meltingPoint.toFixed(0)} C`} symbol={'Tm'} />
              <InfoRow label="Boiling Point" value={`${selectedComp.props.boilingPoint.toFixed(0)} C`} symbol={'Tb'} />
              <InfoRow label="Metalness" value={`${(selectedComp.props.metalness * 100).toFixed(0)}%`} symbol={'M'} />
              <InfoRow label="F0" value={selectedComp.props.F0.toFixed(3)} symbol={'F'} />
              <InfoRow label="IOR" value={selectedComp.props.IOR.toFixed(3)} symbol={'n'} />
            </div>
            <div style={{ marginTop: 8, padding: '6px 8px', background: 'rgba(0,180,255,0.05)', border: '1px solid rgba(0,180,255,0.1)', borderRadius: 3, fontSize: 'calc(9px * var(--font-scale, 1))', color: 'rgba(100,150,200,0.5)', lineHeight: 1.8 }}>
              <div style={{ color: 'rgba(0,180,255,0.6)', marginBottom: 2, letterSpacing: 1 }}>GPU MLS-MPM</div>
              <div>Solver: WebGPU compute</div>
              <div>Substeps: 2 per frame</div>
              <div>Grid: 64x64x64</div>
              <div>Render: SSFR (5-pass)</div>
              <div>Transfer: P2G + G2P</div>
              <div style={{ marginTop: 4, color: 'rgba(0,180,255,0.4)', letterSpacing: 1 }}>From structure.md S3.2</div>
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

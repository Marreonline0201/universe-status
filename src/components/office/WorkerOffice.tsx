// WORKER OFFICE tab (plan §6.1). The building from floorplan.json, drawn by WorkerEngine. Step 1: the interior
// with ZERO workers and no feed. The page reads no office server and starts nothing; live workers will exist only
// on the owner's computer (plan §6.6), so the public page always shows the empty building with a note.
//
// The tab stays mounted once opened (App.tsx toggles `display`), so the engine and its pre-render are built once
// and survive tab switches; `active` only pauses drawing while the tab is hidden.
import { useEffect, useRef, useState } from 'react'
import { WorkerEngine } from '../../worker-office/render/WorkerEngine'
import { getOfficeMap, getOfficeScene } from '../../worker-office/map/office'
import { ResizeHandle } from '../common/ResizeHandle'
import { useSettings } from '../../settings/SettingsContext'

const MONO = '"IBM Plex Mono", monospace'
const SIDEBAR_W_KEY = 'universe-worker-office-sidebar-w'
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const readW = (fallback: number): number => {
  try { const v = parseFloat(localStorage.getItem(SIDEBAR_W_KEY) ?? ''); return Number.isFinite(v) ? v : fallback } catch { return fallback }
}

export function WorkerOffice({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<WorkerEngine | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(() => readW(300))
  const { scale: fontScale } = useSettings()
  const map = getOfficeMap()

  useEffect(() => {
    const engine = new WorkerEngine(canvasRef.current!, getOfficeScene())
    engineRef.current = engine
    return () => { engine.destroy(); engineRef.current = null }
  }, [])
  useEffect(() => { engineRef.current?.setActive(active) }, [active])
  useEffect(() => { engineRef.current?.setFontScale(fontScale) }, [fontScale])
  useEffect(() => { try { localStorage.setItem(SIDEBAR_W_KEY, String(sidebarWidth)) } catch { /* storage off */ } }, [sidebarWidth])

  const topZones = map.zones.filter(z => z.parent === null)

  return (
    <div style={{ display: 'flex', height: '100%', fontFamily: MONO, color: '#cfe3ff' }}>
      {/* ── the building ─────────────────────────────────────────── */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', minWidth: 0 }}>
        <canvas
          ref={canvasRef}
          title="Drag to pan · wheel to zoom · double-click to fit"
          style={{ display: 'block', width: '100%', height: '100%', imageRendering: 'pixelated', cursor: 'grab', touchAction: 'none' }}
        />
        <div style={{
          position: 'absolute', top: 8, left: 8, display: 'flex', gap: 8, alignItems: 'center', pointerEvents: 'none',
        }}>
          <Chip label="WORKERS 0" color="#8a97b8" />
        </div>
        <div style={{
          position: 'absolute', top: 34, left: '50%', transform: 'translateX(-50%)', zIndex: 10, pointerEvents: 'none',
          padding: '7px 16px', borderRadius: 4, background: 'rgba(14,20,34,0.9)', border: '1px solid rgba(138,151,184,0.45)',
          color: '#cfd8e8', fontSize: 'calc(12px * var(--font-scale, 1))', letterSpacing: 1, textAlign: 'center', whiteSpace: 'nowrap',
        }}>
          No live feed — live only on the owner's computer
        </div>
      </div>

      {/* ── sidebar: the room key (drag the gutter to resize) ────── */}
      <ResizeHandle side="right" onDrag={d => setSidebarWidth(w => clamp(w + d, 220, 560))} />
      <div style={{
        width: sidebarWidth, flexShrink: 0, borderLeft: '1px solid rgba(0,180,255,0.15)', overflowY: 'auto',
        background: 'rgba(4,8,18,0.92)', padding: 12, fontSize: 'calc(10.5px * var(--font-scale, 1))',
      }}>
        <SectionTitle text="WORKERS" />
        <div style={{ color: '#5c6a8a', lineHeight: 1.6, marginBottom: 14 }}>
          None on screen. A worker appears only for a real helper event, and only on the owner's computer.
        </div>
        <SectionTitle text="ROOMS" />
        {topZones.map(z => (
          <div key={z.name}>
            <RoomRow name={z.name} finish={z.finish} color={z.floor} />
            {map.zones.filter(c => c.parent === z.name).map(c => (
              <RoomRow key={c.name} name={c.name} finish={c.finish} color={c.floor} indent />
            ))}
          </div>
        ))}
        <div style={{ color: '#3a4157', marginTop: 12, lineHeight: 1.6 }}>
          {map.width}×{map.height} tiles · {map.objects.length} objects · {map.points.length} interaction points
        </div>
      </div>
    </div>
  )
}

function Chip({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      fontSize: 'calc(9px * var(--font-scale, 1))', letterSpacing: 1.5, padding: '3px 8px', borderRadius: 3,
      background: 'rgba(8,12,24,0.85)', border: `1px solid ${color}44`, color,
    }}>{label}</span>
  )
}

function SectionTitle({ text }: { text: string }) {
  return <div style={{ color: '#5c6a8a', fontSize: 'calc(9px * var(--font-scale, 1))', letterSpacing: 2, marginBottom: 6 }}>{text}</div>
}

function RoomRow({ name, finish, color, indent = false }: { name: string; finish: string; color: string; indent?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', paddingLeft: indent ? 16 : 0 }}>
      <span style={{ width: 12, height: 12, flexShrink: 0, borderRadius: 2, background: color, border: '1px solid rgba(255,255,255,0.18)' }} />
      <span style={{ color: '#cfe3ff', letterSpacing: 1 }}>{name}</span>
      <span style={{ color: '#5c6a8a', marginLeft: 'auto', textAlign: 'right' }}>{finish.replace(' (existing art)', '')}</span>
    </div>
  )
}

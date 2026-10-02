// WORKER OFFICE tab (plan §6.1, §6.4). The building from floorplan.json, drawn by WorkerEngine. This tab reads no
// office server and starts nothing (the app shell's own sockets belong to App.tsx, kept by plan §5.3); live workers will
// exist only on the owner's computer (plan §6.6), so the page shows the empty building with the no-live-feed note.
// "Play example" plays a SYNTHETIC spool (live/example.ts: made-up helpers, never the owner's) through the same observer
// core, planner and figures as live data, and the note says EXAMPLE while it plays; when it ends (or Stop) the note is
// the no-live-feed one again.
//
// The tab stays mounted once opened (App.tsx toggles `display`), so the engine and its pre-render are built once
// and survive tab switches; `active` only pauses drawing while the tab is hidden.
// Layout: the room key is a resizable sidebar on wide screens and a strip under the map at 720 px and below. The
// overlay over the map (WORKERS chip and the no-live-feed note) is measured and handed to the engine, which fits
// the building below it when there is room. If the floorplan or the pre-render throws, an error boundary shows the
// note and the error in this tab only; the rest of the site keeps working.
// Colours come from workerOfficeTheme.ts (WCAG AA, checked by scripts/worker-office-render-check.ts).
import { Component, type ErrorInfo, type ReactNode, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { WorkerEngine, type FeedSummary } from '../../worker-office/render/WorkerEngine'
import { getOfficeMap, getOfficeScene, getPlaceLayout } from '../../worker-office/map/office'
import { ResizeHandle } from '../common/ResizeHandle'
import { useSettings } from '../../settings/SettingsContext'
import { WO } from './workerOfficeTheme'

const MONO = '"IBM Plex Mono", monospace'
const NO_FEED = "No live feed — live only on the owner's computer"
const EXAMPLE_NOTE = 'EXAMPLE — synthetic events, not live data'
/** How often the room key reads the engine's workers while a feed plays. */
const SUMMARY_MS = 500
const NO_SUMMARY: FeedSummary = { feed: 'none', workers: 0, lines: [], seconds: 0 }
const SIDEBAR_W_KEY = 'universe-worker-office-sidebar-w'
const SIDEBAR_MIN = 220
const SIDEBAR_MAX = 560
const NARROW_QUERY = '(max-width: 720px)'
/** Room between the overlay and the building's top edge when the fit has space for it (CSS px). */
const OVERLAY_GAP = 6
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const readW = (fallback: number): number => {
  try {
    const v = parseFloat(localStorage.getItem(SIDEBAR_W_KEY) ?? '')
    return Number.isFinite(v) ? clamp(v, SIDEBAR_MIN, SIDEBAR_MAX) : fallback
  } catch { return fallback }
}
const VISUALLY_HIDDEN = {
  position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
} as const

const subscribeNarrow = (onChange: () => void) => {
  const m = window.matchMedia(NARROW_QUERY)
  m.addEventListener('change', onChange)
  return () => m.removeEventListener('change', onChange)
}
const isNarrow = () => window.matchMedia(NARROW_QUERY).matches
const notNarrow = () => false
function useNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, isNarrow, notNarrow)
}

export function WorkerOffice({ active }: { active: boolean }) {
  return (
    <WorkerOfficeBoundary>
      <WorkerOfficeView active={active} />
    </WorkerOfficeBoundary>
  )
}

function WorkerOfficeView({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<WorkerEngine | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(() => readW(300))
  const { scale: fontScale } = useSettings()
  const narrow = useNarrow()
  const helpId = useId()
  const keyId = useId()
  const map = getOfficeMap()   // throws on a bad floorplan: the boundary below catches it
  const [summary, setSummary] = useState<FeedSummary>(NO_SUMMARY)
  const playing = summary.feed !== 'none'

  useEffect(() => {
    const engine = new WorkerEngine(canvasRef.current!, getOfficeScene())
    engineRef.current = engine
    return () => { engine.destroy(); engineRef.current = null }
  }, [])
  useEffect(() => { engineRef.current?.setActive(active) }, [active])
  // while a feed plays and the tab shows, read the workers for the key (the engine's clock stands still when hidden)
  useEffect(() => {
    if (!active || !playing) return
    const id = window.setInterval(() => { const e = engineRef.current; if (e) setSummary(e.summary()) }, SUMMARY_MS)
    return () => window.clearInterval(id)
  }, [active, playing])
  const playExample = () => { const e = engineRef.current; if (!e) return; e.playExample(getPlaceLayout()); setSummary(e.summary()) }
  const stopExample = () => { const e = engineRef.current; if (!e) return; e.stopFeed(); setSummary(e.summary()) }
  useEffect(() => { engineRef.current?.setFontScale(fontScale) }, [fontScale])
  useEffect(() => { try { localStorage.setItem(SIDEBAR_W_KEY, String(sidebarWidth)) } catch { /* storage off */ } }, [sidebarWidth])
  // the overlay band over the top of the map: measured whenever its size changes (text scale, wrapping)
  useEffect(() => {
    const overlay = overlayRef.current, canvas = canvasRef.current
    if (!overlay || !canvas) return
    const measure = () => {
      const c = canvas.getBoundingClientRect()
      if (c.height < 1) return // hidden tab: keep the last band
      engineRef.current?.setTopInset(overlay.getBoundingClientRect().bottom - c.top + OVERLAY_GAP)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(overlay)
    measure()
    return () => ro.disconnect()
  }, [])

  const topZones = map.zones.filter(z => z.parent === null)
  const workers = summary.workers

  return (
    <div style={{ display: 'flex', flexDirection: narrow ? 'column' : 'row', height: '100%', fontFamily: MONO, color: WO.text }}>
      {/* ── the building ─────────────────────────────────────────── */}
      <div data-wo="map" style={{ flex: '1 1 0', position: 'relative', overflow: 'hidden', minWidth: 0, minHeight: narrow ? 220 : 0 }}>
        <canvas
          ref={canvasRef}
          tabIndex={0}
          role="img"
          aria-label={`Worker office floor plan: ${topZones.length} areas, ${workers} workers`}
          aria-describedby={`${helpId} ${keyId}`}
          title="Drag to pan · wheel or pinch to zoom · double-click to fit · when focused: arrow keys, + − and 0"
          style={{ display: 'block', width: '100%', height: '100%', imageRendering: 'pixelated', cursor: 'grab', touchAction: 'none' }}
        />
        <span id={helpId} style={VISUALLY_HIDDEN}>
          Drag or use the arrow keys to pan, the wheel, a pinch or the plus and minus keys to zoom, and double-click or 0 to fit the whole building.
        </span>
        <div ref={overlayRef} data-wo="overlay" style={{
          position: 'absolute', top: 8, left: 8, right: 8, zIndex: 10, pointerEvents: 'none',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
        }}>
          <div style={{ alignSelf: 'flex-start' }}><Chip label={`WORKERS ${workers}`} /></div>
          <Banner example={playing} />
        </div>
      </div>

      {/* ── the room key: a sidebar (drag the gutter to resize), or a strip under the map on narrow screens ── */}
      {!narrow && <ResizeHandle side="right" onDrag={d => setSidebarWidth(w => clamp(w + d, SIDEBAR_MIN, SIDEBAR_MAX))} />}
      <div data-wo="key" style={{
        ...(narrow
          ? { flex: '0 0 auto', maxHeight: '40%', borderTop: `1px solid ${WO.sidebarRule}` }
          : { width: sidebarWidth, flexShrink: 0, borderLeft: `1px solid ${WO.sidebarRule}` }),
        overflowY: 'auto', background: WO.sidebarBg, padding: 12, fontSize: 'calc(10.5px * var(--font-scale, 1))',
      }}>
        <SectionTitle text="WORKERS" />
        {playing ? (
          <div data-wo="workers" style={{ color: WO.muted, lineHeight: 1.6, marginBottom: 10 }}>
            <div style={{ color: WO.exampleText, background: WO.exampleBg, padding: '2px 6px', borderRadius: 3, marginBottom: 6 }}>
              {EXAMPLE_NOTE} · {Math.floor(summary.seconds)} s
            </div>
            {summary.lines.length === 0 ? <div>None inside yet.</div> : (
              <ul aria-label="Workers in the example" style={{ listStyle: 'none' }}>
                {summary.lines.map(l => <li key={l.n}><span style={{ color: WO.text }}>#{l.n}</span> {l.text}</li>)}
              </ul>
            )}
          </div>
        ) : (
          <div style={{ color: WO.muted, lineHeight: 1.6, marginBottom: 10 }}>
            None on screen. A worker appears only for a real helper event, and only on the owner's computer.
          </div>
        )}
        <button
          type="button"
          data-wo="example"
          onClick={playing ? stopExample : playExample}
          aria-pressed={playing}
          style={{
            fontFamily: MONO, fontSize: 'calc(10px * var(--font-scale, 1))', letterSpacing: 1, padding: '4px 10px', marginBottom: 14,
            borderRadius: 3, cursor: 'pointer', color: WO.buttonText, background: WO.buttonBg, border: `1px solid ${WO.buttonEdge}`,
          }}
        >
          {playing ? 'Stop example' : 'Play example'}
        </button>
        <div style={{ color: WO.faint, lineHeight: 1.5, marginBottom: 14 }}>
          The example plays made-up helpers through the same office logic; it is never live data.
        </div>
        <SectionTitle text="ROOMS" />
        <ul id={keyId} aria-label="Rooms and their floors" style={{ listStyle: 'none' }}>
          {topZones.map(z => (
            <li key={z.name}>
              <RoomRow name={z.name} finish={z.finish} color={z.floor} />
              {map.zones.some(c => c.parent === z.name) && (
                <ul style={{ listStyle: 'none' }}>
                  {map.zones.filter(c => c.parent === z.name).map(c => (
                    <li key={c.name}><RoomRow name={c.name} finish={c.finish} color={c.floor} indent /></li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
        <div style={{ color: WO.faint, marginTop: 12, lineHeight: 1.6 }}>
          {map.width}×{map.height} tiles · {map.objects.length} objects · {map.points.length} interaction points
        </div>
      </div>
    </div>
  )
}

function Banner({ example = false }: { example?: boolean }) {
  return (
    <div data-wo="banner" role="status" style={{
      maxWidth: '100%', padding: '7px 16px', borderRadius: 4,
      background: example ? WO.exampleBg : WO.bannerBg, border: `1px solid ${example ? WO.exampleEdge : WO.bannerEdge}`,
      color: example ? WO.exampleText : WO.bannerText, fontSize: 'calc(12px * var(--font-scale, 1))', letterSpacing: 1, lineHeight: 1.35,
      textAlign: 'center', whiteSpace: 'normal', overflowWrap: 'anywhere',
    }}>
      {example ? EXAMPLE_NOTE : NO_FEED}
    </div>
  )
}

function Chip({ label }: { label: string }) {
  return (
    <span style={{
      fontSize: 'calc(9px * var(--font-scale, 1))', letterSpacing: 1.5, padding: '3px 8px', borderRadius: 3,
      background: WO.chipBg, border: `1px solid ${WO.chipEdge}`, color: WO.chipText,
    }}>{label}</span>
  )
}

function SectionTitle({ text }: { text: string }) {
  return <div style={{ color: WO.muted, fontSize: 'calc(9px * var(--font-scale, 1))', letterSpacing: 2, marginBottom: 6 }}>{text}</div>
}

function RoomRow({ name, finish, color, indent = false }: { name: string; finish: string; color: string; indent?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', paddingLeft: indent ? 16 : 0 }}>
      <span aria-hidden style={{ width: 12, height: 12, flexShrink: 0, borderRadius: 2, background: color, border: `1px solid ${WO.swatchEdge}` }} />
      <span style={{ color: WO.text, letterSpacing: 1 }}>{name}</span>
      <span style={{ color: WO.muted, marginLeft: 'auto', textAlign: 'right' }}>{finish.replace(' (existing art)', '')}</span>
    </div>
  )
}

// ── the error boundary: a broken floorplan or pre-render must not take the whole site down ─────────────────────
interface BoundaryState { readonly error: Error | null }

class WorkerOfficeBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // the loader's message lists every problem it found in floorplan.json
    console.error('[WORKER OFFICE] the office map failed to load (the other tabs are unaffected):', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div role="alert" data-wo="error" style={{
        height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12,
        padding: 16, fontFamily: MONO, background: WO.sidebarBg, textAlign: 'center',
      }}>
        <Banner />
        <div style={{ color: WO.text, fontSize: 'calc(12px * var(--font-scale, 1))', letterSpacing: 1 }}>The office map failed to load.</div>
        <pre style={{
          color: WO.muted, fontSize: 'calc(10.5px * var(--font-scale, 1))', whiteSpace: 'pre-wrap', textAlign: 'left',
          maxWidth: 720, maxHeight: '50%', overflow: 'auto', fontFamily: MONO,
        }}>{error.message}</pre>
      </div>
    )
  }
}

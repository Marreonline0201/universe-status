// WORKER OFFICE tab (plan §6.1, §6.4). The building from floorplan.json, drawn by WorkerEngine. This tab reads no
// office server and starts nothing (the app shell's own sockets belong to App.tsx, kept by plan §5.3); live workers
// exist only on the owner's computer (plan §6.6), so the page shows the empty building with the no-live-feed note until
// the owner connects the log folder.
// LIVE (plan §5.1 option B): "Connect log folder" grants this page read access to the spool folder (Chrome / Edge);
// feed/useWorkerFeed.ts reads it in a Web Worker and the lines play through the observer core on the wall clock; later
// visits ask again with one click ("Reconnect"). The page only reads that folder; nothing is sent anywhere.
// "Play example" plays a SYNTHETIC spool (live/example.ts: made-up helpers, never the owner's) through the same observer
// core, planner and figures as live data, and the note says EXAMPLE while it plays. The example and live never play
// together: the example pauses live reading, and live reading starts again (a reconnect: backlog, then a snap) when the
// example ends or is stopped.
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
import { useWorkerFeed, type LiveState } from '../../worker-office/feed/useWorkerFeed'
import { getOfficeMap, getOfficeScene, getPlaceLayout } from '../../worker-office/map/office'
import { ResizeHandle } from '../common/ResizeHandle'
import { useSettings } from '../../settings/SettingsContext'
import { WO } from './workerOfficeTheme'

const MONO = '"IBM Plex Mono", monospace'
const NO_FEED = "No live feed — live only on the owner's computer"
const EXAMPLE_NOTE = 'EXAMPLE — synthetic events, not live data'
const LIVE_NOTE = 'LIVE — read from your log folder on this computer; nothing is sent anywhere'
/** What the LIVE FEED section says for each state of the reader (feed/useWorkerFeed.ts). */
const LIVE_STATE: Readonly<Record<LiveState, string>> = {
  unsupported: 'not available in this browser (folder access needs Chrome or Edge)',
  idle: 'not connected',
  connecting: 'connected · reading the log so far…',
  live: 'connected · live',
  reconnect: 'reconnect needed',
  paused: 'connected · paused while the example plays',
}
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
  /** The engine's note after a frame failed (security review I2), until a feed starts again. */
  const [failure, setFailure] = useState<string | null>(null)
  const playing = summary.feed !== 'none'
  const example = summary.feed === 'example'
  const live = useWorkerFeed({
    start: () => { const e = engineRef.current; if (!e) return; setFailure(null); e.startLive(getPlaceLayout()); setSummary(e.summary()) },
    lines: lines => engineRef.current?.pushLines(lines),
    caughtUp: () => engineRef.current?.liveCaughtUp(),
    stop: () => { const e = engineRef.current; if (!e) return; e.stopFeed(); setSummary(e.summary()) },
  })

  useEffect(() => {
    const engine = new WorkerEngine(canvasRef.current!, getOfficeScene(), {
      onFailure: note => { setFailure(note); setSummary(engine.summary()) },
    })
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
  // the example and live never play together: the example pauses live reading; live starts again after it
  const playExample = () => {
    const e = engineRef.current
    if (!e) return
    live.pause()
    setFailure(null)
    e.playExample(getPlaceLayout())
    setSummary(e.summary())
  }
  const stopExample = () => {
    const e = engineRef.current
    if (!e) return
    e.stopFeed()
    setSummary(e.summary())
    if (live.state === 'paused') live.resume()
  }
  // the example ended by itself while live reading was paused for it: read again
  const resumeLive = live.resume
  useEffect(() => { if (summary.feed === 'none' && live.state === 'paused') resumeLive() }, [summary.feed, live.state, resumeLive])
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
          <Banner feed={summary.feed} />
          {failure !== null && (
            <div data-wo="failure" role="alert" style={{
              maxWidth: '100%', padding: '6px 14px', borderRadius: 4, background: WO.bannerBg, border: `1px solid ${WO.bannerEdge}`,
              color: WO.bannerText, fontSize: 'calc(11px * var(--font-scale, 1))', lineHeight: 1.35, textAlign: 'center',
            }}>{failure}</div>
          )}
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
        <SectionTitle text="LIVE FEED" />
        <div data-wo="live" style={{ color: WO.muted, lineHeight: 1.6, marginBottom: 14 }}>
          <div data-wo="live-state" role="status" style={{ color: WO.text }}>{LIVE_STATE[live.state]}</div>
          {live.folder !== null && live.state !== 'idle' && <div>folder: {live.folder}</div>}
          {live.detail !== '' && <div>{live.detail}</div>}
          {live.state !== 'unsupported' && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
              {live.state === 'reconnect' && <Button wo="live-reconnect" label="Reconnect" onClick={live.reconnect} />}
              {(live.state === 'idle' || live.state === 'reconnect') && <Button wo="live-connect" label="Connect log folder" onClick={live.connect} />}
              {live.folder !== null && <Button wo="live-forget" label="Forget folder" onClick={live.forget} />}
            </div>
          )}
          <div style={{ color: WO.faint, marginTop: 6, lineHeight: 1.5 }}>
            {live.state === 'unsupported'
              ? 'Live workers appear only in Chrome or Edge on the owner\'s computer.'
              : 'Pick the folder .universe-office\\spool in your home folder. The page only reads that folder; nothing is sent anywhere.'}
          </div>
        </div>
        <SectionTitle text="WORKERS" />
        {playing ? (
          <div data-wo="workers" style={{ color: WO.muted, lineHeight: 1.6, marginBottom: 10 }}>
            <div style={{ color: example ? WO.exampleText : WO.liveText, background: example ? WO.exampleBg : WO.liveBg, padding: '2px 6px', borderRadius: 3, marginBottom: 6 }}>
              {example ? `${EXAMPLE_NOTE} · ${Math.floor(summary.seconds)} s` : 'LIVE — your own helpers, now'}
            </div>
            {summary.lines.length === 0 ? <div>None inside yet.</div> : (
              <ul aria-label={example ? 'Workers in the example' : 'Workers inside now'} style={{ listStyle: 'none' }}>
                {summary.lines.map(l => <li key={l.n}><span style={{ color: WO.text }}>#{l.n}</span> {l.text}</li>)}
              </ul>
            )}
          </div>
        ) : (
          <div style={{ color: WO.muted, lineHeight: 1.6, marginBottom: 10 }}>
            None on screen. A worker appears only for a real helper event, and only on the owner's computer.
          </div>
        )}
        <div style={{ marginBottom: 14 }}>
          <Button wo="example" label={example ? 'Stop example' : 'Play example'} onClick={example ? stopExample : playExample} pressed={example} />
        </div>
        <div style={{ color: WO.faint, lineHeight: 1.5, marginBottom: 14 }}>
          The example plays made-up helpers through the same office logic; it is never live data. Live reading pauses while it plays.
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

function Banner({ feed = 'none' }: { feed?: FeedSummary['feed'] }) {
  const [bg, edge, ink, text] = feed === 'example' ? [WO.exampleBg, WO.exampleEdge, WO.exampleText, EXAMPLE_NOTE]
    : feed === 'live' ? [WO.liveBg, WO.liveEdge, WO.liveText, LIVE_NOTE] : [WO.bannerBg, WO.bannerEdge, WO.bannerText, NO_FEED]
  return (
    <div data-wo="banner" role="status" style={{
      maxWidth: '100%', padding: '7px 16px', borderRadius: 4, background: bg, border: `1px solid ${edge}`,
      color: ink, fontSize: 'calc(12px * var(--font-scale, 1))', letterSpacing: 1, lineHeight: 1.35,
      textAlign: 'center', whiteSpace: 'normal', overflowWrap: 'anywhere',
    }}>
      {text}
    </div>
  )
}

function Button({ wo, label, onClick, pressed }: { wo: string; label: string; onClick: () => void; pressed?: boolean }) {
  return (
    <button
      type="button"
      data-wo={wo}
      onClick={onClick}
      aria-pressed={pressed}
      style={{
        fontFamily: MONO, fontSize: 'calc(10px * var(--font-scale, 1))', letterSpacing: 1, padding: '4px 10px',
        borderRadius: 3, cursor: 'pointer', color: WO.buttonText, background: WO.buttonBg, border: `1px solid ${WO.buttonEdge}`,
      }}
    >
      {label}
    </button>
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

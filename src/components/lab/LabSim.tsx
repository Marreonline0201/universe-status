// React lifecycle wrapper for LabFluidEngine (StrictMode-safe).
import { useEffect, useRef, useState } from 'react'
import { LabFluidEngine, type LabStats } from '../../lab/LabFluidEngine'
import type { LabScenario } from '../../lab/scenario'

export function LabSim({ scenario, runNonce, onStats, onEngine, onLoaded }: {
  scenario: LabScenario | null
  runNonce: number
  onStats: (s: LabStats) => void
  onEngine?: (e: LabFluidEngine | null) => void   // hand the engine up so the page can build its control panel
  onLoaded?: () => void                            // fired after a scenario loads (compositions/ball may have changed)
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<LabFluidEngine | null>(null)
  const [ready, setReady] = useState(false)
  const onStatsRef = useRef(onStats); onStatsRef.current = onStats
  const onEngineRef = useRef(onEngine); onEngineRef.current = onEngine
  const onLoadedRef = useRef(onLoaded); onLoadedRef.current = onLoaded

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let cancelled = false
    const engine = new LabFluidEngine(container, s => onStatsRef.current(s))
    engineRef.current = engine
    void engine.init().then(ok => {
      if (cancelled) return
      setReady(ok)
      if (ok) onEngineRef.current?.(engine)
    })
    return () => {
      cancelled = true
      onEngineRef.current?.(null)
      engine.destroy()
      engineRef.current = null
      setReady(false)
    }
  }, [])

  useEffect(() => {
    if (ready && scenario && engineRef.current) {
      engineRef.current.loadScenario(scenario)
      onLoadedRef.current?.()
    }
  }, [ready, scenario, runNonce])

  return (
    <div
      ref={containerRef}
      // Left-click spawns a cluster of the selected material (parity with FLUID TEST);
      // OrbitControls still handles drag-to-orbit on the canvas beneath.
      onPointerDown={(e) => { if (e.button === 0) engineRef.current?.spawnAtPointer(e.clientX, e.clientY) }}
      style={{ position: 'absolute', inset: 0, cursor: 'crosshair' }}
    >
      {!ready && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#5c6a8a', fontSize: 'calc(11px * var(--font-scale, 1))', letterSpacing: 2, pointerEvents: 'none',
        }}>
          INITIALIZING WEBGPU…
        </div>
      )}
    </div>
  )
}

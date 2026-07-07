// React lifecycle wrapper for LabFluidEngine (StrictMode-safe).
import { useEffect, useRef, useState } from 'react'
import { LabFluidEngine, type LabStats } from '../../lab/LabFluidEngine'
import type { LabScenario } from '../../lab/scenario'

export function LabSim({ scenario, runNonce, onStats }: {
  scenario: LabScenario | null
  runNonce: number
  onStats: (s: LabStats) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<LabFluidEngine | null>(null)
  const [ready, setReady] = useState(false)
  const onStatsRef = useRef(onStats)
  onStatsRef.current = onStats

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let cancelled = false
    const engine = new LabFluidEngine(container, s => onStatsRef.current(s))
    engineRef.current = engine
    void engine.init().then(ok => {
      if (cancelled) return
      setReady(ok)
    })
    return () => {
      cancelled = true
      engine.destroy()
      engineRef.current = null
      setReady(false)
    }
  }, [])

  useEffect(() => {
    if (ready && scenario && engineRef.current) engineRef.current.loadScenario(scenario)
  }, [ready, scenario, runNonce])

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0, cursor: 'grab' }}>
      {!ready && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#5c6a8a', fontSize: 11, letterSpacing: 2, pointerEvents: 'none',
        }}>
          INITIALIZING WEBGPU…
        </div>
      )}
    </div>
  )
}

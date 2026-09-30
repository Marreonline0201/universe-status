// ── FluidTest ────────────────────────────────────────────────────────────────
// FLUID TEST page: the owner's hands-on fluid sandbox + AI material chat.
// The simulation, rendering, spawning and ball all live in the shared FluidEngine
// (src/fluid-engine/FluidEngine.ts) — the same engine the LABORATORY page runs.
// This component owns only UI state and the AI features.

import { useEffect, useRef, useState, useCallback } from 'react'
import { FluidEngine, type FluidNotice } from '../fluid-engine/FluidEngine'
import type { MenuEntry } from '../composition/liquidGate'
import { G_STANDARD } from '../fluid-engine/units'
import { clampBrightnessFor, readBgBrightness, readBgPreset, writeBgBrightness, writeBgPreset } from '../fluid-render/bgBrightness'
import type { NamedComposition } from '../composition/CompositionTable'
import { MaterialGenerator } from '../ai/MaterialGenerator'
import { AutoExperimenter } from '../ai/AutoExperimenter'
import { AIChatPanel } from './AIChatPanel'
import { FluidControls, type FluidController, type TankInfo } from './fluid/FluidControls'
import { solverFromUrl } from '../fluid-engine/backends'
import { packingFor } from '../fluid-engine/spawn'
import { benchHookEnabled, installBenchHook } from '../bench/benchHook'
import { parseScenario } from '../lab/scenario'

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_PARTICLES = 1_000_000

// ── React Component ──────────────────────────────────────────────────────────

export function FluidTest() {
  const canvasRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<FluidEngine | null>(null)
  const [tank, setTank] = useState<TankInfo | null>(null)
  const [selectedComposition, setSelectedComposition] = useState(0)
  const [gravityVal, setGravityVal] = useState(G_STANDARD)   // m/s²
  const [bgPresetVal, setBgPresetVal] = useState(readBgPreset)
  const [bgBrightVal, setBgBrightVal] = useState(() => clampBrightnessFor(readBgPreset(), readBgBrightness()))
  const [temperatureVal, setTemperatureVal] = useState(20)
  const [fps, setFps] = useState(0)
  const [particleCount, setParticleCount] = useState(0)
  const [fpsWarning, setFpsWarning] = useState(false)
  const [rtFactor, setRtFactor] = useState(1)
  const [stokes, setStokes] = useState<{ iterations: number; converged: boolean; capHits: number } | null>(null)
  const [menu, setMenu] = useState<MenuEntry[]>([])
  const [notice, setNotice] = useState<FluidNotice | null>(null)   // latest gate refusal / warning
  const [gpuReady, setGpuReady] = useState(false)
  const [compositions, setCompositions] = useState<NamedComposition[]>([])
  const [ballActive, setBallActive] = useState(false)

  // AI state
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('anthropic-api-key') || '')
  const [autoExperimentActive, setAutoExperimentActive] = useState(false)
  const materialGenRef = useRef<MaterialGenerator | null>(null)
  const autoExpRef = useRef<AutoExperimenter | null>(null)
  const chatAddMessageRef = useRef<((role: 'user' | 'ai' | 'system', text: string) => void) | null>(null)

  const syncCount = useCallback(() => setParticleCount(engineRef.current?.particleCount ?? 0), [])

  const resetSim = useCallback(() => {
    engineRef.current?.reset()
    syncCount()
  }, [syncCount])

  const spawnBatch = useCallback(async (count: number) => {
    const added = await engineRef.current?.spawnBatch(count) ?? 0
    syncCount()
    return added
  }, [syncCount])

  const dropBall = useCallback(() => {
    if (!engineRef.current) return
    engineRef.current.dropBall()
    setBallActive(engineRef.current.ballActive)   // false when the solver refused (reason in the notice)
  }, [])

  const removeBall = useCallback(() => {
    if (!engineRef.current) return
    engineRef.current.removeBall()
    setBallActive(false)
  }, [])

  // Push UI state into the engine (re-run once the engine is ready).
  useEffect(() => { engineRef.current?.setSelectedComposition(selectedComposition) }, [selectedComposition, gpuReady])
  useEffect(() => { engineRef.current?.setGravity(gravityVal) }, [gravityVal, gpuReady])
  useEffect(() => {
    const e = engineRef.current
    if (!e) return
    e.setTemperature(temperatureVal)
    setMenu(e.getMenuEntries(temperatureVal))   // the menu re-evaluates every material at the spawn temperature
  }, [temperatureVal, gpuReady])
  useEffect(() => {
    // Brightness scales the fixed olive hue on BOTH paint paths (SSFR + fallback);
    // persisted so the Lab page (and reloads) share the preference.
    writeBgBrightness(bgBrightVal)
    engineRef.current?.setBgBrightness(bgBrightVal)
  }, [bgBrightVal, gpuReady])
  useEffect(() => {
    // The background colour preset, on both paint paths; persisted and shared with the Lab page.
    writeBgPreset(bgPresetVal)
    engineRef.current?.setBgPreset(bgPresetVal)
    setBgBrightVal(b => clampBrightnessFor(bgPresetVal, b))   // the new preset's brightness cap
  }, [bgPresetVal, gpuReady])

  // ── AI: Update MaterialGenerator when API key changes ─────────────────────
  useEffect(() => {
    if (apiKey) {
      localStorage.setItem('anthropic-api-key', apiKey)
      materialGenRef.current = new MaterialGenerator(apiKey)
    } else {
      materialGenRef.current = null
    }
  }, [apiKey])

  // ── AI: Spawn material via Claude API ─────────────────────────────────────
  const handleSpawnMaterial = useCallback(async (description: string): Promise<string> => {
    if (!materialGenRef.current) return 'No API key set'
    const engine = engineRef.current
    if (!engine) return 'Simulation not ready'

    const result = await materialGenRef.current.generate(description)
    if (!result) return 'Could not generate material. Try a different description.'

    // The AI proposes a composition; the material gates decide whether the simulator can represent it
    // honestly (sourced liquid properties at that temperature, within the solver's limits).
    const compId = engine.addComposition(result.name, result.formula, result.elements, result.temperature)
    engine.lastRefusal = null
    const added = await engine.spawnCompositionBlock(compId, 3000, [0.5, 0.75, 0.5], result.temperature)
    syncCount()
    // A refused AI material stays in the menu, disabled, with its reason.
    setCompositions(engine.getCompositions())
    setMenu(engine.getMenuEntries())
    if (added === 0 && engine.lastRefusal) return `Not spawned — ${engine.lastRefusal}`
    setSelectedComposition(compId)

    return `Spawned ${added} ${result.name} (${result.formula}) at ${result.temperature} C [${result.state}]`
  }, [syncCount])

  // ── AI: Toggle auto-experiment ────────────────────────────────────────────
  const handleToggleAutoExperiment = useCallback(() => {
    if (autoExpRef.current?.isRunning) {
      autoExpRef.current.stop()
      setAutoExperimentActive(false)
    } else {
      if (!materialGenRef.current) return
      const exp = new AutoExperimenter(
        handleSpawnMaterial,
        (msg) => {
          chatAddMessageRef.current?.('system', msg)
        },
      )
      autoExpRef.current = exp
      exp.start()
      setAutoExperimentActive(true)
    }
  }, [handleSpawnMaterial])

  // Cleanup auto-experimenter on unmount
  useEffect(() => {
    return () => {
      if (autoExpRef.current?.isRunning) {
        autoExpRef.current.stop()
      }
    }
  }, [])

  // ── Engine lifecycle (StrictMode-safe) ─────────────────────────────────────
  useEffect(() => {
    const container = canvasRef.current
    if (!container) return
    let cancelled = false
    let uninstallHook: (() => void) | null = null
    const engine = new FluidEngine(container, s => {
      setFps(s.fps)
      setParticleCount(s.count)
      setRtFactor(s.rtFactor)
      setStokes(s.stokes ?? null)
      setFpsWarning(s.fps < 30 && s.count > 100)
    }, { initialScene: 'default-water', tankHandles: true })
    engineRef.current = engine
    void engine.init().then(ok => {
      if (cancelled) return
      if (!ok) { console.error('[fluid] FluidEngine init failed (WebGPU unavailable?)'); return }
      engine.onNotice = n => setNotice(n)
      setGpuReady(true)
      setCompositions(engine.getCompositions())
      setMenu(engine.getMenuEntries())
      setParticleCount(engine.particleCount)
      setTank(engine.tank)
      // a resize may remove a ball that no longer fits: the button follows the engine
      engine.onTankChange = t => { setTank(t); setParticleCount(engine.particleCount); setBallActive(engine.ballActive) }
      if (benchHookEnabled()) {
        // Scripted tests drive the same callbacks the buttons call.
        uninstallHook = installBenchHook(engine.benchTarget({
          loadScenario: (json) => {
            const parsed = parseScenario(json, { packing: engineRef.current?.tankPacking ?? packingFor(solverFromUrl()) })
            if (!parsed.ok) throw new Error(parsed.error)
            const r = engine.loadScenario(parsed.scenario)
            if (!r.ok) throw new Error(`scenario refused: ${r.reason}`)
            return { warning: [parsed.warning, ...r.warnings].filter(Boolean).join('; ') || null }
          },
          action: (name) => {
            if (name === 'reset') return resetSim()
            if (name === 'batch10k') return spawnBatch(10000)
            if (name === 'dropBall') return dropBall()
            if (name === 'removeBall') return removeBall()
            if (name === 'defaultScene') { engine.loadDefaultScene(); return syncCount() }
            if (name.startsWith('spawnAt:')) {   // the click-spawn path at an exact point (tests skip the raycast)
              const [x, y, z] = name.slice(8).split(',').map(Number)
              return engine.spawnAt({ x, y, z }).then(n => { syncCount(); return n })
            }
            throw new Error(`unknown action ${name}`)
          },
        }), { page: 'fluid-test' }).uninstall
      }
    })
    return () => {
      cancelled = true
      uninstallHook?.()
      engine.destroy()
      engineRef.current = null
      setGpuReady(false)
    }
  }, [resetSim, spawnBatch, dropBall, removeBall, syncCount])

  // Click-to-spawn only on a CLICK: a pointerdown that becomes an orbit drag must not spawn
  // (each spawn reads the particle buffer back from the GPU).
  const pointerDownAt = useRef<{ x: number; y: number } | null>(null)

  // Adapter over engine state → the shared FluidControls panel (same one the LAB page uses).
  const ftController: FluidController = {
    solver: solverFromUrl(),
    gpuReady, compositions, selectedComposition,
    setSelectedComposition,
    spawnBatch,
    ballActive, dropBall, removeBall,
    gravity: gravityVal, setGravity: setGravityVal,
    temperature: temperatureVal, setTemperature: setTemperatureVal,
    bgBrightness: bgBrightVal, setBgBrightness: setBgBrightVal,
    bgPreset: bgPresetVal, setBgPreset: setBgPresetVal,
    reset: resetSim,
    menu, notice,
    tank,
    resizeTank: cells => engineRef.current ? engineRef.current.resizeTank(cells) : Promise.resolve({ ok: false, reason: 'engine not ready' }),
  }

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: '#060810',   // page chrome stays dark; the olive scene bg comes from the canvas (SSFR shader + scene.background)
      color: '#c0d0e0',
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 16px',
        borderBottom: '1px solid rgba(0,180,255,0.1)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{
            fontSize: 'calc(12px * var(--font-scale, 1))',
            fontWeight: 700,
            color: '#00d4ff',
            letterSpacing: 2,
          }}>
            {solverFromUrl() === 'mpm' ? 'GPU MLS-MPM FLUID' : 'INCOMPRESSIBLE FLUID'}
          </span>
          <span style={{
            fontSize: 'calc(9px * var(--font-scale, 1))',
            color: 'rgba(100,150,200,0.5)',
            letterSpacing: 1,
          }}>
            WebGPU Compute + SSFR
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {fpsWarning && (
            <span style={{
              fontSize: 'calc(9px * var(--font-scale, 1))',
              color: '#ffaa00',
              letterSpacing: 1,
              animation: 'blockedPulse 1.2s ease-in-out infinite',
            }}>
              LOW FPS
            </span>
          )}
          <span style={{
            fontSize: 'calc(10px * var(--font-scale, 1))',
            color: fps >= 50 ? '#00ff88' : fps >= 30 ? '#ffaa00' : '#ff4444',
            letterSpacing: 1,
          }}>
            FPS: {fps}
          </span>
          {stokes && (
            <span title={`A ball is in a thick liquid, so pressure and viscosity are solved together in one step (Larionov, Batty & Bridson 2017). With separate steps a heavy ball in lava fell ~10× too slowly (measured: 0.05 vs 0.52 of Stokes' law in the test tank); together it falls within 10 % of the published reference for that tank (+9.7 %, converging as the ball is resolved finer). The cost: ${Math.round(stokes.iterations)} solver iterations per step, so time may run slower than real time (TIME ×) — physics per second of simulated time is unchanged. A faster preconditioner is planned.${stokes.capHits ? ` ${stokes.capHits} solves stopped at the iteration cap.` : ''}`} style={{
              fontSize: 'calc(10px * var(--font-scale, 1))',
              color: stokes.converged ? '#66ccff' : '#ff4444',
              letterSpacing: 1,
            }}>
              BALL IN THICK LIQUID · {Math.round(stokes.iterations)} it/step
            </span>
          )}
          {rtFactor < 0.98 && (
            <span title="The simulation cannot keep up with real time; physics is unchanged, time runs slower." style={{
              fontSize: 'calc(10px * var(--font-scale, 1))',
              color: '#ffaa00',
              letterSpacing: 1,
            }}>
              TIME ×{rtFactor.toFixed(2)}
            </span>
          )}
          {gpuReady && (
            <span style={{
              fontSize: 'calc(8px * var(--font-scale, 1))',
              fontWeight: 700,
              color: '#000',
              background: '#00ff88',
              padding: '1px 5px',
              borderRadius: 3,
              letterSpacing: 1,
            }}>
              GPU
            </span>
          )}
          <span style={{
            fontSize: 'calc(10px * var(--font-scale, 1))',
            color: 'rgba(100,150,200,0.6)',
            letterSpacing: 1,
          }}>
            N: {particleCount} / {MAX_PARTICLES}
          </span>
        </div>
      </div>

      {/* Main area */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
        {/* 3D Canvas */}
        <div
          ref={canvasRef}
          // Left-click spawns a cluster of the selected material; OrbitControls still orbits on drag.
          onPointerDown={(e) => { if (e.button === 0) pointerDownAt.current = { x: e.clientX, y: e.clientY } }}
          onPointerUp={(e) => {
            const d = pointerDownAt.current
            pointerDownAt.current = null
            if (e.button === 0 && d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) {
              void engineRef.current?.spawnAtPointer(e.clientX, e.clientY).then(syncCount)
            }
          }}
          style={{
            flex: 1,
            minWidth: 0,
            cursor: 'crosshair',
            position: 'relative',
          }}
        >
          {/* Click hint overlay */}
          {!gpuReady && (
            <div style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              fontSize: 'calc(13px * var(--font-scale, 1))',
              color: 'rgba(0,180,255,0.35)',
              letterSpacing: 2,
              pointerEvents: 'none',
              textAlign: 'center',
              lineHeight: 2,
            }}>
              INITIALIZING GPU...
              <br />
              <span style={{ fontSize: 'calc(10px * var(--font-scale, 1))', opacity: 0.6 }}>
                Setting up WebGPU compute + SSFR render
              </span>
            </div>
          )}
        </div>

        {/* Right Panel: Controls + AI Chat */}
        <div style={{
          width: 260,
          flexShrink: 0,
          borderLeft: '1px solid rgba(0,180,255,0.1)',
          display: 'flex',
          flexDirection: 'column',
          background: 'rgba(4,8,18,0.6)',
        }}>
        {/* Control Panel (60%) \u2014 hands-on controls, shared with the LAB page */}
        <div style={{ flex: '0 0 60%', minHeight: 0 }}>
          <FluidControls controller={ftController} />
        </div>

        {/* AI Chat Panel (40%) */}
        <div style={{ flex: '0 0 40%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {/* API Key input (only shows if no key stored) */}
          {!apiKey && (
            <div style={{
              padding: '8px 10px',
              borderTop: '1px solid rgba(0,180,255,0.1)',
              display: 'flex',
              gap: 4,
            }}>
              <input
                type="password"
                placeholder="Anthropic API key..."
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setApiKey((e.target as HTMLInputElement).value)
                  }
                }}
                style={{
                  flex: 1,
                  background: 'rgba(0,180,255,0.04)',
                  border: '1px solid rgba(0,180,255,0.15)',
                  borderRadius: 3,
                  padding: '4px 8px',
                  color: '#c0d0e0',
                  fontSize: 'calc(9px * var(--font-scale, 1))',
                  fontFamily: 'inherit',
                  outline: 'none',
                }}
              />
              <button
                onClick={(e) => {
                  const input = (e.target as HTMLElement).previousElementSibling as HTMLInputElement
                  if (input?.value) setApiKey(input.value)
                }}
                style={{
                  background: 'rgba(0,255,136,0.08)',
                  border: '1px solid rgba(0,255,136,0.2)',
                  borderRadius: 3,
                  padding: '4px 8px',
                  color: 'rgba(0,255,136,0.6)',
                  fontSize: 'calc(8px * var(--font-scale, 1))',
                  fontFamily: 'inherit',
                  letterSpacing: 1,
                  cursor: 'pointer',
                }}
              >
                SET
              </button>
            </div>
          )}
          <div style={{ flex: 1, minHeight: 0 }}>
            <AIChatPanel
              onSpawnMaterial={handleSpawnMaterial}
              onSetTemperature={(temp) => setTemperatureVal(temp)}
              autoExperimentActive={autoExperimentActive}
              onToggleAutoExperiment={handleToggleAutoExperiment}
              disabled={!apiKey}
            />
          </div>
        </div>
        </div>
      </div>
    </div>
  )
}

// (labelStyle / sliderStyle / valueStyle / InfoRow moved to ./fluid/FluidControls.tsx —
//  now shared with the LABORATORY page's control panel.)

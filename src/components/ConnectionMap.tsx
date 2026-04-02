// ── ConnectionMap ────────────────────────────────────────────────────────────
// Interactive force-directed graph of Chapter 3 internal physics connections.
// No external deps — force simulation implemented from scratch.

import React, { useState, useEffect, useRef, useCallback } from 'react'

// ── Types ────────────────────────────────────────────────────────────────────

type NodeGroup = 'material' | 'fluid' | 'sound' | 'structural' | 'network' | 'tick'
type EdgeSeverity = 'exists' | 'partial' | 'missing'

interface GraphNode {
  id: string
  label: string
  section: string
  group: NodeGroup
  description: string
  x: number
  y: number
  vx: number
  vy: number
  pinned: boolean
}

interface GraphEdge {
  id: string
  source: string
  target: string
  label: string
  data: string
  severity: EdgeSeverity
}

// ── Color constants ──────────────────────────────────────────────────────────

const GROUP_COLORS: Record<NodeGroup, string> = {
  material: '#f4a261',
  fluid: '#00d4ff',
  sound: '#06d6a0',
  structural: '#ef476f',
  network: '#a78bfa',
  tick: '#ffd700',
}

const GROUP_LABELS: Record<NodeGroup, string> = {
  material: 'Material System 3.1',
  fluid: 'Fluid Simulation 3.2',
  sound: 'Sound Engine 3.3',
  structural: 'Structural Physics 3.4',
  network: 'Networking 3.5',
  tick: 'Physics Tick Stages',
}

const SEVERITY_COLORS: Record<EdgeSeverity, string> = {
  exists: '#06d6a0',
  partial: '#ffd166',
  missing: '#ff6b6b',
}

const SEVERITY_LABELS: Record<EdgeSeverity, string> = {
  exists: 'Existing',
  partial: 'Partial',
  missing: 'Missing Science',
}

// ── Node definitions ─────────────────────────────────────────────────────────

interface NodeDef {
  id: string
  label: string
  section: string
  group: NodeGroup
  description: string
}

const NODE_DEFS: NodeDef[] = [
  // Tick stages
  { id: 'temp-propagation', label: 'Stage 1: Temperature', section: '3.0', group: 'tick', description: "Fourier's law heat transfer between adjacent packets" },
  { id: 'phase-transitions', label: 'Stage 2: Phase Transitions', section: '3.0', group: 'tick', description: 'Solid<>liquid<>gas based on melting/boiling points' },
  { id: 'reaction-engine', label: 'Stage 3: Reactions', section: '3.1', group: 'tick', description: 'Gibbs free energy check, stoichiometry' },
  { id: 'fluid-stage', label: 'Stage 4: Fluid Sim', section: '3.2', group: 'tick', description: 'SPH/MPM particle forces' },
  { id: 'structural-stage', label: 'Stage 5: Structural', section: '3.4', group: 'tick', description: 'Load path check on modified structures' },
  { id: 'rigid-body', label: 'Stage 6: Rigid Body', section: '3.0', group: 'tick', description: 'Gravity, collision for loose objects' },
  { id: 'sound-stage', label: 'Stage 7: Sound Events', section: '3.3', group: 'tick', description: 'Convert physics events to SoundEvent descriptors' },
  { id: 'broadcast', label: 'Stage 8: Broadcast', section: '3.5', group: 'tick', description: 'Package and send via WebSocket' },

  // Material System 3.1
  { id: 'property-calc', label: 'Property Calculator', section: '3.1', group: 'material', description: 'Composition -> 33+ derived properties' },
  { id: 'reaction-rules', label: 'Reaction Engine', section: '3.1', group: 'material', description: 'delta-G < 0 check, activation energy, stoichiometry' },

  // Fluid System 3.2
  { id: 'sph-solver', label: 'SPH Solver (crafting)', section: '3.2', group: 'fluid', description: '5 forces, 100-5k particles, 60Hz' },
  { id: 'mpm-solver', label: 'MPM Solver (environment)', section: '3.2', group: 'fluid', description: 'Particle<>grid transfer, 5k-200k particles, 30Hz' },
  { id: 'phase-system', label: 'Phase Transition System', section: '3.2', group: 'fluid', description: 'Spawns/merges particles at melting/boiling points' },
  { id: 'optical-pipeline', label: 'Optical Properties', section: '3.2', group: 'fluid', description: 'Beer-Lambert absorption, Fresnel, Planck emission' },
  { id: 'secondary-particles', label: 'Secondary Particles', section: '3.2', group: 'fluid', description: 'Spray (Weber), foam (vorticity), bubbles (reactions)' },
  { id: 'particle-network', label: 'Particle Streaming', section: '3.2', group: 'fluid', description: 'Delta compression, spatial LOD, ~97 KB/s' },
  { id: 'tier-rendering', label: 'Three-Tier Rendering', section: '3.2', group: 'fluid', description: 'Marching cubes / Screen-space / Raw points' },
  { id: 'redistribution', label: 'Redistribution', section: '3.2', group: 'fluid', description: 'Split/merge for even spacing' },

  // Sound System 3.3
  { id: 'modal-synth', label: 'Modal Synthesis', section: '3.3', group: 'sound', description: 'f = beta^2/(2piL^2) * sqrt(EI/rhoA)' },
  { id: 'noise-synth', label: 'Noise Synthesis', section: '3.3', group: 'sound', description: 'Rain, fire, wind, water flow, thunder' },
  { id: 'voice-synth', label: 'Voice Synthesis', section: '3.3', group: 'sound', description: 'NPC speech, animal calls' },

  // Structural System 3.4
  { id: 'load-path', label: 'Load Path Algorithm', section: '3.4', group: 'structural', description: 'BFS connectivity + top-down load accumulation' },
  { id: 'beam-analysis', label: 'Beam Bending', section: '3.4', group: 'structural', description: 'sigma = 3wL^2/(4bh^2), tensile failure' },
  { id: 'arch-analysis', label: 'Arch Thrust', section: '3.4', group: 'structural', description: 'T = wL^2/(8h), abutment checks' },
  { id: 'foundation', label: 'Foundation', section: '3.4', group: 'structural', description: 'Terzaghi bearing capacity, sinking rate' },
  { id: 'decay-system', label: 'Decay System', section: '3.4', group: 'structural', description: 'Rain, freeze-thaw, fire damage' },

  // Networking 3.5
  { id: 'authority', label: 'Server Authority', section: '3.5', group: 'network', description: 'All physics server-computed' },
  { id: 'video-mode', label: 'Video Mode', section: '3.5', group: 'network', description: 'H.264 stream for precision craft' },
  { id: 'state-mode', label: 'State Mode', section: '3.5', group: 'network', description: 'Client renders from position data' },
]

// ── Edge definitions ─────────────────────────────────────────────────────────

interface EdgeDef {
  id: string
  source: string
  target: string
  label: string
  data: string
  severity: EdgeSeverity
}

const EDGE_DEFS: EdgeDef[] = [
  // Connection A: 3.1 -> 3.2 (properties feed fluid)
  { id: 'A1', source: 'property-calc', target: 'sph-solver', label: 'Viscosity, density, surface tension', data: 'Material-dependent SPH forces', severity: 'exists' },
  { id: 'A2', source: 'property-calc', target: 'mpm-solver', label: 'Same properties for MPM', data: 'Viscosity, density for grid transfer', severity: 'exists' },
  { id: 'A3', source: 'property-calc', target: 'phase-system', label: 'Melting/boiling points', data: 'Triggers particle spawn/merge', severity: 'exists' },
  { id: 'A4', source: 'property-calc', target: 'optical-pipeline', label: 'Composition -> optical properties', data: 'Beer-Lambert, Arago-Biot, Planck', severity: 'exists' },
  { id: 'A5', source: 'property-calc', target: 'phase-system', label: 'MISSING: Latent heat', data: '334 kJ/kg for ice, 2260 kJ/kg for water -- transitions should absorb/release heat', severity: 'missing' },
  { id: 'A6', source: 'property-calc', target: 'sph-solver', label: 'Non-Newtonian viscosity', data: 'Mud, clay, blood are shear-thinning (Cross model)', severity: 'exists' },

  // Connection B: 3.1 -> 3.3 (properties feed sound)
  { id: 'B1', source: 'property-calc', target: 'modal-synth', label: "Young's modulus, density", data: 'E and rho determine modal frequencies', severity: 'exists' },
  { id: 'B2', source: 'property-calc', target: 'modal-synth', label: 'Boundary conditions + damping', data: 'Boundary detection for modal frequencies, Q factor from loss tangent', severity: 'exists' },

  // Connection C: 3.1 -> 3.4 (properties feed structural)
  { id: 'C1', source: 'property-calc', target: 'load-path', label: 'Compressive/tensile/shear strength', data: 'Block stress vs material capacity', severity: 'exists' },
  { id: 'C2', source: 'property-calc', target: 'beam-analysis', label: 'Tensile strength, E, density', data: 'Beam bending stress check', severity: 'exists' },
  { id: 'C3', source: 'property-calc', target: 'decay-system', label: 'Water absorption, flammability', data: 'Rain/fire damage rates', severity: 'exists' },
  { id: 'C4', source: 'property-calc', target: 'load-path', label: 'MISSING: Fatigue (Basquin)', data: 'Cyclic loading below yield still causes failure', severity: 'missing' },
  { id: 'C5', source: 'property-calc', target: 'load-path', label: 'MISSING: Fracture toughness', data: 'Cracked blocks weaker than intact -- Griffith-Irwin', severity: 'missing' },
  { id: 'C6', source: 'property-calc', target: 'load-path', label: 'MISSING: Buckling (Euler)', data: 'Tall columns fail before compressive strength', severity: 'missing' },

  // Connection E: 3.2 -> 3.1 (solidification back to materials)
  { id: 'E1', source: 'phase-system', target: 'property-calc', label: 'Frozen particles -> solid MaterialPacket', data: 'Mass-weighted composition average', severity: 'exists' },
  { id: 'E2', source: 'phase-system', target: 'property-calc', label: 'Microstructure (martensite)', data: 'Cooling rate -> grain size -> properties (martensite in steel)', severity: 'exists' },

  // Connection F: 3.2 -> 3.3 (fluid events -> sound)
  { id: 'F1', source: 'sph-solver', target: 'noise-synth', label: 'Splash events (v > 0.5 m/s)', data: 'Impact energy + liquid material -> noise descriptor', severity: 'exists' },
  { id: 'F2', source: 'sph-solver', target: 'noise-synth', label: 'Pour/flow sounds', data: 'Flow speed + channel geometry -> frequency', severity: 'exists' },
  { id: 'F3', source: 'secondary-particles', target: 'noise-synth', label: 'Bubble sounds', data: 'Minnaert frequency: f = 3.26/radius', severity: 'exists' },

  // Connection G: 3.2 -> 3.4 (MISSING: fluid loads on structures)
  { id: 'G1', source: 'sph-solver', target: 'load-path', label: 'MISSING: Hydrostatic pressure', data: 'P = rho*g*h on dams/walls -- 5m water = 50 kPa', severity: 'missing' },
  { id: 'G2', source: 'mpm-solver', target: 'load-path', label: 'MISSING: Hydrodynamic force', data: 'F = 0.5*rho*v^2*Cd*A on bridge piers', severity: 'missing' },
  { id: 'G3', source: 'mpm-solver', target: 'foundation', label: 'MISSING: Buoyancy uplift', data: 'Submerged foundations experience uplift', severity: 'missing' },

  // Connection H: 3.2 -> 3.5 (particles to network)
  { id: 'H1', source: 'particle-network', target: 'broadcast', label: 'PARTICLE_UPDATE messages', data: 'Delta-compressed, spatial LOD, 97 KB/s', severity: 'exists' },
  { id: 'H2', source: 'sph-solver', target: 'video-mode', label: 'Active particle count trigger', data: '>200 particles within 10m -> video mode', severity: 'exists' },

  // Connection I: 3.3 -> 3.5 (sound to network)
  { id: 'I1', source: 'sound-stage', target: 'broadcast', label: 'SOUND_EVENT messages', data: 'Descriptors sent to client for synthesis', severity: 'exists' },
  { id: 'I2', source: 'modal-synth', target: 'broadcast', label: 'Doppler effect', data: 'f_obs = f_src * (v+v_l)/(v+v_s) for moving sources', severity: 'exists' },
  { id: 'I3', source: 'noise-synth', target: 'broadcast', label: 'Freq-dependent absorption', data: 'Distant sounds lose high frequencies', severity: 'exists' },

  // Connection J: 3.4 -> 3.3 (structural events -> sound)
  { id: 'J1', source: 'load-path', target: 'modal-synth', label: 'Block breaking -> crack/crash sound', data: 'storedEnergy -> modal descriptor', severity: 'exists' },
  { id: 'J2', source: 'load-path', target: 'noise-synth', label: 'Cascade collapse -> staggered impacts', data: 'Multiple events over 0.5s', severity: 'exists' },

  // Connection K: 3.4 -> 3.2 (MISSING: collapse displaces fluid)
  { id: 'K1', source: 'load-path', target: 'mpm-solver', label: 'Progressive collapse -> flood', data: 'Structural failure releases contained water, progressive collapse dynamics', severity: 'exists' },
  { id: 'K2', source: 'load-path', target: 'sph-solver', label: 'Debris into water -> splash', data: 'Collapsing structure displaces liquid', severity: 'exists' },

  // Connection L: Temperature -> 3.4 (thermal structural damage)
  { id: 'L1', source: 'temp-propagation', target: 'decay-system', label: 'Fire weakens materials', data: 'Wood burns, stone spalls at 500C', severity: 'exists' },
  { id: 'L2', source: 'temp-propagation', target: 'decay-system', label: 'Freeze-thaw cycles', data: 'Water in cracks expands 9%', severity: 'exists' },
  { id: 'L3', source: 'temp-propagation', target: 'load-path', label: 'MISSING: Thermal stress', data: 'sigma = E*alpha*deltaT -- heated stone walls crack', severity: 'missing' },

  // Connection M: 3.4 -> rigid body
  { id: 'M1', source: 'load-path', target: 'rigid-body', label: 'Failed blocks -> debris', data: 'Compound rigid bodies with tumble', severity: 'exists' },

  // Connection N: Reactions -> 3.2 (gas -> bubbles)
  { id: 'N1', source: 'reaction-rules', target: 'secondary-particles', label: 'Gas products in liquid -> bubbles', data: 'CO2, H2 from reactions', severity: 'exists' },

  // Connection O: 3.2 optical -> 3.5
  { id: 'O1', source: 'optical-pipeline', target: 'tier-rendering', label: 'Per-particle shading data', data: 'absorptionRGB + refractiveIndex + emission', severity: 'exists' },
  { id: 'O2', source: 'tier-rendering', target: 'state-mode', label: 'Rendered fluid surfaces', data: 'Marching cubes or SSFR to client GPU', severity: 'exists' },

  // Pipeline connections (tick stages)
  { id: 'P1', source: 'temp-propagation', target: 'phase-transitions', label: 'Updated temperatures', data: 'Packets may cross melting/boiling points', severity: 'exists' },
  { id: 'P2', source: 'phase-transitions', target: 'reaction-engine', label: 'New compositions from phase changes', data: 'Liquid may react differently than solid', severity: 'exists' },
  { id: 'P3', source: 'reaction-engine', target: 'fluid-stage', label: 'Transformed packets + spawned particles', data: 'New compositions, gas products', severity: 'exists' },
  { id: 'P4', source: 'fluid-stage', target: 'structural-stage', label: 'Fluid forces on structures', data: 'Currently only indirect via temperature', severity: 'partial' },
  { id: 'P5', source: 'structural-stage', target: 'rigid-body', label: 'Broken blocks', data: 'Debris objects for physics sim', severity: 'exists' },
  { id: 'P6', source: 'rigid-body', target: 'sound-stage', label: 'Impact events', data: 'Every collision generates sound descriptor', severity: 'exists' },
  { id: 'P7', source: 'sound-stage', target: 'broadcast', label: 'All events packaged', data: 'WebSocket to all clients', severity: 'exists' },

  // Connection Q: Newly filled science gaps (sprint 2026-04)
  { id: 'Q1', source: 'property-calc', target: 'load-path', label: 'Work hardening', data: 'Plastic deformation increases yield strength in metals', severity: 'exists' },
  { id: 'Q2', source: 'property-calc', target: 'decay-system', label: 'Galvanic corrosion', data: 'Dissimilar metals in contact corrode at electrochemical potential difference', severity: 'exists' },
  { id: 'Q3', source: 'sph-solver', target: 'decay-system', label: 'Capillary action', data: 'Capillary: rising damp in walls', severity: 'exists' },
  { id: 'Q4', source: 'sph-solver', target: 'property-calc', label: 'Sedimentation / settling', data: 'Settling: heavy particles deposit as MaterialPackets', severity: 'exists' },
  { id: 'Q5', source: 'mpm-solver', target: 'noise-synth', label: 'Hydraulic jump', data: 'Hydraulic jump: turbulent roar at Fr transitions', severity: 'exists' },
  { id: 'Q6', source: 'modal-synth', target: 'load-path', label: 'Structure-borne sound', data: 'Structure-borne: sound propagates through structural BFS graph', severity: 'exists' },
  { id: 'Q7', source: 'foundation', target: 'mpm-solver', label: 'Lateral earth pressure', data: 'Earth pressure: soil pushes on retaining walls, connects to water table', severity: 'exists' },
  { id: 'Q8', source: 'load-path', target: 'load-path', label: 'Frame triangulation', data: 'Triangulation: kinematic criterion m=b+r-2j for frame stability', severity: 'exists' },
  { id: 'Q9', source: 'beam-analysis', target: 'tier-rendering', label: 'Deflection limits', data: 'Deflection: visible beam sag at delta > L/180', severity: 'exists' },
]

// Compute edge counts
const EDGE_COUNTS = {
  exists: EDGE_DEFS.filter(e => e.severity === 'exists').length,
  partial: EDGE_DEFS.filter(e => e.severity === 'partial').length,
  missing: EDGE_DEFS.filter(e => e.severity === 'missing').length,
}

// ── Force simulation ─────────────────────────────────────────────────────────

const REPULSION_K = 5000
const SPRING_K = 0.006
const SPRING_REST = 140
const CENTER_GRAVITY = 0.008
const DAMPING = 0.91
const MAX_ITERATIONS = 400
const DT = 1.0

// Group-based initial placement angles (radians)
const GROUP_ANGLE: Record<NodeGroup, number> = {
  tick: 0,                    // top center (pipeline)
  material: Math.PI * 0.35,   // upper right
  fluid: Math.PI * 0.7,       // right
  sound: Math.PI * 1.1,       // lower left
  structural: Math.PI * 1.5,  // left
  network: Math.PI * 1.85,    // upper left
}

function initNodes(width: number, height: number): GraphNode[] {
  const cx = width / 2
  const cy = height / 2
  const groupCounts: Record<NodeGroup, number> = { material: 0, fluid: 0, sound: 0, structural: 0, network: 0, tick: 0 }
  const groupTotals: Record<NodeGroup, number> = { material: 0, fluid: 0, sound: 0, structural: 0, network: 0, tick: 0 }
  for (const nd of NODE_DEFS) groupTotals[nd.group]++

  return NODE_DEFS.map(nd => {
    const baseAngle = GROUP_ANGLE[nd.group]
    const spread = Math.PI * 0.35
    const idx = groupCounts[nd.group]
    const total = Math.max(1, groupTotals[nd.group])
    const angle = baseAngle + (idx / total) * spread - spread / 2
    const radius = 160 + Math.random() * 80
    groupCounts[nd.group]++
    return {
      id: nd.id,
      label: nd.label,
      section: nd.section,
      group: nd.group,
      description: nd.description,
      x: cx + Math.cos(angle) * radius + (Math.random() - 0.5) * 50,
      y: cy + Math.sin(angle) * radius + (Math.random() - 0.5) * 50,
      vx: 0,
      vy: 0,
      pinned: false,
    }
  })
}

function stepSimulation(nodes: GraphNode[], edges: GraphEdge[], width: number, height: number): void {
  const cx = width / 2
  const cy = height / 2
  const n = nodes.length

  const fx = new Float64Array(n)
  const fy = new Float64Array(n)

  // Coulomb repulsion (all pairs)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let dx = nodes[j].x - nodes[i].x
      let dy = nodes[j].y - nodes[i].y
      let dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < 1) dist = 1
      const force = REPULSION_K / (dist * dist)
      const fdx = (dx / dist) * force
      const fdy = (dy / dist) * force
      fx[i] -= fdx
      fy[i] -= fdy
      fx[j] += fdx
      fy[j] += fdy
    }
  }

  // Index map
  const idxMap = new Map<string, number>()
  for (let i = 0; i < n; i++) idxMap.set(nodes[i].id, i)

  // Spring attraction (connected pairs)
  for (const edge of edges) {
    const si = idxMap.get(edge.source)
    const ti = idxMap.get(edge.target)
    if (si === undefined || ti === undefined) continue
    let dx = nodes[ti].x - nodes[si].x
    let dy = nodes[ti].y - nodes[si].y
    let dist = Math.sqrt(dx * dx + dy * dy)
    if (dist < 1) dist = 1
    const displacement = dist - SPRING_REST
    const force = SPRING_K * displacement
    const fdx = (dx / dist) * force
    const fdy = (dy / dist) * force
    fx[si] += fdx
    fy[si] += fdy
    fx[ti] -= fdx
    fy[ti] -= fdy
  }

  // Center gravity
  for (let i = 0; i < n; i++) {
    fx[i] += (cx - nodes[i].x) * CENTER_GRAVITY
    fy[i] += (cy - nodes[i].y) * CENTER_GRAVITY
  }

  // Apply forces
  for (let i = 0; i < n; i++) {
    if (nodes[i].pinned) continue
    nodes[i].vx = (nodes[i].vx + fx[i] * DT) * DAMPING
    nodes[i].vy = (nodes[i].vy + fy[i] * DT) * DAMPING
    nodes[i].x += nodes[i].vx * DT
    nodes[i].y += nodes[i].vy * DT
    nodes[i].x = Math.max(60, Math.min(width - 60, nodes[i].x))
    nodes[i].y = Math.max(60, Math.min(height - 60, nodes[i].y))
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export function ConnectionMap() {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const nodesRef = useRef<GraphNode[]>([])
  const edgesRef = useRef<GraphEdge[]>(EDGE_DEFS.map(e => ({ ...e })))
  const iterRef = useRef(0)
  const rafRef = useRef(0)
  const sizeRef = useRef({ width: 1200, height: 800 })

  const [, forceRender] = useState(0)
  const [hoveredNode, setHoveredNode] = useState<string | null>(null)
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null)
  const [hiddenGroups, setHiddenGroups] = useState<Set<NodeGroup>>(new Set())

  // Zoom/pan state
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 })
  const panRef = useRef<{ active: boolean; startX: number; startY: number; startTx: number; startTy: number }>({
    active: false, startX: 0, startY: 0, startTx: 0, startTy: 0,
  })
  const dragNodeRef = useRef<{ active: boolean; nodeId: string | null; offsetX: number; offsetY: number }>({
    active: false, nodeId: null, offsetX: 0, offsetY: 0,
  })

  // Tooltip state
  const [tooltip, setTooltip] = useState<{ x: number; y: number; nodeId: string } | null>(null)

  // Initialize nodes
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const w = rect.width || 1200
    const h = rect.height || 800
    sizeRef.current = { width: w, height: h }
    nodesRef.current = initNodes(w, h)
    iterRef.current = 0
    forceRender(v => v + 1)
  }, [])

  // Resize observer
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        if (width > 0 && height > 0) {
          sizeRef.current = { width, height }
        }
      }
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // Force simulation loop
  useEffect(() => {
    let running = true
    function tick() {
      if (!running) return
      if (iterRef.current < MAX_ITERATIONS) {
        stepSimulation(nodesRef.current, edgesRef.current, sizeRef.current.width, sizeRef.current.height)
        iterRef.current++
        forceRender(v => v + 1)
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      running = false
      cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // Build adjacency for hover highlighting
  const adjacency = useRef(new Map<string, Set<string>>())
  useEffect(() => {
    const adj = new Map<string, Set<string>>()
    for (const nd of NODE_DEFS) adj.set(nd.id, new Set())
    for (const e of EDGE_DEFS) {
      adj.get(e.source)?.add(e.target)
      adj.get(e.target)?.add(e.source)
    }
    adjacency.current = adj
  }, [])

  // Get connections for a node
  const getNodeConnections = useCallback((nodeId: string) => {
    return EDGE_DEFS.filter(e => e.source === nodeId || e.target === nodeId)
  }, [])

  // Screen coords to graph coords
  const screenToGraph = useCallback((sx: number, sy: number) => {
    return {
      x: (sx - transform.x) / transform.scale,
      y: (sy - transform.y) / transform.scale,
    }
  }, [transform])

  // Mouse wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9
    const newScale = Math.max(0.2, Math.min(4, transform.scale * zoomFactor))
    const newX = mx - (mx - transform.x) * (newScale / transform.scale)
    const newY = my - (my - transform.y) * (newScale / transform.scale)
    setTransform({ x: newX, y: newY, scale: newScale })
  }, [transform])

  // Pan / drag handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    panRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      startTx: transform.x,
      startTy: transform.y,
    }
  }, [transform])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (dragNodeRef.current.active && dragNodeRef.current.nodeId) {
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const gp = screenToGraph(mx, my)
      const node = nodesRef.current.find(n => n.id === dragNodeRef.current.nodeId)
      if (node) {
        node.x = gp.x
        node.y = gp.y
        node.vx = 0
        node.vy = 0
        node.pinned = true
        forceRender(v => v + 1)
      }
      return
    }
    if (panRef.current.active) {
      const dx = e.clientX - panRef.current.startX
      const dy = e.clientY - panRef.current.startY
      setTransform(prev => ({
        ...prev,
        x: panRef.current.startTx + dx,
        y: panRef.current.startTy + dy,
      }))
    }
  }, [screenToGraph])

  const handleMouseUp = useCallback(() => {
    panRef.current.active = false
    if (dragNodeRef.current.active && dragNodeRef.current.nodeId) {
      const node = nodesRef.current.find(n => n.id === dragNodeRef.current.nodeId)
      if (node) {
        node.pinned = false
        iterRef.current = Math.max(0, iterRef.current - 50)
      }
      dragNodeRef.current = { active: false, nodeId: null, offsetX: 0, offsetY: 0 }
    }
  }, [])

  // Node mouse handlers
  const handleNodeMouseDown = useCallback((e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation()
    dragNodeRef.current = { active: true, nodeId, offsetX: 0, offsetY: 0 }
    const node = nodesRef.current.find(n => n.id === nodeId)
    if (node) node.pinned = true
  }, [])

  const handleNodeClick = useCallback((e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation()
    if (!dragNodeRef.current.active) {
      setSelectedNode(prev => prev === nodeId ? null : nodeId)
      setSelectedEdge(null)
    }
  }, [])

  const handleEdgeClick = useCallback((e: React.MouseEvent, edgeId: string) => {
    e.stopPropagation()
    setSelectedEdge(prev => prev === edgeId ? null : edgeId)
    setSelectedNode(null)
  }, [])

  const handleNodeEnter = useCallback((e: React.MouseEvent, nodeId: string) => {
    setHoveredNode(nodeId)
    const rect = containerRef.current?.getBoundingClientRect()
    if (rect) {
      setTooltip({ x: e.clientX - rect.left, y: e.clientY - rect.top, nodeId })
    }
  }, [])

  const handleNodeMove = useCallback((e: React.MouseEvent, nodeId: string) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (rect) {
      setTooltip({ x: e.clientX - rect.left, y: e.clientY - rect.top, nodeId })
    }
  }, [])

  const handleNodeLeave = useCallback(() => {
    setHoveredNode(null)
    setTooltip(null)
  }, [])

  const toggleGroup = useCallback((group: NodeGroup) => {
    setHiddenGroups(prev => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }, [])

  // Build visible sets
  const visibleNodeIds = new Set(
    nodesRef.current
      .filter(n => !hiddenGroups.has(n.group))
      .map(n => n.id)
  )

  const hoveredNeighbors = hoveredNode ? adjacency.current.get(hoveredNode) ?? new Set<string>() : new Set<string>()

  const nodeMap = new Map<string, GraphNode>()
  for (const n of nodesRef.current) nodeMap.set(n.id, n)

  // ── Render ─────────────────────────────────────────────────────────────────

  const { width: _w, height: _h } = sizeRef.current
  void _w; void _h
  const selectedNodeData = selectedNode ? NODE_DEFS.find(n => n.id === selectedNode) : null
  const selectedEdgeData = selectedEdge !== null ? EDGE_DEFS.find(e => e.id === selectedEdge) : null

  return (
    <div style={{
      display: 'flex',
      height: '100%',
      width: '100%',
      overflow: 'hidden',
      background: 'rgba(4,8,18,0.88)',
      position: 'relative',
    }}>
      {/* Main graph area */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          minWidth: 0,
          position: 'relative',
          overflow: 'hidden',
          cursor: panRef.current.active ? 'grabbing' : 'grab',
        }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {/* Stats bar at top */}
        <div style={{
          position: 'absolute',
          top: 10,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 25,
          display: 'flex',
          gap: 16,
          padding: '6px 18px',
          background: 'rgba(4,8,20,0.92)',
          border: '1px solid rgba(0,180,255,0.12)',
          borderRadius: 4,
          fontSize: 11,
          fontFamily: "'IBM Plex Mono', monospace",
          letterSpacing: 0.5,
        }}>
          <span style={{ color: SEVERITY_COLORS.exists }}>
            {EDGE_COUNTS.exists} existing
          </span>
          <span style={{ color: 'rgba(100,130,160,0.3)' }}>|</span>
          <span style={{ color: SEVERITY_COLORS.partial }}>
            {EDGE_COUNTS.partial} partial
          </span>
          <span style={{ color: 'rgba(100,130,160,0.3)' }}>|</span>
          <span style={{ color: SEVERITY_COLORS.missing }}>
            {EDGE_COUNTS.missing} missing science gaps
          </span>
        </div>

        {/* Legend — node groups */}
        <div style={{
          position: 'absolute',
          top: 48,
          left: 10,
          zIndex: 20,
          display: 'flex',
          gap: 6,
          flexWrap: 'wrap',
          maxWidth: 520,
        }}>
          {(Object.keys(GROUP_COLORS) as NodeGroup[]).map(group => {
            const hidden = hiddenGroups.has(group)
            return (
              <button
                key={group}
                onClick={() => toggleGroup(group)}
                style={{
                  background: hidden ? 'rgba(4,8,20,0.6)' : `${GROUP_COLORS[group]}15`,
                  border: `1px solid ${hidden ? 'rgba(60,80,100,0.3)' : GROUP_COLORS[group]}`,
                  borderRadius: 3,
                  padding: '3px 10px',
                  fontSize: 9,
                  letterSpacing: 1.5,
                  fontFamily: 'inherit',
                  color: hidden ? 'rgba(80,100,120,0.4)' : GROUP_COLORS[group],
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  textDecoration: hidden ? 'line-through' : 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                }}
              >
                <span style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: hidden ? 'rgba(60,80,100,0.3)' : GROUP_COLORS[group],
                  display: 'inline-block',
                  flexShrink: 0,
                }} />
                {GROUP_LABELS[group]}
              </button>
            )
          })}
          {/* Edge severity legend */}
          <div style={{ width: '100%', display: 'flex', gap: 10, marginTop: 4 }}>
            {(Object.keys(SEVERITY_COLORS) as EdgeSeverity[]).map(sev => (
              <div key={sev} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 9,
                color: 'rgba(150,185,220,0.55)',
                letterSpacing: 1,
              }}>
                <span style={{
                  width: 20,
                  height: 2,
                  display: 'inline-block',
                  borderRadius: 1,
                  ...(sev === 'missing' ? {
                    backgroundImage: `repeating-linear-gradient(90deg, ${SEVERITY_COLORS[sev]} 0px, ${SEVERITY_COLORS[sev]} 4px, transparent 4px, transparent 8px)`,
                    background: 'none',
                  } : {
                    background: SEVERITY_COLORS[sev],
                  }),
                }} />
                {SEVERITY_LABELS[sev]}
              </div>
            ))}
          </div>
        </div>

        {/* Title label */}
        <div style={{
          position: 'absolute',
          bottom: 6,
          left: 10,
          fontSize: 10,
          letterSpacing: 2,
          color: 'rgba(0,180,255,0.2)',
          zIndex: 20,
          fontFamily: "'IBM Plex Mono', monospace",
        }}>
          CHAPTER 3 PHYSICS // INTERNAL CONNECTIONS {iterRef.current >= MAX_ITERATIONS ? '// SETTLED' : `// SIMULATING ${iterRef.current}/${MAX_ITERATIONS}`}
        </div>

        {/* Zoom indicator */}
        <div style={{
          position: 'absolute',
          bottom: 6,
          right: (selectedNodeData || selectedEdgeData) ? 340 : 10,
          fontSize: 9,
          letterSpacing: 1,
          color: 'rgba(0,180,255,0.2)',
          zIndex: 20,
          transition: 'right 0.2s',
          fontFamily: "'IBM Plex Mono', monospace",
        }}>
          {Math.round(transform.scale * 100)}%
        </div>

        {/* Subtle grid */}
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: `
            linear-gradient(rgba(0,180,255,0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0,180,255,0.03) 1px, transparent 1px)
          `,
          backgroundSize: '40px 40px',
          pointerEvents: 'none',
        }} />

        {/* SVG */}
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          style={{ position: 'absolute', inset: 0 }}
        >
          <defs>
            {/* Arrow markers for each severity */}
            <marker id="arrow-exists" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill={SEVERITY_COLORS.exists} opacity="0.7" />
            </marker>
            <marker id="arrow-partial" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill={SEVERITY_COLORS.partial} opacity="0.7" />
            </marker>
            <marker id="arrow-missing" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill={SEVERITY_COLORS.missing} opacity="0.7" />
            </marker>
            <marker id="arrow-highlight" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill="rgba(255,255,255,0.9)" />
            </marker>
          </defs>

          <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}>
            {/* Edges */}
            {edgesRef.current.map(edge => {
              const s = nodeMap.get(edge.source)
              const t = nodeMap.get(edge.target)
              if (!s || !t) return null
              if (!visibleNodeIds.has(edge.source) || !visibleNodeIds.has(edge.target)) return null

              const isHoverHighlighted = hoveredNode !== null && (
                edge.source === hoveredNode || edge.target === hoveredNode
              )
              const isDimmed = hoveredNode !== null && !isHoverHighlighted

              // Offset line endpoints so arrows stop at node circle edge
              const dx = t.x - s.x
              const dy = t.y - s.y
              const dist = Math.sqrt(dx * dx + dy * dy)
              if (dist < 1) return null
              const nx = dx / dist
              const ny = dy / dist
              const nodeRadius = 14
              const x1 = s.x + nx * nodeRadius
              const y1 = s.y + ny * nodeRadius
              const x2 = t.x - nx * (nodeRadius + 6)
              const y2 = t.y - ny * (nodeRadius + 6)

              const isMissing = edge.severity === 'missing'
              const isPartial = edge.severity === 'partial'

              return (
                <line
                  key={edge.id}
                  x1={x1} y1={y1}
                  x2={x2} y2={y2}
                  stroke={isHoverHighlighted ? 'rgba(255,255,255,0.9)' : SEVERITY_COLORS[edge.severity]}
                  strokeWidth={isHoverHighlighted ? 2.5 : isMissing ? 1.2 : isPartial ? 1 : 0.8}
                  strokeDasharray={isMissing ? '6,4' : '0'}
                  opacity={isDimmed ? 0.04 : isHoverHighlighted ? 1 : isMissing ? 0.65 : 0.5}
                  style={{ transition: 'opacity 0.2s', cursor: 'pointer' }}
                  markerEnd={isHoverHighlighted ? 'url(#arrow-highlight)' : `url(#arrow-${edge.severity})`}
                  onClick={(e) => handleEdgeClick(e, edge.id)}
                />
              )
            })}

            {/* Nodes */}
            {nodesRef.current.map(node => {
              if (!visibleNodeIds.has(node.id)) return null

              const isHovered = hoveredNode === node.id
              const isNeighbor = hoveredNeighbors.has(node.id)
              const isDimmed = hoveredNode !== null && !isHovered && !isNeighbor
              const nodeColor = GROUP_COLORS[node.group]
              const r = 14

              return (
                <g
                  key={node.id}
                  style={{ cursor: 'pointer', transition: 'opacity 0.2s' }}
                  opacity={isDimmed ? 0.1 : 1}
                  onMouseDown={(e: React.MouseEvent<SVGGElement>) => handleNodeMouseDown(e as unknown as React.MouseEvent, node.id)}
                  onClick={(e: React.MouseEvent<SVGGElement>) => handleNodeClick(e as unknown as React.MouseEvent, node.id)}
                  onMouseEnter={(e: React.MouseEvent<SVGGElement>) => handleNodeEnter(e as unknown as React.MouseEvent, node.id)}
                  onMouseMove={(e: React.MouseEvent<SVGGElement>) => handleNodeMove(e as unknown as React.MouseEvent, node.id)}
                  onMouseLeave={handleNodeLeave}
                >
                  {/* Glow ring for hovered */}
                  {isHovered && (
                    <circle
                      cx={node.x} cy={node.y}
                      r={r + 6}
                      fill="none"
                      stroke={nodeColor}
                      strokeWidth={1.5}
                      opacity={0.3}
                    />
                  )}
                  {/* Node circle */}
                  <circle
                    cx={node.x} cy={node.y}
                    r={r}
                    fill={isHovered ? `${nodeColor}30` : 'rgba(4,8,20,0.85)'}
                    stroke={nodeColor}
                    strokeWidth={isHovered ? 2 : 1.2}
                  />
                  {/* Section number inside */}
                  <text
                    x={node.x} y={node.y + 1}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={8}
                    fontFamily="'IBM Plex Mono', monospace"
                    fill={nodeColor}
                    opacity={0.9}
                  >
                    {node.section}
                  </text>
                  {/* Label below */}
                  <text
                    x={node.x} y={node.y + r + 12}
                    textAnchor="middle"
                    fontSize={8}
                    fontFamily="'IBM Plex Mono', monospace"
                    fill={isHovered ? nodeColor : 'rgba(180,210,240,0.5)'}
                    fontWeight={isHovered ? 600 : 400}
                  >
                    {node.label.length > 22 ? node.label.slice(0, 20) + '..' : node.label}
                  </text>
                </g>
              )
            })}
          </g>
        </svg>

        {/* Tooltip */}
        {tooltip && !dragNodeRef.current.active && (() => {
          const nd = NODE_DEFS.find(n => n.id === tooltip.nodeId)
          if (!nd) return null
          const connections = getNodeConnections(tooltip.nodeId)
          const missingCount = connections.filter(c => c.severity === 'missing').length
          return (
            <div style={{
              position: 'absolute',
              left: tooltip.x + 14,
              top: tooltip.y - 10,
              zIndex: 30,
              background: 'rgba(4,8,20,0.96)',
              border: `1px solid ${GROUP_COLORS[nd.group]}`,
              borderRadius: 4,
              padding: '8px 12px',
              fontSize: 10,
              color: 'rgba(220,235,255,0.9)',
              fontFamily: "'IBM Plex Mono', monospace",
              pointerEvents: 'none',
              maxWidth: 320,
              boxShadow: `0 0 12px ${GROUP_COLORS[nd.group]}22`,
            }}>
              <div style={{ color: GROUP_COLORS[nd.group], fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
                {nd.label}
              </div>
              <div style={{ color: 'rgba(150,185,220,0.55)', fontSize: 9, marginBottom: 4 }}>
                Section {nd.section} / {GROUP_LABELS[nd.group]}
              </div>
              <div style={{ color: 'rgba(180,210,240,0.65)', fontSize: 9, marginBottom: 6, lineHeight: 1.4 }}>
                {nd.description}
              </div>
              {missingCount > 0 && (
                <div style={{
                  color: SEVERITY_COLORS.missing,
                  fontSize: 9,
                  marginBottom: 4,
                  padding: '3px 6px',
                  background: 'rgba(255,107,107,0.08)',
                  borderRadius: 2,
                  border: '1px solid rgba(255,107,107,0.15)',
                }}>
                  {missingCount} missing science gap{missingCount > 1 ? 's' : ''}
                </div>
              )}
              {connections.length > 0 && (
                <div style={{ borderTop: '1px solid rgba(0,180,255,0.1)', paddingTop: 4 }}>
                  <div style={{ fontSize: 9, color: 'rgba(150,185,220,0.4)', marginBottom: 3, letterSpacing: 1 }}>
                    CONNECTIONS ({connections.length})
                  </div>
                  {connections.slice(0, 8).map(c => {
                    const other = c.source === tooltip.nodeId ? c.target : c.source
                    const dir = c.source === tooltip.nodeId ? '->' : '<-'
                    const otherNode = NODE_DEFS.find(n => n.id === other)
                    return (
                      <div key={c.id} style={{
                        fontSize: 9,
                        color: SEVERITY_COLORS[c.severity],
                        opacity: 0.8,
                        lineHeight: 1.6,
                      }}>
                        {c.severity === 'missing' ? '[!] ' : ''}{dir} {otherNode?.label ?? other}
                      </div>
                    )
                  })}
                  {connections.length > 8 && (
                    <div style={{ fontSize: 9, color: 'rgba(150,185,220,0.3)' }}>
                      +{connections.length - 8} more
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })()}
      </div>

      {/* Detail panel (right side) */}
      {(selectedNodeData || selectedEdgeData) && (
        <div style={{
          width: 330,
          flexShrink: 0,
          background: 'rgba(2,5,14,0.95)',
          borderLeft: '1px solid rgba(0,180,255,0.13)',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          backdropFilter: 'blur(8px)',
        }}>
          {/* Close button */}
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '8px 12px',
            borderBottom: '1px solid rgba(0,180,255,0.08)',
          }}>
            <span style={{
              fontSize: 9,
              letterSpacing: 2,
              color: 'rgba(0,180,255,0.3)',
            }}>
              {selectedNodeData ? 'NODE DETAIL' : 'CONNECTION DETAIL'}
            </span>
            <button
              onClick={() => { setSelectedNode(null); setSelectedEdge(null) }}
              style={{
                background: 'none',
                border: '1px solid rgba(0,180,255,0.15)',
                borderRadius: 3,
                color: 'rgba(150,185,220,0.55)',
                fontSize: 10,
                padding: '2px 8px',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              CLOSE
            </button>
          </div>

          {/* Node detail */}
          {selectedNodeData && (() => {
            const connections = getNodeConnections(selectedNodeData.id)
            const outgoing = connections.filter(c => c.source === selectedNodeData.id)
            const incoming = connections.filter(c => c.target === selectedNodeData.id)
            const existsCount = connections.filter(c => c.severity === 'exists').length
            const partialCount = connections.filter(c => c.severity === 'partial').length
            const missingCount = connections.filter(c => c.severity === 'missing').length
            const color = GROUP_COLORS[selectedNodeData.group]

            return (
              <div style={{ padding: '12px' }}>
                <div style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color,
                  marginBottom: 4,
                }}>
                  {selectedNodeData.label}
                </div>
                <div style={{
                  fontSize: 10,
                  color: 'rgba(150,185,220,0.55)',
                  marginBottom: 6,
                }}>
                  Section {selectedNodeData.section} / {GROUP_LABELS[selectedNodeData.group]}
                </div>
                <div style={{
                  fontSize: 10,
                  color: 'rgba(180,210,240,0.65)',
                  lineHeight: 1.5,
                  marginBottom: 12,
                  padding: '6px 8px',
                  background: 'rgba(0,180,255,0.03)',
                  borderRadius: 3,
                  border: '1px solid rgba(0,180,255,0.06)',
                }}>
                  {selectedNodeData.description}
                </div>

                {/* Stats bar */}
                <div style={{
                  display: 'flex',
                  gap: 12,
                  marginBottom: 16,
                  padding: '8px 10px',
                  background: 'rgba(0,180,255,0.04)',
                  borderRadius: 3,
                  border: '1px solid rgba(0,180,255,0.08)',
                }}>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 600, color: '#00d4ff' }}>{connections.length}</div>
                    <div style={{ fontSize: 8, color: 'rgba(150,185,220,0.4)', letterSpacing: 1 }}>TOTAL</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 600, color: SEVERITY_COLORS.exists }}>{existsCount}</div>
                    <div style={{ fontSize: 8, color: 'rgba(150,185,220,0.4)', letterSpacing: 1 }}>EXISTS</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 600, color: SEVERITY_COLORS.partial }}>{partialCount}</div>
                    <div style={{ fontSize: 8, color: 'rgba(150,185,220,0.4)', letterSpacing: 1 }}>PARTIAL</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 600, color: SEVERITY_COLORS.missing }}>{missingCount}</div>
                    <div style={{ fontSize: 8, color: 'rgba(150,185,220,0.4)', letterSpacing: 1 }}>MISSING</div>
                  </div>
                </div>

                {/* Missing science alert */}
                {missingCount > 0 && (
                  <div style={{
                    padding: '8px 10px',
                    marginBottom: 12,
                    background: 'rgba(255,107,107,0.06)',
                    border: '1px solid rgba(255,107,107,0.15)',
                    borderRadius: 3,
                    fontSize: 10,
                    color: SEVERITY_COLORS.missing,
                    lineHeight: 1.5,
                  }}>
                    This node has {missingCount} missing science connection{missingCount > 1 ? 's' : ''} that need implementation.
                  </div>
                )}

                {/* Outgoing connections */}
                {outgoing.length > 0 && (
                  <>
                    <div style={{
                      fontSize: 9,
                      letterSpacing: 1.5,
                      color: 'rgba(0,180,255,0.3)',
                      marginBottom: 6,
                    }}>
                      OUTGOING ({outgoing.length})
                    </div>
                    {outgoing.map(c => {
                      const targetNode = NODE_DEFS.find(n => n.id === c.target)
                      return (
                        <div
                          key={c.id}
                          onClick={() => { setSelectedEdge(c.id); setSelectedNode(null) }}
                          style={{
                            padding: '6px 8px',
                            marginBottom: 3,
                            background: c.severity === 'missing' ? 'rgba(255,107,107,0.04)' : 'rgba(0,180,255,0.03)',
                            borderLeft: `2px solid ${SEVERITY_COLORS[c.severity]}`,
                            borderRadius: '0 3px 3px 0',
                            cursor: 'pointer',
                            transition: 'background 0.15s',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = c.severity === 'missing' ? 'rgba(255,107,107,0.1)' : 'rgba(0,180,255,0.08)' }}
                          onMouseLeave={e => { e.currentTarget.style.background = c.severity === 'missing' ? 'rgba(255,107,107,0.04)' : 'rgba(0,180,255,0.03)' }}
                        >
                          <div style={{ fontSize: 10, color: SEVERITY_COLORS[c.severity] }}>
                            {c.severity === 'missing' ? '[!] ' : ''}{c.label}
                          </div>
                          <div style={{ fontSize: 9, color: 'rgba(150,185,220,0.45)', marginTop: 2 }}>
                            -&gt; {targetNode?.label ?? c.target}
                          </div>
                        </div>
                      )
                    })}
                  </>
                )}

                {/* Incoming connections */}
                {incoming.length > 0 && (
                  <>
                    <div style={{
                      fontSize: 9,
                      letterSpacing: 1.5,
                      color: 'rgba(0,180,255,0.3)',
                      marginTop: 12,
                      marginBottom: 6,
                    }}>
                      INCOMING ({incoming.length})
                    </div>
                    {incoming.map(c => {
                      const sourceNode = NODE_DEFS.find(n => n.id === c.source)
                      return (
                        <div
                          key={c.id}
                          onClick={() => { setSelectedEdge(c.id); setSelectedNode(null) }}
                          style={{
                            padding: '6px 8px',
                            marginBottom: 3,
                            background: c.severity === 'missing' ? 'rgba(255,107,107,0.04)' : 'rgba(0,180,255,0.03)',
                            borderLeft: `2px solid ${SEVERITY_COLORS[c.severity]}`,
                            borderRadius: '0 3px 3px 0',
                            cursor: 'pointer',
                            transition: 'background 0.15s',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = c.severity === 'missing' ? 'rgba(255,107,107,0.1)' : 'rgba(0,180,255,0.08)' }}
                          onMouseLeave={e => { e.currentTarget.style.background = c.severity === 'missing' ? 'rgba(255,107,107,0.04)' : 'rgba(0,180,255,0.03)' }}
                        >
                          <div style={{ fontSize: 10, color: SEVERITY_COLORS[c.severity] }}>
                            {c.severity === 'missing' ? '[!] ' : ''}{c.label}
                          </div>
                          <div style={{ fontSize: 9, color: 'rgba(150,185,220,0.45)', marginTop: 2 }}>
                            &lt;- {sourceNode?.label ?? c.source}
                          </div>
                        </div>
                      )
                    })}
                  </>
                )}
              </div>
            )
          })()}

          {/* Edge detail */}
          {selectedEdgeData && (() => {
            const sourceNode = NODE_DEFS.find(n => n.id === selectedEdgeData.source)
            const targetNode = NODE_DEFS.find(n => n.id === selectedEdgeData.target)
            const color = SEVERITY_COLORS[selectedEdgeData.severity]
            const isMissing = selectedEdgeData.severity === 'missing'

            return (
              <div style={{ padding: '12px' }}>
                <div style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color,
                  marginBottom: 4,
                }}>
                  {isMissing ? '[!] ' : ''}{selectedEdgeData.label}
                </div>
                <div style={{
                  fontSize: 9,
                  letterSpacing: 1,
                  color: 'rgba(150,185,220,0.4)',
                  marginBottom: 12,
                  textTransform: 'uppercase',
                }}>
                  {SEVERITY_LABELS[selectedEdgeData.severity]} CONNECTION
                </div>

                {/* Missing science banner */}
                {isMissing && (
                  <div style={{
                    padding: '8px 10px',
                    marginBottom: 12,
                    background: 'rgba(255,107,107,0.08)',
                    border: '1px dashed rgba(255,107,107,0.3)',
                    borderRadius: 3,
                    fontSize: 10,
                    color: SEVERITY_COLORS.missing,
                    lineHeight: 1.5,
                  }}>
                    SCIENCE GAP -- This connection needs to be implemented. The underlying physics is described below.
                  </div>
                )}

                {/* Source -> Target visual */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '10px',
                  background: 'rgba(0,180,255,0.04)',
                  borderRadius: 4,
                  border: '1px solid rgba(0,180,255,0.08)',
                  marginBottom: 12,
                }}>
                  <div style={{ flex: 1, textAlign: 'center' }}>
                    <div style={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      border: `1.5px solid ${sourceNode ? GROUP_COLORS[sourceNode.group] : '#aaa'}`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      margin: '0 auto 4px',
                      fontSize: 8,
                      color: sourceNode ? GROUP_COLORS[sourceNode.group] : '#aaa',
                      background: 'rgba(4,8,20,0.8)',
                    }}>
                      {sourceNode?.section}
                    </div>
                    <div style={{ fontSize: 9, color: sourceNode ? GROUP_COLORS[sourceNode.group] : 'rgba(150,185,220,0.55)' }}>
                      {sourceNode?.label ?? selectedEdgeData.source}
                    </div>
                  </div>
                  <div style={{
                    color,
                    fontSize: 14,
                    flexShrink: 0,
                    ...(isMissing ? { opacity: 0.6 } : {}),
                  }}>
                    {isMissing ? '- ->' : '->'}
                  </div>
                  <div style={{ flex: 1, textAlign: 'center' }}>
                    <div style={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      border: `1.5px solid ${targetNode ? GROUP_COLORS[targetNode.group] : '#aaa'}`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      margin: '0 auto 4px',
                      fontSize: 8,
                      color: targetNode ? GROUP_COLORS[targetNode.group] : '#aaa',
                      background: 'rgba(4,8,20,0.8)',
                    }}>
                      {targetNode?.section}
                    </div>
                    <div style={{ fontSize: 9, color: targetNode ? GROUP_COLORS[targetNode.group] : 'rgba(150,185,220,0.55)' }}>
                      {targetNode?.label ?? selectedEdgeData.target}
                    </div>
                  </div>
                </div>

                {/* Data flow description */}
                <div style={{
                  fontSize: 9,
                  letterSpacing: 1.5,
                  color: 'rgba(0,180,255,0.3)',
                  marginBottom: 6,
                }}>
                  {isMissing ? 'MISSING SCIENCE' : 'DATA FLOW'}
                </div>
                <div style={{
                  fontSize: 11,
                  lineHeight: 1.6,
                  color: isMissing ? 'rgba(255,170,170,0.8)' : 'rgba(200,220,240,0.75)',
                  padding: '8px 10px',
                  background: isMissing ? 'rgba(255,107,107,0.04)' : 'rgba(0,180,255,0.03)',
                  border: `1px solid ${isMissing ? 'rgba(255,107,107,0.1)' : 'rgba(0,180,255,0.06)'}`,
                  borderRadius: 3,
                  marginBottom: 12,
                }}>
                  {selectedEdgeData.data}
                </div>

                {/* Navigate to source/target nodes */}
                <div style={{
                  fontSize: 9,
                  letterSpacing: 1.5,
                  color: 'rgba(0,180,255,0.3)',
                  marginBottom: 6,
                }}>
                  VIEW NODE
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={() => { setSelectedNode(selectedEdgeData.source); setSelectedEdge(null) }}
                    style={{
                      flex: 1,
                      background: 'rgba(0,180,255,0.06)',
                      border: `1px solid ${sourceNode ? GROUP_COLORS[sourceNode.group] + '44' : 'rgba(0,180,255,0.15)'}`,
                      borderRadius: 3,
                      color: sourceNode ? GROUP_COLORS[sourceNode.group] : 'rgba(150,185,220,0.55)',
                      fontSize: 9,
                      padding: '5px 8px',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      letterSpacing: 0.5,
                    }}
                  >
                    {sourceNode?.label ?? selectedEdgeData.source}
                  </button>
                  <button
                    onClick={() => { setSelectedNode(selectedEdgeData.target); setSelectedEdge(null) }}
                    style={{
                      flex: 1,
                      background: 'rgba(0,180,255,0.06)',
                      border: `1px solid ${targetNode ? GROUP_COLORS[targetNode.group] + '44' : 'rgba(0,180,255,0.15)'}`,
                      borderRadius: 3,
                      color: targetNode ? GROUP_COLORS[targetNode.group] : 'rgba(150,185,220,0.55)',
                      fontSize: 9,
                      padding: '5px 8px',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      letterSpacing: 0.5,
                    }}
                  >
                    {targetNode?.label ?? selectedEdgeData.target}
                  </button>
                </div>
              </div>
            )
          })()}
        </div>
      )}
    </div>
  )
}

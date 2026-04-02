// ── ConnectionMap ────────────────────────────────────────────────────────────
// Interactive force-directed graph of all cross-system connections.
// No external deps — force simulation implemented from scratch.

import React, { useState, useEffect, useRef, useCallback } from 'react'

// ── Types ────────────────────────────────────────────────────────────────────

type NodeGroup = 'core' | 'world' | 'crafting' | 'player'
type EdgeSeverity = 'critical' | 'moderate' | 'internal'

interface GraphNode {
  id: string
  label: string
  section: string
  group: NodeGroup
  x: number
  y: number
  vx: number
  vy: number
  pinned: boolean
}

interface GraphEdge {
  id: number
  source: string
  target: string
  label: string
  data: string
  severity: EdgeSeverity
}

// ── Color constants ──────────────────────────────────────────────────────────

const GROUP_COLORS: Record<NodeGroup, string> = {
  core: '#00d4ff',
  world: '#00ff88',
  crafting: '#ff6b35',
  player: '#ffd700',
}

const GROUP_LABELS: Record<NodeGroup, string> = {
  core: 'Core Engine',
  world: 'World Systems',
  crafting: 'Crafting',
  player: 'Player',
}

const SEVERITY_COLORS: Record<EdgeSeverity, string> = {
  critical: '#ff6b6b',
  moderate: '#ffd166',
  internal: 'rgba(0,180,255,0.2)',
}

const SEVERITY_LABELS: Record<EdgeSeverity, string> = {
  critical: 'Critical',
  moderate: 'Moderate',
  internal: 'Internal (Fluid)',
}

// ── Node definitions ─────────────────────────────────────────────────────────

interface NodeDef {
  id: string
  label: string
  section: string
  group: NodeGroup
}

const NODE_DEFS: NodeDef[] = [
  // Core Engine
  { id: 'physics-tick', label: 'Unified Physics Tick', section: '3.0', group: 'core' },
  { id: 'material-system', label: 'Material System', section: '3.1', group: 'core' },
  { id: 'reaction-engine', label: 'Reaction Engine', section: '3.1', group: 'core' },
  { id: 'fluid-sim', label: 'Fluid Simulation', section: '3.2', group: 'core' },
  { id: 'sph-crafting', label: 'SPH Crafting', section: '3.2', group: 'core' },
  { id: 'mpm-environment', label: 'MPM Environment', section: '3.2', group: 'core' },
  { id: 'particle-redis', label: 'Particle Redistribution', section: '3.2', group: 'core' },
  { id: 'optical-pipeline', label: 'Optical Properties', section: '3.2', group: 'core' },
  { id: 'secondary-particles', label: 'Secondary Particles', section: '3.2', group: 'core' },
  { id: 'phase-transitions', label: 'Phase Transitions', section: '3.2', group: 'core' },
  { id: 'scale-transitions', label: 'Scale Transitions', section: '3.2', group: 'core' },
  { id: 'network-streaming', label: 'Network Streaming', section: '3.2', group: 'core' },
  { id: 'tier-rendering', label: 'Three-Tier Rendering', section: '3.2', group: 'core' },
  { id: 'sound-engine', label: 'Sound Engine', section: '3.3', group: 'core' },
  { id: 'structural', label: 'Structural Physics', section: '3.4', group: 'core' },
  { id: 'networking', label: 'Networking', section: '3.5', group: 'core' },
  { id: 'temp-propagation', label: 'Temperature', section: '3.0', group: 'core' },
  { id: 'shelter-map', label: 'Shelter Detection', section: '3.0', group: 'core' },

  // World Systems
  { id: 'weather', label: 'Weather System', section: '4.6', group: 'world' },
  { id: 'farming', label: 'Farming System', section: '4.4', group: 'world' },
  { id: 'animals', label: 'Animal System', section: '4.3', group: 'world' },
  { id: 'geology', label: 'Geology & Biomes', section: '4.1', group: 'world' },
  { id: 'organisms', label: 'Organism Ecosystem', section: '4.2', group: 'world' },
  { id: 'settlement', label: 'Settlement Economy', section: '5.2', group: 'world' },
  { id: 'npc-brain', label: 'NPC Brain / SLM', section: '5.3', group: 'world' },

  // Crafting
  { id: 'crafting', label: 'Crafting System', section: '6.4', group: 'crafting' },
  { id: 'precision-craft', label: 'Precision Craft', section: '6.4', group: 'crafting' },
  { id: 'sdf-collision', label: 'SDF Collision', section: '3.2', group: 'crafting' },

  // Player
  { id: 'player-health', label: 'Player Health', section: '7.2', group: 'player' },
  { id: 'player-inventory', label: 'Player Inventory', section: '7.3', group: 'player' },
  { id: 'player-combat', label: 'Combat System', section: '7.5', group: 'player' },
  { id: 'player-movement', label: 'Player Movement', section: '7.5', group: 'player' },
  { id: 'world-persistence', label: 'World Persistence', section: '7.12', group: 'player' },
]

// ── Edge definitions ─────────────────────────────────────────────────────────

interface EdgeDef {
  id: number
  source: string
  target: string
  label: string
  data: string
  severity: EdgeSeverity
}

const EDGE_DEFS: EdgeDef[] = [
  // Critical (1-15)
  { id: 1, source: 'physics-tick', target: 'sound-engine', label: 'Sound Event Generation', data: 'Physical events (collision, fracture, fluid splash) emit SoundEvent descriptors with material type, energy, and contact geometry', severity: 'critical' },
  { id: 2, source: 'weather', target: 'shelter-map', label: 'Weather Shelter Detection', data: 'precipitationType + windVector + temperature feed into shelter voxel map which calculates exposure factor per grid cell', severity: 'critical' },
  { id: 201, source: 'shelter-map', target: 'player-health', label: 'Shelter -> Health', data: 'Exposure factor modulates hypothermia rate, wetness accumulation, and wind-chill damage on the player health model', severity: 'critical' },
  { id: 202, source: 'shelter-map', target: 'sound-engine', label: 'Shelter -> Sound', data: 'Shelter enclosure value drives acoustic occlusion, reverb wet/dry mix, and rain-on-roof ambience layers', severity: 'critical' },
  { id: 3, source: 'animals', target: 'material-system', label: 'Death -> MaterialPacket', data: 'Animal death decomposes the creature into MaterialPackets (hide, bone, sinew, fat) with quality grades based on health at death', severity: 'critical' },
  { id: 301, source: 'animals', target: 'player-inventory', label: 'Animal -> Inventory', data: 'Butchering action converts MaterialPackets into inventory items; yield depends on tool sharpness and player skill', severity: 'critical' },
  { id: 4, source: 'animals', target: 'farming', label: 'Animal Manure', data: 'Grazing animals produce manure at rate proportional to feed quality; manure decomposes into soil nitrogen/phosphorus over time', severity: 'critical' },
  { id: 5, source: 'npc-brain', target: 'reaction-engine', label: 'NPC Crafting API', data: 'NPC SLM selects recipe + inputs, submits CraftRequest to reaction engine which validates stoichiometry and returns products', severity: 'critical' },
  { id: 501, source: 'crafting', target: 'reaction-engine', label: 'Player Crafting API', data: 'Player crafting UI submits identical CraftRequest; reaction engine is the shared backend for both NPC and player crafting', severity: 'critical' },
  { id: 6, source: 'npc-brain', target: 'structural', label: 'NPC Building', data: 'NPC building planner emits PlaceBlock commands with material + orientation; structural system validates load-bearing and snapping', severity: 'critical' },
  { id: 601, source: 'npc-brain', target: 'world-persistence', label: 'NPC -> Persistence', data: 'NPC-placed structures are serialized to world persistence with NPC ownership tags for settlement tracking', severity: 'critical' },
  { id: 7, source: 'temp-propagation', target: 'structural', label: 'Fire Spread', data: 'Temperature field above ignition threshold triggers combustion state on structural blocks; burn rate depends on material flammability', severity: 'critical' },
  { id: 8, source: 'weather', target: 'fluid-sim', label: 'Rain -> Water', data: 'precipitationRate per cell spawns SPH water particles at terrain surface; intensity maps to particle emission rate', severity: 'critical' },
  { id: 801, source: 'weather', target: 'farming', label: 'Rain -> Soil', data: 'precipitationRate feeds soil moisture model; excess triggers runoff erosion; drought flags reduce crop growth multiplier', severity: 'critical' },
  { id: 9, source: 'fluid-sim', target: 'weather', label: 'Evaporation -> Humidity', data: 'Water surface area and temperature drive Penman-Monteith evaporation; vapor mass feeds humidity field which seeds cloud formation and rain', severity: 'critical' },
  { id: 10, source: 'precision-craft', target: 'crafting', label: 'Precision -> Functional Props', data: 'Precision minigame score maps to functional property bonuses (sharpness, durability, thermal conductivity) on the crafted item', severity: 'critical' },
  { id: 11, source: 'precision-craft', target: 'player-combat', label: 'Sharpness', data: 'Blade sharpness value from precision crafting modifies base damage, armor penetration, and bleed chance in combat calculations', severity: 'critical' },
  { id: 12, source: 'player-combat', target: 'player-inventory', label: 'Combat -> Durability', data: 'Each strike reduces weapon/armor durability based on material hardness differential; breakage destroys the item slot', severity: 'critical' },
  { id: 13, source: 'player-combat', target: 'player-health', label: 'Combat -> Bleed Rate', data: 'Wound depth and weapon type determine bleed rate (mL/s); blood loss drives stamina drain, vision blur, and eventual unconsciousness', severity: 'critical' },
  { id: 14, source: 'settlement', target: 'npc-brain', label: 'Barter Exchange Rate', data: 'Settlement economy calculates supply/demand price ratios; NPC brain uses these as utility weights when deciding trade offers', severity: 'critical' },
  { id: 15, source: 'npc-brain', target: 'player-inventory', label: 'Player-NPC Trade', data: 'Trade negotiation resolves item transfer between NPC inventory and player inventory with settlement price as reference', severity: 'critical' },
  { id: 1501, source: 'npc-brain', target: 'settlement', label: 'NPC -> Settlement', data: 'NPC economic actions (buying, selling, building) feed back into settlement supply/demand model and population metrics', severity: 'critical' },

  // Moderate (16-31)
  { id: 16, source: 'weather', target: 'structural', label: 'Wind Force', data: 'Wind velocity field applies lateral force to tall/exposed structures; exceeding structural integrity triggers collapse', severity: 'moderate' },
  { id: 17, source: 'weather', target: 'npc-brain', label: 'Weather -> NPC Brain', data: 'Weather state (storm, cold, heat) modifies NPC behavior urgency: seek shelter, delay travel, prioritize firewood gathering', severity: 'moderate' },
  { id: 18, source: 'weather', target: 'structural', label: 'Lightning', data: 'Lightning strike selects tallest conductive point in cell; delivers thermal pulse that can ignite wood and damage stone', severity: 'moderate' },
  { id: 1801, source: 'weather', target: 'player-health', label: 'Lightning -> Health', data: 'Direct lightning strike applies massive electrical damage; nearby strikes cause stun and temporary hearing loss', severity: 'moderate' },
  { id: 19, source: 'weather', target: 'player-movement', label: 'Snow -> Speed', data: 'Snow depth reduces player movement speed logarithmically; ice surface zeroes friction coefficient causing sliding', severity: 'moderate' },
  { id: 20, source: 'farming', target: 'organisms', label: 'Pest System', data: 'Crop monoculture above threshold attracts pest organisms; organism population dynamics model handles pest reproduction and spread', severity: 'moderate' },
  { id: 21, source: 'weather', target: 'farming', label: 'Soil Erosion', data: 'Heavy rain on bare/sloped soil removes topsoil layer; erosion rate depends on slope angle, soil type, and vegetation cover', severity: 'moderate' },
  { id: 22, source: 'player-inventory', target: 'player-health', label: 'Clothing Warmth', data: 'Equipped clothing thermal resistance value offsets environmental cold exposure; wet clothing loses 60% insulation', severity: 'moderate' },
  { id: 23, source: 'player-inventory', target: 'player-movement', label: 'Swimming Buoyancy', data: 'Total equipped weight modifies buoyancy and swim speed; heavy armor causes sinking; leather/cloth items become waterlogged', severity: 'moderate' },
  { id: 24, source: 'sound-engine', target: 'player-health', label: 'Sleep Wake', data: 'Ambient noise level above threshold interrupts player sleep state; sleep quality affects next-day stamina recovery rate', severity: 'moderate' },
  { id: 25, source: 'fluid-sim', target: 'networking', label: 'Video Mode Check', data: 'Fluid particle count triggers LOD decision: below threshold sends full particle state, above sends velocity field summary', severity: 'moderate' },
  { id: 26, source: 'networking', target: 'tier-rendering', label: 'ENVIRONMENT_STATE', data: 'Network layer delivers authoritative ENVIRONMENT_STATE snapshots to rendering tier for client-side interpolation', severity: 'moderate' },
  { id: 27, source: 'geology', target: 'fluid-sim', label: 'Volcanic Eruption', data: 'Volcanic event injects high-temperature fluid particles (lava) with extreme viscosity; cools to basalt material over time', severity: 'moderate' },
  { id: 2701, source: 'geology', target: 'settlement', label: 'Geology -> Settlement', data: 'Geological resource deposits (ore veins, clay beds, fertile valleys) drive NPC settlement location preferences and trade goods', severity: 'moderate' },
  { id: 28, source: 'geology', target: 'organisms', label: 'Biome -> Spawning', data: 'Biome type (temperature, rainfall, altitude, soil) determines organism spawn tables and population carrying capacity', severity: 'moderate' },
  { id: 29, source: 'crafting', target: 'player-health', label: 'Cooking -> Calories', data: 'Cooked food items carry calorie, protein, vitamin values; eating updates player nutrition model affecting health regen', severity: 'moderate' },
  { id: 30, source: 'npc-brain', target: 'npc-brain', label: 'NPC Fitness', data: 'NPC evaluates own skill tree, health, inventory, and social standing to compute fitness score guiding long-term goal selection', severity: 'moderate' },
  { id: 31, source: 'world-persistence', target: 'npc-brain', label: 'Structural Decay', data: 'Structural integrity decay notifications prompt NPC repair/rebuild decisions; abandoned structures eventually collapse', severity: 'moderate' },

  // Internal (fluid system)
  { id: 100, source: 'fluid-sim', target: 'sph-crafting', label: 'Fluid -> SPH', data: 'Fluid simulation dispatches crafting-context particles to SPH solver for high-fidelity small-scale interactions', severity: 'internal' },
  { id: 101, source: 'fluid-sim', target: 'mpm-environment', label: 'Fluid -> MPM', data: 'Environment-scale fluid (rivers, rain pools) routed to MPM solver for terrain-coupled large-scale flow', severity: 'internal' },
  { id: 102, source: 'sph-crafting', target: 'tier-rendering', label: 'SPH -> Render', data: 'SPH particle positions and material IDs sent to rendering tier for real-time fluid surface reconstruction', severity: 'internal' },
  { id: 103, source: 'mpm-environment', target: 'tier-rendering', label: 'MPM -> Render', data: 'MPM grid velocities and density field sent to rendering for environment water/mud/lava visualization', severity: 'internal' },
  { id: 104, source: 'particle-redis', target: 'sph-crafting', label: 'Redis -> SPH', data: 'Particle redistribution balances SPH workload across spatial partitions based on particle density', severity: 'internal' },
  { id: 105, source: 'particle-redis', target: 'mpm-environment', label: 'Redis -> MPM', data: 'Particle redistribution balances MPM grid chunks across compute nodes for even load distribution', severity: 'internal' },
  { id: 106, source: 'material-system', target: 'optical-pipeline', label: 'Material -> Optical', data: 'Material properties (refractive index, absorption spectrum, scattering coefficient) feed optical property calculations', severity: 'internal' },
  { id: 107, source: 'optical-pipeline', target: 'tier-rendering', label: 'Optical -> Render', data: 'Per-material optical parameters (BRDF, subsurface profile, emission) sent to rendering for physically-based shading', severity: 'internal' },
  { id: 108, source: 'fluid-sim', target: 'secondary-particles', label: 'Fluid -> Secondary', data: 'High-energy fluid events (splashes, spray) spawn secondary particles for visual effects (foam, mist, droplets)', severity: 'internal' },
  { id: 109, source: 'phase-transitions', target: 'fluid-sim', label: 'Phase -> Fluid', data: 'Phase transition events (melting, freezing, boiling) change particle solver assignment and material properties', severity: 'internal' },
  { id: 110, source: 'scale-transitions', target: 'fluid-sim', label: 'Scale -> Fluid', data: 'Scale transition system promotes/demotes particles between SPH and MPM solvers based on interaction context', severity: 'internal' },
  { id: 111, source: 'sph-crafting', target: 'sdf-collision', label: 'SPH -> SDF', data: 'SPH particles query signed distance field for tool/container collision boundaries during crafting', severity: 'internal' },
  { id: 112, source: 'fluid-sim', target: 'network-streaming', label: 'Fluid -> Network', data: 'Fluid state snapshots compressed and queued for network streaming to connected clients', severity: 'internal' },
  { id: 113, source: 'network-streaming', target: 'tier-rendering', label: 'Stream -> Render', data: 'Received fluid state deltas applied to client-side rendering buffers for interpolated display', severity: 'internal' },
  { id: 114, source: 'material-system', target: 'phase-transitions', label: 'Material -> Phase', data: 'Material melting/boiling points and latent heat values drive phase transition threshold calculations', severity: 'internal' },
  { id: 115, source: 'reaction-engine', target: 'secondary-particles', label: 'Reaction -> Secondary', data: 'Chemical reactions (combustion, acid dissolution) emit secondary particles (smoke, sparks, gas bubbles)', severity: 'internal' },
]

// ── Force simulation ─────────────────────────────────────────────────────────

const REPULSION_K = 4000
const SPRING_K = 0.008
const SPRING_REST = 120
const CENTER_GRAVITY = 0.01
const DAMPING = 0.92
const MAX_ITERATIONS = 300
const DT = 1.0

function initNodes(width: number, height: number): GraphNode[] {
  const cx = width / 2
  const cy = height / 2
  // Spread nodes by group in initial positions
  const groupAngle: Record<NodeGroup, number> = {
    core: 0,
    world: Math.PI * 0.5,
    crafting: Math.PI,
    player: Math.PI * 1.5,
  }
  const groupCounts: Record<NodeGroup, number> = { core: 0, world: 0, crafting: 0, player: 0 }
  const groupTotals: Record<NodeGroup, number> = { core: 0, world: 0, crafting: 0, player: 0 }
  for (const nd of NODE_DEFS) groupTotals[nd.group]++

  return NODE_DEFS.map(nd => {
    const angle = groupAngle[nd.group] + (groupCounts[nd.group] / Math.max(1, groupTotals[nd.group])) * Math.PI * 0.4 - Math.PI * 0.2
    const radius = 150 + Math.random() * 100
    groupCounts[nd.group]++
    return {
      id: nd.id,
      label: nd.label,
      section: nd.section,
      group: nd.group,
      x: cx + Math.cos(angle) * radius + (Math.random() - 0.5) * 60,
      y: cy + Math.sin(angle) * radius + (Math.random() - 0.5) * 60,
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

  // Reset forces
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

  // Index map for quick lookup
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
    // Keep in bounds with padding
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
  const [selectedEdge, setSelectedEdge] = useState<number | null>(null)
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
    // Zoom toward cursor
    const newX = mx - (mx - transform.x) * (newScale / transform.scale)
    const newY = my - (my - transform.y) * (newScale / transform.scale)
    setTransform({ x: newX, y: newY, scale: newScale })
  }, [transform])

  // Pan / drag handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    // Check if we're clicking on a node (handled by node mousedown)
    // This handles background pan
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
      // Dragging a node
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
        // Re-run simulation a bit to let it settle
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
    // Only register click if we didn't drag
    if (!dragNodeRef.current.active) {
      setSelectedNode(prev => prev === nodeId ? null : nodeId)
      setSelectedEdge(null)
    }
  }, [])

  const handleEdgeClick = useCallback((e: React.MouseEvent, edgeId: number) => {
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
        {/* Legend */}
        <div style={{
          position: 'absolute',
          top: 10,
          left: 10,
          zIndex: 20,
          display: 'flex',
          gap: 6,
          flexWrap: 'wrap',
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
          <div style={{ width: '100%', display: 'flex', gap: 6, marginTop: 2 }}>
            {(Object.keys(SEVERITY_COLORS) as EdgeSeverity[]).map(sev => (
              <div key={sev} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 9,
                color: 'rgba(150,185,220,0.55)',
                letterSpacing: 1,
              }}>
                <span style={{
                  width: 16,
                  height: 2,
                  background: SEVERITY_COLORS[sev],
                  display: 'inline-block',
                  borderRadius: 1,
                  ...(sev === 'internal' ? {
                    backgroundImage: `repeating-linear-gradient(90deg, ${SEVERITY_COLORS[sev]} 0px, ${SEVERITY_COLORS[sev]} 4px, transparent 4px, transparent 7px)`,
                    background: 'none',
                  } : {}),
                }} />
                {SEVERITY_LABELS[sev]}
              </div>
            ))}
          </div>
        </div>

        {/* Iteration / status label */}
        <div style={{
          position: 'absolute',
          bottom: 6,
          left: 10,
          fontSize: 10,
          letterSpacing: 2,
          color: 'rgba(0,180,255,0.2)',
          zIndex: 20,
        }}>
          CONNECTION MAP {iterRef.current >= MAX_ITERATIONS ? '// SETTLED' : `// SIMULATING ${iterRef.current}/${MAX_ITERATIONS}`}
        </div>

        {/* Zoom indicator */}
        <div style={{
          position: 'absolute',
          bottom: 6,
          right: (selectedNodeData || selectedEdgeData) ? 330 : 10,
          fontSize: 9,
          letterSpacing: 1,
          color: 'rgba(0,180,255,0.2)',
          zIndex: 20,
          transition: 'right 0.2s',
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
            <marker id="arrow-critical" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill={SEVERITY_COLORS.critical} opacity="0.7" />
            </marker>
            <marker id="arrow-moderate" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill={SEVERITY_COLORS.moderate} opacity="0.7" />
            </marker>
            <marker id="arrow-internal" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
              <polygon points="0 0, 8 3, 0 6" fill="rgba(0,180,255,0.3)" opacity="0.7" />
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

              // Self-loop for npc-brain -> npc-brain
              if (edge.source === edge.target) {
                const loopR = 25
                return (
                  <g key={edge.id}>
                    <path
                      d={`M ${s.x} ${s.y - 14} C ${s.x - loopR} ${s.y - loopR - 20}, ${s.x + loopR} ${s.y - loopR - 20}, ${s.x} ${s.y - 14}`}
                      fill="none"
                      stroke={isHoverHighlighted ? 'rgba(255,255,255,0.9)' : SEVERITY_COLORS[edge.severity]}
                      strokeWidth={isHoverHighlighted ? 2.5 : 1}
                      strokeDasharray={edge.severity === 'internal' ? '4,3' : '0'}
                      opacity={isDimmed ? 0.03 : isHoverHighlighted ? 1 : 0.5}
                      style={{ transition: 'opacity 0.2s', cursor: 'pointer' }}
                      markerEnd={isHoverHighlighted ? 'url(#arrow-highlight)' : `url(#arrow-${edge.severity})`}
                      onClick={(e) => handleEdgeClick(e, edge.id)}
                    />
                  </g>
                )
              }

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
              const x2 = t.x - nx * (nodeRadius + 6) // extra space for arrow
              const y2 = t.y - ny * (nodeRadius + 6)

              return (
                <line
                  key={edge.id}
                  x1={x1} y1={y1}
                  x2={x2} y2={y2}
                  stroke={isHoverHighlighted ? 'rgba(255,255,255,0.9)' : SEVERITY_COLORS[edge.severity]}
                  strokeWidth={isHoverHighlighted ? 2.5 : edge.severity === 'internal' ? 0.6 : 1}
                  strokeDasharray={edge.severity === 'internal' ? '4,3' : '0'}
                  opacity={isDimmed ? 0.03 : isHoverHighlighted ? 1 : edge.severity === 'internal' ? 0.3 : 0.5}
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
                    {node.label.length > 18 ? node.label.slice(0, 16) + '..' : node.label}
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
              maxWidth: 280,
              boxShadow: `0 0 12px ${GROUP_COLORS[nd.group]}22`,
            }}>
              <div style={{ color: GROUP_COLORS[nd.group], fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
                {nd.label}
              </div>
              <div style={{ color: 'rgba(150,185,220,0.55)', fontSize: 9, marginBottom: 6 }}>
                Section {nd.section} / {GROUP_LABELS[nd.group]}
              </div>
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
                        {dir} {otherNode?.label ?? other}
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
          width: 320,
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
                  marginBottom: 12,
                }}>
                  Section {selectedNodeData.section} / {GROUP_LABELS[selectedNodeData.group]}
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
                    <div style={{ fontSize: 16, fontWeight: 600, color: '#ff6b6b' }}>{connections.filter(c => c.severity === 'critical').length}</div>
                    <div style={{ fontSize: 8, color: 'rgba(150,185,220,0.4)', letterSpacing: 1 }}>CRIT</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 600, color: '#ffd166' }}>{connections.filter(c => c.severity === 'moderate').length}</div>
                    <div style={{ fontSize: 8, color: 'rgba(150,185,220,0.4)', letterSpacing: 1 }}>MOD</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 600, color: 'rgba(0,180,255,0.4)' }}>{connections.filter(c => c.severity === 'internal').length}</div>
                    <div style={{ fontSize: 8, color: 'rgba(150,185,220,0.4)', letterSpacing: 1 }}>INT</div>
                  </div>
                </div>

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
                            background: 'rgba(0,180,255,0.03)',
                            borderLeft: `2px solid ${SEVERITY_COLORS[c.severity]}`,
                            borderRadius: '0 3px 3px 0',
                            cursor: 'pointer',
                            transition: 'background 0.15s',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,180,255,0.08)' }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(0,180,255,0.03)' }}
                        >
                          <div style={{ fontSize: 10, color: SEVERITY_COLORS[c.severity] }}>
                            {c.label}
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
                            background: 'rgba(0,180,255,0.03)',
                            borderLeft: `2px solid ${SEVERITY_COLORS[c.severity]}`,
                            borderRadius: '0 3px 3px 0',
                            cursor: 'pointer',
                            transition: 'background 0.15s',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,180,255,0.08)' }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(0,180,255,0.03)' }}
                        >
                          <div style={{ fontSize: 10, color: SEVERITY_COLORS[c.severity] }}>
                            {c.label}
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

            return (
              <div style={{ padding: '12px' }}>
                <div style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color,
                  marginBottom: 4,
                }}>
                  {selectedEdgeData.label}
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
                  <div style={{ color, fontSize: 14, flexShrink: 0 }}>
                    -&gt;
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
                  DATA FLOW
                </div>
                <div style={{
                  fontSize: 11,
                  lineHeight: 1.6,
                  color: 'rgba(200,220,240,0.75)',
                  padding: '8px 10px',
                  background: 'rgba(0,180,255,0.03)',
                  border: '1px solid rgba(0,180,255,0.06)',
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

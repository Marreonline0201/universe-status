// ── ConnectionMap ────────────────────────────────────────────────────────────
// 3D interactive concept map — Chapter 3 Physics concepts rendered as a
// force-directed graph in Three.js with SPH-inspired physics.

import { useEffect, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

// ── Types ───────────────────────────────────────────────────────────────────

type ConceptGroup =
  | 'thermal' | 'fluid' | 'material' | 'structural'
  | 'force' | 'energy' | 'rotation' | 'chemical'
  | 'wave' | 'em'

interface Concept {
  id: string
  label: string
  group: ConceptGroup
  size: number
  desc: string
}

interface Relation {
  source: string
  target: string
  label: string
}

interface SimNode {
  id: string
  label: string
  group: ConceptGroup
  size: number
  desc: string
  pos: THREE.Vector3
  vel: THREE.Vector3
  pinned: boolean
  mesh: THREE.Mesh
  edges: number[]     // indices into RELATIONS
}

// ── Data ────────────────────────────────────────────────────────────────────

const CONCEPTS: Concept[] = [
  // Fundamental properties
  { id: 'temperature', label: 'Temperature', group: 'thermal', size: 3, desc: 'Heat level of any material. Drives phase transitions, reactions, viscosity, sound, structural decay.' },
  { id: 'pressure', label: 'Pressure', group: 'fluid', size: 2, desc: 'Force per area. Tait equation for liquids, ideal gas law for gases, hydrostatic on dams.' },
  { id: 'density', label: 'Density', group: 'material', size: 2, desc: 'Mass per volume. Affects buoyancy, terminal velocity, sound pitch, structural load.' },
  { id: 'viscosity', label: 'Viscosity', group: 'fluid', size: 2, desc: 'Thickness of liquid. Andrade for metals, Cross model for mud/clay. Temperature-dependent.' },
  { id: 'surface-tension', label: 'Surface Tension', group: 'fluid', size: 1.5, desc: 'Liquid pulling inward. Eotvos rule. Determines droplets, capillary rise, spray threshold.' },
  { id: 'elasticity', label: "Young's Modulus", group: 'material', size: 2, desc: 'Stiffness. How much force to stretch/compress. Determines sound pitch and beam deflection.' },
  { id: 'strength', label: 'Strength', group: 'structural', size: 2.5, desc: 'Tensile, compressive, shear. When stress exceeds strength -> failure. Fleischer solid solution.' },
  { id: 'hardness', label: 'Hardness', group: 'material', size: 1.5, desc: 'Resistance to scratching. Mohs scale. Determines tool quality, dig speed, wear rate.' },
  { id: 'conductivity', label: 'Thermal Conductivity', group: 'thermal', size: 1.5, desc: 'How fast heat flows. Fourier law. Clay insulates (low k), copper conducts (high k).' },
  { id: 'electrical', label: 'Electrical Conductivity', group: 'em', size: 1.5, desc: 'How well current flows. Ohm law. Copper=good wire, wood=insulator.' },

  // Forces and motion
  { id: 'gravity', label: 'Gravity', group: 'force', size: 2, desc: 'Pulls everything down. F=mg. Drives fluid flow, structural loads, projectile arcs, falling.' },
  { id: 'drag', label: 'Drag', group: 'force', size: 1.5, desc: 'Air/water pushes back on moving objects. F=0.5pv2CdA. Arrows slow, feathers float.' },
  { id: 'friction', label: 'Friction', group: 'force', size: 1.5, desc: 'Surfaces resist sliding. mu coefficient. Bearings, wheels, stacked blocks, braking.' },
  { id: 'tension', label: 'Tension', group: 'force', size: 1.5, desc: 'Pulling force along ropes/wires. Verlet chains. Pulleys multiply it.' },
  { id: 'torque', label: 'Torque', group: 'rotation', size: 2, desc: 'Rotational force. tau=r*F. Gears change ratio. Windmills, motors, crankshafts.' },
  { id: 'buoyancy', label: 'Buoyancy', group: 'fluid', size: 1, desc: 'Upward push from displaced fluid. Archimedes. Floats boats, lifts basements.' },

  // Energy
  { id: 'kinetic-energy', label: 'Kinetic Energy', group: 'energy', size: 2, desc: 'Energy of motion. KE=0.5mv2. Combat damage, impact force, terminal velocity.' },
  { id: 'thermal-energy', label: 'Heat Energy', group: 'thermal', size: 2.5, desc: 'Energy stored as temperature. Drives everything: melting, boiling, reactions, expansion.' },
  { id: 'elastic-energy', label: 'Elastic Energy', group: 'energy', size: 1, desc: 'Energy stored in bent/compressed material. E=0.5kx2. Bows, springs, catapults.' },
  { id: 'chemical-energy', label: 'Chemical Energy', group: 'energy', size: 2, desc: 'Energy in molecular bonds. Released by combustion, reactions. Gibbs free energy.' },
  { id: 'electrical-energy', label: 'Electrical Energy', group: 'em', size: 1.5, desc: 'Energy from moving charges. P=IV. Batteries, generators, motors, arc furnaces.' },

  // Phenomena
  { id: 'phase-transition', label: 'Phase Transition', group: 'thermal', size: 2, desc: 'Solid<->liquid<->gas. Melting, freezing, boiling. Latent heat. Martensite in steel.' },
  { id: 'reaction', label: 'Chemical Reaction', group: 'chemical', size: 2.5, desc: 'Substances transform. dG<0 = spontaneous. Smelting, combustion, fermentation.' },
  { id: 'sound-wave', label: 'Sound', group: 'wave', size: 2, desc: 'Vibration through matter. Modal synthesis. Doppler, absorption.' },
  { id: 'light', label: 'Light', group: 'wave', size: 1.5, desc: 'EM radiation. Snell refraction, lens focusing, solar concentration, blackbody glow.' },
  { id: 'magnetism', label: 'Magnetism', group: 'em', size: 1.5, desc: 'Magnetic fields from current/magnets. Solenoids, motors, generators, compass.' },
  { id: 'fracture', label: 'Fracture', group: 'structural', size: 1.5, desc: 'Material breaks. Griffith-Irwin K_IC. Cracks grow from fatigue. Glass shatters easily.' },
  { id: 'deformation', label: 'Deformation', group: 'structural', size: 1.5, desc: 'Material bends. Beam sag, arch thrust, work hardening, creep at high temp.' },
  { id: 'erosion', label: 'Erosion', group: 'fluid', size: 1, desc: 'Water/wind wear away material. Rain on soil, river on banks, freeze-thaw on stone.' },
  { id: 'diffusion', label: 'Diffusion', group: 'chemical', size: 1, desc: 'Substances spread from high to low concentration. Mixing liquids, gas dispersal.' },
  { id: 'evaporation', label: 'Evaporation', group: 'thermal', size: 1, desc: 'Liquid->gas at surface. Penman equation. Cools the surface. Drives weather cycle.' },
  { id: 'capillary', label: 'Capillary Action', group: 'fluid', size: 1, desc: 'Liquid climbs in narrow spaces. Jurin law. Oil lamps, rising damp, cloth wicking.' },
]

const RELATIONS: Relation[] = [
  // Temperature connects to many things
  { source: 'temperature', target: 'phase-transition', label: 'drives' },
  { source: 'temperature', target: 'viscosity', label: 'reduces' },
  { source: 'temperature', target: 'reaction', label: 'enables' },
  { source: 'temperature', target: 'conductivity', label: 'determines rate' },
  { source: 'temperature', target: 'sound-wave', label: 'affects speed' },
  { source: 'temperature', target: 'deformation', label: 'enables creep' },
  { source: 'temperature', target: 'evaporation', label: 'drives' },
  { source: 'temperature', target: 'light', label: 'blackbody emission' },
  { source: 'temperature', target: 'electrical', label: 'changes resistance' },

  // Pressure
  { source: 'pressure', target: 'phase-transition', label: 'affects melting point' },
  { source: 'pressure', target: 'density', label: 'compresses' },
  { source: 'pressure', target: 'buoyancy', label: 'creates' },
  { source: 'pressure', target: 'sound-wave', label: 'is sound' },

  // Density
  { source: 'density', target: 'buoyancy', label: 'determines' },
  { source: 'density', target: 'drag', label: 'medium density' },
  { source: 'density', target: 'sound-wave', label: 'affects pitch' },
  { source: 'density', target: 'gravity', label: 'weight = rho*V*g' },

  // Strength/hardness/elasticity
  { source: 'strength', target: 'fracture', label: 'threshold for' },
  { source: 'strength', target: 'deformation', label: 'resists' },
  { source: 'elasticity', target: 'sound-wave', label: 'determines pitch' },
  { source: 'elasticity', target: 'deformation', label: 'spring constant' },
  { source: 'elasticity', target: 'elastic-energy', label: 'stores' },
  { source: 'hardness', target: 'friction', label: 'affects' },
  { source: 'hardness', target: 'strength', label: 'correlates' },

  // Forces
  { source: 'gravity', target: 'kinetic-energy', label: 'accelerates -> KE' },
  { source: 'gravity', target: 'pressure', label: 'hydrostatic' },
  { source: 'gravity', target: 'tension', label: 'loads ropes' },
  { source: 'gravity', target: 'torque', label: 'pendulum/waterwheel' },
  { source: 'drag', target: 'kinetic-energy', label: 'removes' },
  { source: 'drag', target: 'torque', label: 'brakes rotation' },
  { source: 'friction', target: 'thermal-energy', label: 'generates heat' },
  { source: 'friction', target: 'kinetic-energy', label: 'removes' },
  { source: 'tension', target: 'torque', label: 'via pulleys' },

  // Energy transformations
  { source: 'chemical-energy', target: 'thermal-energy', label: 'combustion releases' },
  { source: 'thermal-energy', target: 'kinetic-energy', label: 'heat engine converts' },
  { source: 'kinetic-energy', target: 'electrical-energy', label: 'generator converts' },
  { source: 'electrical-energy', target: 'kinetic-energy', label: 'motor converts' },
  { source: 'electrical-energy', target: 'thermal-energy', label: 'Joule heating I2R' },
  { source: 'electrical-energy', target: 'chemical-energy', label: 'electrolysis' },
  { source: 'electrical-energy', target: 'light', label: 'incandescence' },
  { source: 'electrical-energy', target: 'magnetism', label: 'creates field' },
  { source: 'elastic-energy', target: 'kinetic-energy', label: 'bow releases' },

  // Phenomena connections
  { source: 'phase-transition', target: 'density', label: 'changes' },
  { source: 'phase-transition', target: 'viscosity', label: 'solid=inf, liquid=finite' },
  { source: 'reaction', target: 'thermal-energy', label: 'exo/endothermic' },
  { source: 'reaction', target: 'phase-transition', label: 'can trigger' },
  { source: 'reaction', target: 'diffusion', label: 'mixing needed' },
  { source: 'light', target: 'thermal-energy', label: 'solar concentration' },
  { source: 'magnetism', target: 'torque', label: 'motor torque' },
  { source: 'magnetism', target: 'electrical-energy', label: 'induction EMF' },
  { source: 'surface-tension', target: 'capillary', label: 'drives' },
  { source: 'surface-tension', target: 'drag', label: 'Weber breakup' },
  { source: 'evaporation', target: 'thermal-energy', label: 'absorbs (cooling)' },
  { source: 'erosion', target: 'fracture', label: 'weakens over time' },
  { source: 'viscosity', target: 'drag', label: 'fluid resistance' },
  { source: 'viscosity', target: 'diffusion', label: 'slows mixing' },
]

// ── Colors ──────────────────────────────────────────────────────────────────

const GROUP_COLORS: Record<ConceptGroup, string> = {
  thermal:    '#ff6b6b',
  fluid:      '#00d4ff',
  material:   '#f4a261',
  structural: '#ef476f',
  force:      '#a78bfa',
  energy:     '#ffd700',
  rotation:   '#06d6a0',
  chemical:   '#fb923c',
  wave:       '#2dd4bf',
  em:         '#818cf8',
}

const GROUP_LABELS: Record<ConceptGroup, string> = {
  thermal:    'Thermal',
  fluid:      'Fluid',
  material:   'Material',
  structural: 'Structural',
  force:      'Force',
  energy:     'Energy',
  rotation:   'Rotation',
  chemical:   'Chemical',
  wave:       'Wave',
  em:         'Electromagnetic',
}

// ── Physics constants ───────────────────────────────────────────────────────

const REPULSION_K = 500
const SPRING_K = 0.05
const REST_LENGTH = 8
const CENTER_K = 0.01
const DRAG_K = 0.1
const DT = 0.3

// ── Component ───────────────────────────────────────────────────────────────

export function ConnectionMap() {
  const containerRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const stateRef = useRef<{
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    renderer: any
    controls: OrbitControls
    nodes: SimNode[]
    edgeLines: THREE.Line[]
    raycaster: THREE.Raycaster
    mouse: THREE.Vector2
    hoveredNode: SimNode | null
    selectedNode: SimNode | null
    draggedNode: SimNode | null
    playing: boolean
    animId: number
    labelEls: Map<string, HTMLDivElement>
  } | null>(null)

  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [playing, setPlaying] = useState(true)

  // Build edge lookup per node
  const edgeLookup = useRef(new Map<string, number[]>())
  useEffect(() => {
    const m = new Map<string, number[]>()
    RELATIONS.forEach((r, i) => {
      if (!m.has(r.source)) m.set(r.source, [])
      if (!m.has(r.target)) m.set(r.target, [])
      m.get(r.source)!.push(i)
      m.get(r.target)!.push(i)
    })
    edgeLookup.current = m
  }, [])

  // ── Init Three.js ──────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current
    const overlay = overlayRef.current
    if (!container || !overlay) return

    const w = container.clientWidth
    const h = container.clientHeight

    // Scene
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#060810')

    // Camera
    const camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 500)
    camera.position.set(0, 0, 50)

    // Renderer
    const renderer = new (THREE as any).WebGPURenderer({ antialias: true })
    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    container.appendChild(renderer.domElement)

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.rotateSpeed = 0.6
    controls.zoomSpeed = 0.8
    controls.minDistance = 15
    controls.maxDistance = 120

    // Ambient light + point light
    scene.add(new THREE.AmbientLight(0xffffff, 0.4))
    const pointLight = new THREE.PointLight(0xffffff, 1.2, 200)
    pointLight.position.set(20, 30, 40)
    scene.add(pointLight)

    // Create nodes
    const nodes: SimNode[] = CONCEPTS.map((c) => {
      const radius = c.size * 0.6
      const geo = new THREE.SphereGeometry(radius, 24, 24)
      const color = new THREE.Color(GROUP_COLORS[c.group])
      const mat = new THREE.MeshStandardMaterial({
        color,
        emissive: color.clone().multiplyScalar(0.25),
        roughness: 0.4,
        metalness: 0.3,
      })
      const mesh = new THREE.Mesh(geo, mat)

      // Random initial position in a sphere
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      const r = 10 + Math.random() * 15
      const x = r * Math.sin(phi) * Math.cos(theta)
      const y = r * Math.sin(phi) * Math.sin(theta)
      const z = r * Math.cos(phi)

      mesh.position.set(x, y, z)
      scene.add(mesh)

      // Store concept id on mesh for raycasting
      mesh.userData = { conceptId: c.id }

      return {
        id: c.id,
        label: c.label,
        group: c.group,
        size: c.size,
        desc: c.desc,
        pos: new THREE.Vector3(x, y, z),
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * 2,
          (Math.random() - 0.5) * 2,
          (Math.random() - 0.5) * 2,
        ),
        pinned: false,
        mesh,
        edges: edgeLookup.current.get(c.id) || [],
      }
    })

    // Node index by id
    const nodeById = new Map<string, number>()
    nodes.forEach((n, i) => nodeById.set(n.id, i))

    // Create edge lines
    const edgeLines: THREE.Line[] = RELATIONS.map((r) => {
      const geo = new THREE.BufferGeometry()
      const si = nodeById.get(r.source)!
      const ti = nodeById.get(r.target)!
      const positions = new Float32Array(6)
      positions[0] = nodes[si].pos.x; positions[1] = nodes[si].pos.y; positions[2] = nodes[si].pos.z
      positions[3] = nodes[ti].pos.x; positions[4] = nodes[ti].pos.y; positions[5] = nodes[ti].pos.z
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))

      const mat = new THREE.LineBasicMaterial({
        color: 0x334466,
        transparent: true,
        opacity: 0.25,
      })
      const line = new THREE.Line(geo, mat)
      scene.add(line)
      return line
    })

    // HTML labels — create one per node
    const labelEls = new Map<string, HTMLDivElement>()
    nodes.forEach((n) => {
      const el = document.createElement('div')
      el.textContent = n.label
      el.style.cssText = `
        position: absolute;
        pointer-events: none;
        color: #aabbcc;
        font-size: 10px;
        font-family: 'JetBrains Mono', 'SF Mono', monospace;
        letter-spacing: 0.5px;
        text-shadow: 0 0 4px rgba(0,0,0,0.9);
        white-space: nowrap;
        transform: translate(-50%, -100%);
        padding-bottom: 4px;
        opacity: 0;
        transition: opacity 0.15s;
      `
      overlay.appendChild(el)
      labelEls.set(n.id, el)
    })

    const raycaster = new THREE.Raycaster()
    raycaster.params.Points = { threshold: 1 }
    const mouse = new THREE.Vector2()

    stateRef.current = {
      scene, camera, renderer, controls, nodes, edgeLines,
      raycaster, mouse, hoveredNode: null, selectedNode: null,
      draggedNode: null, playing: true, animId: 0, labelEls,
    }

    // ── Force simulation step ────────────────────────────────────────────
    const _force = new THREE.Vector3()
    const _dir = new THREE.Vector3()

    function simulate() {
      const st = stateRef.current!
      if (!st.playing) return

      const N = st.nodes.length
      for (let i = 0; i < N; i++) {
        const ni = st.nodes[i]
        if (ni.pinned) continue

        _force.set(0, 0, 0)

        // 1. Repulsion from all other nodes
        for (let j = 0; j < N; j++) {
          if (i === j) continue
          const nj = st.nodes[j]
          _dir.subVectors(ni.pos, nj.pos)
          const dist = Math.max(1, _dir.length())
          _dir.normalize()
          const f = REPULSION_K / (dist * dist)
          _force.addScaledVector(_dir, f)
        }

        // 2. Spring attraction on edges
        for (const ei of ni.edges) {
          const rel = RELATIONS[ei]
          const otherId = rel.source === ni.id ? rel.target : rel.source
          const oi = nodeById.get(otherId)!
          const other = st.nodes[oi]
          _dir.subVectors(other.pos, ni.pos)
          const dist = _dir.length()
          _dir.normalize()
          const f = SPRING_K * (dist - REST_LENGTH)
          _force.addScaledVector(_dir, f)
        }

        // 3. Center gravity
        _force.addScaledVector(ni.pos, -CENTER_K)

        // 4. Drag
        _force.addScaledVector(ni.vel, -DRAG_K)

        // 5. Integrate
        ni.vel.addScaledVector(_force, DT)
        ni.pos.addScaledVector(ni.vel, DT)
      }
    }

    // ── Update visuals ───────────────────────────────────────────────────
    function updateVisuals() {
      const st = stateRef.current!

      // Sync mesh positions
      for (const n of st.nodes) {
        n.mesh.position.copy(n.pos)
      }

      // Update edge line positions
      for (let i = 0; i < RELATIONS.length; i++) {
        const r = RELATIONS[i]
        const si = nodeById.get(r.source)!
        const ti = nodeById.get(r.target)!
        const geo = st.edgeLines[i].geometry
        const pos = geo.getAttribute('position') as THREE.BufferAttribute
        pos.setXYZ(0, st.nodes[si].pos.x, st.nodes[si].pos.y, st.nodes[si].pos.z)
        pos.setXYZ(1, st.nodes[ti].pos.x, st.nodes[ti].pos.y, st.nodes[ti].pos.z)
        pos.needsUpdate = true
      }

      // Update HTML label positions
      for (const n of st.nodes) {
        const el = st.labelEls.get(n.id)
        if (!el) continue

        // Project node position to screen
        const v = n.pos.clone().project(st.camera)
        const hw = st.renderer.domElement.clientWidth / 2
        const hh = st.renderer.domElement.clientHeight / 2
        const sx = v.x * hw + hw
        const sy = -v.y * hh + hh

        el.style.left = sx + 'px'
        el.style.top = sy + 'px'

        // Show label if hovered or selected, or always for large nodes
        const isHovered = st.hoveredNode?.id === n.id
        const isSelected = st.selectedNode?.id === n.id
        const isConnectedToHovered = st.hoveredNode && n.edges.some(ei => {
          const r = RELATIONS[ei]
          return r.source === st.hoveredNode!.id || r.target === st.hoveredNode!.id
        })
        const isConnectedToSelected = st.selectedNode && n.edges.some(ei => {
          const r = RELATIONS[ei]
          return r.source === st.selectedNode!.id || r.target === st.selectedNode!.id
        })

        // Behind camera check
        const behindCamera = v.z > 1

        if (behindCamera) {
          el.style.opacity = '0'
        } else if (isHovered || isSelected) {
          el.style.opacity = '1'
          el.style.fontSize = '13px'
          el.style.color = '#ffffff'
        } else if (isConnectedToHovered || isConnectedToSelected) {
          el.style.opacity = '0.9'
          el.style.fontSize = '11px'
          el.style.color = GROUP_COLORS[n.group]
        } else if (n.size >= 2) {
          el.style.opacity = '0.5'
          el.style.fontSize = '10px'
          el.style.color = '#aabbcc'
        } else {
          el.style.opacity = '0'
        }
      }

      // Highlight edges connected to hovered/selected node
      for (let i = 0; i < RELATIONS.length; i++) {
        const r = RELATIONS[i]
        const line = st.edgeLines[i]
        const mat = line.material as THREE.LineBasicMaterial
        const isActiveEdge =
          (st.hoveredNode && (r.source === st.hoveredNode.id || r.target === st.hoveredNode.id)) ||
          (st.selectedNode && (r.source === st.selectedNode.id || r.target === st.selectedNode.id))

        if (isActiveEdge) {
          mat.color.set(0x66aadd)
          mat.opacity = 0.7
        } else {
          mat.color.set(0x334466)
          mat.opacity = 0.25
        }
      }

      // Node glow on hover/selection
      for (const n of st.nodes) {
        const mat = n.mesh.material as THREE.MeshStandardMaterial
        const baseColor = new THREE.Color(GROUP_COLORS[n.group])
        const isHovered = st.hoveredNode?.id === n.id
        const isSelected = st.selectedNode?.id === n.id
        const isConnected =
          (st.hoveredNode && n.edges.some(ei => {
            const r = RELATIONS[ei]
            return r.source === st.hoveredNode!.id || r.target === st.hoveredNode!.id
          })) ||
          (st.selectedNode && n.edges.some(ei => {
            const r = RELATIONS[ei]
            return r.source === st.selectedNode!.id || r.target === st.selectedNode!.id
          }))

        if (isHovered || isSelected) {
          mat.emissive.copy(baseColor).multiplyScalar(0.7)
          n.mesh.scale.setScalar(1.3)
        } else if (isConnected) {
          mat.emissive.copy(baseColor).multiplyScalar(0.4)
          n.mesh.scale.setScalar(1.1)
        } else if (st.hoveredNode || st.selectedNode) {
          mat.emissive.copy(baseColor).multiplyScalar(0.05)
          n.mesh.scale.setScalar(1.0)
        } else {
          mat.emissive.copy(baseColor).multiplyScalar(0.25)
          n.mesh.scale.setScalar(1.0)
        }
      }
    }

    // ── Render loop ──────────────────────────────────────────────────────
    function animate() {
      const st = stateRef.current!
      st.animId = requestAnimationFrame(animate)
      simulate()
      updateVisuals()
      st.controls.update()
      st.renderer.render(st.scene, st.camera)
    }
    // Init WebGPU renderer, then start animation
    renderer.init().then(() => animate())

    // ── Mouse events ─────────────────────────────────────────────────────
    const canvas = renderer.domElement

    function getIntersected(event: MouseEvent): SimNode | null {
      const st = stateRef.current!
      const rect = canvas.getBoundingClientRect()
      st.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      st.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      st.raycaster.setFromCamera(st.mouse, st.camera)

      const meshes = st.nodes.map(n => n.mesh)
      const hits = st.raycaster.intersectObjects(meshes)
      if (hits.length > 0) {
        const id = hits[0].object.userData.conceptId as string
        return st.nodes.find(n => n.id === id) || null
      }
      return null
    }

    let isDragging = false
    let dragPlane = new THREE.Plane()
    let dragOffset = new THREE.Vector3()

    function onMouseMove(event: MouseEvent) {
      const st = stateRef.current!
      if (!st) return

      if (isDragging && st.draggedNode) {
        // Project mouse onto drag plane
        const rect = canvas.getBoundingClientRect()
        st.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
        st.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
        st.raycaster.setFromCamera(st.mouse, st.camera)

        const intersection = new THREE.Vector3()
        st.raycaster.ray.intersectPlane(dragPlane, intersection)
        if (intersection) {
          st.draggedNode.pos.copy(intersection.sub(dragOffset))
          st.draggedNode.vel.set(0, 0, 0)
        }
        return
      }

      const node = getIntersected(event)
      st.hoveredNode = node
      setHoveredId(node?.id || null)
      canvas.style.cursor = node ? 'pointer' : 'grab'
    }

    function onMouseDown(event: MouseEvent) {
      const st = stateRef.current!
      if (!st) return
      if (event.button !== 0) return // left-click only

      const node = getIntersected(event)
      if (node) {
        // Start dragging
        isDragging = true
        st.draggedNode = node
        node.pinned = true
        st.controls.enabled = false

        // Create a plane facing the camera through the node position
        const camDir = new THREE.Vector3()
        st.camera.getWorldDirection(camDir)
        dragPlane.setFromNormalAndCoplanarPoint(camDir.negate(), node.pos)

        // Compute offset
        const rect = canvas.getBoundingClientRect()
        st.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
        st.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
        st.raycaster.setFromCamera(st.mouse, st.camera)
        const intersection = new THREE.Vector3()
        st.raycaster.ray.intersectPlane(dragPlane, intersection)
        dragOffset.subVectors(intersection, node.pos)
      }
    }

    function onMouseUp(_event: MouseEvent) {
      const st = stateRef.current!
      if (!st) return

      if (isDragging && st.draggedNode) {
        st.draggedNode.pinned = false
        st.draggedNode = null
        isDragging = false
        st.controls.enabled = true
        return
      }
    }

    function onClick(event: MouseEvent) {
      const st = stateRef.current!
      if (!st) return
      // Don't trigger click if we were dragging
      if (isDragging) return

      const node = getIntersected(event)
      if (node) {
        st.selectedNode = node
        setSelectedId(node.id)
      } else {
        st.selectedNode = null
        setSelectedId(null)
      }
    }

    canvas.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('mousedown', onMouseDown)
    canvas.addEventListener('mouseup', onMouseUp)
    canvas.addEventListener('click', onClick)

    // ── Resize ───────────────────────────────────────────────────────────
    function onResize() {
      const st = stateRef.current!
      if (!st || !container) return
      const w = container.clientWidth
      const h = container.clientHeight
      st.camera.aspect = w / h
      st.camera.updateProjectionMatrix()
      st.renderer.setSize(w, h)
    }

    const ro = new ResizeObserver(onResize)
    ro.observe(container)

    // ── Cleanup ──────────────────────────────────────────────────────────
    return () => {
      const st = stateRef.current
      if (st) {
        cancelAnimationFrame(st.animId)
        st.controls.dispose()
        st.renderer.dispose()
        st.scene.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.geometry.dispose()
            if (Array.isArray(obj.material)) {
              obj.material.forEach(m => m.dispose())
            } else {
              obj.material.dispose()
            }
          }
          if (obj instanceof THREE.Line) {
            obj.geometry.dispose()
            ;(obj.material as THREE.Material).dispose()
          }
        })
        // Remove labels
        st.labelEls.forEach(el => el.remove())
      }
      canvas.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('mousedown', onMouseDown)
      canvas.removeEventListener('mouseup', onMouseUp)
      canvas.removeEventListener('click', onClick)
      ro.disconnect()
      if (container.contains(canvas)) {
        container.removeChild(canvas)
      }
      stateRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Play/pause sync ────────────────────────────────────────────────────
  useEffect(() => {
    if (stateRef.current) {
      stateRef.current.playing = playing
    }
  }, [playing])

  // ── Shake ──────────────────────────────────────────────────────────────
  const shake = useCallback(() => {
    const st = stateRef.current
    if (!st) return
    for (const n of st.nodes) {
      n.vel.set(
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8,
      )
    }
    if (!st.playing) {
      setPlaying(true)
    }
  }, [])

  // ── Get selected concept info ──────────────────────────────────────────
  const selectedConcept = selectedId ? CONCEPTS.find(c => c.id === selectedId) : null
  const selectedRelations = selectedId
    ? RELATIONS.filter(r => r.source === selectedId || r.target === selectedId)
    : []
  const hoveredConcept = hoveredId && !selectedId ? CONCEPTS.find(c => c.id === hoveredId) : null

  return (
    <div style={{
      width: '100%',
      height: '100%',
      position: 'relative',
      overflow: 'hidden',
      background: '#060810',
    }}>
      {/* Three.js canvas container */}
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0 }}
      />

      {/* HTML label overlay */}
      <div
        ref={overlayRef}
        style={{
          position: 'absolute', top: 0, left: 0,
          width: '100%', height: '100%',
          pointerEvents: 'none',
          overflow: 'hidden',
        }}
      />

      {/* ── Top-left: Legend ──────────────────────────────────────────── */}
      <div style={{
        position: 'absolute', top: 10, left: 12,
        display: 'flex', flexDirection: 'column', gap: 3,
        pointerEvents: 'none',
      }}>
        {(Object.keys(GROUP_COLORS) as ConceptGroup[]).map(g => (
          <div key={g} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: GROUP_COLORS[g],
              boxShadow: `0 0 4px ${GROUP_COLORS[g]}44`,
            }} />
            <span style={{
              fontSize: 9, color: '#667788',
              fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
              letterSpacing: 0.5,
            }}>
              {GROUP_LABELS[g]}
            </span>
          </div>
        ))}
      </div>

      {/* ── Top-center: Title ────────────────────────────────────────── */}
      <div style={{
        position: 'absolute', top: 10,
        left: '50%', transform: 'translateX(-50%)',
        textAlign: 'center', pointerEvents: 'none',
      }}>
        <div style={{
          fontSize: 12, fontWeight: 700,
          color: '#88aacc',
          fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
          letterSpacing: 2,
        }}>
          CONCEPT MAP
        </div>
        <div style={{
          fontSize: 9, color: '#445566',
          fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
          letterSpacing: 1,
          marginTop: 2,
        }}>
          Chapter 3 Physics
        </div>
      </div>

      {/* ── Top-right: Stats ─────────────────────────────────────────── */}
      <div style={{
        position: 'absolute', top: 10, right: 12,
        textAlign: 'right', pointerEvents: 'none',
      }}>
        <div style={{
          fontSize: 10, color: '#556677',
          fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
          letterSpacing: 0.5,
        }}>
          {CONCEPTS.length} concepts
        </div>
        <div style={{
          fontSize: 10, color: '#445566',
          fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
          letterSpacing: 0.5,
        }}>
          {RELATIONS.length} relations
        </div>
      </div>

      {/* ── Bottom-right: Controls ───────────────────────────────────── */}
      <div style={{
        position: 'absolute', bottom: 12, right: 12,
        display: 'flex', gap: 8,
      }}>
        <button
          onClick={() => setPlaying(p => !p)}
          style={{
            background: 'rgba(20,30,50,0.85)',
            border: '1px solid rgba(100,140,180,0.25)',
            borderRadius: 6,
            color: playing ? '#66ddaa' : '#ff8888',
            fontSize: 11,
            fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
            padding: '6px 14px',
            cursor: 'pointer',
            letterSpacing: 1,
            transition: 'all 0.2s',
          }}
          onMouseEnter={e => { (e.target as HTMLElement).style.borderColor = 'rgba(100,180,255,0.5)' }}
          onMouseLeave={e => { (e.target as HTMLElement).style.borderColor = 'rgba(100,140,180,0.25)' }}
        >
          {playing ? 'PAUSE' : 'PLAY'}
        </button>
        <button
          onClick={shake}
          style={{
            background: 'rgba(20,30,50,0.85)',
            border: '1px solid rgba(100,140,180,0.25)',
            borderRadius: 6,
            color: '#aabbdd',
            fontSize: 11,
            fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
            padding: '6px 14px',
            cursor: 'pointer',
            letterSpacing: 1,
            transition: 'all 0.2s',
          }}
          onMouseEnter={e => { (e.target as HTMLElement).style.borderColor = 'rgba(100,180,255,0.5)' }}
          onMouseLeave={e => { (e.target as HTMLElement).style.borderColor = 'rgba(100,140,180,0.25)' }}
        >
          SHAKE
        </button>
      </div>

      {/* ── Hover tooltip (bottom-left) ──────────────────────────────── */}
      {hoveredConcept && (
        <div style={{
          position: 'absolute', bottom: 12, left: 12,
          background: 'rgba(8,14,28,0.92)',
          border: '1px solid rgba(100,140,180,0.2)',
          borderRadius: 8,
          padding: '10px 14px',
          maxWidth: 300,
          pointerEvents: 'none',
        }}>
          <div style={{
            fontSize: 12, fontWeight: 700,
            color: GROUP_COLORS[hoveredConcept.group],
            fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
            marginBottom: 4,
          }}>
            {hoveredConcept.label}
          </div>
          <div style={{
            fontSize: 10, color: '#889aab',
            fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
            lineHeight: 1.5,
          }}>
            {hoveredConcept.desc}
          </div>
        </div>
      )}

      {/* ── Selected detail panel (right side) ───────────────────────── */}
      {selectedConcept && (
        <div style={{
          position: 'absolute', top: 40, right: 12, bottom: 50,
          width: 280,
          background: 'rgba(8,14,28,0.94)',
          border: '1px solid rgba(100,140,180,0.2)',
          borderRadius: 10,
          padding: '16px',
          overflowY: 'auto',
          overflowX: 'hidden',
        }}>
          {/* Close button */}
          <button
            onClick={() => {
              setSelectedId(null)
              if (stateRef.current) stateRef.current.selectedNode = null
            }}
            style={{
              position: 'absolute', top: 8, right: 10,
              background: 'none', border: 'none',
              color: '#667788', fontSize: 16,
              cursor: 'pointer', padding: '2px 6px',
              lineHeight: 1,
            }}
          >
            x
          </button>

          {/* Concept name + group */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            marginBottom: 6,
          }}>
            <div style={{
              width: 10, height: 10, borderRadius: '50%',
              background: GROUP_COLORS[selectedConcept.group],
              boxShadow: `0 0 6px ${GROUP_COLORS[selectedConcept.group]}66`,
            }} />
            <span style={{
              fontSize: 14, fontWeight: 700,
              color: GROUP_COLORS[selectedConcept.group],
              fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
            }}>
              {selectedConcept.label}
            </span>
          </div>
          <div style={{
            fontSize: 9, color: '#556677',
            fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
            letterSpacing: 1,
            marginBottom: 10,
            textTransform: 'uppercase',
          }}>
            {GROUP_LABELS[selectedConcept.group]}
          </div>

          {/* Description */}
          <div style={{
            fontSize: 11, color: '#99aabb',
            fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
            lineHeight: 1.6,
            marginBottom: 16,
          }}>
            {selectedConcept.desc}
          </div>

          {/* Connected concepts */}
          <div style={{
            fontSize: 10, fontWeight: 700,
            color: '#667788',
            fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
            letterSpacing: 1,
            marginBottom: 8,
          }}>
            CONNECTIONS ({selectedRelations.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {selectedRelations.map((r, i) => {
              const otherId = r.source === selectedId ? r.target : r.source
              const other = CONCEPTS.find(c => c.id === otherId)!
              const direction = r.source === selectedId ? '->' : '<-'
              return (
                <div
                  key={i}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '4px 8px',
                    background: 'rgba(30,40,60,0.5)',
                    borderRadius: 4,
                    cursor: 'pointer',
                  }}
                  onClick={() => {
                    setSelectedId(otherId)
                    if (stateRef.current) {
                      stateRef.current.selectedNode =
                        stateRef.current.nodes.find(n => n.id === otherId) || null
                    }
                  }}
                >
                  <div style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: GROUP_COLORS[other.group],
                    flexShrink: 0,
                  }} />
                  <span style={{
                    fontSize: 10, color: '#88aacc',
                    fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
                  }}>
                    {other.label}
                  </span>
                  <span style={{
                    fontSize: 8, color: '#556677',
                    fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
                    marginLeft: 'auto',
                    whiteSpace: 'nowrap',
                  }}>
                    {direction} {r.label}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

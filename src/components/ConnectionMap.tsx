// ── ConnectionMap ────────────────────────────────────────────────────────────
// Interactive force-directed graph of Chapter 3 internal physics connections.
// No external deps — force simulation implemented from scratch.

import React, { useState, useEffect, useRef, useCallback } from 'react'

// ── Types ────────────────────────────────────────────────────────────────────

type NodeGroup = 'material' | 'fluid' | 'sound' | 'structural' | 'network' | 'tick' | 'optimization' | 'advanced'
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
  optimization: '#ff9b3c',
  advanced: '#ff6b9d',
}

const GROUP_LABELS: Record<NodeGroup, string> = {
  material: 'Material System 3.1',
  fluid: 'Fluid Simulation 3.2',
  sound: 'Sound Engine 3.3',
  structural: 'Structural Physics 3.4',
  network: 'Networking 3.5',
  tick: 'Physics Tick Stages',
  optimization: 'Optimization 3.7',
  advanced: 'Advanced Systems 3.8-3.13',
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
  physics?: string
}

const NODE_DEFS: NodeDef[] = [
  // Tick stages
  { id: 'temp-propagation', label: 'Stage 1: Temperature', section: '3.0', group: 'tick', description: "Fourier's law heat transfer between adjacent packets", physics: "q = -k * A * dT/dx (Fourier's law)\nThermal conductivity k from composition\nExplicit Euler: T_new = T + dt * alpha * laplacian(T)\nalpha = k / (rho * Cp)" },
  { id: 'phase-transitions', label: 'Stage 2: Phase Transitions', section: '3.0', group: 'tick', description: 'Solid<>liquid<>gas based on melting/boiling points', physics: "Checks T vs T_melt and T_boil each tick\nLatent heat absorbed during transition\nphaseProgress 0->1 before state change" },
  { id: 'reaction-engine', label: 'Stage 3: Reactions', section: '3.1', group: 'tick', description: 'Gibbs free energy check, stoichiometry', physics: "dG = dH - T*dS < 0 for spontaneous\nArrhenius rate: k = A * exp(-Ea/RT)\nStoichiometric ratio check before proceeding" },
  { id: 'fluid-stage', label: 'Stage 4: Fluid Sim', section: '3.2', group: 'tick', description: 'SPH/MPM particle forces', physics: "SPH: 5 forces at 60Hz for crafting\nMPM: P2G/G2P at 30Hz for environment\n4-8 substeps per frame" },
  { id: 'structural-stage', label: 'Stage 5: Structural', section: '3.4', group: 'tick', description: 'Load path check on modified structures', physics: "Only re-checks dirty regions\nBFS from ground -> top-down load spread\nCascade collapse in batched waves" },
  { id: 'rigid-body', label: 'Stage 6: Rigid Body', section: '3.0', group: 'tick', description: 'Gravity, collision for loose objects', physics: "Verlet integration for position\nGJK/EPA for narrow-phase collision\nRestitution from material elasticity" },
  { id: 'sound-stage', label: 'Stage 7: Sound Events', section: '3.3', group: 'tick', description: 'Convert physics events to SoundEvent descriptors', physics: "Collects impact, break, flow, bubble events\nPackages as SoundEvent descriptors\nEnergy threshold filters trivial events" },
  { id: 'broadcast', label: 'Stage 8: Broadcast', section: '3.5', group: 'tick', description: 'Package and send via WebSocket', physics: "Delta-compressed state updates\nSpatial LOD based on player distance\nPriority queue for bandwidth" },

  // Material System 3.1
  { id: 'property-calc', label: 'Property Calculator', section: '3.1', group: 'material', description: 'Composition -> 36+ derived properties, cached by compositionHash', physics: "36+ properties from composition (cached via CRC32 hash):\n\u2022 Melting point: CALPHAD binary phase diagrams\n\u2022 Viscosity: Andrade \u03bc=A\u00b7e^(Ea/RT)\n\u2022 Strength: Fleischer solid solution \u0394\u03c3=B\u00b7c^(1/2)\n\u2022 Fracture toughness: K_IC from bonding energy\n\u2022 Work hardening: Hollomon \u03c3=K\u00d7\u03b5^n\n\u2022 Latent heat: Clausius-Clapeyron\nCache: 95% hit rate, temp-bracket interpolation" },
  { id: 'reaction-rules', label: 'Reaction Engine', section: '3.1', group: 'material', description: 'delta-G < 0 check, activation energy, stoichiometry', physics: "dG = dH - T*dS (Gibbs free energy)\nArrhenius: k = A * exp(-Ea/(R*T))\nMass conservation via stoichiometric matrix\nExothermic reactions heat neighbors" },

  // Fluid System 3.2
  { id: 'sph-solver', label: 'SPH Solver (crafting)', section: '3.2', group: 'fluid', description: '5 forces, 100-5k particles, 60Hz', physics: "5 forces per particle per tick:\n\u2022 Pressure: Tait P=B\u00b7((\u03c1/\u03c1\u2080)^\u03b3-1)\n\u2022 Viscosity: F=\u03bc\u00b7\u2207\u00b2v (Newtonian) or Cross model (non-Newtonian)\n\u2022 Gravity: F=m\u00b7g\u00b7(-normalize(pos))\n\u2022 Surface tension: F=\u03c3\u00b7\u03ba\u00b7n\u0302\n\u2022 Terrain collision: push to surface + friction" },
  { id: 'mpm-solver', label: 'MPM Solver (environment)', section: '3.2', group: 'fluid', description: 'Particle<>grid transfer, 5k-200k particles, 30Hz', physics: "P2G scatter -> grid force solve -> G2P gather\n\u2022 ~2700 FLOPs per particle per substep\n\u2022 27 grid nodes per particle (quadratic B-spline)\n\u2022 Affine velocity matrix C tracks local deformation\n\u2022 4-8 substeps per frame at 30Hz" },
  { id: 'phase-system', label: 'Phase Transition System', section: '3.2', group: 'fluid', description: 'Spawns/merges particles at melting/boiling points', physics: "Melting: spawn N particles, N=mass/particleMass\nFreezing: merge cluster -> solid MaterialPacket\nLatent heat: phaseProgress 0->1, absorbs L (J/kg)\nStefan solidification front: dx/dt=k(T_m-T_b)/(\u03c1Lx)\nMartensite: coolingRate > critical -> hard/brittle" },
  { id: 'optical-pipeline', label: 'Optical Properties', section: '3.2', group: 'fluid', description: 'Beer-Lambert absorption, Fresnel, Planck emission', physics: "Beer-Lambert: I(\u03bb)=I\u2080\u00b7exp(-\u03b1(\u03bb)\u00b7d)\nArago-Biot: n_mix=\u03a3(x_i\u00b7n_i)\nFresnel: reflectance at interfaces\nPlanck blackbody: \u03bb_peak=2898/T(K)\n40 bytes per particle cached" },
  { id: 'secondary-particles', label: 'Secondary Particles', section: '3.2', group: 'fluid', description: 'Spray (Weber), foam (vorticity), bubbles (reactions)', physics: "Weber number We=\u03c1v\u00b2d/\u03c3 > 12 -> spray\nVorticity threshold -> foam generation\nMinnaert: f = 3.26/radius for bubble sound\nLifetime based on surface tension" },
  { id: 'particle-network', label: 'Particle Streaming', section: '3.2', group: 'fluid', description: 'Delta compression, spatial LOD, ~97 KB/s', physics: "Delta compression: only changed particles sent\nSpatial LOD: far particles at 1/4 rate\nQuantized positions: 12-bit per axis\n~97 KB/s total bandwidth" },
  { id: 'tier-rendering', label: 'Three-Tier Rendering', section: '3.2', group: 'fluid', description: 'Marching cubes / Screen-space / Raw points', physics: "Tier 1: Marching cubes (nearby, high quality)\nTier 2: Screen-space fluid rendering (mid)\nTier 3: Raw point sprites (distant)\nAuto-selects based on camera distance" },
  { id: 'redistribution', label: 'Redistribution', section: '3.2', group: 'fluid', description: 'Split/merge for even spacing', physics: "Split: particle too large -> 2 children\nMerge: overlapping particles -> 1 parent\nConserves mass, momentum, energy\nMaintains uniform particle spacing" },

  // Sound System 3.3
  { id: 'modal-synth', label: 'Modal Synthesis', section: '3.3', group: 'sound', description: 'f = beta^2/(2piL^2) * sqrt(EI/rhoA)', physics: "f_n = \u03b2_n\u00b2/(2\u03c0L\u00b2) \u00d7 \u221a(EI/\u03c1A)\n\u2022 Free-free: \u03b2\u2081=4.73 (dropped object)\n\u2022 Clamped-free: \u03b2\u2081=1.875 (wall-mounted)\n\u2022 Q = 1/(2\u00b7dampingLossTangent)\n\u2022 Doppler: f_obs = f_src \u00d7 (343+v_l)/(343+v_s)" },
  { id: 'noise-synth', label: 'Noise Synthesis', section: '3.3', group: 'sound', description: 'Rain, fire, wind, water flow, thunder', physics: "Procedural noise shaped by physics params:\nRain: drop size -> frequency, intensity -> density\nFire: crackle rate from combustion energy\nWind: Strouhal vortex shedding f=St*v/d\nThunder: distance -> delay and low-pass" },
  { id: 'voice-synth', label: 'Voice Synthesis', section: '3.3', group: 'sound', description: 'NPC speech, animal calls', physics: "Formant synthesis for vocal tract\nF1/F2 vowel space mapping\nGlottal pulse model for pitch" },

  // Structural System 3.4
  { id: 'load-path', label: 'Load Path Algorithm', section: '3.4', group: 'structural', description: 'BFS connectivity + top-down load accumulation', physics: "Phase 1: BFS connectivity from ground\nPhase 2: top-down load (1:4 spreading)\nPhase 3: \u03c3_c=F/A, \u03c3_t=3wL\u00b2/(4bh\u00b2), P_cr=\u03c0\u00b2EI/(KL)\u00b2\nPhase 4: cascade collapse in batched waves\nEarth pressure: \u03c3_h=K_a\u00b7\u03b3\u00b7z\nTriangulation: m=b+r-2j" },
  { id: 'beam-analysis', label: 'Beam Bending', section: '3.4', group: 'structural', description: 'sigma = 3wL^2/(4bh^2), tensile failure', physics: "\u03c3 = 3wL\u00b2/(4bh\u00b2) for simply supported\n\u03b4 = 5wL\u2074/(384EI) for deflection\nL/360 = acceptable, L/180 = visible sag\nFailure when \u03c3 > \u03c3_tensile" },
  { id: 'arch-analysis', label: 'Arch Thrust', section: '3.4', group: 'structural', description: 'T = wL^2/(8h), abutment checks', physics: "Thrust T = wL\u00b2/(8h)\nAbutment must resist horizontal thrust\nFunicular shape: y = 4h*x*(L-x)/L\u00b2\nVoussoir arch: hinge analysis" },
  { id: 'foundation', label: 'Foundation', section: '3.4', group: 'structural', description: 'Terzaghi bearing capacity, sinking rate', physics: "q_ult = cN_c + \u03b3DN_q + 0.5\u03b3BN_\u03b3\nSinking rate from consolidation\nSettlement: \u03b4 = qB(1-\u03bd\u00b2)/E\nRankine earth pressure for retaining walls" },
  { id: 'decay-system', label: 'Decay System', section: '3.4', group: 'structural', description: 'Rain, freeze-thaw, fire damage', physics: "Rain: absorption rate * exposure time\nFreeze-thaw: 9% expansion in cracks\nFire: strength reduction curve vs temperature\nGalvanic: corrosion rate from electrode potential" },

  // Networking 3.5
  { id: 'authority', label: 'Server Authority', section: '3.5', group: 'network', description: 'All physics server-computed', physics: "Server is single source of truth\nClient sends inputs, receives state\nAnti-cheat: server validates all actions" },
  { id: 'video-mode', label: 'Video Mode', section: '3.5', group: 'network', description: 'H.264 stream for precision craft', physics: "H.264 encode at server, decode at client\nTriggered when >200 particles within 10m\nLow latency: ~50ms encode+transmit" },
  { id: 'state-mode', label: 'State Mode', section: '3.5', group: 'network', description: 'Client renders from position data', physics: "Position + velocity + material sent per entity\nClient-side interpolation between ticks\nExtrapolation for network jitter" },

  // Optimization 3.7
  { id: 'tick-scheduler', label: 'Tick Scheduler', section: '3.7', group: 'optimization', description: 'Multi-rate pipeline: 60/30/1 Hz per stage', physics: "60 Hz: SPH crafting, rigid body, sound, broadcast\n30 Hz: temperature, MPM, structural\n1-10 Hz: phase transitions, reactions, grid water\nParallelizable: SPH || rigid body, temp || sound" },
  { id: 'degradation', label: 'Degradation Controller', section: '3.7', group: 'optimization', description: '5-level graceful degradation under load', physics: "Level 1: reduce particle cap (200k→50k)\nLevel 2: reduce tick rates (60→30, 30→15)\nLevel 3: skip distant structural checks\nLevel 4: pause distant reactions\nLevel 5: emergency — freeze background sim\nTrigger: tick_time/budget > threshold" },
  { id: 'profiler', label: 'Profiler & Monitor', section: '3.7', group: 'optimization', description: 'Per-stage timing, memory tracking, alerts', physics: "Reports per-stage microseconds every tick\nMemory tracking: ~200 MB target, alert at 1.5 GB\nSends monitoring data to status site at 1 Hz\nTriggers degradation when stage exceeds 2× budget" },

  // §3.8 Rotational Mechanics
  { id: 'rotational-mechanics', label: 'Rotational Mechanics', section: '3.8', group: 'advanced', description: 'Wheels, gears, axles, crankshafts, flywheels, mechanical joints', physics: "Hinge joint: \u03c4_net = \u03a3\u03c4_ext - \u03c4_friction\n\u03b1 = \u03c4_net / I (angular accel)\nGear mesh: \u03c91\u00d7r1 = \u03c92\u00d7r2\nFlywheel: E = 0.5\u00d7I\u00d7\u03c9\u00b2\nBearing friction: \u03c4_f = \u03bc\u00d7F_n\u00d7r_bearing" },

  // §3.9 Projectile Aerodynamics
  { id: 'drag-system', label: 'Drag & Aerodynamics', section: '3.9', group: 'advanced', description: 'Air resistance, terminal velocity, spin stabilization', physics: "F_drag = 0.5\u00d7\u03c1\u00d7v\u00b2\u00d7Cd\u00d7A\nTerminal velocity: v_t = \u221a(2mg/(\u03c1CdA))\nMagnus: F = S\u00d7(\u03c9\u00d7v)\nSpin stability: Sg = I\u03c9\u00b2/(\u03c1vAdC_M\u03b1)" },

  // §3.10 Rope Physics
  { id: 'rope-system', label: 'Rope & Cable Physics', section: '3.10', group: 'advanced', description: 'Verlet chains, pulleys, bows, catenary curves', physics: "Verlet: x_new = 2x - x_prev + a\u00d7dt\u00b2\nPulley MA = N segments\nBow: E = 0.5\u00d7k\u00d7x\u00b2\nCatenary: y = a\u00d7cosh(x/a)" },

  // §3.11 Heat Engines
  { id: 'heat-engine', label: 'Heat Engines', section: '3.11', group: 'advanced', description: 'Steam, combustion, refrigeration, thermodynamic cycles', physics: "Ideal gas: PV = nRT\nWork: W = \u222bP dV\nCarnot: \u03b7 = 1 - T_cold/T_hot\nOtto: \u03b7 = 1 - 1/r^(\u03b3-1)\nCOP = T_cold/(T_hot - T_cold)" },

  // §3.12 Optics
  { id: 'optics-system', label: 'Optics', section: '3.12', group: 'advanced', description: 'Lenses, mirrors, telescopes, solar concentration', physics: "Snell: n\u2081sin\u03b8\u2081 = n\u2082sin\u03b8\u2082\nLens: 1/f = (n-1)(1/R\u2081 - 1/R\u2082)\nMirror: 1/f = 2/R\nMagnification: M = f_obj/f_eye" },

  // §3.13 Electromagnetism
  { id: 'em-system', label: 'Electromagnetism', section: '3.13', group: 'advanced', description: 'Circuits, batteries, motors, generators, electrolysis', physics: "Ohm: V = IR\nFaraday: EMF = -N\u00d7d\u03a6/dt\nLorentz: F = qv\u00d7B\nSolenoid: B = \u03bc\u2080\u03bc\u1d63NI/L\nElectrolysis: m = MIt/(nF)" },
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
  { id: 'A1', source: 'property-calc', target: 'sph-solver', label: 'Viscosity, density, surface tension', data: 'Andrade viscosity \u03bc=A\u00b7e^(Ea/RT), E\u00f6tv\u00f6s surface tension, Vegard density. Each particle reads these from its MaterialPacket composition every sim tick.', severity: 'exists' },
  { id: 'A2', source: 'property-calc', target: 'mpm-solver', label: 'Same properties for MPM', data: 'Same material-dependent properties transferred to MPM grid via P2G scatter. Grid forces computed from averaged properties.', severity: 'exists' },
  { id: 'A3', source: 'property-calc', target: 'phase-system', label: 'Melting/boiling points', data: 'Property calculator computes T_melt and T_boil from CALPHAD binary phase diagrams. Phase system checks temperature each tick.', severity: 'exists' },
  { id: 'A4', source: 'property-calc', target: 'optical-pipeline', label: 'Composition -> optical properties', data: 'Beer-Lambert: I(\u03bb)=I\u2080\u00b7exp(-\u03b1(\u03bb)\u00b7d). Arago-Biot: n_mix=\u03a3(x_i\u00b7n_i). Planck blackbody: \u03bb_peak=2898/T(K). 40 bytes per particle cached.', severity: 'exists' },
  { id: 'A5', source: 'property-calc', target: 'phase-system', label: 'Latent heat', data: 'L_fusion and L_vaporization computed from Clausius-Clapeyron. Phase transitions track phaseProgress 0\u21921, absorbing/releasing energy without temperature change.', severity: 'exists' },
  { id: 'A6', source: 'property-calc', target: 'sph-solver', label: 'Non-Newtonian viscosity', data: 'Cross model: \u03bc=\u03bc_\u221e+(\u03bc\u2080-\u03bc_\u221e)/(1+(K\u00b7\u03b3\u0307)\u207f). Clay \u03bc\u2080=100 Pa\u00b7s (stiff) \u2192 \u03bc_\u221e=0.1 Pa\u00b7s (flows when worked). Shear rate \u03b3\u0307 from SPH velocity Laplacian.', severity: 'exists' },

  // Connection B: 3.1 -> 3.3 (properties feed sound)
  { id: 'B1', source: 'property-calc', target: 'modal-synth', label: "Young's modulus, density", data: 'f_n = \u03b2_n\u00b2/(2\u03c0L\u00b2) \u00d7 \u221a(EI/\u03c1A). Young\u2019s modulus E and density \u03c1 read from MaterialPacket. Higher E = higher pitch, higher \u03c1 = lower pitch.', severity: 'exists' },
  { id: 'B2', source: 'property-calc', target: 'modal-synth', label: 'Boundary conditions + damping', data: 'Q = 1/(2\u00d7dampingLossTangent). Metal tan(\u03b4)\u22480.001 \u2192 Q=500 (rings long). Wood tan(\u03b4)\u22480.03 \u2192 Q=17 (dies fast). Boundary conditions change \u03b2_n values.', severity: 'exists' },

  // Connection C: 3.1 -> 3.4 (properties feed structural)
  { id: 'C1', source: 'property-calc', target: 'load-path', label: 'Compressive/tensile/shear strength', data: '\u03c3_c=F/A compressive, \u03c3_t=3wL\u00b2/(4bh\u00b2) tensile bending, \u03c4=VQ/(Ib) shear. Each block checked against material-specific strength from PropertyCalculator.', severity: 'exists' },
  { id: 'C2', source: 'property-calc', target: 'beam-analysis', label: 'Tensile strength, E, density', data: '\u03c3_bend = M*y/I where M from load, I from geometry. E determines deflection \u03b4=5wL\u2074/(384EI). Density \u03c1 contributes self-weight load w=\u03c1*A*g.', severity: 'exists' },
  { id: 'C3', source: 'property-calc', target: 'decay-system', label: 'Water absorption, flammability', data: 'Absorption coefficient \u03b1_w determines rain damage rate. Flash point and heat of combustion set fire propagation. Freeze-thaw susceptibility from porosity.', severity: 'exists' },
  { id: 'C4', source: 'property-calc', target: 'load-path', label: 'Fatigue (Basquin)', data: '\u03c3_a = \u03c3\'_f \u00b7 (2N_f)^b. Cyclic loading below yield still causes failure after N cycles. S-N curve from material group.', severity: 'exists' },
  { id: 'C5', source: 'property-calc', target: 'load-path', label: 'Fracture toughness', data: 'K_I = \u03c3\u221a(\u03c0a). Failure when K_I \u2265 K_IC (Griffith-Irwin). Cracked blocks weaker than intact. Crack propagation direction from max tensile stress.', severity: 'exists' },
  { id: 'C6', source: 'property-calc', target: 'load-path', label: 'Buckling (Euler)', data: 'P_cr = \u03c0\u00b2EI/(KL)\u00b2. Tall slender columns fail at P_cr << \u03c3_c*A. K=0.5 (fixed-fixed) to K=2.0 (cantilever). Eccentricity amplifies buckling.', severity: 'exists' },

  // Connection E: 3.2 -> 3.1 (solidification back to materials)
  { id: 'E1', source: 'phase-system', target: 'property-calc', label: 'Frozen particles -> solid MaterialPacket', data: 'Frozen particles merge: mass = \u03a3m_i, composition = mass-weighted average, position = center of mass, shape = convex hull.', severity: 'exists' },
  { id: 'E2', source: 'phase-system', target: 'property-calc', label: 'Microstructure (martensite)', data: 'Cooling rate > critical \u2192 martensite (HV 600, brittle). Slow cool \u2192 pearlite (HV 200, tough). Tempering at 200-600\u00b0C adjusts hardness/toughness trade-off.', severity: 'exists' },

  // Connection F: 3.2 -> 3.3 (fluid events -> sound)
  { id: 'F1', source: 'sph-solver', target: 'noise-synth', label: 'Splash events (v > 0.5 m/s)', data: 'Impact energy E=0.5*m*v\u00b2 + liquid material type \u2192 noise descriptor. Weber number We=\u03c1v\u00b2d/\u03c3 determines splash vs. smooth entry.', severity: 'exists' },
  { id: 'F2', source: 'sph-solver', target: 'noise-synth', label: 'Pour/flow sounds', data: 'Flow speed + channel geometry \u2192 turbulence spectrum. Reynolds Re=\u03c1vd/\u03bc determines laminar (quiet) vs turbulent (noisy) transition.', severity: 'exists' },
  { id: 'F3', source: 'secondary-particles', target: 'noise-synth', label: 'Bubble sounds', data: 'Minnaert frequency: f = 3.26/radius (Hz for radius in meters). Each bubble oscillation \u2192 short tonal ping. Cluster of bubbles \u2192 broadband fizz.', severity: 'exists' },

  // Connection G: 3.2 -> 3.4 (MISSING: fluid loads on structures)
  { id: 'G1', source: 'sph-solver', target: 'load-path', label: 'Hydrostatic pressure', data: 'P = \u03c1*g*h on dams/walls. 5m water = 49 kPa lateral. Triangular pressure distribution. Resultant at h/3 from base.', severity: 'exists' },
  { id: 'G2', source: 'mpm-solver', target: 'load-path', label: 'Hydrodynamic force', data: 'F = 0.5*\u03c1*v\u00b2*C_d*A on bridge piers. C_d\u22481.2 for bluff bodies. Vortex shedding at St\u22480.2 causes oscillating lateral force.', severity: 'exists' },
  { id: 'G3', source: 'mpm-solver', target: 'foundation', label: 'Buoyancy uplift', data: 'F_buoyancy = \u03c1_water*g*V_submerged. Submerged foundations lose effective weight. Reduces bearing capacity. Can float empty basements.', severity: 'exists' },

  // Connection H: 3.2 -> 3.5 (particles to network)
  { id: 'H1', source: 'particle-network', target: 'broadcast', label: 'PARTICLE_UPDATE messages', data: 'Delta-compressed positions (12-bit quantized), spatial LOD (far = 1/4 rate). ~97 KB/s total. Priority queue by player proximity.', severity: 'exists' },
  { id: 'H2', source: 'sph-solver', target: 'video-mode', label: 'Active particle count trigger', data: '>200 particles within 10m of player \u2192 switch to H.264 video mode. Server renders fluid, streams frames. ~50ms latency.', severity: 'exists' },

  // Connection I: 3.3 -> 3.5 (sound to network)
  { id: 'I1', source: 'sound-stage', target: 'broadcast', label: 'SOUND_EVENT messages', data: 'SoundEvent descriptors (type, energy, position, material) sent to client. Client synthesizes audio locally. ~200 bytes per event.', severity: 'exists' },
  { id: 'I2', source: 'modal-synth', target: 'broadcast', label: 'Doppler effect', data: 'f_obs = f_src \u00d7 (343+v_listener)/(343+v_source). Applied per-mode. Moving train: approach +semitone, recede -semitone at 30 m/s.', severity: 'exists' },
  { id: 'I3', source: 'noise-synth', target: 'broadcast', label: 'Freq-dependent absorption', data: 'Atmospheric absorption: \u03b1(f) \u221d f\u00b2. At 100m: 1kHz loses 0.5dB, 10kHz loses 10dB. Distant sounds become muffled/bassy.', severity: 'exists' },

  // Connection J: 3.4 -> 3.3 (structural events -> sound)
  { id: 'J1', source: 'load-path', target: 'modal-synth', label: 'Block breaking -> crack/crash sound', data: 'storedEnergy (J) \u2192 modal descriptor. E_elastic = \u03c3\u00b2V/(2E). Higher stored energy = louder crack. Material determines spectral shape.', severity: 'exists' },
  { id: 'J2', source: 'load-path', target: 'noise-synth', label: 'Cascade collapse -> staggered impacts', data: 'Each wave of cascade collapse \u2192 separate impact event. Staggered over 0.1-2s depending on structure size. Creates rolling rumble effect.', severity: 'exists' },

  // Connection K: 3.4 -> 3.2 (collapse displaces fluid)
  { id: 'K1', source: 'load-path', target: 'mpm-solver', label: 'Progressive collapse -> flood', data: 'Structural failure releases contained water. Failed blocks become boundary conditions for MPM. Dam break: v_front \u2248 2\u221a(g*h).', severity: 'exists' },
  { id: 'K2', source: 'load-path', target: 'sph-solver', label: 'Debris into water -> splash', data: 'Collapsing blocks enter SPH domain as moving boundaries. Displaced volume V \u2192 splash energy E \u221d \u03c1*g*V*h_drop. Secondary wave generation.', severity: 'exists' },

  // Connection L: Temperature -> 3.4 (thermal structural damage)
  { id: 'L1', source: 'temp-propagation', target: 'decay-system', label: 'Fire weakens materials', data: 'Steel: 50% strength at 550\u00b0C, collapse at 700\u00b0C. Wood: ignition at 300\u00b0C, charring rate 0.6mm/min. Stone: spalling at 500\u00b0C from steam pressure.', severity: 'exists' },
  { id: 'L2', source: 'temp-propagation', target: 'decay-system', label: 'Freeze-thaw cycles', data: 'Water in cracks expands 9% on freezing. Pressure up to 200 MPa in confined pores. Each cycle widens cracks. Damage \u221d n_cycles \u00d7 saturation.', severity: 'exists' },
  { id: 'L3', source: 'temp-propagation', target: 'load-path', label: 'Thermal stress', data: '\u03c3_thermal = E\u00b7\u03b1\u00b7\u0394T. Granite \u03b1=8\u00d710\u207b\u2076/K, \u0394T=500K \u2192 \u03c3=200 MPa (near tensile limit). Constrained expansion cracks walls and pavements.', severity: 'exists' },

  // Connection M: 3.4 -> rigid body
  { id: 'M1', source: 'load-path', target: 'rigid-body', label: 'Failed blocks -> debris', data: 'Failed blocks spawn as compound rigid bodies. Initial velocity from stored elastic energy. Tumble from asymmetric force distribution.', severity: 'exists' },

  // Connection N: Reactions -> 3.2 (gas -> bubbles)
  { id: 'N1', source: 'reaction-rules', target: 'secondary-particles', label: 'Gas products in liquid -> bubbles', data: 'CO\u2082, H\u2082, SO\u2082 from reactions in liquid \u2192 bubble nucleation. Bubble radius from ideal gas law: r=(3nRT/(4\u03c0P))^(1/3). Rise velocity from Stokes drag.', severity: 'exists' },

  // Connection O: 3.2 optical -> 3.5
  { id: 'O1', source: 'optical-pipeline', target: 'tier-rendering', label: 'Per-particle shading data', data: 'absorptionRGB (Beer-Lambert), refractiveIndex (Arago-Biot), emission (Planck). 40 bytes/particle. Updated when composition changes.', severity: 'exists' },
  { id: 'O2', source: 'tier-rendering', target: 'state-mode', label: 'Rendered fluid surfaces', data: 'Marching cubes mesh or screen-space fluid rendering (SSFR). Depth + thickness + normal buffers sent to client compositing pass.', severity: 'exists' },

  // Pipeline connections (tick stages)
  { id: 'P1', source: 'temp-propagation', target: 'phase-transitions', label: 'Updated temperatures', data: 'Fourier heat diffusion may push packets past T_melt or T_boil thresholds. Dirty-flagged packets checked by phase system.', severity: 'exists' },
  { id: 'P2', source: 'phase-transitions', target: 'reaction-engine', label: 'New compositions from phase changes', data: 'Phase change alters reaction accessibility. Molten metals expose new surfaces. Evaporation concentrates dissolved solutes.', severity: 'exists' },
  { id: 'P3', source: 'reaction-engine', target: 'fluid-stage', label: 'Transformed packets + spawned particles', data: 'New compositions from reactions feed SPH/MPM. Gas products spawn as bubble particles. Exothermic heat feeds back to temperature.', severity: 'exists' },
  { id: 'P4', source: 'fluid-stage', target: 'structural-stage', label: 'Fluid forces on structures', data: 'Currently only indirect via temperature. Direct hydrostatic/hydrodynamic loads are a missing science gap (G1/G2).', severity: 'partial' },
  { id: 'P5', source: 'structural-stage', target: 'rigid-body', label: 'Broken blocks', data: 'Failed blocks ejected as rigid body debris. Conservation of momentum: m*v = F*dt from collapse impulse.', severity: 'exists' },
  { id: 'P6', source: 'rigid-body', target: 'sound-stage', label: 'Impact events', data: 'Every collision \u2192 SoundEvent. Energy E=0.5*m*v\u00b2*(1-e\u00b2) dissipated as sound. Material pair determines spectral character.', severity: 'exists' },
  { id: 'P7', source: 'sound-stage', target: 'broadcast', label: 'All events packaged', data: 'All SoundEvent descriptors + state deltas + particle updates bundled into WebSocket frame. Priority-sorted by player relevance.', severity: 'exists' },

  // Connection Q: Newly filled science gaps (sprint 2026-04)
  { id: 'Q1', source: 'property-calc', target: 'load-path', label: 'Work hardening', data: 'Hollomon: \u03c3=K\u00d7\u03b5^n. workHardeningState 0\u21921 tracks accumulated plastic strain. Annealing at T>0.4\u00d7T_melt resets to 0.', severity: 'exists' },
  { id: 'Q2', source: 'property-calc', target: 'decay-system', label: 'Galvanic corrosion', data: 'corrosionMultiplier = 1+3\u00d7|E_cathode-E_anode|/1.5V. Iron(-0.44V)+copper(+0.34V) \u2192 2.56\u00d7 faster iron corrosion.', severity: 'exists' },
  { id: 'Q3', source: 'sph-solver', target: 'decay-system', label: 'Capillary action', data: 'Jurin: h=2\u03c3cos\u03b8/(\u03c1gr). Water rises ~13cm in stone pores. Carries dissolved minerals \u2192 salt weathering when water evaporates.', severity: 'exists' },
  { id: 'Q4', source: 'sph-solver', target: 'property-calc', label: 'Sedimentation / settling', data: 'Stokes: v=2(\u03c1_p-\u03c1_f)gr\u00b2/(9\u03bc). Gold dust settles at 0.85 m/s. Clay particles take days. Enables gold panning.', severity: 'exists' },
  { id: 'Q5', source: 'mpm-solver', target: 'noise-synth', label: 'Hydraulic jump', data: 'Fr=v/\u221a(gd). Fr>1\u2192Fr<1 transition = turbulent roller. Energy dissipated = (d\u2082-d\u2081)\u00b3/(4d\u2081d\u2082). Loud roar + spray.', severity: 'exists' },
  { id: 'Q6', source: 'modal-synth', target: 'load-path', label: 'Structure-borne sound', data: 'v_sound=\u221a(E/\u03c1). Steel: 5960 m/s vs air 343 m/s. Sound through walls arrives 17\u00d7 faster. BFS through structural graph.', severity: 'exists' },
  { id: 'Q7', source: 'foundation', target: 'mpm-solver', label: 'Lateral earth pressure', data: 'Rankine: \u03c3_h=K_a\u00d7\u03b3\u00d7z. K_a=(1-sin\u03c6)/(1+sin\u03c6). Soft clay K_a=1.0 \u2192 full overburden pressure. Add \u03c1_water\u00d7g\u00d7z_water if saturated.', severity: 'exists' },
  { id: 'Q8', source: 'load-path', target: 'load-path', label: 'Frame triangulation', data: 'm=b+r-2j. m<0 = mechanism (collapses). Rectangle: m=-1 (unstable). Add diagonal: m=0 (stable). Mortared joints = rigid (no triangulation needed).', severity: 'exists' },
  { id: 'Q9', source: 'beam-analysis', target: 'tier-rendering', label: 'Deflection limits', data: '\u03b4=5wL\u2074/(384EI). L/360=acceptable, L/180=visible sag, L/100=doors won\'t close. Ponding: \u03b4_pond=\u03b4\u2080/(1-qL\u2074/(\u03c0\u2074EI)).', severity: 'exists' },

  // Connection R: Newly filled science gaps (sprint 2026-04, batch 2)
  { id: 'R1', source: 'property-calc', target: 'load-path', label: 'Creep deformation', data: 'Norton: d\u03b5/dt=A\u00b7\u03c3\u207f\u00b7exp(-Q/RT). Blocks above 0.4\u00d7T_melt slowly deform under sustained load. Lead creeps at room temp.', severity: 'exists' },
  { id: 'R2', source: 'property-calc', target: 'load-path', label: 'Ductility / brittle transition', data: 'BCC metals (iron) become brittle below BDTT (-20 to +20\u00b0C). Ductility drops to 0.02, K_IC drops 50-80%. Winter structural failures.', severity: 'exists' },
  { id: 'R3', source: 'property-calc', target: 'property-calc', label: 'Precipitation hardening', data: 'Avrami: f(t)=1-exp(-(kt)\u207f). Cu-Be aged at 315\u00b0C: HV 100\u2192400. Over-aging softens. Temperature-time optimization.', severity: 'exists' },
  { id: 'R4', source: 'property-calc', target: 'temp-propagation', label: 'Corrected specific heat', data: 'Debye correction: C_v=3R\u00b7f(T/\u03b8_D). Carbon \u03b8_D=2230K \u2192 C_p much lower than Dulong-Petit. Kopp-Neumann for compounds.', severity: 'exists' },
  { id: 'R5', source: 'property-calc', target: 'temp-propagation', label: 'Non-metal thermal conductivity', data: 'Slack model for crystalline. Clay \u03ba\u22481.0 W/mK (good insulator), granite \u03ba\u22482.5, wood \u03ba\u22480.15-0.35. Determines furnace wall performance.', severity: 'exists' },
  { id: 'R6', source: 'structural-stage', target: 'noise-synth', label: 'Helmholtz resonance', data: 'f=(v/2\u03c0)\u221a(A/(V\u00b7L)). Chimney: 30Hz rumble. Bottle: 106Hz hum. Cave mouth: infrasonic unease. Wind-driven.', severity: 'exists' },

  // Connection S: Missing node connections (fixing isolated nodes)
  { id: 'S1', source: 'arch-analysis', target: 'load-path', label: 'Arch thrust to load path', data: 'Arch thrust T=wL\u00b2/(8h) applied as horizontal force at springers. Load path checks abutment sliding (friction) and overturning (moment balance).', severity: 'exists' },
  { id: 'S2', source: 'load-path', target: 'arch-analysis', label: 'Load triggers arch check', data: 'When a block near an arch is modified, arch detection runs. Cluster spanning blocks, compute rise/span, check thrust vs. abutment capacity.', severity: 'exists' },
  { id: 'S3', source: 'voice-synth', target: 'broadcast', label: 'Voice events to clients', data: 'NPC speech and animal calls sent as SOUND_EVENT with type=voice. Includes f0, formants, phonemes, species. Client synthesizes via source-filter model.', severity: 'exists' },
  { id: 'S4', source: 'sound-stage', target: 'voice-synth', label: 'Voice trigger from behavior', data: 'NPC intent system triggers speech. Animal behavioral state transitions trigger calls. Each species has frequency, duration, and trigger probability.', severity: 'exists' },
  { id: 'S5', source: 'redistribution', target: 'sph-solver', label: 'Redistribution feeds SPH', data: 'Split particles near camera (r\u21920.794r), merge far particles. Maintains even spacing for stable density estimation. Mass exactly conserved.', severity: 'exists' },
  { id: 'S6', source: 'redistribution', target: 'mpm-solver', label: 'Redistribution feeds MPM', data: 'Adaptive zones: 0.02m near camera, 0.16m distant. 512\u00d7 fewer particles in zone 3 vs zone 0 for same fluid volume.', severity: 'exists' },
  { id: 'S7', source: 'authority', target: 'broadcast', label: 'Authority governs broadcast', data: 'Server computes ALL physics. Clients never simulate. Prevents cheating. All broadcast data is authoritative — clients render only.', severity: 'exists' },
  { id: 'S8', source: 'authority', target: 'state-mode', label: 'Authority defines state mode', data: 'State mode: client renders from server-sent positions (WORLD_SNAPSHOT 6Hz). No local physics. Low bandwidth (~13 KB/s steady state).', severity: 'exists' },
  { id: 'S9', source: 'authority', target: 'video-mode', label: 'Authority defines video mode', data: 'Video mode: server renders frames via H.264 NVENC, streams to client. Used for precision craft and high-particle scenes.', severity: 'exists' },
  { id: 'S10', source: 'load-path', target: 'foundation', label: 'Loads reach foundation', data: 'Accumulated load from top-down computation reaches ground-level blocks. Foundation checks: q=F/A vs. q_ult (Terzaghi). Excess \u2192 sinking.', severity: 'exists' },
  { id: 'S11', source: 'load-path', target: 'beam-analysis', label: 'Load path detects beams', data: 'Horizontal runs with air below, supported at ends = beams. Load path feeds total load to beam bending analysis: \u03c3=3wL\u00b2/(4bh\u00b2).', severity: 'exists' },
  { id: 'S12', source: 'reaction-rules', target: 'phase-system', label: 'Reactions trigger phase changes', data: 'Exothermic reactions raise temperature, potentially crossing melting/boiling points. Endothermic reactions cool, potentially freezing.', severity: 'exists' },
  { id: 'S13', source: 'reaction-rules', target: 'property-calc', label: 'Reactions change composition', data: 'Reaction outputs have new composition \u2192 property calculator recomputes all 36+ properties for the new material.', severity: 'exists' },
  { id: 'S14', source: 'state-mode', target: 'tier-rendering', label: 'State mode uses tier rendering', data: 'In state mode, client renders fluid via three-tier pipeline (marching cubes / SSFR / points) from server-sent particle positions.', severity: 'exists' },

  // Connection T: Optimization 3.7
  { id: 'T1', source: 'tick-scheduler', target: 'temp-propagation', label: 'Schedules at 30 Hz', data: 'Temperature propagation runs at 30 Hz (medium rate). Heat changes are gradual — half-rate is imperceptible.', severity: 'exists' },
  { id: 'T2', source: 'tick-scheduler', target: 'fluid-stage', label: 'Schedules SPH 60Hz / MPM 30Hz', data: 'SPH crafting at 60 Hz (player-facing), MPM environment at 30 Hz (bulk flow). Can run in parallel on separate cores.', severity: 'exists' },
  { id: 'T3', source: 'tick-scheduler', target: 'structural-stage', label: 'Event-driven + 30 Hz max', data: 'Structural checks only on change events, not every tick. Maximum check rate capped at 30 Hz during active construction.', severity: 'exists' },
  { id: 'T4', source: 'tick-scheduler', target: 'sound-stage', label: 'Schedules at 60 Hz', data: 'Sound events need immediate response — impacts must produce audio within one frame for perceived responsiveness.', severity: 'exists' },
  { id: 'T5', source: 'tick-scheduler', target: 'broadcast', label: 'Schedules broadcast 60 Hz', data: 'Broadcast runs every high-frequency tick. Actual send rate per client varies by bandwidth adaptation (15-60 Hz).', severity: 'exists' },
  { id: 'T6', source: 'profiler', target: 'degradation', label: 'Timing triggers degradation', data: 'When any stage exceeds 2x budget for 10 ticks, profiler increments degradation level. Recovery after 30 ticks below threshold.', severity: 'exists' },
  { id: 'T7', source: 'degradation', target: 'tick-scheduler', label: 'Reduces tick rates', data: 'Level 2: SPH 60→30 Hz, MPM 30→15 Hz. Level 5: freeze background sim entirely. Hysteresis prevents oscillation.', severity: 'exists' },
  { id: 'T8', source: 'degradation', target: 'mpm-solver', label: 'Reduces particle cap', data: 'Level 1: cap MPM at 50k instead of 200k. Aggressively merge distant particles. Close-up quality unaffected.', severity: 'exists' },
  { id: 'T9', source: 'degradation', target: 'broadcast', label: 'Adapts bandwidth per client', data: 'Per-client RTT monitoring. >150ms: skip Tier 1-3 particles. >300ms: WORLD_SNAPSHOT at 1 Hz only. Slow clients get reduced updates.', severity: 'exists' },
  { id: 'T10', source: 'profiler', target: 'broadcast', label: 'Monitoring to status site', data: 'Per-tick timing report sent to status site at 1 Hz. Includes per-stage microseconds, memory usage, degradation level, particle counts.', severity: 'exists' },

  // Connection 45-47 (§3.9 Projectile Aerodynamics)
  { id: 'C45', source: 'drag-system', target: 'rigid-body', label: 'Drag on rigid bodies', data: 'F_drag = 0.5\u00d7\u03c1\u00d7v\u00b2\u00d7Cd\u00d7A applied to every active rigid body per tick. Wind from weather affects v_relative.', severity: 'exists' },
  { id: 'C46', source: 'drag-system', target: 'load-path', label: 'Drag \u2192 combat damage', data: 'Projectiles arrive with reduced velocity at range \u2192 reduced impact energy \u2192 less damage.', severity: 'exists' },
  { id: 'C47', source: 'property-calc', target: 'drag-system', label: 'Crafting \u2192 Cd/stability', data: 'Fletched arrows Cd=0.05, Sg>1. Un-fletched Cd=0.20, tumbles. Shape determines aerodynamics.', severity: 'exists' },

  // Connection 48-51 (§3.10 Rope Physics)
  { id: 'C48', source: 'rope-system', target: 'load-path', label: 'Rope tension \u2192 structural', data: 'Rope anchors apply tension force to blocks. Crane lifting 500kg pulls anchor with 4900N.', severity: 'exists' },
  { id: 'C49', source: 'rope-system', target: 'tick-scheduler', label: 'Rope + pulley \u2192 MA', data: 'Rope over axle joint = pulley. N segments = N\u00d7 mechanical advantage minus friction.', severity: 'exists' },
  { id: 'C50', source: 'rope-system', target: 'drag-system', label: 'Bow \u2192 projectile velocity', data: 'Elastic energy E=0.5kx\u00b2 \u2192 arrow velocity v=\u221a(2E\u00d7eff/m). ~51 m/s for longbow.', severity: 'exists' },
  { id: 'C51', source: 'rope-system', target: 'noise-synth', label: 'Wind on ropes', data: 'F = 0.5\u00d7\u03c1\u00d7v\u00b2\u00d7Cd\u00d7d\u00d7L. Ropes hum in wind. Rigging in storm \u2192 mast structural check.', severity: 'exists' },

  // Connection 52-54 (§3.11 Heat Engines)
  { id: 'C52', source: 'heat-engine', target: 'sph-solver', label: 'Gas pressure \u2192 piston', data: 'Gas SPH particles apply P\u00d7A force on slider joint piston. Ideal gas law: P=nRT/V.', severity: 'exists' },
  { id: 'C53', source: 'heat-engine', target: 'tick-scheduler', label: 'Piston \u2192 crankshaft', data: 'Slider joint linear force \u2192 hinge joint \u2192 axle rotation. F\u00d7stroke = \u03c4\u00d7angle.', severity: 'exists' },
  { id: 'C54', source: 'heat-engine', target: 'property-calc', label: 'Efficiency \u2192 fuel', data: 'Carnot limit: \u03b7_max = 1-T_cold/T_hot. Actual efficiency tracks work_out/heat_in.', severity: 'exists' },

  // Connection 55-57 (§3.12 Optics)
  { id: 'C55', source: 'optics-system', target: 'property-calc', label: 'Lens geometry \u2192 magnification', data: '1/f = (n-1)(1/R\u2081-1/R\u2082). Player grinds glass \u2192 R1,R2 \u2192 focal length \u2192 zoom.', severity: 'exists' },
  { id: 'C56', source: 'optics-system', target: 'temp-propagation', label: 'Mirror \u2192 solar heat', data: 'Concave mirror: P = irradiance\u00d7area\u00d7reflectivity at focal point. 2m dish = 3kW.', severity: 'exists' },
  { id: 'C57', source: 'optical-pipeline', target: 'optics-system', label: 'refractiveIndex \u2192 optics', data: 'n already computed for rendering. Now also used for gameplay optics (Snell, lenses).', severity: 'exists' },

  // Connection 58-62 (§3.13 Electromagnetism)
  { id: 'C58', source: 'property-calc', target: 'em-system', label: 'Electrode potential \u2192 battery', data: 'V_cell = E_cathode - E_anode. Zn+Cu = 1.10V. Already on MaterialPacket.', severity: 'exists' },
  { id: 'C59', source: 'em-system', target: 'temp-propagation', label: 'Current \u2192 resistive heat', data: 'P = I\u00b2R. Nichrome wire glows. Iron wire at high current \u2192 melts \u2192 fuse.', severity: 'exists' },
  { id: 'C60', source: 'tick-scheduler', target: 'em-system', label: 'Generator \u2190 rotation', data: 'EMF = N\u00d7B\u00d7A\u00d7\u03c9. Waterwheel/windmill axle spins coil \u2192 voltage in circuit.', severity: 'exists' },
  { id: 'C61', source: 'em-system', target: 'tick-scheduler', label: 'Motor \u2192 rotation', data: '\u03c4 = N\u00d7I\u00d7A\u00d7B. Current + magnetic field \u2192 torque on axle. Motor = reverse generator.', severity: 'exists' },
  { id: 'C62', source: 'em-system', target: 'reaction-rules', label: 'Electrolysis \u2192 reactions', data: 'Current through electrolyte forces non-spontaneous reactions. m = MIt/(nF).', severity: 'exists' },

  // Connection 63-68 (from /connect-chapter 3)
  { id: 'C63', source: 'drag-system', target: 'rotational-mechanics', label: 'Drag torque on rotation', data: '\u03c4_drag = -0.5\u00d7\u03c1\u00d7\u03c9\u00b2\u00d7R\u00b3\u00d7Cd\u00d7A. Spinning windmills/flywheels slow down in still air. Without this, rotation is perpetual.', severity: 'exists' },
  { id: 'C64', source: 'rope-system', target: 'noise-synth', label: 'Rope \u2192 sound events', data: 'Snap: f\u2080=(1/2L)\u221a(E/\u03c1). Twang: f\u2080=(1/2L)\u221a(T/\u03bc), Q=20-50. Wind hum: f=0.2\u00d7v/d. Creak: broadband on tension change.', severity: 'exists' },
  { id: 'C65', source: 'heat-engine', target: 'noise-synth', label: 'Engine \u2192 sound', data: 'Steam chuff at crank freq. Hiss 2-8kHz from valves. Combustion bang (Helmholtz of cylinder). Boiler rumble 30-100Hz.', severity: 'exists' },
  { id: 'C66', source: 'em-system', target: 'noise-synth', label: 'EM \u2192 sound events', data: 'Arc buzz: broadband \u221d power. Motor hum: freq\u00d7poles. Transformer: 2\u00d7AC freq. Spark: impulse 1-10kHz.', severity: 'exists' },
  { id: 'C67', source: 'em-system', target: 'sph-solver', label: 'Electrolysis \u2192 gas bubbles', data: 'H\u2082: m=(0.002\u00d7I\u00d7dt)/(2\u00d796485) at cathode. O\u2082: m=(0.032\u00d7I\u00d7dt)/(4\u00d796485) at anode. Spawn as gas-phase SPH particles.', severity: 'exists' },
  { id: 'C68', source: 'mpm-solver', target: 'drag-system', label: 'Fluid medium \u2192 drag density', data: 'Submerged: \u03c1=1000 (water). Surface: partial. Air: \u03c1=1.225. Underwater drag 800\u00d7 greater \u2014 arrows stop instantly.', severity: 'exists' },
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
  optimization: Math.PI * 1.2, // lower center
  advanced: Math.PI * 0.5,     // bottom right
}

function initNodes(width: number, height: number): GraphNode[] {
  const cx = width / 2
  const cy = height / 2
  const groupCounts: Record<NodeGroup, number> = { material: 0, fluid: 0, sound: 0, structural: 0, network: 0, tick: 0, optimization: 0, advanced: 0 }
  const groupTotals: Record<NodeGroup, number> = { material: 0, fluid: 0, sound: 0, structural: 0, network: 0, tick: 0, optimization: 0, advanced: 0 }
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
  const [sidebarWidth, setSidebarWidth] = useState(360)
  const sidebarDragRef = useRef<{ active: boolean; startX: number; startW: number }>({ active: false, startX: 0, startW: 360 })

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

  // Mouse wheel zoom — use native listener with { passive: false } to allow preventDefault
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9
      setTransform(prev => {
        const newScale = Math.max(0.2, Math.min(4, prev.scale * zoomFactor))
        const newX = mx - (mx - prev.x) * (newScale / prev.scale)
        const newY = my - (my - prev.y) * (newScale / prev.scale)
        return { x: newX, y: newY, scale: newScale }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

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

  // Sidebar resize
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!sidebarDragRef.current.active) return
      const delta = sidebarDragRef.current.startX - e.clientX
      setSidebarWidth(Math.max(240, Math.min(600, sidebarDragRef.current.startW + delta)))
    }
    const onUp = () => {
      if (sidebarDragRef.current.active) {
        sidebarDragRef.current.active = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  const handleSidebarDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    sidebarDragRef.current = { active: true, startX: e.clientX, startW: sidebarWidth }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [sidebarWidth])

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
          right: (selectedNodeData || selectedEdgeData) ? sidebarWidth + 16 : 10,
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

        {/* Tooltip — brief summary on hover */}
        {tooltip && !dragNodeRef.current.active && (() => {
          const nd = NODE_DEFS.find(n => n.id === tooltip.nodeId)
          if (!nd) return null
          const connections = getNodeConnections(tooltip.nodeId)
          const existsCount = connections.filter(c => c.severity === 'exists').length
          const missingCount = connections.filter(c => c.severity === 'missing').length
          const partialCount = connections.filter(c => c.severity === 'partial').length
          return (
            <div style={{
              position: 'absolute',
              left: Math.min(tooltip.x + 14, (containerRef.current?.clientWidth ?? 800) - 220),
              top: tooltip.y - 10,
              zIndex: 30,
              background: 'rgba(4,8,20,0.96)',
              border: `1px solid ${GROUP_COLORS[nd.group]}`,
              borderRadius: 4,
              padding: '6px 10px',
              fontSize: 10,
              color: 'rgba(220,235,255,0.9)',
              fontFamily: "'IBM Plex Mono', monospace",
              pointerEvents: 'none',
              maxWidth: 200,
              boxShadow: `0 0 12px ${GROUP_COLORS[nd.group]}22`,
            }}>
              <div style={{ color: GROUP_COLORS[nd.group], fontSize: 11, fontWeight: 600, marginBottom: 2 }}>
                {nd.label}
              </div>
              <div style={{ color: 'rgba(150,185,220,0.5)', fontSize: 9, marginBottom: 4 }}>
                {nd.section} &middot; {GROUP_LABELS[nd.group]}
              </div>
              <div style={{ display: 'flex', gap: 8, fontSize: 9 }}>
                {existsCount > 0 && <span style={{ color: SEVERITY_COLORS.exists }}>{existsCount} ok</span>}
                {partialCount > 0 && <span style={{ color: SEVERITY_COLORS.partial }}>{partialCount} partial</span>}
                {missingCount > 0 && <span style={{ color: SEVERITY_COLORS.missing }}>{missingCount} gap{missingCount > 1 ? 's' : ''}</span>}
              </div>
              <div style={{ fontSize: 8, color: 'rgba(150,185,220,0.3)', marginTop: 3 }}>
                click for details
              </div>
            </div>
          )
        })()}
      </div>

      {/* Sidebar drag handle */}
      {(selectedNodeData || selectedEdgeData) && (
        <div
          onMouseDown={handleSidebarDragStart}
          style={{
            width: 6,
            flexShrink: 0,
            cursor: 'col-resize',
            background: 'transparent',
            borderLeft: '1px solid rgba(0,180,255,0.08)',
            transition: 'background 0.15s',
            zIndex: 10,
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,180,255,0.15)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
        />
      )}

      {/* Detail panel (right side, resizable) */}
      {(selectedNodeData || selectedEdgeData) && (
        <div style={{
          width: sidebarWidth,
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

                {/* Physics detail / key formulas */}
                {selectedNodeData.physics && (
                  <div style={{
                    fontSize: 10,
                    color: 'rgba(0,220,255,0.7)',
                    lineHeight: 1.6,
                    marginBottom: 12,
                    padding: '8px 10px',
                    background: 'rgba(0,180,255,0.04)',
                    borderRadius: 3,
                    border: '1px solid rgba(0,180,255,0.1)',
                    fontFamily: "'IBM Plex Mono', monospace",
                    whiteSpace: 'pre-line' as const,
                  }}>
                    <div style={{ fontSize: 9, letterSpacing: 1.5, color: 'rgba(0,180,255,0.3)', marginBottom: 6 }}>
                      KEY FORMULAS
                    </div>
                    {selectedNodeData.physics}
                  </div>
                )}

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
                            marginBottom: 4,
                            background: c.severity === 'missing' ? 'rgba(255,107,107,0.04)' : 'rgba(0,180,255,0.03)',
                            borderLeft: `2px solid ${SEVERITY_COLORS[c.severity]}`,
                            borderRadius: '0 3px 3px 0',
                            cursor: 'pointer',
                            transition: 'background 0.15s',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = c.severity === 'missing' ? 'rgba(255,107,107,0.1)' : 'rgba(0,180,255,0.08)' }}
                          onMouseLeave={e => { e.currentTarget.style.background = c.severity === 'missing' ? 'rgba(255,107,107,0.04)' : 'rgba(0,180,255,0.03)' }}
                        >
                          <div style={{ fontSize: 10, color: SEVERITY_COLORS[c.severity], fontWeight: 500 }}>
                            {c.severity === 'missing' ? '[!] ' : ''}{c.label}
                          </div>
                          <div style={{ fontSize: 9, color: 'rgba(150,185,220,0.45)', marginTop: 1 }}>
                            -&gt; {targetNode?.label ?? c.target}
                          </div>
                          <div style={{ fontSize: 9, color: 'rgba(180,210,240,0.5)', marginTop: 3, lineHeight: 1.4, fontStyle: 'italic' }}>
                            {c.data}
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
                            marginBottom: 4,
                            background: c.severity === 'missing' ? 'rgba(255,107,107,0.04)' : 'rgba(0,180,255,0.03)',
                            borderLeft: `2px solid ${SEVERITY_COLORS[c.severity]}`,
                            borderRadius: '0 3px 3px 0',
                            cursor: 'pointer',
                            transition: 'background 0.15s',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = c.severity === 'missing' ? 'rgba(255,107,107,0.1)' : 'rgba(0,180,255,0.08)' }}
                          onMouseLeave={e => { e.currentTarget.style.background = c.severity === 'missing' ? 'rgba(255,107,107,0.04)' : 'rgba(0,180,255,0.03)' }}
                        >
                          <div style={{ fontSize: 10, color: SEVERITY_COLORS[c.severity], fontWeight: 500 }}>
                            {c.severity === 'missing' ? '[!] ' : ''}{c.label}
                          </div>
                          <div style={{ fontSize: 9, color: 'rgba(150,185,220,0.45)', marginTop: 1 }}>
                            &lt;- {sourceNode?.label ?? c.source}
                          </div>
                          <div style={{ fontSize: 9, color: 'rgba(180,210,240,0.5)', marginTop: 3, lineHeight: 1.4, fontStyle: 'italic' }}>
                            {c.data}
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

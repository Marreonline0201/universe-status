# Universe Sim — Game Design Document

**Last Updated**: 2026-04-01

---

## Table of Contents

### PART I — VISION
1. [Executive Summary](#1-executive-summary)
2. [The Vision](#2-what-this-project-is--the-vision)

### PART II — CORE ENGINE
3. [Core Simulation Engine](#3-core-simulation-engine)
    - 3.1 Emergent Material System
    - 3.2 Fluid Simulation
    - 3.3 Sound Engine
    - 3.4 Structural Physics
    - 3.5 Networking & Hybrid Rendering

### PART III — GAME WORLD
4. [World & Life](#4-world--life) — World Gen, Organisms, Geology, Weather & Seasons
    - 4.1 World Generation
    - 4.2 Organism Ecosystem & Species
    - 4.3 Geology & Resource Distribution
5. [Civilization](#5-civilization)
    - 5.1 Settlements
    - 5.2 NPC Brain
    - 5.3 NPC Language & Knowledge Transfer
6. [Crafting & Production](#6-crafting--production)
    - 6.1 Material Taxonomy
    - 6.2 Production System
    - 6.3 Physics-Based Crafting & Workstations
    - 6.4 Precision Crafting Mode
7. [Player Systems](#7-player-systems)
    - 7.1 Character Creation & Body
    - 7.2 Survival Stats
    - 7.3 Inventory
    - 7.4 Terrain Interaction
    - 7.5 Combat
    - 7.6 Death & Respawn
    - 7.7 Multiplayer & PvP
    - 7.8 Player-to-Player Interaction
    - 7.9 Swimming & Underwater
    - 7.10 Lighting
    - 7.11 Map & Navigation
    - 7.12 Persistence Model
    - 7.13 New Player Experience
8. [UI Panels and Hotkeys](#8-ui-panels-and-hotkeys)

### REFERENCES
9. [References](#9-references)

---

# PART I — VISION
---

## 1. Executive Summary

Universe Simulation is a living universe running inside a web browser. It is not a game in the traditional sense — there are no quests, no skill trees, no XP, no dungeons, and no objectives handed to the player. The player enters the world as just another creature. The universe was here before them and will continue after they leave. Other organisms are born, eat, and die whether or not anyone is watching. Weather changes. Seasons shift. Civilizations form around the resources geology has made available. The player's shelter marks where they respawn. Their death is not a punishment — it is just what happens when living things run out of energy.

The game is built on three foundational pillars. First, **physics-based crafting** — fire is started by the correct physical method (bow-drill friction or flint-and-iron striking), with success rates determined by actual material properties (wood moisture content, hardness on the Mohs scale, ignition temperature). No recipe lists. Second, **geological accuracy** — copper concentrates near tectonic plate boundaries as it does on Earth, not randomly. Settlements that form near copper-rich volcanic zones become copper mining towns. Third, a **shared ecosystem** — all players see the same organisms, weather, and civilizations. A birth or death of an organism is a real event that all connected players witness simultaneously.


---

## 2. What This Project Is — The Vision

### The Core Idea

A universe in a browser that players can walk around in. The world exists for itself. The player is just another inhabitant. No quests. No XP. No skill trees. No dungeons. The universe is indifferent to the player. That indifference is what makes it feel real.

### The One Test for Every Feature

"Does this make the universe feel more real — or more like a game?"

If a mechanic feels like a game system — a reward, a progression bar, a level-up notification — it is wrong. If it feels like a natural consequence of how the world physically works, it belongs.

This principle is grounded in Raph Koster's *A Theory of Fun for Game Design* (2004): genuine fun comes from learning the rules of a real system — not from being handed rewards. When a player discovers that dry cedar + flint makes fire, they have learned something true about the world. That discovery is intrinsically satisfying. A recipe list would have told them the answer; the physics system makes them find it.

### What the Player Can Do

The player is a creature. They need food and water to survive. They can gather materials from the environment, start a fire using physical techniques, cook food, craft tools from stone, smelt metals using real chemistry, build shelter, observe other organisms living their lives, and eventually — if they invest enough time — participate in civilization-level technologies up to interplanetary travel and contact with alien civilizations.

None of this is delivered as a quest. The player discovers it by being in the world and paying attention to what is around them.

The arc of discovery follows the framework laid out in Lewis Dartnell's *The Knowledge: How to Rebuild Our World from Scratch* (2014) — the same sequence a surviving human would need to re-learn: fire → agriculture → chemistry → metallurgy → electricity → digital technology. Each step requires what came before. You cannot smelt iron without charcoal. You cannot make charcoal at scale without understanding fire. The world enforces this order through material properties, not through arbitrary unlock gates.

### What Makes It Different

Every physical process in this simulation uses real scientific models, not game approximations:

- Fire is started by the Arrhenius equation governing combustion chemistry
- Metal smelting requires reaching the correct reduction temperature for the specific ore
- Bow-drill fire success depends on the Mohs hardness and moisture content of the wood used
- Resource nodes appear in geologically realistic locations — copper near volcanic plate boundaries, coal in stable sedimentary basins
- Settlement specialties are determined by what the geology nearby actually produces
- Organism energy budgets follow autotroph/heterotroph/mixotroph metabolic models tied to the day/night light cycle

This approach has precedent. *Dwarf Fortress* (Tarn Adams, ongoing) demonstrated that deriving behavior from material properties rather than hardcoding interactions produces emergent complexity that surprises even its creators. *Caves of Qud* (Freehold Games) implemented procedural chemistry — substances with viscosity, reactivity, and temperature thresholds — producing interactions no designer explicitly wrote. Universe Sim follows the same principle at a larger scale.

---


---


---


# PART II — GAME WORLD
---


---

# PART II — CORE ENGINE
---

## 3. Core Simulation Engine

These are the foundational physics systems that power every other system in the game. The material system determines what things are. The fluid system determines how liquids move. The atmospheric model determines weather. The sound engine determines what you hear. The structural system determines whether buildings stand. The networking layer determines who computes what. Everything else in this document is built on top of these six systems.

### 3.1 Emergent Material System — Nothing Is Pre-Defined

#### The Principle

The universe does not have a recipe list. Helium was not "designed" — it emerged when hydrogen atoms were forced together under extreme temperature and pressure inside a star. Bronze was not "invented" — it is what happens when copper and tin atoms mix above 950°C and cool together. Glass was not "planned" — it is what happens when silicon dioxide melts at 1700°C and cools too quickly to crystallize.

The game should work the same way. **No material is pre-defined. Every material is the result of rules applied to simpler materials under specific conditions.** The system doesn't know what "bronze" is. It knows what happens when a packet of mostly-copper meets a packet of mostly-tin at high temperature. The result has properties calculated from the inputs — and those properties happen to match what humans call bronze.

This means:
- The developer never writes `{ name: "bronze", hardness: 3.5, meltingPoint: 950 }` as a static entry
- Instead, the system computes: "a Cu₀.₈₈Sn₀.₁₂ alloy at 25°C has Mohs hardness ≈ 3.5, melting point ≈ 950°C" from the component properties and known alloy rules
- A player who mixes copper and zinc instead gets a different result — brass — without anyone coding brass
- A player who mixes copper, tin, AND a small amount of phosphorus gets phosphor bronze — harder, more elastic — also without anyone coding it

The game builds its material universe the same way the real universe did: from the bottom up.

#### What Is a Material Packet

The fundamental unit is not an atom (too expensive) or a named material (too rigid). It is a **material packet** — a chunk of matter with a composition, mass, temperature, and phase.

```
MaterialPacket {
  // --- Identity: what is this made of? ---
  composition: Map<Element, number>    // element → mass fraction (sums to 1.0)
                                        // e.g., { Cu: 0.88, Sn: 0.12 }

  // --- Physical state ---
  mass: number                          // kg
  temperature: number                   // °C
  phase: 'solid' | 'liquid' | 'gas' | 'plasma'
  pressure: number                      // Pa (default: 101325 = 1 atm)

  // --- Derived (computed from composition + state, never stored manually) ---
  meltingPoint: number                  // °C — weighted from components + alloy corrections
  boilingPoint: number                  // °C
  density: number                       // kg/m³
  hardness: number                      // Mohs scale
  thermalConductivity: number           // W/(m·K)
  electricalConductivity: number        // S/m
  tensileStrength: number               // MPa
  color: [number, number, number]       // RGB derived from composition
  crystalStructure: string              // FCC, BCC, HCP, amorphous...
}
```

Every derived property is **calculated**, not looked up. The calculation uses real material science:

| Property | How it's computed | Source |
|----------|------------------|--------|
| Melting point | Weighted average of component melting points + eutectic corrections from binary phase diagrams | CALPHAD method (simplified) |
| Density | Rule of mixtures: `ρ = Σ(xᵢ · ρᵢ)` with packing corrections for crystal structure | Vegard's law for alloys |
| Hardness | Hall-Petch relationship for grain size + solid solution strengthening from solute atoms | Metallurgy fundamentals |
| Electrical conductivity | Matthiessen's rule: `1/σ = 1/σ_base + Σ(cᵢ · Δρᵢ)` — impurities increase resistivity | Resistivity tables |
| Color | Drude model for metals (free electron plasma frequency → reflectance spectrum), absorption spectrum for non-metals | Optical properties of solids |
| Crystal structure | Hume-Rothery rules: atomic size ratio, electronegativity difference, valence electron count → FCC/BCC/HCP prediction | Hume-Rothery (1934) |

#### How Materials Combine: The Reaction Engine

When two packets meet under conditions, the **reaction engine** determines what happens. It does not look up recipes. It checks thermodynamics.

**Step 1 — Can a reaction happen?**
Check Gibbs free energy: `ΔG = ΔH - TΔS`
- If `ΔG < 0`: reaction is spontaneous (it wants to happen)
- If `ΔG > 0`: reaction needs energy input
- If `ΔG ≈ 0`: equilibrium (both forms coexist)

The enthalpy (ΔH) and entropy (ΔS) values come from the elements' standard formation energies — tabulated from real chemistry, stored per element.

**Step 2 — Is there enough energy?**
- Temperature must be above activation energy threshold (Arrhenius: `k = A·e^(-Ea/RT)`)
- Some reactions need a catalyst to lower Ea (e.g., iron catalyst for ammonia synthesis)
- Some need specific atmosphere (reducing = carbon/CO present, oxidizing = oxygen present)

**Step 3 — What comes out?**
The output packet's composition is computed from stoichiometry:
- Conservation of mass: total mass in = total mass out
- Conservation of elements: every atom that goes in comes out (just rearranged)
- Energy balance: exothermic reactions heat the output, endothermic reactions cool it

**Step 4 — What are the output's properties?**
All properties are recalculated from the new composition using the formulas above. The system doesn't know it made "bronze" — it made a Cu-Sn solid solution with computed properties.

#### Example: A Player Discovers Bronze

```
1. Player has: packet A (composition: {Cu: 1.0}, mass: 1.0kg, temp: 25°C, phase: solid)
              packet B (composition: {Sn: 1.0}, mass: 0.12kg, temp: 25°C, phase: solid)

2. Player puts both in a bloomery and heats to 1100°C

3. Reaction engine:
   - Cu melting point: 1085°C → packet A transitions to liquid
   - Sn melting point: 232°C → packet B already liquid
   - Two liquids in contact → check miscibility: Cu-Sn are fully miscible in liquid phase
   - Packets merge: new packet {Cu: 0.89, Sn: 0.11}, mass: 1.12kg, temp: 1100°C, phase: liquid

4. Player removes from heat, packet cools below solidus (~950°C for this composition)
   - Phase → solid
   - Crystal structure: FCC (Hume-Rothery: Sn atoms substitute into Cu lattice, size ratio 0.93 ≈ OK)
   - Hardness: higher than pure Cu (solid solution strengthening)
   - Color: slightly more golden than pure copper

5. The game has created "bronze" without ever defining bronze.
```

#### Example: Stellar Nucleosynthesis (The Universe Creates Elements)

The same system works at cosmic scale. During world generation, the simulation can model how the planet's elements formed:

```
1. Primordial hydrogen cloud collapses under gravity
2. Core temperature reaches 15,000,000°C, pressure reaches 250 billion atm
3. Reaction engine: H + H → check ΔG at these conditions → fusion is spontaneous
4. Output: He packet + energy (E = Δm·c²)
5. As He accumulates, triple-alpha process: He + He + He → C at 100,000,000°C
6. C + He → O, then Ne, Mg, Si... up to Fe (where fusion becomes endergonic)
7. Supernova: extreme conditions create everything heavier than iron via neutron capture
```

This isn't simulated in real-time during gameplay — it runs once during world generation to establish the planet's elemental abundances. But it uses the same reaction engine. The planet's composition is DERIVED, not hardcoded.

#### The Compounding Rule: 1 + 1 = 2

Materials don't just react — they aggregate. Two dirt packets combine into one larger dirt packet. This is simple mass addition with composition averaging:

```
packet A: {Si: 0.33, O: 0.47, Al: 0.08, Fe: 0.05, ...}, mass: 0.5kg
packet B: {Si: 0.30, O: 0.50, Al: 0.10, Fe: 0.04, ...}, mass: 0.3kg

Result: weighted composition average, mass: 0.8kg
  Si: (0.33×0.5 + 0.30×0.3) / 0.8 = 0.319
  O:  (0.47×0.5 + 0.50×0.3) / 0.8 = 0.481
  ... etc.
```

This means:
- Inventory stacking is just packet merging (compositions average out)
- Splitting a packet divides mass but keeps the same composition
- Impurities naturally accumulate or dilute through mixing
- Ore quality varies by location (different packets have different trace elements)
- Purification is the process of separating a mixed packet into purer sub-packets

#### What This Replaces

The current `MaterialRegistry.ts` with 118 pre-defined materials becomes:
1. **Element table** — 118 entries with REAL measured properties (atomic mass, melting point, density, electronegativity, standard formation enthalpy). This is the only static data. It comes from the periodic table — nature's constants.
2. **Reaction engine** — thermodynamic rules that compute what happens when packets interact
3. **Property calculator** — derives all material properties from composition using material science formulas
4. **Packet store** — every object in the world is a packet (or a collection of packets)

The Tier 2 (minerals) and Tier 3 (processed materials) lists in §3.1–6.3.2 are no longer definitions — they become **expected emergent results**. They describe what SHOULD emerge when the rules are correct. If the reaction engine, given real Cu and Sn properties, doesn't produce something with bronze-like properties at the right temperature, the rules have a bug — not a missing recipe.

#### Computational Cost

This is feasible on current hardware because:
- Packets are coarse-grained (not individual atoms — a packet might represent 1 gram to 1 ton of material)
- Property calculations are simple arithmetic (weighted averages, polynomial fits) — microseconds each
- Reactions only fire when packets are brought together by a player or NPC action — not continuously
- The element table (118 entries × ~20 properties) fits in < 10 KB
- Phase diagram lookups can use pre-computed binary tables for common pairs (Cu-Sn, Fe-C, etc.) — ~500 pairs covers 95% of cases
- Rare or novel combinations fall back to ideal solution approximations (less accurate but always produces a result)

**Estimated per-reaction cost:** < 0.1ms on a single CPU core. A player performing 10 crafting actions per minute costs essentially nothing.

**Where it gets expensive:** fluid simulation (§3.4), where millions of packets move and interact continuously. That is a separate problem addressed in the next section.

---


### 3.2 Fluid Simulation — How Liquids Work

#### Why Liquid Is the Hardest Problem

Solids are easy. A solid material packet sits where you put it. It has a position, a shape, and it doesn't move unless something pushes it. The game only needs to track one object.

Liquids are fundamentally different. A liquid has no fixed shape — it takes the shape of whatever contains it. It flows downhill. It pools in valleys. It splashes when it hits something. It mixes with other liquids. It evaporates when heated, condenses when cooled. Every drop interacts with every nearby drop, the terrain, gravity, temperature, and wind — simultaneously, continuously, at every moment.

The reason liquid is hard is not that the physics is complicated (the equations are well understood). It is that liquid requires simulating **many small pieces moving independently**. A solid copper ingot is one object. Molten copper is thousands of tiny pieces flowing, colliding, merging, and separating. That transition — from one thing to many things — is the core computational challenge.

#### The Physical Truth: What Melting Actually Is

At the atomic level, melting is the breakdown of structure:

- **Solid**: atoms are locked in a crystal lattice. Each atom vibrates around a fixed position but cannot leave. The lattice gives the material its rigid shape. This is why solids hold their form.
- **Liquid**: atoms have enough kinetic energy to break free from the lattice. They can slide past each other, but intermolecular forces (van der Waals, hydrogen bonds, metallic bonds) keep them close together. This is why liquids flow but don't fly apart.
- **Gas**: atoms have enough energy to overcome all intermolecular forces. They fly freely in all directions, filling any container. This is why gas expands to fill a room.

The game simulates this by **fragmenting a material packet into sub-packets when it crosses its melting point**. The sub-packets are the "freed atoms" — they inherit the parent's composition and temperature, but now they can move independently. When they cool below the melting point, they lock back together into a solid.

This is not a metaphor. This is literally what melting is, at a coarser grain size.

#### The Simulation Model: Smoothed Particle Hydrodynamics (SPH)

SPH is a method for simulating fluids using particles instead of a grid. Each particle represents a small volume of liquid. The particles interact with their neighbors to produce realistic fluid behavior: flow, pressure, viscosity, surface tension, and splashing.

**Why SPH and not a grid?** Grid-based methods (like the existing `fluid.worker.ts`) divide space into fixed cells. They work well for large, slow-moving bodies of water (oceans, lakes). But they cannot handle:
- Pouring liquid from one container to another
- A waterfall breaking into droplets
- Molten metal being cast into a mold
- Rain hitting the ground and splashing
- Two different liquids mixing at their boundary

SPH handles all of these because the particles move with the fluid — they go wherever the liquid goes, naturally adapting to any shape or motion.

**Each SPH particle stores:**

```
SPHParticle {
  // --- From the material packet system (§3.3) ---
  composition: Map<Element, number>    // what this droplet is made of
  mass: number                          // kg (fixed at creation)
  temperature: number                   // °C (changes from environment + neighbors)

  // --- SPH physics state ---
  x, y, z: number                      // position on the sphere surface (world space)
  vx, vy, vz: number                   // velocity (m/s)
  density: number                       // kg/m³ (computed from neighbors each tick)
  pressure: number                      // Pa (computed from density)

  // --- Derived from composition (computed once, updated on temperature change) ---
  viscosity: number                     // Pa·s — how thick/resistant to flow
  surfaceTension: number                // N/m — how strongly the surface pulls inward
  restDensity: number                   // kg/m³ — density at atmospheric pressure
}
```

**The five forces on every particle, every tick:**

**1. Pressure force** — particles in high-density regions push outward toward low-density regions. This prevents liquid from compressing into a single point and makes it spread out to fill containers.

Formula: `F_pressure = -∇P / ρ`

Pressure is computed from density using the Tait equation of state:
`P = B · ((ρ/ρ₀)^γ - 1)` where B is a stiffness constant, ρ₀ is rest density, γ ≈ 7 for water.

This is the same equation used in real computational fluid dynamics. It produces the correct behavior: water is nearly incompressible (high B), so even small density increases create large pressure forces that push particles apart.

**2. Viscosity force** — particles drag on their neighbors, resisting relative motion. High viscosity = honey, lava. Low viscosity = water, alcohol. Zero viscosity = superfluid helium (unreachable in-game).

Formula: `F_viscosity = μ · ∇²v` (Laplacian of velocity field, scaled by dynamic viscosity μ)

**The viscosity comes from the material's composition**, not from a hardcoded value per liquid type:
- Water (H₂O): μ ≈ 0.001 Pa·s at 20°C — hydrogen bonds are weak
- Molten copper: μ ≈ 0.004 Pa·s at 1100°C — metallic bonds broken by heat
- Molten glass (SiO₂): μ ≈ 10⁶ Pa·s at 1000°C — silicon-oxygen network barely broken
- Honey (sugar solution): μ ≈ 2–10 Pa·s — long sugar molecules tangle
- Lava (basaltic): μ ≈ 10–100 Pa·s — silicate networks partially intact

Temperature reduces viscosity for all materials (Arrhenius model: `μ = A · e^(Ea/RT)`). Hotter liquid flows faster. This is why lava near the vent flows quickly but slows to a crawl as it cools.

**3. Gravity** — particles fall toward the planet's center. On the sphere surface, this means flowing "downhill" — toward lower terrain elevation.

Formula: `F_gravity = m · g · down_direction`

On a sphere, the "down" direction is toward the planet center: `down = -normalize(position)`. The component of gravity along the terrain surface drives horizontal flow. The component into the terrain is balanced by the terrain's normal force (the ground pushes back).

**4. Surface tension** — particles at the liquid's surface are pulled inward by their neighbors, minimizing surface area. This is what makes water droplets spherical and allows insects to walk on water.

Formula: `F_surface = σ · κ · n̂` where σ is surface tension coefficient, κ is surface curvature, n̂ is surface normal.

Surface tension is computed from composition:
- Water: σ ≈ 0.073 N/m (hydrogen bonds pull surface inward)
- Molten iron: σ ≈ 1.8 N/m (strong metallic bonds)
- Mercury: σ ≈ 0.5 N/m (why mercury forms perfect spherical droplets)
- Ethanol: σ ≈ 0.022 N/m (weak intermolecular forces)

When two different liquids meet, the difference in surface tension drives **Marangoni flow** — liquid flows from low surface tension to high. This is why soap breaks water tension (soap has lower σ, water flows away from it, creating the spreading pattern).

**5. Terrain collision** — particles cannot pass through the ground. When a particle's position would be below the terrain surface, it is pushed to the surface and its velocity component into the terrain is zeroed (with friction applied to the tangential component).

This is what makes liquid pool in valleys, flow along riverbeds, and fill containers. The terrain acts as a rigid boundary that shapes the flow.

#### The SPH Algorithm (per tick)

```
for each particle i:
  1. Find neighbors within kernel radius h (~2× particle spacing)
     — use spatial hash grid for O(1) neighbor lookup

  2. Compute density:  ρᵢ = Σⱼ mⱼ · W(rᵢⱼ, h)
     where W is a smoothing kernel (cubic spline) and rᵢⱼ = |posᵢ - posⱼ|

  3. Compute pressure: Pᵢ = B · ((ρᵢ/ρ₀)^γ - 1)

  4. Compute forces:
     F_pressure  = -Σⱼ mⱼ · (Pᵢ/ρᵢ² + Pⱼ/ρⱼ²) · ∇W(rᵢⱼ, h)
     F_viscosity = μ · Σⱼ mⱼ · (vⱼ - vᵢ) / ρⱼ · ∇²W(rᵢⱼ, h)
     F_gravity   = m · g · (-normalize(posᵢ))
     F_surface   = σ · curvature · surface_normal  (only for surface particles)

  5. Integrate:
     vᵢ += dt · (F_pressure + F_viscosity + F_gravity + F_surface) / mᵢ
     posᵢ += dt · vᵢ

  6. Terrain collision:
     if (length(posᵢ) < PLANET_RADIUS + terrainHeight(posᵢ)):
       push particle to surface, apply friction

  7. Temperature exchange:
     — particles exchange heat with neighbors (Fourier's law: Q = k·A·ΔT/d)
     — particles exchange heat with terrain and air
     — if temperature crosses melting point → phase transition (see below)
```

**The kernel function W** is the mathematical smoothing function that defines "how much influence does a neighbor have." Closer neighbors have more influence. The standard choice is the cubic spline kernel, which is smooth, compact (zero outside radius h), and computationally cheap.

#### Phase Transitions: Solid ↔ Liquid ↔ Gas

Phase transitions connect the fluid simulation to the material packet system (§3.3). They are the bridge between the static world of solids and the dynamic world of fluids.

**Melting (solid → liquid):**
```
When a solid material packet reaches temperature ≥ meltingPoint(composition):
  1. The solid packet is removed from the world
  2. N SPH particles are spawned at its position
     — N = mass / particleMass (particleMass is a resolution parameter, e.g., 0.01 kg)
     — Each particle inherits: composition, temperature, mass/N
     — Particles are placed in a tight cluster matching the solid's shape
     — Particles get zero initial velocity (they start motionless, then flow under gravity)
  3. The SPH simulation takes over — particles flow, pool, splash
```

**Freezing (liquid → solid):**
```
When a cluster of SPH particles cools below meltingPoint(composition):
  1. Identify connected clusters of cold particles (particles within kernel radius of each other)
  2. Each cluster merges into a single solid packet:
     — mass = sum of particle masses
     — composition = mass-weighted average of particle compositions
     — position = center of mass of the cluster
     — shape = convex hull of particle positions (or simplified bounding shape)
  3. The solid packet is placed in the world; particles are removed
```

**Boiling (liquid → gas):**
```
When a particle reaches temperature ≥ boilingPoint(composition):
  1. Particle expands: kernel radius increases, restDensity drops dramatically
  2. Upward buoyancy force added (hot gas rises)
  3. If particle rises above terrain + threshold → convert to gas system
     — Gas particles have much larger spacing, lower interaction frequency
     — Eventually fade out at high altitude (absorbed into atmosphere model)
```

**Condensation (gas → liquid):**
```
When gas-phase particles cool below boilingPoint:
  1. Particles contract: kernel radius shrinks, restDensity increases
  2. Surface tension kicks in → droplets form
  3. Droplets fall under gravity → rain
```

**Sublimation and deposition** (solid ↔ gas, skipping liquid) also emerge naturally. Dry ice (solid CO₂) sublimates because its phase diagram has no liquid phase at 1 atm. The simulation checks: at current pressure, does a liquid phase exist between solid and gas? If not, the solid transitions directly to gas particles.

#### Multi-Scale Fluid System

One simulation method cannot efficiently handle all scales of liquid in the game. A raindrop and an ocean are both water, but simulating an ocean with SPH particles would require billions of particles. Instead, the game uses different methods at different scales, with smooth transitions between them.

**Scale 1 — Crafting (SPH particles, 100–2,000 particles)**

This is the most interactive scale. The player directly manipulates liquid:
- Melting ore in a bloomery → molten metal flows into a channel
- Pouring molten copper into a stone mold → casting
- Mixing two chemicals in a clay pot → the liquids swirl together
- Boiling water → steam rises, water level drops
- Quenching hot steel → dramatic sizzle, steam cloud

SPH runs at 60 Hz in a Web Worker. 2,000 particles × 50 neighbors × 5 forces = 500,000 operations per tick. At ~10 FLOPs each = 5 MFLOP per tick. A single CPU core does 1–5 GFLOP/s. Cost: < 1% of one core.

**Scale 2 — Local environment (SPH particles, 2,000–20,000 particles)**

Environmental liquid near the player:
- Rain hitting the ground and forming puddles
- A small waterfall or creek
- Blood pooling from a killed animal
- Spilled liquid from a broken container
- A hot spring with steam

SPH runs at 30 Hz in a dedicated Web Worker (separate from crafting). 20,000 particles at 30 Hz is ~30 MFLOP per tick — still cheap on a modern CPU. On a GPU compute shader (WebGPU), this could reach 200,000+ particles.

**Scale 3 — Regional (grid-based, Eulerian)**

Rivers, lakes, and large water bodies. Too many particles for SPH — switch to a grid where each cell tracks water volume and flow direction.

```
GridCell {
  waterVolume: number     // m³ of water in this cell
  flowX, flowZ: number    // velocity of water flow (m/s)
  temperature: number     // °C
  composition: Map<Element, number>   // dissolved minerals, pollutants
  depth: number           // computed: waterVolume / cellArea
}
```

Rules per tick (0.5–1 Hz — slow, large scale):
- Water flows from high cells to low cells (terrain height + water depth)
- Flow rate depends on slope (Manning's equation: `v = (1/n) · R^(2/3) · S^(1/2)` where n is roughness, R is hydraulic radius, S is slope)
- Evaporation removes water based on temperature and humidity
- Rain adds water based on weather system (§6)
- Rivers defined by RiverSystem.ts are permanent flow paths with base flow rates

This extends the existing `fluid.worker.ts` and `RiverSystem.ts`. The grid is the same 3D grid already initialized in the worker — it just needs water-specific logic added.

**Scale 4 — Global (mathematical model, no particles or grid)**

Ocean currents, tides, deep water temperature. These are too large and slow for real-time simulation. Instead, they are modeled as:
- Ocean surface: Gerstner wave shader (already built — `OceanShader.ts`)
- Currents: pre-computed flow field based on continent positions and Coriolis effect
- Tides: sinusoidal sea level variation driven by moon position (simple formula)
- Deep ocean temperature: latitude-based gradient (cold at poles, warm at equator)

No per-frame simulation cost. Just math evaluated when needed.

#### Scale Transitions

The critical engineering challenge is smooth transitions between scales. A raindrop (SPH) must be able to join a puddle (SPH), which grows into a stream (grid), which feeds a river (grid), which reaches the ocean (shader). Going backward must also work: a player scoops water from a river (grid → SPH packet).

**SPH → Grid (particle absorption):**
```
When an SPH particle enters a grid cell that already contains water:
  1. Add particle's mass to cell's waterVolume
  2. Add particle's momentum to cell's flow velocity (momentum-conserving)
  3. Mix particle's composition into cell's composition (mass-weighted average)
  4. Mix particle's temperature into cell's temperature
  5. Remove the SPH particle
```

Trigger condition: particle velocity < threshold AND particle is in a cell with waterVolume > threshold. This means fast-moving water (waterfalls, splashes) stays as particles. Slow, settled water becomes grid cells.

**Grid → SPH (particle emission):**
```
When a player interacts with a grid cell (scoop, dig channel, break dam):
  1. Remove requested mass from cell's waterVolume
  2. Spawn N SPH particles with that mass, inheriting cell's composition and temperature
  3. Particles get initial velocity matching the cell's flow direction
```

Also triggered when water flows over a cliff edge (waterfall): grid cells at the edge emit SPH particles that fall freely until they hit water below (absorbed back into grid) or terrain (splash → pool → eventually grid again).

**Grid → Shader (ocean boundary):**
```
Grid cells at the ocean boundary do not store water — they connect to the ocean.
River grid cells that reach sea level feed their flow volume into the ocean's
total water budget (affecting sea level over very long timescales).
The ocean shader reads sea level from the simulation state.
```

#### Mixing and Reactions in Liquid

When two SPH particles of different composition are neighbors, they can mix and react — using the same reaction engine from §3.3.

**Diffusion (passive mixing):**
Each tick, neighboring particles exchange a small fraction of their composition proportional to their contact area and the diffusion coefficient. Over time, two adjacent liquids homogenize. Stirring (player action or turbulent flow) increases the mixing rate by bringing distant particles into contact.

```
mixRate = D · dt · W(rᵢⱼ, h) / distance
particle_i.composition += mixRate · (particle_j.composition - particle_i.composition)
particle_j.composition += mixRate · (particle_i.composition - particle_j.composition)
```

where D is the diffusion coefficient (depends on temperature and the materials involved).

**Reactions in liquid phase:**
When two particles' mixed composition satisfies a reaction condition (§3.3 reaction engine — Gibbs free energy check), the reaction fires:
- Acid dissolves metal: HCl particles + Fe particles → FeCl₂ solution + H₂ gas bubbles
- Salt dissolves in water: NaCl solid particles near H₂O particles → Na⁺ and Cl⁻ dissolve into water composition
- Oil and water refuse to mix: if immiscible (ΔG of mixing > 0), particles repel at the interface instead of diffusing

**Density-driven layering:**
Denser liquid sinks, lighter liquid floats. Oil floats on water. Molten slag floats on molten iron (this is how real smelting separates metal from waste). The SPH pressure force naturally produces this layering because denser particles create higher pressure at the bottom.

#### What the Player Sees

The visual representation of fluid adapts to scale:

**SPH particles (crafting and local):**
- Each particle renders as a small sphere (metaball rendering for smooth appearance)
- Color derived from composition: water = blue-clear, molten copper = orange-red glow, blood = dark red, oil = dark brown
- Temperature → emissive glow: particles above 500°C glow red, above 1000°C glow orange-white
- Surface particles have specular highlights (Fresnel reflection, same as OceanShader.ts)
- Metaball blobbing: nearby particles visually merge into a smooth surface (marching cubes or screen-space fluid rendering)

**Grid cells (regional):**
- Water surface mesh generated from grid cells with waterVolume > 0
- Surface height = terrain height + water depth
- Uses the existing OceanShader.ts material (Gerstner waves scaled down for rivers/lakes)
- River foam where flow speed is high (reuse the foam noise from OceanShader.ts)

**Ocean (global):**
- Unchanged from current implementation: sphere mesh + Gerstner wave vertex displacement + Fresnel + caustics

#### Terrain Interaction: The Container Problem

Liquid needs surfaces to contain it. The terrain height field on the sphere is the primary container. But natural terrain has features that matter for fluid:

**Concavities (valleys, bowls, craters):**
Water pools wherever the terrain forms a local minimum — a point lower than all its neighbors. The grid-based simulation finds these automatically: water flows into the cell and has nowhere lower to go, so it accumulates. Water depth rises until it reaches the lowest outflow point (the rim of the bowl), then spills over and continues flowing.

**Player-made containers:**
When a player digs (removes terrain) or builds (adds terrain), they modify the height field. A trench becomes a channel. A ring of piled dirt becomes a dam. A clay pot (crafted object with concave interior) becomes a vessel. The fluid system treats all of these the same way: particles cannot penetrate solid surfaces, so they pool inside whatever shape the surface creates.

**Porosity:**
Not all terrain is waterproof. Sand absorbs water (high porosity). Clay blocks water (low porosity). Rock is somewhere in between. The grid simulation can model this:
```
absorption = porosity · waterVolume · dt
waterVolume -= absorption
groundwaterLevel += absorption  // water table rises
```

This produces springs (groundwater pressure pushes water to the surface where terrain is lower than the water table) and explains why clay-lined channels hold water better than dirt channels.

#### The Complete Water Cycle

When all scales work together, the full hydrological cycle emerges:

```
EVAPORATION: Ocean + lakes + rivers lose water (temperature + surface area + wind)
  ↓ water vapor enters atmosphere
CLOUD FORMATION: Vapor rises, cools below dew point, condenses
  ↓ water droplets aggregate into clouds (weather system §6)
PRECIPITATION: Clouds release water as rain (liquid) or snow (solid)
  ↓ SPH particles fall from sky (Scale 1-2)
SURFACE FLOW: Rain hits terrain, flows downhill
  ↓ SPH particles merge into grid cells (Scale 2 → Scale 3)
RIVERS: Grid cells with persistent flow form rivers
  ↓ matches RiverSystem.ts flow paths
LAKES: Water accumulates in terrain concavities
  ↓ grid cells fill up, overflow feeds downstream rivers
OCEAN: Rivers discharge into the ocean (Scale 3 → Scale 4)
  ↓ ocean level adjusts over long timescales
GROUNDWATER: Some rain absorbs into porous terrain
  ↓ feeds springs, wells, and maintains river base flow in dry season
```

No part of this cycle is scripted. It all follows from the physics: gravity pulls water down, heat drives evaporation, cooling drives condensation, terrain shape determines where water collects and flows. The weather system (§6) provides precipitation. The fluid simulation handles everything after the raindrop forms.

#### Lava: Liquid Rock

Volcanic eruptions produce lava — molten rock flowing on the surface. In this system, lava is not a special case. It is a material packet (composition: silicate minerals) that has been heated above its melting point (~700–1200°C depending on composition).

```
MAGMA CHAMBER: high-temperature material packets deep underground (world generation)
  ↓ volcanic event (triggered by tectonic simulation or random with geological probability)
ERUPTION: packets surface → temperature > melting point → fragment into SPH particles
  ↓ particles flow downhill (very high viscosity — basaltic: μ ≈ 100 Pa·s, rhyolitic: μ ≈ 10⁶ Pa·s)
COOLING: particles lose heat to air and terrain → temperature drops
  ↓ viscosity increases exponentially as temperature drops (Arrhenius)
SOLIDIFICATION: temperature crosses solidus → particles freeze into solid terrain
  ↓ new rock with composition determined by the original magma
```

Basaltic lava (low silica) flows fast and far — like Hawaiian eruptions. Rhyolitic lava (high silica) barely moves — it piles up into domes. The difference is entirely from composition → viscosity. The simulation handles both with the same code.

Lava flowing over water produces instant steam (boiling) + rapid cooling of the lava surface → obsidian (amorphous glass, because cooling was too fast for crystals to form). This emergent behavior falls out naturally from the phase transition and heat exchange rules.

#### Performance Budget

| Scale | Method | Particle/cell count | Tick rate | CPU cost per tick | Worker |
|-------|--------|-------------------|-----------|-------------------|--------|
| Crafting | SPH | 100–2,000 | 60 Hz | < 1 ms | Shared with game loop or dedicated |
| Local env | SPH | 2,000–20,000 | 30 Hz | 2–5 ms | Dedicated Web Worker |
| Regional | Grid | 10,000–50,000 cells | 1 Hz | 5–10 ms | Existing fluid.worker.ts |
| Global | Math | 0 | On demand | < 0.1 ms | Main thread |
| **Total** | | | | **< 15 ms** at peak | **3 workers max** |

On a GPU (WebGPU compute shaders, when available): SPH particle count can increase 10–100× for the same cost. 200,000 local environment particles at 30 Hz is feasible on a mid-range GPU.

The server (for shared world state) only needs to run Scale 3 (grid) and Scale 4 (math). Crafting-scale and local-scale SPH run on the client only — they are visual and player-local. The server broadcasts grid cell water levels in the WORLD_SNAPSHOT, and clients generate local SPH particles for visual detail.

#### Critical Optimizations

The SPH algorithm is simple. Making it run at 60 Hz in a browser is the engineering challenge. These optimizations are not optional improvements — they are the architectural foundation without which the system cannot function at interactive frame rates.

**1. Spatial Hash Grid — O(n²) → O(n)**

The most important single optimization. SPH requires every particle to find its neighbors within kernel radius h. Naive approach: check every particle against every other particle. With 5,000 particles, that's 25,000,000 distance checks per tick — impossible at 60 Hz.

Spatial hash grid: divide the world into cells of size h. Each particle hashes its position to a cell index. To find neighbors, only check the particle's own cell and the 26 adjacent cells (3×3×3 neighborhood). Average neighbor check drops from n to ~50 particles.

```
// Hash function: position → cell index
function hashCell(x, y, z, cellSize) {
  const ix = Math.floor(x / cellSize)
  const iy = Math.floor(y / cellSize)
  const iz = Math.floor(z / cellSize)
  return (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)
}

// Each tick:
// 1. Clear hash table
// 2. Insert all particles by position hash
// 3. For each particle, query only 27 neighboring cells
```

Cost reduction: 5,000 particles goes from 25M distance checks → ~250K. That's a 100× speedup. This is the difference between "impossible" and "trivial."

**2. Sleep/Wake System — Skip Settled Particles**

A particle that hasn't moved significantly for N consecutive ticks is "sleeping." Skip all force calculations for sleeping particles. They cost zero CPU until disturbed.

```
if (particle.velocity < SLEEP_THRESHOLD for 30 consecutive ticks):
  particle.sleeping = true
  // skip all SPH calculations for this particle

if (any neighbor of sleeping particle moves significantly):
  particle.sleeping = false  // wake up
```

In practice, 80–95% of fluid particles are sleeping at any moment. A puddle that settled 10 seconds ago has zero ongoing cost. Only the actively flowing portion of a liquid body costs CPU.

**3. Flat Typed Arrays — Avoid JavaScript Object Overhead**

Do NOT store particles as JavaScript objects (`{ x, y, z, vx, vy, vz, ... }`). Object access in JS involves property lookup, hidden class checks, and potential garbage collection pauses.

Instead: store all particle data in flat `Float32Array` buffers. One contiguous array for positions, one for velocities, one for densities.

```
// Bad — JS objects, GC pressure, cache misses
particles = [{ x: 1, y: 2, z: 3, vx: 0, ... }, ...]

// Good — flat typed arrays, SIMD-friendly, zero GC
const STRIDE = 3
posX = new Float32Array(MAX_PARTICLES)  // or interleaved: pos = new Float32Array(MAX * 3)
posY = new Float32Array(MAX_PARTICLES)
posZ = new Float32Array(MAX_PARTICLES)
velX = new Float32Array(MAX_PARTICLES)
velY = new Float32Array(MAX_PARTICLES)
velZ = new Float32Array(MAX_PARTICLES)
```

Benefits:
- CPU cache-friendly (sequential memory access)
- Enables SIMD auto-vectorization (V8 can process 4 floats at once)
- Zero garbage collection (no object allocation per tick)
- Direct transfer to GPU via SharedArrayBuffer (zero-copy)
- ~3–5× faster than object-based approach in V8

**4. Web Workers + SharedArrayBuffer — Off Main Thread, Zero Copy**

The fluid simulation must NEVER run on the main thread. It runs in a dedicated Web Worker. The renderer (main thread) reads particle positions to draw them.

With `SharedArrayBuffer`, the worker writes particle positions directly into shared memory. The main thread reads from the same memory to render. No copying, no message passing, no serialization.

```
// Main thread: create shared buffer
const sharedBuf = new SharedArrayBuffer(MAX_PARTICLES * 3 * 4)  // xyz, float32
const positions = new Float32Array(sharedBuf)

// Send to worker once at startup
worker.postMessage({ type: 'init', buffer: sharedBuf })

// Worker: write positions every tick (no postMessage needed)
positions[i * 3 + 0] = particleX
positions[i * 3 + 1] = particleY
positions[i * 3 + 2] = particleZ

// Renderer: read positions every frame (same memory, zero copy)
geometry.attributes.position.array = positions
geometry.attributes.position.needsUpdate = true
```

Cost: effectively zero for data transfer. The only synchronization needed is an `Atomics.store/load` on a tick counter so the renderer knows when new data is ready.

**5. Physics LOD — Distance-Based Quality Reduction**

Particles far from the player don't need full-accuracy physics:

| Distance from player | Tick rate | Neighbor search | Notes |
|---|---|---|---|
| 0–20 m | 60 Hz | Full (27 cells) | Player is watching closely |
| 20–50 m | 15 Hz | Reduced (7 cells — face neighbors only) | Visible but not scrutinized |
| 50–100 m | 2 Hz | Minimal (own cell only) | Background movement |
| > 100 m | Convert to grid | No SPH | Too far to see individual particles |

This reduces the effective particle count by ~60% in typical gameplay (most fluid is not right next to the player).

**6. Hybrid Rendering: Real Physics + Visual Tricks**

The most important optimization is knowing **when NOT to simulate**. Real SPH physics only runs during active interaction moments. Everything else uses cheap visual approximations:

| Situation | Physics method | Visual method |
|---|---|---|
| Player melting/pouring metal | Real SPH (200-500 particles) | Screen-space fluid smoothing on SPH particles |
| Player mixing chemicals | Real SPH + diffusion | Color blending shader on SPH particles |
| Rain falling | None | GPU billboard particle system (thousands of quads, no physics) |
| Rain puddles forming | Heightfield (add volume to grid cell) | Puddle decal texture + animated ripple shader |
| River | Grid flow (volume + direction) | River mesh + scaled-down Gerstner waves from OceanShader |
| Waterfall | None | Particle trail effect + splash particles + foam texture at base |
| Lake | Grid cell (single water volume number) | Flat mesh at water height + wave shader + edge foam |
| Ocean | None | Pure Gerstner wave shader (already built in OceanShader.ts) |
| Lava (active flow front) | Real SPH (2,000-5,000 particles) | Emissive shader + heat distortion + cooled parts become terrain texture |
| Lava (cooled) | None | Terrain with volcanic rock texture |
| Blood | None | Decal projected onto terrain surface |
| Water carried in pot | Just a number (mass + composition) | Sloshing animation shader on the pot model |

The SPH system activates only when needed (phase transition triggers it) and deactivates when particles settle (sleep system) or cool into solids (merge back into material packets). During a typical gameplay session, SPH is actively running for maybe 10% of the time — during smelting, pouring, or weather events. The other 90% costs zero.

**Screen-space fluid rendering** (for the moments when SPH is active):
1. Render each SPH particle as a point sprite into a depth-only buffer
2. Bilateral Gaussian blur on the depth buffer — this smooths overlapping spheres into a continuous surface
3. Reconstruct normals from the smoothed depth
4. Apply water/metal/lava shading (Fresnel, refraction, emissive glow) as a full-screen pass
5. Composite over the scene

This technique is used by Unreal Engine 5, Unity HDRP, and most modern games with fluid effects. The blur cost is per-pixel (fixed cost regardless of particle count), making it extremely efficient. 5,000 particles render at the same cost as 500.

#### Implementation Phases

**Phase 1 — Crafting-scale SPH (connect to material packets)**
- Implement SPH solver in a Web Worker (pressure, viscosity, gravity, terrain collision)
- Hook into material packet phase transitions: solid → liquid spawns particles, cooling merges them back
- Visual: simple sphere rendering per particle with composition-based color
- Test: melt copper ore in bloomery → molten copper flows into a channel → cools into solid

**Phase 2 — Local environment SPH**
- Dedicated worker for environmental particles (rain, puddles, small streams)
- Add surface tension for realistic droplet behavior
- Metaball rendering for smooth liquid surfaces
- Connect to weather system: rain events spawn falling particles

**Phase 3 — Grid-based regional water**
- Extend fluid.worker.ts with water volume tracking, Manning's equation flow
- SPH ↔ grid transitions (particle absorption / emission)
- Lakes form in terrain concavities, overflow creates rivers
- Server syncs grid state in WORLD_SNAPSHOT

**Phase 4 — Full water cycle**
- Evaporation from water surfaces → feeds weather system humidity
- Groundwater absorption and springs
- Seasonal variation (freeze/thaw cycle)
- Connect ocean shader to grid system at coastlines

**Phase 5 — Lava and exotic fluids**
- Volcanic events spawn high-temperature SPH particles
- Lava cooling → terrain modification (new rock forms)
- Molten metal in industrial processes (blast furnace, casting)
- Acid, oil, alcohol — all derived from composition, no special cases


### 3.3 Sound Engine — Physics-Driven Audio

#### The Principle

Every sound in the real world is produced by a physical event: two objects collide and their surfaces vibrate, a fluid turbulates as it flows past an obstacle, air rushes through a narrow opening. The frequency, timbre, and volume of the resulting sound are determined by the physical properties of the objects and the medium.

The game follows the same principle. There is no `sounds/` folder with `campfire_loop.wav` or `footstep_dirt_03.mp3` mapped to game events. Instead, the **audio engine computes what you should hear** from the physics of what is happening.

#### The Audio Pipeline

```
PhysicsEvent → SoundDescriptor → SampleSelector → AudioProcessor → WebAudio → Speakers

Step 1: PhysicsEvent
  Any physics interaction generates an event:
  { type: 'impact'|'scrape'|'flow'|'break'|'combustion'|'pressure_release',
    materialA: MaterialPacket,        // first material involved
    materialB: MaterialPacket | null, // second material (null for single-material events like cracking)
    energy: number,                   // joules of the interaction
    contactPoint: Vec3,               // world position where it happened
    contactNormal: Vec3,              // surface normal at contact
    relativeVelocity: Vec3 }          // approach speed and direction

Step 2: SoundDescriptor
  Computed from the physics event + material properties:
  {
    // ── Timbre Selection ────────────────────────────────────────────────────
    // Based on material classification + hardness
    timbreClass: computeTimbreClass(materialA, materialB)
    // Classes: 'metallic', 'lithic' (stone/ceramic), 'organic' (wood/bone/leather),
    //          'granular' (sand/gravel/soil), 'liquid', 'gas' (wind/steam/explosion)

    // ── Pitch ───────────────────────────────────────────────────────────────
    // Fundamental frequency from object size and material stiffness
    // f₀ = (1/2L) × √(E/ρ)  where:
    //   L = characteristic length of the vibrating object (m)
    //   E = Young's modulus (Pa) — derived from material hardness and crystal structure
    //   ρ = density (kg/m³) — from MaterialPacket
    fundamentalFreq: computeF0(materialA)     // Hz
    // A small stone chip: L=0.03m, E=70GPa, ρ=2700 → f₀ ≈ 2700 Hz (high ping)
    // A large iron anvil: L=0.5m, E=200GPa, ρ=7800 → f₀ ≈ 320 Hz (deep ring)
    // A wooden log: L=1.0m, E=12GPa, ρ=600 → f₀ ≈ 70 Hz (low thud)

    // ── Volume ──────────────────────────────────────────────────────────────
    // Sound power from impact energy
    // P_sound = η × E_impact / t_contact  where:
    //   η = acoustic efficiency (metal: 0.01, stone: 0.005, wood: 0.002, sand: 0.0001)
    //   E_impact = ½mv² (kinetic energy of impact)
    //   t_contact = contact duration (harder materials = shorter = louder)
    soundPower: computePower(energy, materialA, materialB)   // watts

    // ── Decay ───────────────────────────────────────────────────────────────
    // How quickly the sound dies out
    // Metal: long decay (ringing), τ = 2-5 seconds
    // Stone: medium decay, τ = 0.1-0.5 seconds
    // Wood: short decay, τ = 0.05-0.2 seconds
    // Soft materials: nearly instant, τ < 0.05 seconds
    decayTime: computeDecay(materialA)   // seconds (time to -60dB)
  }

Step 3: SampleSelector
  The engine has a library of ~50 base audio samples organized by timbre class:

  metallic_impact[]: 5 samples (light tap to heavy strike)
  metallic_scrape[]: 3 samples (slow to fast)
  metallic_ring[]:   3 samples (small to large resonator)
  lithic_impact[]:   5 samples
  lithic_crack[]:    3 samples
  lithic_grind[]:    3 samples
  organic_impact[]:  5 samples (wood knock to bone crack)
  organic_creak[]:   3 samples
  granular_step[]:   5 samples (packed to loose)
  granular_pour[]:   3 samples
  liquid_splash[]:   5 samples (drip to pour)
  liquid_flow[]:     3 samples (trickle to rush)
  liquid_bubble[]:   3 samples
  gas_rush[]:        3 samples (breeze to blast)
  gas_hiss[]:        3 samples
  combustion[]:      5 samples (spark to roar)

  Selection: timbreClass + energy level → pick the closest base sample
  Total: ~55 samples. Compared to typical games that ship 500-2000 samples,
  this is 10× smaller because the variation comes from processing, not recording.

Step 4: AudioProcessor
  The selected sample is transformed in real-time by the WebAudio API:

  // Pitch shift to match computed fundamental frequency
  playbackRate = fundamentalFreq / sampleBaseFreq

  // Volume from sound power + distance attenuation
  // Inverse square law: I = P / (4π r²) where r = distance from source to listener
  gain = soundPower / (4 * Math.PI * distance² + 1)   // +1 prevents division by zero at contact
  // Clamp to [0, 1] for output

  // Decay envelope: exponential falloff
  // gain(t) = gain₀ × e^(-t/τ) where τ = decayTime

  // Environment filtering:
  if (underwater) {
    // Low-pass filter at 800 Hz (water absorbs high frequencies)
    // Speed of sound: 1500 m/s (vs 343 m/s in air) — affects spatial delay
    lowpassCutoff = 800
    speedOfSound = 1500
  } else if (inCave) {
    // Convolution reverb with cave impulse response
    // Reverb time: proportional to cave volume (estimated from nearest walls raycast)
    reverbTime = estimateCaveVolume(listenerPosition) * 0.001  // seconds
    reverbWetMix = 0.6
  } else if (inForest) {
    // Scattered reflections: short multi-tap delay (tree trunks)
    // High-frequency absorption from foliage
    lowpassCutoff = 4000
    scatterDelay = [20, 35, 55, 80]  // ms, from nearby tree reflections
    scatterGain = [0.3, 0.2, 0.15, 0.1]
  } else {
    // Open field: dry sound, no reverb
    reverbWetMix = 0.0
  }
```

#### Continuous Sounds (Not Impacts)

Some sounds are ongoing processes, not single events:

```
ContinuousSoundSources {
  // ── Fire ──────────────────────────────────────────────────────────────────
  // Fire sound = turbulent gas flow + crackling (moisture in wood popping)
  // Volume: proportional to fire intensity (fuel burn rate × oxygen supply)
  // Pitch: base rumble at 80-200 Hz (turbulence), crackle overlays at 1-4 kHz
  // The crackle rate depends on wood moisture content:
  //   dryWood (moisture < 0.1): rare crackles, clean burn sound
  //   wetWood (moisture > 0.4): frequent loud pops, hissing steam overlay
  fire: {
    baseFreq: 80 + fuelBurnRate * 120,       // Hz
    crackleRate: woodMoisture * 10,           // pops per second
    hissOverlay: woodMoisture > 0.3,          // steam hiss from wet wood
    volume: fuelBurnRate * 0.5                // normalized
  }

  // ── Flowing Water ─────────────────────────────────────────────────────────
  // Sound of water = turbulence at obstacles
  // Volume: proportional to flow speed × cross-section area
  // Pitch: small stream = high (2-4 kHz babble), large river = low (100-400 Hz rumble)
  // River sound uses the queryNearestRiver() data from RiverSystem.ts:
  water: {
    baseFreq: 4000 / (riverWidth + 1),        // narrower = higher pitch
    turbulenceNoise: brownNoise,               // base waveform
    volume: flowSpeed * crossSection * 0.01,
    splashOverlay: flowSpeed > 2.0             // rapids add white noise bursts
  }

  // ── Wind ──────────────────────────────────────────────────────────────────
  // Wind sound = air flowing past the listener's ears and nearby objects
  // Pitch: proportional to wind speed (Aeolian tone: f = 0.2 × v / d, where d = object diameter)
  // Volume: proportional to v² (kinetic energy of air)
  // Variation: gusts modulate volume sinusoidally (period 3-8 seconds)
  wind: {
    baseFreq: 0.2 * windSpeed / 0.02,         // ear diameter ~2cm → Aeolian frequency
    volume: windSpeed * windSpeed * 0.001,
    gustModulation: sin(time * gustFreq) * 0.3 + 0.7,   // 70-100% volume oscillation
    objectWhistle: nearbyThinObjects.map(obj =>  // fence posts, branches whistle
      ({ freq: 0.2 * windSpeed / obj.diameter, volume: windSpeed * 0.01 }))
  }

  // ── Footsteps ─────────────────────────────────────────────────────────────
  // Generated per step from the walk cycle animation (foot contact event)
  footstep: {
    // Terrain material at foot contact point determines timbre class:
    terrainMaterial: getTerrainMaterialAt(footPosition)
    // stone/rock → lithic_impact, hard tap
    // sand → granular_step, soft crunch (pitch varies with grain size)
    // mud → liquid + granular mix, squelch (moisture content determines wet/dry balance)
    // grass → organic + granular, soft swish
    // wood (floor/dock) → organic_impact, hollow knock (pitch from plank thickness)
    // snow → granular, high-pitched crunch (compacting ice crystals)
    // metal (grating) → metallic_impact, sharp ring

    // Volume from player mass × step force
    // Running = 2× walking volume
    // Sneaking = 0.3× walking volume (also slower step frequency)
    volume: playerMass * stepForce * terrainLoudness[terrainType]
  }
}
```

#### Spatial Audio (3D Positioning)

```
SpatialAudio {
  // All sounds are positioned in 3D using WebAudio's PannerNode
  panningModel: 'HRTF'                      // Head-Related Transfer Function
                                              // Simulates how sound arrives at each ear differently
                                              // based on direction — enables "I hear it to my left"

  // Distance attenuation: inverse square law with rolloff
  distanceModel: 'inverse'
  refDistance: 1.0                            // full volume at 1 meter
  maxDistance: 200.0                          // silent beyond 200 meters
  rolloffFactor: 1.0                         // standard inverse-square (realistic)

  // Sound travels at finite speed (optional, for immersion):
  // delay = distance / speedOfSound
  // At 100m: delay = 100/343 = 0.29 seconds
  // Player sees lightning, then hears thunder 0.3s later per 100m distance
  // This is subtle but adds enormous realism for distant events (explosions, mining, thunder)
  propagationDelay: distance / (underwater ? 1500 : 343)   // seconds
}
```

#### Performance Budget

The audio system must stay within strict CPU limits:

| Component | Budget | How |
|-----------|--------|-----|
| SoundDescriptor computation | <0.1ms per event | Simple arithmetic on material properties — no iteration, no lookup tables |
| Sample selection | <0.05ms per event | Direct array index from timbre class + energy bucket |
| WebAudio processing | ~2-3ms total | Handled by browser's audio thread (not main thread). Typically 8-16 concurrent voices max. |
| Environment estimation | ~0.5ms per frame | Raycast cache for cave/forest/open classification. Recompute only when player moves >5m. |
| Total audio CPU | <1ms main thread | Most work happens on the browser's audio thread. Main thread only computes SoundDescriptors and sends them to WebAudio. |

**Voice limiting:** Maximum 16 simultaneous sounds. When a new sound would exceed the limit, the quietest (lowest gain after distance attenuation) sound is dropped. Continuous sounds (fire, river, wind) have reserved slots (max 4) and compete separately from transient sounds (impacts, footsteps).


### 3.4 Structural Physics — How Buildings Stand or Fall

Every structure is made of MaterialPackets (§3.1). Whether it stands or falls is determined by the same material properties that determine melting point and hardness: compressive strength, tensile strength, and shear strength. Gravity loads propagate downward through connections. Where stress exceeds material strength, blocks break and cascade collapse occurs. Arches convert tension to compression, allowing stone to span gaps. Foundations must match terrain bearing capacity. Weather decays materials over time — rain dissolves mud mortar, freeze-thaw cracks stone, fire destroys wood. See the full internal specification for force propagation algorithms, span limit formulas, and performance budgets.

### 3.5 Networking & Hybrid Rendering

#### The Principle

This is a real-world online simulation. The server is the world. The client is a window into that world — eyes and ears only. If the server doesn't know about it, it didn't happen. This prevents cheating and ensures all players experience the same reality.

#### Authority Model

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                         SERVER (Node.js)                             │
│                                                                              │
│  AUTHORITATIVE (server computes, broadcasts results):                        │
│  ├── All physics simulations                                                 │
│  │   ├── SPH fluid particles (melting, pouring, lava, water flow)           │
│  │   ├── Material packet reactions (Gibbs free energy, stoichiometry)        │
│  │   ├── Temperature propagation (heat transfer between objects)             │
│  │   ├── Rigid body physics (dropped items, thrown objects, digging debris)  │
│  │   └── Terrain collision and modification                                  │
│  ├── All entity state                                                        │
│  │   ├── Player positions (server validates movement)                        │
│  │   ├── Player stats (health, hunger, thirst, energy, stamina, temperature)│
│  │   ├── Player inventory (server controls all add/remove)                   │
│  │   ├── NPC state machines (goal loops, positions, carried items)           │
│  │   ├── Organism simulation (births, deaths, movement, feeding)            │
│  │   └── Dropped item positions and despawn timers                           │
│  ├── Weather and atmosphere (§6)                                           │
│  ├── Settlement economy (trade, population, resource stockpiles)             │
│  ├── Crafting validation (interaction engine runs server-side)               │
│  └── Death, loot drops, respawn timing                                       │
│                                                                              │
│  BROADCAST TO CLIENTS:                                                       │
│  ├── WORLD_SNAPSHOT (6 Hz): player positions, NPC positions, organism       │
│  │   positions, weather state, settlement state                              │
│  ├── PHYSICS_EVENT (as needed): SPH particle spawns/updates, material        │
│  │   reactions, temperature changes, terrain modifications                   │
│  ├── SOUND_EVENT (as needed): physics event descriptors for audio            │
│  │   { type, materialA, materialB, energy, position, contactNormal }        │
│  └── ENTITY_UPDATE (as needed): inventory changes, stat changes, deaths     │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│                         CLIENT (Browser, Three.js)                           │
│                                                                              │
│  RECEIVES AND RENDERS (never computes authoritative state):                  │
│  ├── Visual rendering                                                        │
│  │   ├── Terrain mesh from server-sent CHUNK_DATA (no local generation)      │
│  │   ├── Player/NPC body meshes at server-provided positions                 │
│  │   ├── SPH particle rendering (metaballs) from server particle positions   │
│  │   ├── Weather visuals (rain particles, snow, fog, clouds, lightning)      │
│  │   ├── Lighting (sun position from season/time, torches, campfires)        │
│  │   ├── Ocean shader (Gerstner waves — visual only, no physics)            │
│  │   └── UI panels (inventory, workstation, map)                             │
│  ├── Sound generation (§8.6)                                               │
│  │   ├── Receives SOUND_EVENT from server                                    │
│  │   ├── Computes audio parameters locally (pitch, volume, timbre)           │
│  │   ├── Spatial audio positioning from server-provided source position      │
│  │   └── Environment filtering (cave/forest/underwater) from local geometry  │
│  ├── Input capture                                                           │
│  │   ├── WASD + mouse → sends MOVE_INPUT to server                          │
│  │   ├── Click/interact → sends ACTION_REQUEST to server                     │
│  │   ├── Tool swing → sends TOOL_USE { target, position } to server         │
│  │   └── Drop/pour/place → sends corresponding request to server            │
│  └── Client-side prediction (for responsiveness)                             │
│      ├── Player movement is predicted locally, corrected by server          │
│      ├── Tool swing animation plays immediately, result comes from server   │
│      └── Camera and first-person arms are client-only (no server involved)  │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

#### Why Server-Authoritative Physics

- **Anti-cheat:** If the client computed reactions, a modified client could claim "I smelted gold from dirt." The server runs the reaction engine — the client only sees the result.
- **Consistency:** Two players watching the same smelting see the same outcome because the server computed it once.
- **Sound from physics:** Sound events are a byproduct of server physics. When an impact happens server-side, the server emits a `SOUND_EVENT` with the physics descriptor. The client's audio engine (§8.6) converts that into actual audio. The client hears what the server says happened — not what the client thinks happened.

#### Latency Mitigation

Server-authoritative physics adds latency. A player swings a pickaxe → request goes to server → server computes → result comes back. At 50ms round-trip, this is barely noticeable. At 200ms, it feels sluggish. Mitigations:

```
Client-Side Prediction {
  // Movement: client immediately moves the player mesh, server corrects if wrong
  // If server position diverges > 0.5m from client prediction → snap correction

  // Tool animations: client plays the swing animation immediately
  // The physical result (rock fragment, sparks, sound) waits for server confirmation
  // Typical delay: 30-80ms — fast enough that animation covers the gap

  // Crafting: client shows "processing..." immediately when player starts a craft
  // Server validates and returns result. If invalid, client shows failure feedback.

  // Pouring liquid: client shows a visual pour stream immediately
  // Actual SPH particles are spawned by server and streamed to client
  // Visual stream hides the 50ms gap before real particles appear
}
```

#### Bandwidth Budget

```
Per player, per second (steady state — not moving to new chunks):
  WORLD_SNAPSHOT (6 Hz):    ~2 KB × 6 = 12 KB/s     (positions, compressed)
  PHYSICS_EVENT (variable): ~0.5 KB average           (only during active physics)
  SOUND_EVENT (variable):   ~0.1 KB average           (compact descriptors)
  ENTITY_UPDATE (variable): ~0.2 KB average           (stat changes, inventory)
  Player input (upstream):  ~0.5 KB/s                 (movement + actions)

  Total per player (steady): ~13 KB/s downstream, ~0.5 KB/s upstream
  50 concurrent players: ~650 KB/s total server bandwidth

Per player, burst (entering new area):
  CHUNK_DATA (9 chunks):    ~90 KB burst              (one-time, cached after)
  This is a brief spike when the player moves into unexplored terrain.
  Chunks are cached on the client — subsequent visits to the same area cost nothing.

Per player, terrain modification:
  CHUNK_UPDATE:             ~10 KB per modified chunk  (rare — only when digging/building)

Per player, video stream mode (when active):
  H.264 hardware encoder (720p):      ~750 KB/s (~6 Mbit/s)    (replaces all other visual data)
  JPEG fallback:            ~2-3 MB/s                 (if MSE not supported)
  Sound data still sent separately as SOUND_EVENTs
```

#### Hybrid Rendering — Local 3D + Server Video Stream

##### The Problem

The client needs to show the world. Two extremes exist:

1. **Send state data, client renders 3D** — cheap bandwidth (~13 KB/s), but the client must reconstruct complex physics visuals (SPH particles, fire, debris, deforming materials) from abstract position data. This is hard. Thousands of SPH particles flowing in a crucible can't be faithfully rendered from just position arrays — the client would need the full physics context (material properties, surface tension, light interaction with molten metal) to make it look right. The result would either look wrong or require the client to run its own physics (which defeats server authority).

2. **Server renders everything, streams video** — pixel-perfect visuals, but costs ~750 KB/s per player and requires a GPU server. Works for complex scenes but wasteful for a player standing in a field looking at terrain.

Neither extreme is ideal. The hybrid approach uses each where it's strongest.

##### Two Rendering Modes

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  MODE 1: State + Shader Rendering (default, ~90% of play time)             │
│                                                                             │
│  Used when: exploring, walking, standing on a beach, watching weather,     │
│             looking at a campfire, rain falling, rivers flowing, ocean      │
│             waves, wind blowing through trees — the full living world      │
│                                                                             │
│  Server sends: WORLD_SNAPSHOT + CHUNK_DATA + ENTITY_UPDATE                 │
│                + ENVIRONMENT_STATE (wind, rain, fire positions, flow       │
│                  vectors, temperature field)                                │
│  Client does:  Full 3D rendering with GPU shaders that make the world     │
│                look REAL:                                                   │
│                                                                             │
│    TERRAIN:     Meshes with PBR materials, normal maps                     │
│    OCEAN:       Gerstner wave shader — realistic waves responding to wind  │
│                 Foam, Fresnel reflections, depth transparency, shore wash  │
│    RIVERS:      Flow shader driven by server flow vectors, foam at rocks   │
│    RAIN:        GPU particle system — 10,000+ raindrops, splash on contact│
│    SNOW:        Particle system, accumulation shader on terrain            │
│    FIRE:        Billboard particles, emissive glow, point light, smoke    │
│    WIND:        Vertex displacement on grass and trees from server wind    │
│    FOG:         Exponential distance fog from server weather               │
│    CLOUDS:      Scrolling noise layers, density from server                │
│    CHARACTERS:  Animated skeletal meshes at server positions               │
│    LIGHTING:    Sun, dynamic shadows, point lights from fires/torches     │
│    DAY/NIGHT:   Atmospheric scattering sky shader, stars at night         │
│                                                                             │
│  The world looks FULLY REAL in Mode 1. A player on a beach sees waves     │
│  crashing, foam washing up, rain falling, wind bending grass, firelight   │
│  flickering. This is the normal, full-quality game experience.             │
│                                                                             │
│  What the client CANNOT do in Mode 1 (only interactive physics):           │
│    - SPH fluid the player is actively pouring or mixing                    │
│    - Molten metal flowing into a mold (shape depends on simulation)        │
│    - Material deforming under hammer blows (precision craft)               │
│    - Clay being shaped on a wheel (player-driven deformation)              │
│                                                                             │
│  Bandwidth: ~15 KB/s steady + ~90 KB burst for new chunks                  │
│  Client needs: GPU (any modern integrated GPU handles these shaders)       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  MODE 2: Video Stream (only for interactive physics, ~10% of play time)    │
│                                                                             │
│  Used ONLY when the player is directly interacting with physics:            │
│    - Precision crafting: shaping clay, knapping flint, forging metal       │
│    - Pouring liquid from one container to another                           │
│    - Smelting: watching ore melt and metal separate from slag               │
│    - Active lava flow deforming terrain in front of the player              │
│                                                                             │
│  NOT used for: ocean waves, campfire, rain, walking through forest —       │
│                all of these look great in Mode 1 with GPU shaders.          │
│                                                                             │
│  Server does: renders the scene on its GPU                                 │
│               encodes H.264 via hardware encoder                            │
│               streams frames over WebSocket                                 │
│  Client does: decodes video and displays it                                │
│               still captures and forwards player input                      │
│               still plays sound from SOUND_EVENTs                           │
│                                                                             │
│  Bandwidth: ~750 KB/s (H.264) or ~2-3 MB/s (JPEG fallback)               │
│  Server needs: GPU with hardware encoder                                   │
│  Client needs: just a browser (no GPU required)                            │
│                                                                             │
│  Why video is needed here: the player is CREATING the visual result.       │
│  When you pour copper into a mold, the shape depends on SPH simulation.    │
│  A shader can't fake that — it must be computed and shown.                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

##### When and How the Switch Happens

The switch between modes is triggered by **the player's actions**, not by scene complexity analysis. This makes it predictable and clean.

```
Mode Switch Triggers {
  // ── State → Video (player enters a physics-heavy context) ─────────────────

  trigger_1: "Player presses F at a workstation"
    // Camera zooms into the workstation (§8.14 precision craft mode)
    // During the zoom animation (0.5s), the server:
    //   1. Starts rendering this player's view on the GPU
    //   2. Begins encoding H.264 frames
    //   3. Sends MODE_SWITCH { mode: 'video' } to client
    // Client:
    //   1. Receives MODE_SWITCH
    //   2. Creates/shows <video> element (or JPEG canvas)
    //   3. Fades out the 3D canvas, fades in the video
    //   4. The zoom blur hides any visual discontinuity during the transition
    //   5. From this point, client displays video frames from server
    //   6. Client still sends input (mouse position for precision craft, keyboard)

  trigger_2: "Active SPH particles > 200 within 10m of player"
    // A lava flow reaches the player, or someone pours a large amount of liquid nearby
    // Server detects the threshold and initiates video mode
    // Transition: 0.3s crossfade from 3D to video

  trigger_3: "Player enters precision craft mode manually"
    // Player holds an item and presses the precision key
    // Same as trigger_1 — zoom in, switch to video

  // ── Video → State (physics event ends) ────────────────────────────────────

  trigger_4: "Player exits workstation (ESC or walks away)"
    // Camera zooms out
    // During zoom out (0.5s), server:
    //   1. Sends final state update (what changed: new items, terrain mods)
    //   2. Sends MODE_SWITCH { mode: 'state' }
    //   3. Stops encoding video for this player
    // Client:
    //   1. Receives MODE_SWITCH
    //   2. Fades out video, fades in 3D canvas
    //   3. 3D scene is already up-to-date from state data received during video mode
    //      (WORLD_SNAPSHOT continues during video mode — client updates 3D scene in background)

  trigger_5: "Active SPH particles drop below 50 near player"
    // The liquid solidified, the lava cooled, the pour is done
    // Server sends final state, switches back to state mode
    // 0.3s crossfade back to 3D
}
```

##### Implementation — How It Actually Works

The hybrid system works as follows:

```
Server Side (Node.js + server-side renderer + hardware encoder):

  // The server already has:
  //   - server-side renderer creating a WebGL context
  //   - Three.js rendering scenes
  //   - video encoder hardware_h264 encoding frames at ~3-8ms per frame
  //   - WebSocket transport for binary frame data
  //   - Per-player camera management

  // What's new for hybrid mode:
  //   - The server does NOT render video for all players all the time
  //   - Video rendering is ON-DEMAND, per player, only during physics moments
  //   - Each player has a videoMode: boolean flag

  class PlayerSession {
    videoMode: boolean = false           // starts in state mode
    camera: THREE.PerspectiveCamera      // player's view (always maintained)
    ffmpegProcess: ChildProcess | null   // spawned only when videoMode = true

    enterVideoMode() {
      this.videoMode = true
      // Spawn video encoder hardware encoder encoder for this player
      this.ffmpegProcess = spawn('ffmpeg', [
        '-f', 'rawvideo', '-pix_fmt', 'rgba',
        '-s', '1280x720', '-r', '30',       // 720p at 30fps
        '-i', 'pipe:0',                       // raw frames from stdin
        '-c:v', 'hardware_h264',                 // NVIDIA hardware encoder
        '-preset', 'p4',                      // balanced quality/speed
        '-tune', 'ull',                       // ultra-low-latency
        '-b:v', '4M',                         // 4 Mbit/s bitrate
        '-f', 'mp4',
        '-movflags', 'frag_keyframe+empty_moov',
        'pipe:1'                              // fragmented MP4 to stdout
      ])
      // video encoder stdout → WebSocket binary frames to client
      this.ffmpegProcess.stdout.on('data', chunk => {
        this.ws.send(chunk)                   // binary frame to browser
      })
      // Send mode switch message
      this.ws.send(JSON.stringify({ t: 'mode', mode: 'video' }))
    }

    exitVideoMode() {
      this.videoMode = false
      if (this.ffmpegProcess) {
        this.ffmpegProcess.stdin.end()        // graceful shutdown
        this.ffmpegProcess = null
      }
      this.ws.send(JSON.stringify({ t: 'mode', mode: 'state' }))
    }
  }

  // Render loop (runs at 30 Hz for video-mode players only):
  function renderVideoFrames() {
    for (const session of activeSessions) {
      if (!session.videoMode) continue        // skip state-mode players — no rendering needed

      // Position camera at player's view
      renderer.render(scene, session.camera)

      // Read pixels from GPU
      const pixels = new Uint8Array(1280 * 720 * 4)
      gl.readPixels(0, 0, 1280, 720, gl.RGBA, gl.UNSIGNED_BYTE, pixels)

      // Feed to this player's video encoder process
      session.ffmpegProcess.stdin.write(Buffer.from(pixels))
    }
  }

  // Server cost: rendering ONLY happens for players in video mode
  // If 50 players are online but only 3 are at workstations, only 3 get rendered
  // dedicated GPU can handle ~8-10 simultaneous 720p renders at 30fps
```

```
Client Side (Browser):

  class GameClient {
    mode: 'state' | 'video' = 'state'
    threeCanvas: HTMLCanvasElement           // 3D rendering (always exists)
    videoElement: HTMLVideoElement           // MSE video playback
    mediaSource: MediaSource                 // for H.264 decoding
    sourceBuffer: SourceBuffer | null

    // 3D scene is ALWAYS maintained, even during video mode
    // This means switching back to state mode is instant — no loading
    threeScene: THREE.Scene
    threeRenderer: THREE.WebGLRenderer

    onMessage(data) {
      if (typeof data === 'string') {
        const msg = JSON.parse(data)

        if (msg.t === 'mode') {
          this.switchMode(msg.mode)
          return
        }

        // State data — always processed, even during video mode
        if (msg.t === 'snapshot') this.updateSceneFromSnapshot(msg)
        if (msg.t === 'chunk')    this.loadChunkData(msg)
        if (msg.t === 'sound')    this.playSound(msg)
        if (msg.t === 'entity')   this.updateEntity(msg)
      } else {
        // Binary data = video frame (only arrives during video mode)
        if (this.sourceBuffer && !this.sourceBuffer.updating) {
          this.sourceBuffer.appendBuffer(data)
        }
      }
    }

    switchMode(newMode: 'state' | 'video') {
      if (newMode === this.mode) return

      if (newMode === 'video') {
        // Crossfade: 3D canvas fades out, video fades in
        this.threeCanvas.style.transition = 'opacity 0.4s'
        this.threeCanvas.style.opacity = '0'
        this.videoElement.style.transition = 'opacity 0.4s'
        this.videoElement.style.opacity = '1'
        this.videoElement.style.display = 'block'
        // Start MSE pipeline
        this.initMSE()
      } else {
        // Crossfade: video fades out, 3D canvas fades in
        this.videoElement.style.opacity = '0'
        this.threeCanvas.style.opacity = '1'
        // 3D scene is already up-to-date (state data kept flowing during video mode)
        setTimeout(() => {
          this.videoElement.style.display = 'none'
          this.cleanupMSE()
        }, 400)
      }

      this.mode = newMode
    }

    // Input is ALWAYS captured and sent to server, regardless of mode
    // In state mode: server uses input to update player position
    // In video mode: server uses input for precision craft (mouse on work surface)
  }
```

##### Why This Works

| Concern | Answer |
|---------|--------|
| "How does the client show SPH particles?" | It doesn't. When physics is active, the server renders it and streams video. The client sees pixel-perfect fluid. |
| "Doesn't video streaming need an expensive GPU server?" | Only for the ~10% of time when players are at workstations or near active physics. The dedicated GPU you already have handles ~8-10 concurrent video streams. |
| "What about latency in video mode?" | hardware encoder encoding: ~3-8ms. Network: ~20-50ms. MSE decode: ~5ms. Total: ~30-60ms. For precision crafting (slow, deliberate actions), this is imperceptible. |
| "What if 50 players all use workstations at once?" | The server queues rendering. At 30fps each, 10 players max at 720p on a single GPU. Beyond that: lower resolution, lower framerate, or add a second GPU. In practice, most players are walking around (state mode = zero GPU cost). |
| "What does the transition look like?" | Player presses F at bloomery → camera zooms in → 0.4s blur/fade → video appears. The zoom motion and blur hide the switch. Looks intentional, not glitchy. |
| "Can the 3D scene get out of sync during video mode?" | No — state data (WORLD_SNAPSHOT, CHUNK_UPDATE, ENTITY_UPDATE) continues flowing during video mode. The 3D scene updates silently in the background. When switching back, it's already current. |
| "What if the player has no GPU at all?" | They can stay in video mode permanently — the server renders everything. This is the full cloud gaming fallback. Bandwidth cost: ~750 KB/s constant. Playable on a Chromebook. |

##### Server Hardware Requirements

```
For state mode only (no video):
  Node.js server (no GPU needed)
  Handles 50+ players at ~650 KB/s total

For hybrid mode (state + video):
  GPU server with NVIDIA card + hardware encoder
  Requires dedicated GPU server
  Capacity per GPU:
    720p @ 30fps: ~8-10 concurrent video streams
    480p @ 30fps: ~15-20 concurrent video streams
    720p @ 15fps: ~15-20 concurrent video streams (lower framerate for less intense moments)

  Scaling:
    50 players, 5 at workstations → 5 video streams → 1 GPU handles it easily
    50 players, 15 at workstations → need 2 GPUs or lower resolution
    100 players → additional dedicated GPU server
```



---

# PART III — GAME WORLD
---

## 4. World & Life

### 4.1 World Generation — Physical Foundation

---

#### 3.1.0 Planetary Formation and Bulk Geochemistry

The current world-generation pipeline starts at tectonic plates. That is the wrong starting point. Tectonic plates are an emergent consequence of planetary cooling — they are not where resources come from. Resources come from the planet's bulk chemistry, which was set at accretion, then sorted by differentiation, then fractionated by partial melting, then concentrated by hydrothermal circulation. The tectonic plate is just the last step in a chain that starts in the solar nebula.

This section documents that full chain. The tectonic rules in 6.4.1–6.4.8 are downstream consequences of what this section establishes. A resource node is only valid if it is consistent with the geochemical rules here. Nothing gets seeded by proximity to a boundary type alone — everything derives from the planet's initial chemistry.

---

##### 3.1.0.1 Planetary Accretion and Bulk Composition

A rocky planet forms by gravitational accretion of planetesimals from the protoplanetary disk. The disk's composition follows stellar abundances (solar composition), but the innermost zone where rocky planets form is depleted of volatile elements (H, He, C, N, noble gases) because the young star's heat drove them outward. What remains to build a rocky planet is dominated by refractory elements — those with high condensation temperatures from a cooling gas.

**Earth's bulk elemental composition (by mass):**

| Element | Mass % | Notes |
|---------|--------|-------|
| Iron (Fe) | 32.1% | Most abundant by mass — dense, sinks to core |
| Oxygen (O) | 30.1% | Second most — present in all silicate minerals |
| Silicon (Si) | 15.1% | Framework of all silicate rocks |
| Magnesium (Mg) | 13.9% | Primary mantle mineral component |
| Sulfur (S) | 2.9% | Mostly in core (as FeS); chalcophile |
| Nickel (Ni) | 1.8% | Siderophile — mostly in core with iron |
| Calcium (Ca) | 1.5% | Lithophile — in plagioclase, pyroxene, carbonates |
| Aluminum (Al) | 1.4% | Lithophile — in feldspar, spinel |
| All others | <1% | Including C, H, Na, K, Ti, Mn, P, Cr, Co, rare metals |

These numbers are not arbitrary — they are the cosmic abundances of refractory elements in CI carbonaceous chondrites (the most primitive meteorites, representative of the solar nebula composition minus volatiles). Any generated planet with a similar mass and orbital position to Earth should start with approximately these proportions.

**The game's generation step 1:** Sample bulk planetary composition from a probability distribution around these values, perturbed by planet mass and stellar type. A smaller planet (Mars-sized) has less total iron. A planet orbiting a metal-poor star has lower heavy element fractions. This sets the total inventory of each element available for the entire world — no element can be created or destroyed by geological processes, only concentrated.

---

##### 3.1.0.2 Planetary Differentiation and Goldschmidt Classification

When a newly accreted planet is hot enough (from accretional energy + short-lived radioisotope decay — primarily ²⁶Al, with a 730,000-year half-life), the interior melts. This melting is the most important event in planetary history for resource distribution: elements sort themselves by chemical affinity.

Victor Goldschmidt (1888–1947) systematized this into four chemical groups, based on where each element prefers to reside when iron metal, silicate melt, sulfide melt, and gas are all coexisting:

**Siderophile elements** ("iron-loving") — partition into liquid iron metal:
Fe, Ni, Co, Mo, W, Re, Ru, Rh, Pd, Os, Ir, Pt, Au, As (partial), Cu (partial), Ge, Ga (partial), P (partial)

These elements followed iron when it melted and sank to form the core. Earth's core contains essentially all the planet's budget of platinum-group metals (PGMs), most of the gold, most of the tungsten and molybdenum. The gold found in crustal deposits is NOT primordial — it arrived after core formation, delivered by a Late Heavy Bombardment of meteorite impacts ~3.9–4.1 Ga ago. Without that bombardment there would be no accessible gold, silver, or PGMs on the surface.

**Lithophile elements** ("rock-loving") — partition into silicate minerals and melts:
O, Si, Al, Mg, Ca, Na, K, Ti, P, Li, Be, B, Rb, Sr, Y, Zr, Nb, Ba, REEs (La–Lu), Hf, Ta, U, Th, Cs, F, Cl (partial)

These stayed in the mantle and crust. U and Th are lithophile and radioactive — their ongoing decay (~45 TW globally) is the principal heat source driving mantle convection and therefore plate tectonics today. Without U and Th, Earth's interior would have cooled, tectonics would have ceased, and volcanism would have stopped billions of years ago.

**Chalcophile elements** ("sulfur-loving") — partition into sulfide melt:
S, Cu, Pb, Zn, Ag, Cd, In, Tl, Hg, As, Bi, Sb, Se, Te, Sn (partial), Mo (partial)

When an iron-sulfide liquid separates from a silicate magma (as happens in large mafic intrusions when the melt becomes sulfur-saturated), chalcophile elements enter the sulfide phase and are concentrated there. This is the origin of magmatic copper-nickel-PGM sulfide deposits (Sudbury, Norilsk). It is also why copper, lead, and zinc are associated with hydrothermal sulfide systems — these elements readily dissolve in hot saline water as sulfide complexes (CuCl₂⁻, PbCl₄²⁻, ZnCl₄²⁻), travel through fractures, and precipitate as sulfide minerals when the fluid cools.

**Atmophile elements** — partition into gas/fluid phase:
H, C, N, O (partial), noble gases (He, Ne, Ar, Kr, Xe)

These form the hydrosphere, atmosphere, and biosphere. The oceans and atmosphere were not present at accretion — they were degassed from the mantle over billions of years, and supplemented by volatile delivery from water-rich asteroids and comets. The composition of the ocean (NaCl-dominated brine) reflects billions of years of continental weathering delivering Na⁺ and Cl⁻ to the sea.

**The game's generation step 2:** Apply Goldschmidt partitioning to the bulk elemental inventory. Each element is partitioned between core, mantle, and crust according to its partition coefficient — a dimensionless number expressing the element's preference for metal vs. silicate vs. sulfide. The result is the elemental budget available in the accessible crust. Elements with high siderophile affinity (gold, platinum) have extremely small crustal budgets. Elements that are strongly lithophile and incompatible (uranium, lithium, cesium) are concentrated in the continental crust despite their low overall abundance.

---

##### 3.1.0.3 Bowen's Reaction Series and Magmatic Differentiation

Once differentiation has established the mantle, further chemical fractionation occurs every time a piece of mantle melts. This is the second major sorting mechanism, and it controls which elements end up in which types of crustal rock.

**The process — partial melting:** The mantle is not molten globally. It melts locally, when:
1. Pressure drops (decompression melting — at mid-ocean ridges, as the mantle upwells)
2. Water is added (flux melting — at subduction zones, as the slab releases water)
3. Temperature anomaly (hotspot melting — above a mantle plume)

The fraction that melts first is not a representative sample of the mantle — it is enriched in components with lower melting points. For peridotite (the mantle rock), this means the first melt is basaltic: higher in SiO₂, Al₂O₃, CaO, Na₂O, and depleted in MgO and Cr relative to the source rock.

**Bowen's Reaction Series — crystallization sequence as basalt cools:**

As a basaltic magma cools from ~1200°C to ~600°C, minerals crystallize in a predictable sequence. Each mineral that crystallizes removes certain elements from the remaining liquid, changing its composition continuously — this is fractional crystallization:

1. **Olivine** (Mg₂SiO₄) crystallizes first, above ~1200°C. Removes Mg, Fe, Si from melt. The remaining melt becomes richer in Al, Ca, Na, K, Si relative to Mg.

2. **Pyroxene** (MgSiO₃ / CaMgSi₂O₆) crystallizes next, ~1100–900°C. Continues removing Mg and Ca.

3. **Amphibole** (complex Ca-Mg-Fe-Al silicate) crystallizes in hydrated magmas, ~1000–800°C. Requires water in the melt.

4. **Plagioclase feldspar** (continuous series CaAl₂Si₂O₈ → NaAlSi₃O₈) crystallizes through a wide temperature range, ~1200–700°C. Early plagioclase is Ca-rich (anorthite); later plagioclase is Na-rich (albite). Removes Ca, Al, Na.

5. **Biotite mica** (K-Mg-Fe-Al silicate), ~800°C. Removes K.

6. **K-feldspar** (KAlSi₃O₈), ~700°C. Removes K.

7. **Muscovite mica**, ~700°C.

8. **Quartz** (SiO₂) crystallizes last, below ~600°C. The last liquid to crystallize is quartz-rich.

**Incompatible elements — the pegmatite concentration mechanism:**

Certain elements fit into none of these crystal structures: Li, Be, B, Rb, Cs, Ba (somewhat), Nb, Ta, REEs (La–Lu), Hf, Zr, Sn, W, U, Th, F, Cl, H₂O. These are called "incompatible elements" — their ionic radius or charge is wrong for all the common minerals in the series.

As crystallization proceeds, incompatible elements are continuously expelled from the crystallizing minerals into the residual melt. By the end of crystallization, the last ~1% of the original magma body is enriched in incompatible elements by factors of 100–1000× compared to the original magma. This final liquid, also rich in water and fluorine (which dramatically lower the crystallization temperature and allow very slow crystal growth), crystallizes as **pegmatite** — a rock with enormous crystals (meters in some cases) containing:

- Lithium (as spodumene LiAlSi₂O₆, lepidolite K(Li,Al)₃(Si,Al)₄O₁₀(OH,F)₂)
- Beryllium (as beryl Be₃Al₂Si₆O₁₈ — emerald and aquamarine are gem varieties)
- Tin (as cassiterite SnO₂)
- Tungsten (as wolframite (Fe,Mn)WO₄, scheelite CaWO₄)
- Tantalum and Niobium (as coltan (Fe,Mn)(Nb,Ta)₂O₆)
- REEs (as monazite (Ce,La,Nd,Th)PO₄, xenotime YPO₄)
- Uranium (as uraninite UO₂)
- Cesium (as pollucite Cs(AlSi₂)O₆)

**The game's generation step 3:** At every granitic intrusion in the world, simulate fractional crystallization from an initial basaltic parent melt composition. The residual melt fraction (the last liquid) precipitates pegmatites in the thermal aureole of the intrusion. The incompatible elements concentrated in that pegmatite are proportional to the initial magma volume and the degree of differentiation. Large, deeply emplaced granite batholiths produce larger, richer pegmatite fields than small shallow intrusions.

**Second partial melt — subduction-derived continental crust:**

When oceanic basalt subducts, the slab releases water at 80–120 km depth (dehydration of hydrous minerals — serpentine, amphibole, chlorite). This water rises into the overlying mantle wedge and lowers its melting point (water lowers the solidus of peridotite by ~200–300°C). The resulting melt is more silica-rich than the original mantle melt — it is andesitic. This andesite erupts at the surface as stratovolcanoes (the "Ring of Fire") or crystallizes at depth as the first step toward forming granodiorite → granite.

With each melting and crystallization cycle at subduction zones, the crustal column becomes more differentiated: more SiO₂, more K₂O, more incompatible elements, less MgO, less FeO. This is why continental crust (average composition ~65% SiO₂) is so different from oceanic crust (~50% SiO₂) and from the mantle (~45% SiO₂).

---

##### 3.1.0.4 Planet Layer Model

The game must generate and track these layers. Each layer has a distinct composition and set of accessible resources:

| Layer | Primary mineralogy | Elemental character | Avg. thickness | T range | Player-accessible |
|-------|-------------------|---------------------|----------------|---------|-------------------|
| **Inner core** | Fe–Ni alloy (solid) | Siderophile: Fe 85%, Ni 5%, Si+S 10% | 1220 km radius | ~5000–6000°C | No |
| **Outer core** | Fe–Ni–S melt (liquid) | Siderophile: Fe 82%, Ni 5%, S 9%, O+Si 4% | 2260 km | 4000–5000°C | No — generates magnetic field via dynamo |
| **Lower mantle** | Bridgmanite (MgSiO₃ perovskite), ferropericlase (MgO) | Lithophile, high-pressure phases | 2300 km | 1500–4000°C | No |
| **Upper mantle** | Peridotite: olivine (Mg,Fe)₂SiO₄ + pyroxene MgSiO₃ | Lithophile: Mg, Fe, Si, O, Cr, Ni | 660 km | 500–1500°C | Only via volcanic transport (xenoliths, kimberlites) |
| **Oceanic crust** | Basalt: SiO₂ 50%, Al₂O₃ 16%, FeO 10%, MgO 7%, CaO 11%, Na₂O 3% | Chalcophile enriched by seafloor hydrothermal vents | 5–10 km | surface–400°C | Yes — seafloor and island arcs |
| **Continental crust (lower)** | Granulite, amphibolite, mafic granulite | Mixed mafic+felsic | 20–50 km | 300–800°C | Only via very deep mines or thrust faults |
| **Continental crust (upper)** | Granite, gneiss, schist, sedimentary cover | Lithophile + incompatible: SiO₂ 65%, Al₂O₃ 16%, Na₂O+K₂O 9%, enriched in U, Th, REE, Li, Sn, W | 10–30 km | surface–200°C | Yes — primary exploration target |
| **Hydrosphere** | H₂O + dissolved Na⁺, Cl⁻, Mg²⁺, SO₄²⁻, Ca²⁺, K⁺ | Atmophile + chalcophile ions in solution | 3.7 km avg ocean depth | 2–35°C | Yes — oceans, rivers, lakes |
| **Atmosphere** | N₂ 78%, O₂ 21%, Ar 1%, CO₂ 0.04%, H₂O variable | Atmophile | 80 km to 99% mass | −60°C to +50°C | Yes |

**The magnetic field:** The liquid outer core generates Earth's magnetic field by dynamo action — convecting conductive iron fluid driven by the heat gradient between inner and outer core. A game planet with a normal-sized iron core generates a magnetosphere that deflects the stellar wind, protecting the surface from ionizing radiation. A planet with a small core (low Fe fraction), a fully solidified core (too cool), or no core generates no magnetic field — the surface experiences high radiation, which affects organism mutation rates and material degradation rates. Players could detect the field's presence or absence with a compass.

---

##### 3.1.0.5 Crustal Abundance — Clarke Numbers

The **Clarke number** (named after geochemist Frank Wigglesworth Clarke, 1847–1931) is the average abundance of an element in the continental crust, in parts per million (ppm) by mass. These numbers define how common or rare a resource is in the game world. A resource with a Clarke number of 60 ppm (copper) is ~15,000 times more abundant than one with 0.004 ppm (gold). The game must respect these ratios in deposit size and discovery frequency.

**Clarke numbers for game-relevant elements:**

| Element | Clarke (ppm) | Goldschmidt type | Why abundant or rare |
|---------|-------------|-----------------|---------------------|
| Oxygen (O) | 461,000 | Lithophile | Silicate anion — in every rock mineral |
| Silicon (Si) | 282,000 | Lithophile | Silicate framework — in every silicate |
| Aluminum (Al) | 82,300 | Lithophile | Feldspar — most common mineral group |
| Iron (Fe) | 56,300 | Siderophile (partial) | Retained in crust as Fe²⁺ in mafic silicates |
| Calcium (Ca) | 41,500 | Lithophile | Plagioclase, pyroxene, carbonite |
| Sodium (Na) | 23,600 | Lithophile | Plagioclase, evaporite |
| Magnesium (Mg) | 23,300 | Lithophile | Olivine, pyroxene — abundant in mafic crust |
| Potassium (K) | 20,900 | Lithophile | K-feldspar, mica — concentrated in granite |
| Titanium (Ti) | 5,650 | Lithophile | Ilmenite, rutile — accessory minerals |
| Phosphorus (P) | 1,050 | Lithophile | Apatite — ubiquitous accessory mineral |
| Manganese (Mn) | 950 | Lithophile/siderophile | Pyrolusite, seafloor nodules |
| Fluorine (F) | 585 | Lithophile | Fluorapatite, fluorite |
| Chlorine (Cl) | 130 | Atmophile | Halite — concentrated by evaporation |
| Chromium (Cr) | 102 | Siderophile | Chromite in mafic/ultramafic rock |
| Zinc (Zn) | 70 | Chalcophile | Sphalerite — hydrothermal concentration |
| Copper (Cu) | 60 | Chalcophile | Sulfide minerals — hydrothermal concentration |
| Nickel (Ni) | 59 | Siderophile | Pentlandite in mafic intrusions |
| Lithium (Li) | 20 | Lithophile (incompatible) | Pegmatite and continental brine |
| Lead (Pb) | 14 | Chalcophile | Galena — MVT and hydrothermal veins |
| Cobalt (Co) | 25 | Siderophile | Ni–Cu sulfide deposits |
| Boron (B) | 10 | Lithophile | Evaporite deposits (borax) |
| Uranium (U) | 2.7 | Lithophile (incompatible) | Concentrated in continental crust granites |
| Tin (Sn) | 2.3 | Lithophile (incompatible) | Pegmatite and greisen — very rare |
| Tungsten (W) | 1.3 | Siderophile (partial) | Pegmatite and skarn — very rare |
| Silver (Ag) | 0.075 | Chalcophile | Hydrothermal veins with lead |
| Gold (Au) | 0.004 | Siderophile | Post-LHB delivery — extremely rare |
| Platinum (Pt) | 0.005 | Siderophile | Magmatic sulfide deposits |

**Game balance implication:** Copper (60 ppm) should appear in deposits roughly 15,000× more frequently than gold (0.004 ppm). A copper deposit might cover 1–2 km² and contain millions of tonnes of ore. A gold deposit might be a vein 20 cm wide and 50 meters long. These are real proportions. The game is not balanced around equal deposit sizes — it is balanced around real scarcity, which forces trade.

---

##### 3.1.0.6 Mineral Stability — Formation Conditions

A resource node can only exist if the conditions that formed it actually existed at that location. The game's resource seeder must run a mineral stability check before placing any deposit. Each mineral has a valid temperature window, pressure window, chemical activity window, and atmospheric condition:

| Mineral | Formation T | Formation P | Required chemistry | Stability at surface |
|---------|------------|------------|-------------------|---------------------|
| Diamond | >900°C | >45 kbar (~150 km depth) | Carbon + mantle reducing conditions | Metastable — survives at surface; returns to graphite only above 1500°C at 1 atm |
| Graphite | >300°C | >2 kbar | Carbon in metamorphic/metasedimentary rock | Stable |
| Olivine | >900°C | 0.001–100 kbar | Mg-Fe silicate melt | Unstable at surface — rapidly weathers to serpentine + iron oxides |
| Quartz | <870°C | 0–50 kbar | SiO₂ supersaturation in fluid or late melt | Highly stable — chemically inert at surface |
| Halite (salt) | Any T | 1 atm | Brine concentration >26% NaCl | Unstable in humid climates — dissolves; stable in arid |
| Pyrite (FeS₂) | <400°C | 1–5 kbar | Reducing conditions + sulfur activity | Unstable at surface in O₂ atmosphere — oxidizes to goethite + SO₄²⁻ |
| Chalcopyrite (CuFeS₂) | 200–500°C | hydrothermal | Cu + Fe + S + reducing fluid | Unstable at surface — weathers to malachite and azurite |
| Malachite / Azurite | Surface T | 1 atm | Oxidizing conditions + CaCO₃ substrate | Stable in oxidizing zone — forms from chalcopyrite weathering |
| Calcite (CaCO₃) | <500°C | any | Seawater CaCO₃ supersaturation OR biogenic | Stable in neutral-alkaline conditions; dissolves in acid |
| Bauxite | Surface T | 1 atm | Intense tropical weathering, >2000 mm/yr rain, >25°C | Stable in tropical climate; erodes in cooler/drier conditions |
| Cassiterite (SnO₂) | 200–600°C | 0.5–3 kbar | Pegmatite/greisen — high F activity | Very stable — survives transport as placer |
| Uraninite (UO₂) | 200–500°C | hydrothermal or pegmatite | Reducing conditions + U-rich fluid | Unstable in oxidizing surface — oxidizes to schoepite; mobilizes in O₂ groundwater |
| Garnet | >500°C | >2 kbar | Metamorphic — pelitic or mafic bulk composition | Stable at surface — survives weathering, common in beach sand |
| Platinum (native) | Magmatic | >1200°C | Fe–Ni–S liquid saturation in mafic melt | Highly stable — survives transport as placer |
| Gold (native) | Hydrothermal: 200–350°C | 0.5–2 kbar | Au-bisulfide complex + pH/temperature gradient | Highly stable at surface — inert, survives transport |
| Gypsum (CaSO₄·2H₂O) | <60°C | 1 atm | Evaporating seawater, early-stage concentration | Stable in surface conditions; converts to anhydrite below water table |
| Corundum (Al₂O₃, ruby/sapphire) | >700°C | >5 kbar | Low SiO₂ activity + Al-rich metapelite or pegmatite | Stable — very hard, survives as placer |

**The stability check in world generation:** Before seeding a mineral deposit, the generator checks:
1. Does the local geological history include the required formation conditions? (e.g., was there a granite intrusion here? Was this area subducted? Was there a tropical climate phase?)
2. Have surface conditions since formation been compatible with preservation? (e.g., a sulfide deposit formed 500 Ma ago in a reducing environment may have since been oxidized — its surface expression is a gossan of iron oxides with secondary copper carbonates, not fresh chalcopyrite)
3. Is the deposit on a terrain type that logically supports it? (bauxite cannot form in an arctic biome; salt cannot survive in a humid tropical biome)

---

##### 3.1.0.7 World Generation Algorithm — From First Principles

This is the full ordered sequence the game runs when generating a new world:

**Phase 1 — Bulk composition:**
1. Set planet mass (drawn from distribution around 1 Earth mass, with variance)
2. Sample bulk elemental composition from CI chondrite reference adjusted for planet mass and stellar metallicity
3. Apply Goldschmidt partitioning: compute how much of each element goes to core, mantle, and bulk silicate Earth (BSE = mantle + crust)
4. Output: BSE elemental budget — the total inventory of lithophile + chalcophile elements available to build the crust

**Phase 2 — Crust generation:**
5. Divide BSE budget into oceanic crust fraction and continental crust fraction (ratio determined by tectonic maturity parameter — young planets have more oceanic crust; old planets have more continental crust)
6. For oceanic crust: apply basaltic differentiation model (partial melt of peridotite at mid-ocean ridges) — produces tholeiitic basalt composition
7. For continental crust: apply multi-stage differentiation (subduction arc → granodiorite → granite fractionation) — produces average continental composition enriched in incompatible elements
8. For each granitic province in continental crust: simulate pegmatite formation by computing residual melt fraction and incompatible element concentration factor — places pegmatite fields with Li, Sn, W, REE, U proportional to volume

**Phase 3 — Tectonic structure:**
9. Generate 12 tectonic plates (existing Voronoi sphere method)
10. Classify each plate as oceanic or continental based on BSE volume fractions
11. Classify each boundary (convergent, divergent, transform)
12. For each convergent boundary: compute subduction geometry, slab depth, and hydrothermal fluid chemistry — seeds copper porphyry, epithermal gold/silver, VMS deposits proportional to accumulated subduction history
13. For each divergent boundary: compute spreading rate and seafloor hydrothermal vent activity — seeds black smoker VMS deposits, seafloor manganese nodule fields
14. For each craton (stable ancient continental core): compute age and thermal history — seeds BIF iron deposits (only if craton pre-dates Great Oxidation Event at 2.4 Ga), unconformity uranium deposits, diamond-bearing kimberlites

**Phase 4 — Surface weathering and secondary deposits:**
15. Apply biome layer (from organism simulation — tropical biomes trigger laterite and bauxite generation on mafic terrain)
16. Apply drainage model (rivers carry dissolved weathering products to interior basins, generating evaporite sequences — salt, gypsum, potash — in endorheic basins)
17. Apply oxidation fronts to sulfide deposits exposed at surface (gossan formation, supergene enrichment, malachite/azurite secondary cap)
18. Apply placer transport to dense, stable minerals (gold, cassiterite, diamonds) — follow river network downstream from hard-rock source deposits

**Phase 5 — Surface expression:**
19. Each deposit is assigned a visible surface expression (the signal that a player or NPC can detect without drilling):
    - Gossan: red-orange iron oxide staining above sulfide deposit
    - Malachite staining: green mineral in outcrop → copper below
    - Magnetic anomaly: deflection of compass near magnetite → iron ore
    - Sulfur smell + yellow crust: volcanic fumarole → native sulfur
    - White crust: salt flat or gypsum outcrop
    - Black coal seam: visible in river valley or cliff
    - Dark heavy grains in river sediment: cassiterite or gold placer
    - Glassy dark nodules in limestone: flint
    - Bright black metallic dendrites on rock faces: manganese oxide

Every resource node in the game has a surface expression that derives from the real mineralogy of the deposit and the real weathering chemistry of that mineral in contact with oxygen, water, and carbon dioxide. No resource is hidden without a signal — but reading the signals requires geological knowledge.

---

#### 3.1.1 Surface Terrain and Biomes

The planet is a sphere with a 4-kilometer radius. The terrain is generated using a technique called 3D Fractional Brownian Motion (FBM) with domain warping — this produces natural-looking mountain ranges, valleys, and coastlines without any repetition. Additional passes add ridged mountains and Voronoi-based tectonic plates.

20 Whittaker biomes are assigned based on elevation and moisture (tundra, boreal forest, temperate forest, tropical rainforest, desert, grassland, etc.). Each biome has real ecological properties: net primary productivity (how much plant life grows), carrying capacity (how many organisms can live here), and decomposition rate (how quickly dead matter breaks down).

River networks are generated with valley carving. Coastal areas are identified and affect settlement behavior.


### 4.2 Organism Ecosystem & Species Registry

The server runs `OrganismManager` at 6 Hz. Organisms have four diet types (autotroph, heterotroph, mixotroph, chemoautotroph), energy budgets tied to the day/night light cycle, stochastic death and reproduction, and 256-bit genomes that enable speciation tracking.

Starting population: 80 primordial organisms. Population cap: 300.

All players share the same organism state — births, deaths, and positions are global.

Client rendering: instanced glowing spheres with two LOD levels (full detail within 2,000m, simplified beyond 8,000m).

**Scientific grounding — Lotka-Volterra dynamics:**
The predator-prey population oscillations in this system follow the equations independently derived by Alfred Lotka (1925) and Vito Volterra (1926):

```
dPrey/dt     =  α·Prey  −  β·Prey·Predator
dPredator/dt =  δ·Prey·Predator  −  γ·Predator
```

When autotrophs (prey) are abundant, heterotrophs (predators) reproduce faster than they die. As heterotrophs grow, they deplete autotrophs. Autotroph population crashes. Heterotrophs starve and decline. Autotrophs recover. The cycle repeats. No designer writes this behavior — it emerges from energy accounting per organism per tick.

**Scientific grounding — genome and speciation:**
The 256-bit genome and Hamming distance speciation threshold implement the conceptual framework from Richard Dawkins' *The Selfish Gene* (1976): evolution operates on genes, not individuals. Two populations that diverge beyond a Hamming distance of 32 bits are treated as separate species — a computational proxy for reproductive isolation. Traits encoded in the genome (size, metabolic rate, diet preference) determine fitness. Unfit organisms die sooner. Fit ones reproduce more. Selection pressure does the rest.

---

#### Full Organism Species Registry

Every living thing in the game is an organism in the simulation. There are no static resource nodes for biological materials — wood, grain, wool, wax, guano, and every other biological product comes from a living organism that was born, grew, and can die. This section documents every species that must exist in the system, organized by kingdom, with their ecological role, biome constraints, products they yield, and how their population dynamics interact with the rest of the simulation.

The four existing diet type categories (autotroph, heterotroph, mixotroph, chemoautotroph) remain the metabolic backbone. Species identity is a new layer on top — it determines what a given autotroph *is* (an oak tree, a wheat plant, a kelp colony), what it looks like, what it yields when harvested, what kills it, and what depends on it.

---

#### Kingdom Plantae — Autotrophs

All plants are autotrophs. They gain energy from sunlight proportional to their leaf area index (how much surface they expose to light) and the biome's net primary productivity value. Each plant species has a growth rate (slow: trees; fast: annual grasses), a maximum size/yield, a preferred biome, a temperature range, a moisture range, and a set of products it yields at different life stages (sapling → juvenile → mature → senescent).

Plants do not move. They occupy a fixed grid cell. A cell can hold one large plant (tree) or multiple small plants (ground cover, grass). When harvested below a survivable threshold, the plant dies and the cell opens for recolonization. Regrowth is biological time — it cannot be bypassed.

---

**Trees**

**Oak** (*Quercus* spp.)

- Biome: Temperate deciduous forest, Mediterranean woodland
- Temperature range: −20°C to +40°C; growth optimal 10–20°C
- Moisture: Moderate to high; drought-tolerant when mature
- Growth rate: Slow — sapling to mature: ~200 years real-biology-time, compressed to game time scale
- Life stages: Acorn → sapling (1–3m) → juvenile (3–10m) → mature (10–25m) → ancient (25–40m, hollow interior)
- Products by stage:
  - Acorn (sapling+): food for wildlife (pigs, deer, wild boar), bitter without leaching — not directly edible by humans
  - Bark (juvenile+): tannin content ~10–15% tannic acid — primary tanning agent for leather production; also used in dyeing as mordant
  - Timber (mature): hardwood, Janka hardness ~6,000 N — shipbuilding, construction, barrel staves, furniture
  - Charcoal (mature timber burned in pit): high fixed-carbon (~82%), low ash — best charcoal for smelting; superior to pine or softwood charcoal
  - Galls (infected by Cynips gall wasps): high tannin concentration — ink production (iron gall ink), extra tannin source
- Ecological role: Primary autotroph of temperate biome; host for gall wasps (organism dependency); acorns support wild boar and deer populations
- Threats: Logging (player harvest), wildfire, drought (moisture falls below threshold for 3+ seasons)
- Regrowth: Acorns dispersed by jays and squirrels (heterotroph interaction required for seed dispersal in old-growth forest); open clearings reseed within 20–50 game years without intervention

**Ash** (*Fraxinus* spp.)

- Biome: Temperate deciduous forest, riverine woodland
- Products: Timber (excellent tool handles — high shock resistance, Janka ~5,700 N), charcoal (good quality, ~78% fixed carbon), bark (mild tannins)
- Ecological role: Fast-growing pioneer on disturbed ground — colonizes cleared areas before oak returns; provides early timber after deforestation

**Hickory** (*Carya* spp.)

- Biome: Temperate deciduous forest (continental)
- Products: Timber (hardest North American wood, Janka ~8,100 N — hammer handles, axe hafts), charcoal (highest fixed-carbon of any temperate hardwood, ~85% — optimal for high-temperature smelting), nuts (calorie-dense wild food)
- Note: Charcoal made from hickory reaches higher sustained temperatures than oak charcoal — meaningful for iron smelting vs. copper smelting distinction

**Beech** (*Fagus* spp.)

- Biome: Temperate deciduous forest, montane
- Products: Timber (even-grained, good turning), charcoal (good quality), mast (beechnuts — calorie-dense, 50% fat, used as animal feed and pressed for oil), tannins in bark

**Pine** (*Pinus* spp. — generic conifer group)

- Biome: Boreal forest, temperate montane, Mediterranean coast
- Products:
  - Timber (softwood — construction, paper pulp precursor, fuel)
  - Resin (tapped from bark wounds): pine resin collected raw, heated to produce pitch, distilled to produce turpentine — waterproofing, adhesive, caulking
  - Tar (destructive distillation of pine wood and roots): wood tar preserves wood and rope; pine tar is antiseptic
  - Charcoal (poor quality, ~65% fixed carbon, high resin — produces sooty flame; unsuitable for metal smelting but adequate for cooking)
  - Pine nuts (certain species): edible seed
- Ecological role: Dominant autotroph of boreal biome; much lower tannin than hardwoods; primary source of resin chemistry

**Papyrus** (*Cyperus papyrus*)

- Biome: Tropical and subtropical freshwater margins, river deltas, swamp edges
- Temperature range: >15°C; frost-kills stem tissue
- Moisture: Requires permanent shallow water (0.1–0.5m depth) — it is an aquatic plant
- Growth rate: Fast — stem regrows from rhizome within one season after cutting
- Products:
  - Stem pith (mature): papyrus writing material — strip pith into thin layers, press perpendicular layers together, dry under weight; yields a flat writing surface without pulping
  - Fiber (stem): rope and basket weaving
  - Rhizome: edible starchy root (emergency food)
- Ecological role: Builds up organic sediment in shallow water; habitat for wading birds and fish nurseries; rhizome network stabilizes riverbank
- Constraint: Only grows where permanent standing or slow-moving freshwater exists at correct depth — cannot be cultivated away from water

**Mulberry** (*Morus* spp.)

- Biome: Temperate, subtropical
- Products:
  - Inner bark (bast): paper production (Japanese washi, Chinese paper) — macerated to pulp, sheet-formed
  - Fruit: edible, used for dye (dark red-purple) and wine
  - Leaves: primary food of silkworm (*Bombyx mori*) — mulberry tree is the prerequisite for silk production; without mulberry there is no silk

**Bamboo** (*Bambusoideae* family — treated as single functional group)

- Biome: Subtropical and tropical, humid temperate
- Growth rate: Fastest woody plant on Earth — up to 91 cm/day; mature culm in 3–5 years
- Products:
  - Culm (mature): construction material (tensile strength ~160 MPa — stronger than mild steel by weight), scaffolding, tool handles, pipes, containers
  - Young shoot: edible (requires boiling to remove cyanogenic glycosides)
  - Fiber: paper precursor, coarse textile
- Ecological role: Rapidly recolonizes disturbed ground; provides fast timber supply in tropical biome where oak does not grow; pandas (if present) depend on it

---

**Fiber Plants**

**Flax** (*Linum usitatissimum*)

- Biome: Temperate grassland, cool temperate mixed; does not grow in tropics or arid zones
- Temperature range: 10–25°C; frost-tolerant as seedling; dies in summer heat above 30°C
- Moisture: Moderate — neither waterlogged nor arid
- Growth rate: Annual — seed to harvest in ~100 days
- Life cycle: Sown in spring → grows 60–90 cm → flowers blue → seeds develop → harvest at seed ripening stage (for both fiber and seed) OR at green-pod stage (longer fiber)
- Products:
  - Bast fiber (inner stem): retted (bacteria decompose outer stem 1–3 weeks in standing water), broken and scutched (mechanically separated), hackled (combed fine), spun → linen thread → linen cloth. Oldest textile fiber — linen found in Egyptian sites 6,000 years old
  - Linseed oil (pressed from seed): drying oil — polymerizes when exposed to air, used as wood preservative, oil paint medium, leather conditioner
  - Linseed cake (seed residue after pressing): animal feed
- Constraint: Cannot survive in biomes outside its temperature/moisture envelope. A tropical settlement cannot grow flax — they must trade for linen or use cotton

**Hemp** (*Cannabis sativa*)

- Biome: Temperate, subtropical, continental — broad tolerance compared to flax
- Temperature range: 6–27°C; frost-sensitive but recovers; tolerates continental climates
- Growth rate: Annual — faster than flax (~80 days to harvest)
- Products:
  - Bast fiber (inner stem): coarser than linen, stronger in tension — rope, sailcloth, sacking, canvas (the word "canvas" derives from *cannabis*). Retting process same as flax
  - Seed oil: similar to linseed — drying oil, food oil
  - Seed: calorie-dense, 35% fat, 25% protein — edible directly
- Note: Grows in a wider range of conditions than flax. Most pre-industrial rope was hemp. Where flax is impossible, hemp is the fallback fiber

**Nettle** (*Urtica dioica*)

- Biome: Temperate, moist disturbed ground, woodland edges — a weed; grows anywhere humans have disturbed soil
- Products: Bast fiber (coarser than flax, finer than hemp — intermediate quality); young leaves are edible (boiling removes sting); used as green dye
- Advantage: No cultivation needed — nettle colonizes disturbed ground around settlements spontaneously. The first textile fiber available to a new settlement before dedicated fiber cultivation is established

**Cotton** (*Gossypium* spp.)

- Biome: Subtropical, tropical — requires long hot summers (>200 frost-free days, >25°C growing season average)
- Growth rate: Annual in cultivation — 180–200 days seed to harvest
- Products:
  - Seed hair (boll): cotton fiber — unlike bast fibers, cotton is a seed hair, not a stem fiber. Ginning (separating seeds from fiber), carding, spinning, weaving yield cotton cloth. Softer than linen, breathable, dyeable
  - Cottonseed oil: drying oil, food oil, soap precursor
- Constraint: Cannot grow in temperate zones — unavailable to northern civilizations without trade. Explains the historical cotton trade between subtropical India and temperate Europe

**Jute** (*Corchorus* spp.)

- Biome: Tropical, humid subtropical — Bengal, Bangladesh, India
- Products: Coarse bast fiber — sacking, burlap, rope. Cheapest fiber; degrades faster than hemp
- Ecological note: Grows in flooded fields; tolerates waterlogging that kills other fiber crops

---

**Grain Crops** (All are annual autotrophs)

Each grain species is modeled as a patch organism occupying agricultural land. NPC farming settlements cultivate grain patches. Wild ancestors exist in their native biomes before domestication.

**Barley** (*Hordeum vulgare*)

- Biome: Temperate to cool temperate; most cold-tolerant grain; grows at higher altitudes than wheat
- Wild form: grassy autotroph in dry temperate grassland
- Cultivated form: requires cleared, tilled soil (NPC farming action)
- Products: Grain — malt (germinated grain, enzymes for starch conversion), flour (bread), beer (primary historical grain for brewing), animal feed. Straw: animal bedding, thatching

**Wheat** (*Triticum* spp. — emmer, einkorn, durum, bread wheat)

- Biome: Temperate — optimal 15–25°C; needs dry harvest period to prevent fungal grain rot
- Products: Grain — highest gluten content of all grains, best for leavened bread (gluten traps CO₂ from yeast fermentation, creating bread's texture). Straw: construction, thatching, paper pulp precursor

**Rye** (*Secale cereale*)

- Biome: Cool temperate, continental — grows where wheat fails; cold-hardy, poor-soil tolerant
- Products: Grain — bread (denser than wheat, lower gluten); fermented → whiskey, rye beer. Ergot fungus (*Claviceps purpurea*) grows on rye in wet conditions — causes ergotism (hallucinations, convulsions, gangrene). Ergot on grain supply = epidemic in settlement

**Millet** (*Panicum miliaceum*, *Setaria italica*, *Eleusine coracana*, and others)

- Biome: Hot semi-arid to tropical; most drought-tolerant grain; dominant crop in arid Africa, India
- Products: Grain — bread (no gluten, flat unleavened), porridge, beer (African opaque beer), animal feed. Fastest-growing grain (60–90 days)

**Maize / Corn** (*Zea mays*)

- Biome: Subtropical, tropical, warm temperate — requires warm nights (>10°C)
- Products: Grain (highest yield per hectare of any cereal), cob as fuel, stalks as animal feed and building material, silk as fiber
- Ecological note: Requires hand pollination in cultivation (tassel → silk); cannot self-seed without human intervention. A settlement that stops farming maize loses it within one generation

**Rice** (*Oryza sativa*)

- Biome: Tropical and subtropical — paddy rice requires flooded fields (0–10 cm standing water); upland rice grows in tropical highlands without flooding but yields less
- Products: Grain (staple for ~3.5 billion people), rice straw (thatching, paper, rope), rice bran (oil)
- Ecological note: Flooded paddy fields are a major source of methane (anaerobic decomposition of organic matter in flooded soil) — this is a simulated atmospheric consequence

---

**Dye Plants**

**Woad** (*Isatis tinctoria*)

- Biome: Temperate — native to steppe and Mediterranean, cultivated widely in temperate Europe
- Products: Blue dye (indigo precursor — woad contains indican, hydrolyzed by fermentation to indigo). Primary blue dye of pre-contact Europe. Fermentation vat required: leaves fermented 3–4 weeks in urine or water, then oxidized in air → blue precipitate
- Replaced by: Indigo (*Indigofera tinctoria*) from tropical India — far more concentrated, same chemistry. Trade of true indigo collapsed woad industry in 17th century

**Madder** (*Rubia tinctorum*)

- Biome: Temperate, Mediterranean — cultivated for root
- Products: Red dye (alizarin) from root — boil root, dye cloth with alum mordant (without alum, color washes out). Primary red dye of pre-synthetic Europe

**Weld** (*Reseda luteola*)

- Biome: Temperate grassland, disturbed ground — a weed
- Products: Yellow dye (luteolin) — most lightfast yellow dye before synthetic era. Mordanted with alum

**Walnut** (*Juglans* spp.)

- Biome: Temperate deciduous forest
- Products: Nut (calorie-dense food, 65% fat), timber (fine furniture), brown-black dye (juglone from hull — does not require mordant, stains permanently)

**Teasel** (*Dipsacus fullonum*)

- Biome: Temperate grassland, disturbed ground — weed
- Products: Dried seed head — the spines catch wool fibers without breaking them. Used as natural carding tool; wool fibers pulled through teasel head are aligned for spinning. Metal carding paddles eventually replace it but require metalworking. Teasel is the pre-metalwork carding tool

---

**Other Plant Resources**

**Grape vine** (*Vitis vinifera*)

- Biome: Mediterranean, warm temperate — requires hot dry summers and cool winters (specific climate window)
- Products: Fruit (fresh eating, dried as raisins/currants), wine (fermented juice), grape pomace (seed oil, compost), young shoots (edible)
- Constraint: Narrow climate window — does not grow in cold temperate or tropical zones. Wine-producing civilizations are therefore geographically concentrated, explaining why wine was a trade good (not every region could produce it)

**Legumes** (*Pisum*, *Lens*, *Vicia*, *Phaseolus*, *Glycine* — modeled as a functional group)

- Biome: Temperate to tropical depending on species
- Products: Seed (highest protein content of plant foods: 20–40% protein), nitrogen fixation (root nodule bacteria — *Rhizobium* — fix atmospheric N₂ into soil ammonium; growing legumes replenishes soil nitrogen depleted by grain farming)
- Ecological function: Rotation of grain + legume maintains soil fertility indefinitely. Without legumes or manure, grain fields exhaust their nitrogen and yields collapse. NPC farming settlements that grow only grain will see declining yields over time

**Tannin-bearing trees** (*Quercus*, *Castanea*, *Acacia* — oak, chestnut, mimosa/wattle)

- Bark tannin content by species:
  - Oak bark: 10–15% tannic acid
  - Chestnut bark: 6–9% tannic acid
  - Mimosa/wattle bark: 25–40% tannic acid (highest of any bark — explains why Australia's wattle became the global leather industry's primary tannin source by the 19th century)
- Game consequence: A settlement near mimosa/wattle can produce leather faster and in larger volume than one relying on oak bark. Tannin source species is a real competitive advantage in early civilization

---

#### Kingdom Animalia — Heterotrophs and Mixotrophs

Animals are heterotrophs. They consume other organisms for energy. Each species has a diet (herbivore, carnivore, omnivore — which maps to which organism types it consumes), a territory radius, a reproductive rate, a body mass (determines energy stored and yield on death), and a set of products yielded when hunted.

Animals are physically present in the world — they move, flee from players, aggregate in herds, drink at water sources. Their populations are dynamic: overhunting causes collapse; underhunting causes overpopulation that overgrazes autotroph populations.

---

**Ungulates (large herbivores)**

**Cattle** (*Bos taurus* / *Bos indicus*)

- Diet: Herbivore — grass, legumes, browse
- Biome: Temperate grassland, tropical savanna, agricultural zones
- Body mass: 400–800 kg (adult)
- Products on death:
  - Hide: large (~5 m²) — tanned → sole leather, harness leather, shield, drum, binding
  - Tallow: rendered fat from cavity fat and marrow — candles, soap, lubricant, leather conditioning
  - Bone: marrow (food), ground bone (fertilizer — calcium phosphate), bone glue (boiled → collagen gelatin for adhesive), worked bone (tools, needles, toggles)
  - Sinew: backstrap and leg tendons — strongest natural fiber, bowstring, surgical suture, binding
  - Horn and hoof: worked horn (cups, combs, window panes, powder flasks), hoof gelatin (hide glue)
  - Blood: coagulates into protein-rich paste — used in paint (blood paint on rock), food (black pudding)
  - Stomach and bladder: water container, sausage casing
- Alive products (domesticated):
  - Milk: fresh, fermented (cheese, butter, yogurt) — requires NPC settlement domestication
  - Dung: fuel (dried), fertilizer, binder (added to clay for improved plasticity), daub (wattle and daub construction)
  - Draft power: pulling plows, millstones, transport — vastly increases NPC settlement agricultural output
- Ecological role: Primary grazer of temperate and tropical grassland; dung supports dung beetle population; overgrazing causes soil compaction and grass loss

**Sheep** (*Ovis aries*)

- Diet: Herbivore — grass, forbs, browse; can graze shorter grass than cattle
- Biome: Temperate grassland, montane, Mediterranean semi-arid — very hardy
- Body mass: 40–100 kg (adult)
- Products on death:
  - Hide (sheepskin): small; tanned → soft leather, parchment (vellum — scraped, stretched, dried → writing surface)
  - Tallow: rendered fat — candles, soap, lubricant
  - Bone: similar to cattle but smaller
  - Sinew: lighter cordage
  - Horn: worked horn tools
- Alive products (domesticated):
  - Wool: shorn 1–2 times per year; raw fleece → washed (lanolin removal), carded, spun, woven or knitted → woolen cloth (warm, felts when wet, can be felted intentionally)
  - Lanolin (from wool washing): natural wax/oil — skin ointment, waterproofing agent for leather
  - Milk: moderate volume, higher fat than cow milk — cheese (feta, manchego)
- Ecological role: Primary grazer of montane and semi-arid biomes; overgrazing causes desertification (fine roots of grasses destroyed by sheep hooves faster than cattle)

**Goat** (*Capra hircus*)

- Diet: Herbivore + browser — unique ability to digest tough woody browse, bark, and dry vegetation that cattle and sheep reject
- Biome: Semi-arid, arid, montane, Mediterranean — extreme hardiness; survives where other ungulates cannot
- Products: Hide (soft leather — morocco, kid gloves), milk (higher fat and protein than cow milk — goat cheese), fiber (cashmere from undercoat of Cashmere goat; mohair from Angora goat)
- Ecological note: Goats can deforest a landscape — they eat tree seedlings and bark, preventing forest regeneration. A large goat herd + no predators = permanent grassland where forest would otherwise grow. This is a simulated ecological consequence

**Deer** (*Cervidae* family — red deer, fallow deer, roe deer, white-tailed deer; modeled as a biome-appropriate functional group)

- Diet: Herbivore — browse, grass, forbs, bark in winter
- Biome: Temperate forest, woodland, forest-grassland edge
- Body mass: 50–300 kg depending on species
- Products on death:
  - Hide: soft buckskin leather (brain-tanned traditionally — deer brain contains exactly enough fat to tan one hide); summer hide is thin and supple; winter hide is thick
  - Antler: hardest natural material after bone — worked into tools (pressure flaker for flint knapping, digging stick, hook), adze heads, needles, knife handles
  - Sinew: backstrap sinew — finest natural fiber, better bowstring material than cattle sinew (thinner, stronger per cross-section)
  - Bone: tools, needles, glue
  - Fat: tallow equivalent, but less abundant than cattle
- Ecological role: Primary herbivore of temperate forest biome; without predator pressure (wolves, lions), populations explode and overbrowse forest understory, preventing tree regeneration

**Horse** (*Equus caballus*)

- Diet: Herbivore — grass, forbs
- Biome: Temperate grassland (steppe) — origin in Eurasian steppe; adapted to cold, dry continental grassland
- Products on death: Hide (horse leather — strong, used for boots), bone, sinew, fat
- Alive (domesticated): Draft power (pulling plows, carts, millstones, artillery — stronger than oxen for speed, weaker for sustained pulling); riding (mobility — transforms settlement trading radius); war (cavalry); threshing (walking over grain stalks)
- Ecological role: Primary megaherbivore of steppe biome; grazes differently from cattle (clips grass shorter) — maintains open grassland

**Wild Boar** (*Sus scrofa*)

- Diet: Omnivore — roots, tubers, acorns, mushrooms, carrion, small animals; rooting behavior (turns over soil with snout)
- Biome: Temperate deciduous forest, Mediterranean woodland, scrub
- Body mass: 50–200 kg
- Products: Hide, fat (lard — preferred over tallow for cooking, lubricant, soap), bone, bristle (brush-making)
- Alive (domesticated as pig): Manure (high nitrogen — best agricultural fertilizer available pre-synthetic), converts food waste and acorn mast into meat and fat efficiently
- Ecological role: Seed dispersal (buries acorns); rooting disturbs soil, creates microhabitats for ground-nesting birds; key consumer of forest mast

---

**Carnivores and Apex Predators**

Predators are modeled for population control and ecosystem balance, not primarily as harvestable resources. Their presence keeps herbivore populations from overgrazing autotrophs.

**Wolf** (*Canis lupus*)

- Diet: Carnivore — deer, wild boar, smaller animals; pack hunter
- Biome: Temperate forest, boreal forest, tundra, grassland
- Ecological role: Primary deer population regulator. When wolves are present, deer populations are suppressed and forest regenerates. When wolves are hunted out, deer overpopulate and forest collapses (trophic cascade — documented in Yellowstone: wolf reintroduction in 1995 transformed rivers and vegetation within years). This trophic cascade is a simulated consequence in the game. A settlement that hunts wolves to extinction to protect livestock will see deer overpopulation → forest overbrowsing → timber collapse within decades.

**Lion / Big Cats** (*Panthera leo* and others, by biome)

- Biome: Tropical savanna, grassland
- Ecological role: Controls wildebeest, zebra, antelope populations in tropical grassland. Equivalent trophic cascade to wolf in temperate zones

**Eagle / Raptor** (functional group — hawks, eagles, owls)

- Diet: Carnivore — small mammals, fish, rabbits, rodents
- Biome: All biomes — highest diversity in temperate and tropical biomes
- Products: Feathers (arrow fletching — primary early game projectile component; eagle feathers preferred for straightness and stiffness)
- Ecological role: Primary rodent population controller; DDT biomagnification target — raptors at top of terrestrial food chain accumulate DDT from eating contaminated small mammals and fish → eggshell thinning → population collapse. This is the first visible sign of DDT's ecosystem consequence in the simulation

**Fish** (multiple species modeled as biome-appropriate functional groups)

- Diet: Omnivore (most freshwater species); carnivore (large marine species)
- Biome: Freshwater (rivers, lakes), coastal marine, open ocean — each with different species group
- Products on death:
  - Meat: food — preserved by salting, smoking, or drying
  - Oil (fatty species — herring, mackerel, salmon, sardine): fish oil — lubricant, lamp fuel (fish oil lamp predates tallow candle), soap precursor, leather conditioner
  - Bones: needles (fine fish bones), fish glue (boiled bones — strong, water-resistant adhesive), fertilizer
  - Scales: mirror surface (before glass), decorative
- Ecological role: Freshwater fish transfer nutrients from water to land (via predation by bears, raptors, humans); marine fish are the primary protein source for coastal civilizations; DDT biomagnification applies — large predatory fish (tuna, pike, salmon) accumulate DDT from contaminated plankton/insects → consumption by humans and raptors causes secondary poisoning

**Rabbit / Hare** (*Lepus*, *Oryctolagus*)

- Diet: Herbivore — grass, forbs, bark
- Biome: Temperate grassland, forest edge, semi-arid
- Products: Hide (rabbit fur — warmth, soft), meat, bone
- Ecological role: Primary prey of foxes, hawks, and wolves; population regulated by predators; in absence of predators, explodes exponentially (Australia rabbit introduction is the historical example — without natural predators, rabbits denuded vegetation across a continent)

---

**Insects and Invertebrates**

**Honeybee** (*Apis mellifera* and related species)

- Diet: Mixotroph / herbivore — collects nectar and pollen from flowering plants
- Biome: Temperate, subtropical, tropical — anywhere flowering plants exist
- Colony size: 20,000–80,000 individuals (modeled as a single organism entity with colony-level behavior)
- Products:
  - Beeswax: secreted by worker bees to build honeycomb — harvested from comb after honey extraction. Properties: melt point 62–65°C, water-resistant, plastic when warm. Uses: candle making (burns cleaner than tallow with less smoke), waterproofing (rope, leather, cloth, wooden joints), writing tablet (wax tablet), thread waxing (reduces friction for sewing), pharmaceutical base
  - Honey: concentrated nectar — primary sweetener before cane sugar arrives; preservative (antimicrobial — low water activity + hydrogen peroxide); mead (fermented honey + water = oldest alcoholic beverage, predates grain beer)
  - Propolis (bee glue): resin collected from tree buds, mixed with wax and saliva — used by bees to seal hive. Properties: antimicrobial, antifungal, sticky. Historical use: sealing wounds, varnish precursor (Stradivarius violins may have used propolis-based varnish)
  - Royal jelly: secreted by nurse bees to feed queen; high in proteins and fatty acids
- Dependency: Honeybees depend on flowering plants (need at least one flowering plant species in biome). Conversely, ~70% of flowering plants require bee pollination — without bees, plant reproduction drops sharply. This is a game-critical dependency: if bee populations collapse (pesticide use, habitat loss), autotroph reproduction drops, food supply drops, settlement population drops

**Silkworm** (*Bombyx mori*)

- Diet: Herbivore — exclusively mulberry leaves (*Morus* spp.); will not eat any other plant
- Biome: Temperate to subtropical — wherever mulberry grows; farmed indoors in silkworm houses
- Products:
  - Silk thread: silkworm spins a cocoon of a single continuous protein filament (fibroin) 300–1500 meters long. To harvest, cocoons are steamed (killing the pupae) and the filament unwound. Multiple filaments twisted together form silk thread — the finest and strongest natural textile fiber
  - Used for: luxury cloth, surgical suture (strong, biodegradable), bowstring (most accurate natural bowstring — silk stretches uniformly), fishing line
- Constraint: Requires mulberry trees. No mulberry = no silk. This creates a real technology prerequisite: silk production demands mulberry cultivation and silkworm husbandry both

**Gall wasp** (*Cynips* spp. and others)

- Diet: Herbivore — infects oak tree tissue; larva develops inside gall structure
- Biome: Temperate deciduous forest, wherever oak grows
- Products: Oak galls (plant tissue response to larval secretions) — highest tannin concentration of any natural source (~50–70% gallic acid and tannic acid). Primary ingredient for iron gall ink (medieval and Renaissance writing ink), used for 1,400 years; also supplementary tannin source for leather

**Dung Beetle** (*Scarabaeidae*)

- Diet: Heterotroph — dung; processes and buries mammal dung
- Biome: Grassland, savanna, temperate open terrain
- Ecological role: Soil aeration (burrowing), nutrient cycling (buries dung, releases nitrogen to root zone), pest control (removes dung that would otherwise breed flies). Without dung beetles, grassland fertility drops. Historical example: Australia's native dung beetles could not process cattle dung (wrong dung type) — agricultural areas developed fly plagues and soil fertility problems until European dung beetles were imported.

**Earthworm** (*Lumbricus* and others)

- Diet: Mixotroph — consumes decomposing organic matter and mineral soil
- Biome: Temperate and tropical soil — requires moist, non-frozen, non-arid soil
- Ecological role: Primary soil structure organism — burrowing aerates soil, casts improve fertility, tunnels improve drainage. Farmland without earthworms compacts and loses fertility. Charles Darwin's last book (*The Formation of Vegetable Mould Through the Action of Worms*, 1881) quantified earthworm ecosystem services. In-game: settlement agricultural productivity scales partially with earthworm population density in nearby soil.

---

#### Kingdom Fungi — Decomposers and Symbionts

Fungi are modeled as chemoautotrophs/decomposers — they gain energy from breaking down organic matter, not from sunlight. Unlike plants and animals, individual fungi are not positioned as discrete entities; they are modeled as colony density per soil cell.

**Decomposer fungi** (functional group — *Agaricus*, *Pleurotus*, and thousands of species)

- Role: Primary decomposer of dead plant material — breaks down cellulose and lignin. Without decomposer fungi, dead plant material accumulates without releasing nutrients back to soil. This is why coal exists: the Carboniferous period produced coal because lignin-digesting fungi had not yet evolved — wood piled up instead of rotting.
- Products: Mushroom fruiting bodies (food); mycelium mat (structural material — mycelium composite is an emerging material but requires specific species and controlled conditions)
- Ecological function: Locks carbon in soil; completes nutrient cycle

**Mycorrhizal fungi** (functional group — *Amanita*, *Boletus*, *Rhizopogon*, and thousands of species)

- Role: Symbiont — forms physical connections between fungal mycelium and plant roots. Plant feeds fungus carbon (sugar); fungus feeds plant phosphorus and water extracted from soil pores too small for roots to reach. ~90% of all plant species depend on mycorrhizal associations. Trees in a forest are linked by a fungal network — established trees transfer carbon to seedlings via this network ("wood wide web"). Cutting all trees destroys the fungal network; replanting in a clearcut does not restore the network for decades.
- Game consequence: Deforested land has reduced mycorrhizal network → replanted trees grow slower than trees in intact forest → timber recovery is slower than raw growth rate suggests

**Ergot** (*Claviceps purpurea*)

- Role: Parasite — infects rye and other grains in wet humid conditions during flowering
- Products: Ergot alkaloids (lysergic acid derivatives — vasoconstrictors, uterotonic, hallucinogenic in sufficient dose). Historically caused ergotism: mass poisoning of populations eating contaminated grain. "St. Anthony's Fire" — burning sensation in limbs, hallucinations, convulsions, dry gangrene of extremities
- Game consequence: Wet season + rye crop = risk of ergot contamination in NPC grain supply. Grain appears normal but causes settlement-wide ergotism if stored and consumed without visual inspection

**Penicillium mold** (*Penicillium chrysogenum* and related)

- Role: Decomposer — grows on any organic matter in cool, humid conditions; common bread mold and cheese mold
- Products: Penicillin (excreted as competitive metabolite — kills bacteria competing for the same substrate)
- Discovery condition: Player observing a green-blue mold colony growing adjacent to a bacterial culture notices bacteria dying in the vicinity → isolation and extraction experiment → crude penicillin (requires distillation equipment and understanding of filtration)
- Game behavior: Penicillium appears spontaneously on stored food and in humid caves. It is always there — the question is whether anyone notices the bacteria-free zone around it

**Yeast** (*Saccharomyces cerevisiae* and related wild yeasts)

- Role: Mixotroph — ferments sugars to ethanol + CO₂ under anaerobic conditions; respires aerobically when oxygen is present
- Habitat: Surface of fruits (wild yeast), grain, flower nectar, soil; air — yeast is always present in the environment
- Products: Ethanol (fermentation product — beer, wine, distilled spirits), CO₂ (leavening agent in bread), lactic acid (sourdough, in combination with lactobacillus)
- Game behavior: Yeast does not need to be "found" — it is present on every fruit surface and grain. A player who crushes grapes and leaves the juice in a vessel will observe spontaneous fermentation within 24–48 hours. The game does not require a yeast discovery event — fermentation is a natural consequence of sugar + time + warmth + anaerobic conditions

---

#### Kingdom Bacteria — Decomposers, Fixers, and Fermenters

Bacteria are modeled not as individual organisms but as functional populations in specific environments. Their presence is assumed wherever the right substrate, temperature, and chemistry exist. Players cannot see bacteria — they see the consequences.

**Nitrifying bacteria** (*Nitrosomonas*, *Nitrobacter*)

- Environment: Soil, dung heaps, cave guano accumulations, compost — wherever organic nitrogen compounds (urea, uric acid, protein) decompose
- Function: Two-stage oxidation chain: NH₃ → NO₂⁻ (Nitrosomonas) → NO₃⁻ (Nitrobacter). The end product — nitrate — is soluble, mobile in soil water, and can crystallize as potassium nitrate (saltpeter) on cave walls and stable floors when potassium is present
- Game consequence: A sealed cave with a large bat colony develops saltpeter efflorescence on walls over 12–18 months. A livestock stable floor develops saltpeter after 6–12 months. The player who scrapes this crystalline material and tests it (ignition test — saltpeter supports combustion; burns with purple flame from potassium) has found a gunpowder precursor. No recipe is needed — the chemistry produces it if the environment is correct

**Acetobacter** (*Acetobacter aceti*)

- Environment: Dilute ethanol solutions exposed to air — wine barrel surfaces, open fermentation vessels, surface of vinegar "mother"
- Function: Oxidizes ethanol to acetic acid: C₂H₅OH + O₂ → CH₃COOH + H₂O. This is why open wine turns to vinegar — Acetobacter is always present in air and cannot be excluded from an open vessel
- Game consequence: Wine or beer left in an open vessel at warm temperature → vinegar within 2–4 weeks. A sealed vessel → stays as wine/beer. The player who deliberately leaves wine open produces vinegar (acetic acid), which then enables further chemistry (acid reactions, pickling, removal of carbonate scale)

**Lactobacillus** (*Lactobacillus* spp.)

- Environment: Food surfaces, gut of animals, fermentation vessels — ubiquitous
- Function: Ferments sugars and lactose to lactic acid under anaerobic conditions. Reduces pH, inhibiting spoilage bacteria. Responsible for cheese ripening, yogurt, sauerkraut, kimchi, sourdough bread acidity, salt-preserved meat
- Game consequence: Salted meat and fish preserved by a combination of osmotic dehydration (salt) + lactic acid fermentation (lactobacillus naturally present on food surface). The player does not add lactobacillus — it is always there. The right salt concentration selects for it while killing spoilage organisms

**Rhizobium** (nitrogen-fixing root symbiont)

- Environment: Root nodules of legume plants — exists in soil wherever legumes have grown
- Function: Fixes atmospheric N₂ → NH₄⁺ (ammonium) inside root nodules. The legume supplies carbon; Rhizobium supplies fixed nitrogen. When the plant dies, nitrogen releases into soil. Grain crops following a legume crop have higher nitrogen availability and yield better.
- Game consequence: NPC farms that rotate grain → legume → grain maintain soil fertility. Farms that grow grain continuously exhaust soil nitrogen. Soil nitrogen depletion is modeled per cell — fields that have never grown legumes have lower productivity

**Decomposer bacteria** (functional group — *Bacillus*, *Pseudomonas*, *Clostridium*, and thousands of others)

- Environment: All soils, all dead organic matter
- Function: Primary decomposers — break down proteins (putrefaction), cellulose (with cellulase enzymes), fats (rancidification). Decomposition releases CO₂, NH₃, H₂S. Rate depends on temperature, moisture, and oxygen.
- Game consequence: Dead organisms decompose — their nutrients return to soil. The rate of decomposition determines how quickly a cleared field, a kill site, or a dump becomes fertile again. Aerobic decomposition (well-drained, oxygenated) is fast and odorless. Anaerobic decomposition (waterlogged) is slow and produces methane and H₂S — detectable by smell and by flammability of gas above stagnant water

---

#### Ecological Food Chain and Biomagnification

Every organism in the system is linked to the food chain. Each feeding interaction transfers energy (with ~10% efficiency per trophic level — the ecological energy rule: only 10% of energy consumed is incorporated into biomass; 90% is lost as heat). It also transfers any accumulated contaminants.

The food chain for biomagnification works as follows:

```
Soil bacteria → Decompose organic matter → Release nutrients
Plants (autotrophs) → Absorb nutrients + sunlight → Grow
Insects / invertebrates → Eat plants → Accumulate plant compounds
Small fish / birds / amphibians → Eat insects → Accumulate further
Large fish / medium predators → Eat small animals → Accumulate further
Apex predators (eagles, large fish, humans) → Eat medium predators → Maximum accumulation
```

When DDT (or any persistent organic pollutant) is applied to a field, it enters this chain at the plant/soil level and concentrates with each trophic step. At the apex predator level, concentrations may be 10,000–100,000 times the original soil concentration. Effects by trophic level:

- Insects: sub-lethal neurological effects (behavioral changes — bees lose navigation, can't return to hive → colony collapse)
- Small birds/fish: lethal above ~5 ppm in tissue
- Raptors (eagles, ospreys, peregrine falcons): eggshell thinning (DDT inhibits carbonic anhydrase, reducing calcium carbonate deposition) → eggs crack under brooding weight → breeding failure → population collapse within 2–3 generations
- Humans: liver toxicity, endocrine disruption, probable carcinogen at chronic exposure levels

The game tracks contaminant concentration per organism. A player who kills a large fish downstream of a DDT-treated field will see an anomalous contamination flag on the fish. An NPC settlement that eats contaminated fish regularly shows declining health and reproduction. Eagle populations collapse within in-game years.

---

#### Organism System Architecture — What Needs to Change

The current system models organisms as abstract entities with diet types and energy budgets. Species identity must be added as a new field without breaking the existing simulation.

**New fields required per organism entity:**


| Field             | Type                   | Description                                                                              |
| ----------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| `speciesId`       | string                 | Unique species identifier (e.g., `"quercus_robur"`, `"apis_mellifera"`)                  |
| `kingdom`         | enum                   | `plant`, `animal`, `fungus`, `bacteria`                                                  |
| `bodyMass`        | number                 | Current mass in kg — scales energy stored and yield on harvest                           |
| `growthStage`     | enum                   | `seed`, `juvenile`, `mature`, `senescent` (plants); `pup`, `juvenile`, `adult` (animals) |
| `biomeAffinity`   | number[]               | Compatibility score per biome (0–1 per biome type) — replaces binary biome assignment    |
| `contaminantLoad` | Record<string, number> | Accumulated contaminant concentrations — e.g., `{ "DDT": 0.003 }` in mg/kg body fat      |
| `products`        | ProductEntry[]         | What this organism yields when harvested at current growth stage                         |
| `dependencies`    | string[]               | Species IDs this organism depends on (mulberry → silkworm; oak → gall wasp)              |


**New simulation behaviors:**

- Plants grow biomass per tick proportional to sunlight × biome productivity × soil nitrogen × mycorrhizal network density. They yield products proportional to current biomass.
- Animals move toward food sources. Herbivores graze plant patches. Carnivores pursue prey. Prey flees (behavioral state machine).
- Contaminant transfer: at each feeding interaction, transfer a fraction of predator's contaminant load × bioaccumulation factor to prey's load.
- Decomposition: dead organisms lose mass at decomposition rate. Nutrients released to soil cell.
- Bee pollination: each tick, bees within territory radius increase seed production of nearby flowering plants by a pollination factor. Without bees, seed production drops.

**Population caps remain per biome carrying capacity** — now broken down by trophic level rather than total organism count:

- Primary producer cap (autotrophs) = f(biome NPP, soil fertility, rainfall)
- Primary consumer cap (herbivores) = f(autotroph population)
- Secondary consumer cap (omnivores) = f(primary consumer + autotroph populations)
- Apex predator cap = f(secondary consumer population)


### 4.3 Geology & Resource Distribution

Resource distribution builds on the planetary formation and tectonic structure defined in §1. Resource nodes are concentrated according to real geological processes. Settlement specialties assigned by server-side geology query (matching the client algorithm exactly).

**Scientific grounding — why geology determines civilization:**
Jared Diamond's *Guns, Germs, and Steel* (1997) argues that geography is the primary driver of civilizational development — not intelligence, culture, or luck. Societies that happened to sit on land with domesticable crops, workable metals, and navigable rivers developed faster and outcompeted those that did not. The same logic applies here. A player who starts near a copper-rich volcanic zone has access to metal tools earlier than one who starts in a sedimentary basin with only flint. This is not unfair — it is how reality works. The world rewards exploration and trade precisely because different regions have different resources.

Every resource in the game has one or more real geological formation mechanisms. A player who understands these can search intelligently instead of wandering randomly. The entries below cover every resource in the game's material taxonomy — how it forms, under what conditions, and what terrain signals its presence.

---

#### 3.4.1 Metals and Ores

**Copper** (native copper, malachite, azurite, chalcopyrite)

*Formation mechanism 1 — Porphyry copper deposits:* The most common copper source. When a magma body cools beneath a subduction zone, hot saline fluids circulate through the cooling rock and precipitate copper sulfides (chalcopyrite, bornite) in a disseminated halo around the intrusion. These deposits are enormous but low-grade — billions of tonnes of rock at 0.3–1.5% copper. They form exclusively at convergent plate boundaries where oceanic crust subducts under continental crust.

*Formation mechanism 2 — Hydrothermal vein deposits:* Hotter, more concentrated mineralizing fluids travel along fault systems and fracture zones. As they cool, copper minerals drop out of solution and fill the fracture walls. These deposits are smaller but much richer (2–10% copper). The veins often follow fault scarps visible at the surface. Associated with volcanic arcs.

*Formation mechanism 3 — Native copper in basalt:* In places where basaltic lava flows over groundwater-saturated terrain, copper-bearing hydrothermal solutions percolate upward through gas vesicles (amygdules) in the cooling basalt and deposit native metallic copper — the purest natural copper, requiring no smelting, only hammering. The Michigan Upper Peninsula produced native copper this way for thousands of years of pre-contact indigenous metalwork. Found in flood basalt provinces.

*Formation mechanism 4 — Secondary enrichment (gossans):* When a sulfide ore body is exposed to weathering, rainwater dissolves the copper and carries it downward. Below the water table, this dissolved copper re-precipitates in a supergene zone — much higher grade than the original ore. The gossanous (rusted-orange) surface cap above the water table is a visible exploration signal. Malachite (green) and azurite (blue) oxidation minerals appear at surface outcrops.

*Game search signal:* Volcanic terrain at plate boundaries. Bright green (malachite) or blue (azurite) rock patches at surface. Rusted orange gossan caps.

---

**Tin** (cassiterite — SnO₂)

*Formation mechanism 1 — Granitic pegmatite veins:* Tin concentrates in the last fraction of magma to solidify when a granite intrusion cools. This late-stage fluid is enriched in volatile elements (fluorine, boron, water) and rare metals including tin, tungsten, and lithium. It intrudes into the surrounding country rock as coarse-crystalline pegmatite veins. Cassiterite (tin oxide) forms large, well-crystallized black crystals within these veins. The veins cut through or occur within granite plutons.

*Formation mechanism 2 — Alluvial/placer deposits:* Cassiterite is dense (6.9 g/cm³) and chemically inert — it survives weathering intact. When pegmatite veins erode, the cassiterite washes downstream and settles in river bends and gravel bars, exactly like gold. The great tin fields of Southeast Asia (Malaysia, Indonesia, Thailand) are almost entirely alluvial placer deposits worked by hydraulic dredging. Tin can often be found by panning river sediments near granite highlands.

*Game search signal:* Granitic highlands, coarse-grained pale rock (granite outcrops). River gravels and alluvial plains downstream of granite terrain. Heavy black mineral grains in river sediment.

---

**Lead** (galena — PbS)

*Formation mechanism 1 — Mississippi Valley-type (MVT) deposits:* Lead and zinc sulfides (galena and sphalerite) precipitate when warm saline brines expelled from deep sedimentary basins migrate upward and encounter carbonate rocks (limestone, dolomite). The brines carry dissolved lead and zinc; when they cool or mix with sulfur-rich fluids, galena and sphalerite precipitate in open pores and cavities of the limestone. These deposits form far from volcanoes — in stable sedimentary platforms, often hundreds of kilometers from any plate boundary. The name comes from the major Pb-Zn districts of Missouri, Kansas, and Oklahoma.

*Formation mechanism 2 — Hydrothermal veins:* As with copper, lead also precipitates in fault-controlled hydrothermal veins. Galena typically co-occurs with silver (argentite is often intergrown within galena crystals), which is why lead smelting historically yielded silver as a byproduct. These deposits are associated with volcanic arcs.

*Formation mechanism 3 — Sediment-hosted stratiform deposits:* Some lead deposits formed as seafloor hydrothermal vents discharged metal-rich brines onto the ocean bottom. The galena precipitated in flat layers interbedded with normal marine sediment — called sediment-hosted massive sulfide (SHMS) deposits. These appear as flat, tabular ore bodies within sedimentary sequences.

*Game search signal:* Limestone terrain (grey, layered rock) in sedimentary platforms. River valleys cutting through carbonate rock sequences. Bright silver-grey metallic mineral (galena is highly reflective, cube-shaped).

---

**Iron** (hematite Fe₂O₃, magnetite Fe₃O₄, limonite FeOOH, siderite FeCO₃)

*Formation mechanism 1 — Banded Iron Formations (BIF):* The world's largest iron deposits. Between 2.5 and 1.8 billion years ago, the early ocean was rich in dissolved ferrous iron (Fe²⁺) because the atmosphere had no free oxygen. When photosynthetic cyanobacteria began producing oxygen, it oxidized the dissolved iron to insoluble ferric iron (Fe³⁺), which precipitated as hematite and magnetite in alternating red and grey bands on the seafloor. These ancient ocean deposits are now exposed as thick, layered rock formations in ancient continental cratons — the Precambrian shield rocks of Australia, Brazil, Canada, Ukraine, India, and West Africa. They are flat-lying, laterally extensive (hundreds of kilometers), and contain billions of tonnes of iron ore.

*Formation mechanism 2 — Lateritic iron (limonite):* In tropical climates with intense chemical weathering, iron in ordinary rock is oxidized and concentrated near the surface as laterite — a reddish, iron-rich soil horizon. Any silica and alumina dissolve away; iron hydroxides (limonite, goethite) remain. Laterite is low-grade but widespread and accessible. Historical bog iron — extracted from limonite-rich swamp sediments — powered the early Iron Age in Europe and Asia. Found in tropical biomes and ancient weathered landscapes.

*Formation mechanism 3 — Magmatic iron (magnetite in igneous rock):* Some granitic and basaltic intrusions contain enough iron and titanium that magnetite crystallizes as a discrete mineral phase and can form exploitable concentrations. These deposits are smaller than BIFs but occur near volcanic arcs. Magnetite is strongly magnetic — a lodestone placed near the ore will deflect visibly.

*Game search signal:* Ancient stable continental interiors (cratons), flat layered red-and-grey striped rock. Tropical terrain with red soils. Swamp edges (bog iron). Magnetic compass deflection near magnetite deposits.

---

**Gold** (native gold, electrum, gold tellurides)

*Formation mechanism 1 — Lode gold (orogenic/mesothermal veins):* The most important gold source historically. During mountain-building events, large volumes of hot fluid are expelled from deeply buried metamorphic rocks and migrate upward through fault zones. These fluids carry dissolved gold (as gold-bisulfide complexes) and deposit it as native gold in quartz veins when the fluids cool and depressurize. The gold occurs as fine disseminations and visible specks within white quartz. Found along ancient suture zones and fold belts — the roots of ancient mountain ranges, now eroded down to metamorphic basement rocks.

*Formation mechanism 2 — Epithermal gold (volcanic systems):* In active volcanic arcs, shallow hydrothermal circulation deposits gold near the surface (within 1 km depth). Hot acidic fluids move through volcanic rock and precipitate gold and silver where they boil or cool abruptly. Two subtypes: high-sulfidation (acidic, near volcanic vents, associated with sulfur and arsenic minerals) and low-sulfidation (neutral pH, white quartz veins, associated with calcite and adularia). Both are found in young volcanic terrains at convergent boundaries.

*Formation mechanism 3 — Placer gold:* Gold is dense (19.3 g/cm³) and chemically inert. When lode deposits erode, gold travels downstream and concentrates in river bedload. It settles wherever water velocity drops — the inside of meander bends, below waterfalls, behind large boulders, at bedrock irregularities on the riverbed. Fine gold panning from river sediments (alluvial placer) was the entry point for gold discovery in nearly every historical gold rush. Ancient, deeply weathered placer deposits (paleoplacers) may be buried under younger sediment.

*Game search signal:* White quartz veins in metamorphic terrain. Volcanic arc terrain (fresh or ancient). Gold panned from river gravel — follow rivers upstream toward gold-bearing highlands. Very rare; small deposit size.

---

**Silver** (native silver, argentite Ag₂S, electrum, horn silver AgCl)

*Formation mechanism 1 — Hydrothermal veins with lead:* Silver is the most common precious metal in hydrothermal vein systems. Argentite (silver sulfide) intergrows with galena (lead sulfide) so intimately that smelting lead ore almost always yields silver. The great silver deposits of history — Laurion (Greece), Potosí (Bolivia), Zacatecas (Mexico), Comstock Lode (Nevada) — are all hydrothermal vein systems. Silver occurs in the same fault-controlled veins as lead and zinc, associated with volcanic arcs.

*Formation mechanism 2 — Epithermal silver:* At shallower depths and lower temperatures than gold-bearing systems, silver precipitates in large amounts in low-sulfidation epithermal veins. The silver minerals are different: argentite, pyrargyrite (ruby silver), proustite. These vein systems can have spectacular high-grade "bonanza" zones where the veins widen and silver content rises sharply.

*Formation mechanism 3 — Secondary supergene silver:* When a silver sulfide ore body weathers, rainwater oxidizes and mobilizes the silver, which re-deposits as horn silver (AgCl, cerargyrite) — a pale grey waxy mineral — or as native silver whiskers and wire-like crystal habits near the surface. Secondary native silver can form large masses just below the oxidized zone.

*Game search signal:* Same terrain as lead and gold. Galena (silver-grey cubic) is a reliable indicator — lead smelting reveals silver. Light-grey waxy mineral near surface (horn silver). Associated with volcanic arcs and fold belts.

---

**Aluminum** (bauxite — gibbsite Al(OH)₃, boehmite AlOOH, diaspore AlOOH)

*Formation mechanism — Tropical lateritic weathering:* Aluminum cannot be found as a concentrated ore in igneous or sedimentary rocks — it is the third most abundant element in the crust, but it is locked in aluminosilicate minerals (feldspars, micas) and cannot be separated by simple chemistry. Bauxite forms only through extreme tropical weathering. In hot, wet equatorial climates, millions of years of rainfall dissolve and remove all silica, iron, calcium, and sodium from rock, leaving behind a concentrated residue of aluminum hydroxide — bauxite. This is a surficial deposit, formed in place above the parent rock. No bauxite exists in cold or arid climates. The thicker the soil profile and the older the land surface, the higher the bauxite grade.

*Additional note:* Aluminum smelting (Hall-Héroult process) requires electricity — a civilization must reach the Electrical Age before aluminum becomes accessible. Even if bauxite is found, it cannot be processed without electrolytic reduction.

*Game search signal:* Old, deeply weathered tropical terrain. Red-brown soil with white nodules. No mountain building needed — flat, ancient land surface.

---

**Tungsten** (wolframite (Fe,Mn)WO₄, scheelite CaWO₄)

*Formation mechanism — Contact metamorphic skarns and greisens:* Tungsten concentrates in the same late-stage granitic fluids as tin — the last fractions of cooling magma enriched in volatiles. Wolframite forms in greisen veins (fluorine-rich alteration zones) within and around granite intrusions. Scheelite forms in contact metamorphic skarns — zones where granite magma baked adjacent limestone and injected calcium-tungstate into the carbonate. Both deposit types occur within or immediately adjacent to granite plutons, often in the same district as tin.

*Game search signal:* Granite terrain. Dense, dark-brown to black heavy crystals (wolframite) in veins. Often co-located with tin mining areas. Scheelite fluoresces bright blue-white under UV light.

---

**Chromium** (chromite FeCr₂O₄)

*Formation mechanism 1 — Stratiform chromite in layered intrusions:* When large volumes of basaltic magma cool slowly in a magma chamber, minerals crystallize in sequence by density. Chromite, being dense and early-crystallizing, settles to the floor of the magma chamber and accumulates in discrete layers — sometimes meters thick and laterally continuous for kilometers. The Bushveld Complex (South Africa) contains over 70% of world chromite reserves this way.

*Formation mechanism 2 — Podiform chromite in ophiolites:* Ophiolites are fragments of ancient oceanic crust and upper mantle thrust onto continents during tectonic collisions. The mantle portion (peridotite/dunite) contains irregular, lens-shaped pods of chromite formed in the mantle wedge above a subduction zone. These podiform bodies are smaller and more scattered than stratiform deposits.

*Game search signal:* Ancient cratons with large, flat layered igneous complexes (dark, banded mafic rock). Mountain belts containing ophiolite sequences (dark green peridotite/serpentinite).

---

**Nickel** (pentlandite (Fe,Ni)₉S₈, lateritic nickel in garnierite)

*Formation mechanism 1 — Magmatic sulfide deposits:* When large volumes of nickel-rich basaltic or komatiitic magma intrude into the crust, sulfur from the surrounding rocks can be incorporated into the melt. The sulfur separates as an immiscible sulfide liquid that scavenges nickel, copper, and platinum from the silicate melt and sinks to the bottom of the intrusion. Pentlandite crystallizes from this sulfide liquid. Classic deposits: Sudbury (Canada — formed by a meteorite impact melting the crust), Norilsk (Russia), Thompson (Canada).

*Formation mechanism 2 — Lateritic nickel (garnierite):* In tropical climates, weathering of nickel-bearing peridotite/serpentinite concentrates nickel as green garnierite in the weathering profile. Lateritic nickel makes up ~60% of world nickel resources. Less rich per tonne than sulfide deposits but much more widespread in tropical terrain over ultramafic rocks.

*Game search signal:* Large mafic-ultramafic intrusions (dark, heavy rock). Meteorite impact craters (circular lakes, shocked rock). Tropical terrain over dark green serpentinite.

---

**Zinc** (sphalerite ZnS)

*Formation mechanism — Mississippi Valley-type and volcanogenic massive sulfide:* Zinc always co-occurs with lead in MVT deposits (see Lead above) and in volcanic-hosted massive sulfide (VMS) deposits — ancient seafloor hot spring mounds now incorporated into mountain belts. In VMS deposits, metal-rich fluids vented onto the seafloor and precipitated zinc and copper sulfides as massive mounds, later metamorphosed and deformed by tectonic activity. Zinc is so closely associated with lead that the two are almost always mined together.

*Game search signal:* Same terrain as lead. Yellow-brown to black heavy mineral (sphalerite).

---

**Manganese** (pyrolusite MnO₂, rhodonite MnSiO₃, rhodochrosite MnCO₃)

*Formation mechanism 1 — Sedimentary manganese nodules:* On the deep ocean floor, manganese precipitates slowly from cold seawater, forming fist-sized nodules rich in manganese, cobalt, nickel, and copper. These are not accessible early game — deep-sea mining requires industrial infrastructure.

*Formation mechanism 2 — Shallow marine sedimentary beds:* Ancient shallow-sea sediments can contain manganese carbonate and oxide beds deposited by bacterial activity in anoxic conditions. Found in ancient sedimentary sequences, often associated with BIF iron formations.

*Formation mechanism 3 — Supergene concentration:* Near-surface weathering of manganiferous rock produces soft, black pyrolusite coatings and dendrites on rock fractures. This is the most accessible surface deposit — a shiny black dendritic mineral on rock faces.

*Game search signal:* Black dendritic mineral on fractured rock. Ancient sedimentary terrain. Associated with iron-bearing formations.

---

#### 3.4.2 Non-Metallic Rock and Mineral Resources

**Limestone and chalk** (calcite CaCO₃, aragonite CaCO₃)

*Formation mechanism 1 — Biogenic marine carbonate:* Limestone is almost entirely biological in origin. Marine organisms — coral, mollusks, foraminifera, coccolithophores — build their shells and skeletons from calcium carbonate extracted from seawater. When they die, their shells accumulate on the seafloor and compact into limestone over millions of years. A 10-meter limestone bed represents tens of millions of years of marine sedimentation. Chalk is a particularly pure, fine-grained variety of limestone formed from microscopic coccolithophore shells, deposited in shallow warm epicontinental seas (Cretaceous chalk beds of England, France, and Kansas formed in exactly this way — the white cliffs of Dover were ocean floor 70 million years ago).

*Formation mechanism 2 — Chemical precipitation:* In warm, shallow, supersaturated marine water, carbonate can precipitate directly from solution as ooids (small rounded grains) or as carbonate mud — producing limestone without biological input. Travertine forms this way around hot springs (carbonate-rich thermal water deposits calcium carbonate as it degasses CO₂).

*Formation mechanism 3 — Reef buildup:* Coral reefs accumulate massive volumes of biogenic carbonate in place, creating thick, porous reef limestone — excellent for groundwater storage and cave formation.

*Game search signal:* Flat, layered grey-white rock in sedimentary terrain away from plate boundaries. Often contains visible shell fragments, coral fossils. Karst topography (sinkholes, caves, disappearing rivers).

---

**Clay** (kaolinite Al₂Si₂O₅(OH)₄, illite, smectite/montmorillonite, halloysite)

*Formation mechanism 1 — Weathering of feldspar-bearing rock:* Clay is the decomposition product of feldspar. All granite, most sandstone, and most metamorphic rock contain feldspar. When rainwater (slightly acidic from dissolved CO₂) attacks feldspar over thousands of years, it strips out sodium, potassium, and calcium, leaving behind a clay mineral lattice of aluminum and silicon. The type of clay depends on the parent rock and drainage conditions: kaolinite forms under intense leaching (tropical, well-drained); illite under moderate leaching; smectite under poor drainage with magnesium-rich water.

*Formation mechanism 2 — Hydrothermal alteration:* Near volcanic vents and hot springs, acidic hydrothermal fluids aggressively alter igneous rock to kaolin and alunite. This produces high-purity kaolin deposits (china clay) associated with granite intrusions and volcanic systems. Cornwall (England) and Limoges (France) china clay deposits formed this way.

*Formation mechanism 3 — Sedimentary clay beds:* Eroded clay particles transported by rivers settle in lakes, river deltas, and ocean floors as thick, soft clay layers. River floodplains always have surface clay — the fine-grained fraction of flood sediment.

*Game search signal:* Everywhere there is standing water and fine-grained sediment — river valleys, lake beds, deltas, floodplains. Tropical terrain produces the purest kaolin. Clay is never rare. Identified by its plastic behavior when wet: it sticks to the finger, holds a shape, dries white or buff.

---

**Sand and quartz** (SiO₂ — quartz, quartzite, quartz sand)

*Formation mechanism 1 — Weathering of quartz-bearing rock:* Quartz is the most chemically resistant common mineral. When granite, sandstone, or metamorphic rock weathers, feldspar dissolves into clay, dark minerals oxidize, but quartz grains survive intact. Rivers carry these grains downstream; wind transports them further. Sand is weathered quartz. A desert dune is a concentration of quartz grains stripped from rock over millions of years of erosion.

*Formation mechanism 2 — Coastal and aeolian concentration:* Waves wash lighter and more soluble minerals away, concentrating heavy, resistant quartz grains as beach sand. Wind winnows fine silt away from deflation surfaces, leaving a quartz-sand lag.

*Formation mechanism 3 — Hydrothermal quartz veins:* Pure silica precipitates from hydrothermal fluids as white quartz veins that cut through virtually every rock type. These veins are not useful as bulk silica (too hard to process in bulk), but they signal hydrothermal activity and often contain the gold and silver that precipitated alongside the quartz.

*Game search signal:* River bars, beaches, dunes — quartz sand is ubiquitous. Pure white quartzite outcrops in metamorphic terrain. White quartz veins everywhere. Silica is effectively inexhaustible.

---

**Flint and chert** (cryptocrystalline SiO₂)

*Formation mechanism — Biogenic silica in marine sediment:* Flint and chert are dense, fine-grained forms of silica that form when silica from dissolved marine organisms (radiolarians, diatoms, siliceous sponges) recrystallizes in nodules within carbonate mud during burial. The silica precipitates as irregular nodules and lenses within limestone beds. Flint is a type of chert found specifically within chalk — it formed in Cretaceous chalk seas and is the material that made Stone Age Europe possible. Without chalk terrain, there is no flint.

*Game search signal:* Inside limestone and chalk outcrops — look for dark grey to black nodular masses within white or grey limestone layers. Cliff faces exposing limestone beds. Flint is identifiable by its conchoidal (shell-shaped) fracture when struck.

---

**Gypsum** (CaSO₄·2H₂O) and **Anhydrite** (CaSO₄)

*Formation mechanism — Evaporite basin:* Gypsum forms when a landlocked sea or a marine basin becomes isolated and begins evaporating. As the water becomes increasingly saline, calcium sulfate reaches saturation first and precipitates as gypsum (at lower temperatures) or anhydrite (at higher temperatures or deeper burial). Gypsum always underlies halite (salt) in an evaporite sequence — it precipitates at higher water activity. Ancient evaporite sequences are found in intracratonic basins (the interior of continents, where ancient seas once existed). The Michigan Basin, Permian Basin (Texas), Zechstein Basin (North Sea region), and Keuper beds (Central Europe) are all gypsum-salt sequences from ancient evaporated seas.

*Game search signal:* Same terrain as salt — sedimentary basins with ancient marine history. Soft, white-to-grey rock that scratches easily with a fingernail. Often interbedded with halite in outcrop. Alabaster is a fine-grained variety.

---

**Salt** (halite — NaCl)

*Formation mechanism 1 — Evaporite basin (marine evaporation):* When an arm of the sea becomes isolated — by tectonic closure, a sand bar, or a change in sea level — and the climate is arid enough that evaporation exceeds inflow, the water concentrates. Calcium carbonate precipitates first (limestone), then gypsum, then halite (common salt), then the more soluble potassium and magnesium salts (sylvite, carnallite, bischofite). A complete evaporite sequence records the entire drying history of an ancient sea. The Mediterranean Sea almost completely evaporated 5–6 million years ago (Messinian Salinity Crisis), leaving up to 3 km of salt beneath the present seafloor. In the game: large sedimentary basins in arid zones contain salt domes and bedded halite.

*Formation mechanism 2 — Salt diapirs (underground domes):* Salt is less dense than most rock and flows plastically under pressure. Over millions of years, thick salt beds become gravitationally unstable and pierce upward through overlying sediment as rising salt diapirs — underground salt pillars and domes. These can reach the surface as salt plugs or salt glaciers (Iran has surface salt glaciers today). A player walking over a salt dome may find salt outcrops far from any basin or ancient sea.

*Formation mechanism 3 — Playa lake evaporation (surface salt flats):* In desert basins with no drainage outlet (endorheic basins), seasonal rain dissolves salts from surrounding terrain and carries them into a central lake. When the lake dries, salt is left behind as a hard white crust. The Bonneville Salt Flats (Utah), Salar de Uyuni (Bolivia), Chott el Djerid (Tunisia), and Sambhar Lake (India) all formed this way. Surface salt flats are immediately visible and collectable without mining.

*Formation mechanism 4 — Sea spray and coastal salt pans:* In coastal zones with tidal flats and strong sun, seawater trapped in shallow pools evaporates and deposits thin salt crusts. Traditional salt production in the Mediterranean, Bay of Biscay, and East Asia relied entirely on solar evaporation in artificial coastal salt pans (salinas). No underground mining required.

*Game search signal:* White surface crust in dry, flat basin terrain (salt flat — immediately visible and collectable). Arid coastal tidal flats (sea salt pans). Underground salt domes detectable only by drilling or mining near dome margins. Evaporite sequences in sedimentary basins interbedded with gypsum. Taste-test: salt has an unmistakable cubic crystal habit and solubility in water.

---

**Potash** (sylvite KCl, carnallite KMgCl₃·6H₂O, polyhalite K₂Ca₂Mg(SO₄)₄·2H₂O)

*Formation mechanism — Late-stage evaporite precipitation:* Potassium salts are more soluble than halite and precipitate only in the final stages of brine evaporation — requiring ~90% water loss. This means potash deposits form only in the deepest, most isolated parts of evaporite basins where brine became maximally concentrated. Potash layers sit above gypsum and halite in the evaporite stratigraphy and are therefore deeper. The Permian evaporites of New Mexico (Carlsbad Potash District) and Saskatchewan (the world's largest potash reserves) formed in closed marine basins during particularly arid periods.

*Game search signal:* Deep below salt deposits in sedimentary basins. Never exposed at surface in humid climates (too soluble — it would have dissolved). Only accessible in arid regions or by mining below the salt layer.

---

**Saltpeter** (potassium nitrate KNO₃, also calcium nitrate Ca(NO₃)₂ and sodium nitrate NaNO₃)

*Formation mechanism 1 — Cave bat guano nitrification:* Bats roost in caves in vast colonies and deposit thick layers of guano. Bacteria in the guano decompose organic nitrogen compounds (uric acid, proteins) to ammonium, then nitrifying bacteria (Nitrosomonas, Nitrobacter) oxidize ammonium to nitrite and then nitrate. The nitrate migrates into cave wall soil and crystallizes on cool cave surfaces as saltpeter efflorescence — the white powdery crust that cave miners scraped for gunpowder. Medieval European and Asian gunpowder industries depended on cave-floor soil collection and leaching.

*Formation mechanism 2 — Soil nitrification in animal enclosures:* Urine and manure from livestock decompose and nitrify in stable floors and compost heaps. The nitrate crystallizes on stable walls and under hay as white efflorescence. Pre-industrial "nitre plantations" deliberately composted animal manure to grow saltpeter. The French government maintained royal nitre plantations; Gustavus Adolphus of Sweden ran military nitre farms. Not a geological deposit — a biological one.

*Formation mechanism 3 — Atacama Desert caliche:* The Atacama Desert of Chile is the driest place on Earth. Over millions of years, aerosol deposition from the ocean (fog, sea spray) and decomposition of biological material accumulated nitrate salts in the soil with no rain to dissolve them. The Atacama caliche beds — thick horizontal layers of calcium and sodium nitrate mixed with sand — were the world's primary nitrate source before the Haber-Bosch process (1913). Found only in hyper-arid terrain.

*Game search signal:* White crystalline efflorescence on cave walls and floors (especially near bat roosting zones). Stable floors, barn walls, and composting areas. Hyper-arid desert terrain with no modern drainage.

---

**Phosphate** (apatite Ca₅(PO₄)₃(OH,F,Cl), phosphorite, guano)

*Formation mechanism 1 — Marine phosphorite:* Phosphorus concentrates in ocean water where cold, nutrient-rich deep water upwells onto shallow continental shelves. Biological productivity is extremely high; dead organisms rain down and decompose, releasing phosphorus that reprecipitates as nodular or bedded phosphorite on the seafloor. Found along ancient upwelling zones and passive continental margins. Morocco, Florida, and North Africa have major phosphorite deposits of this type.

*Formation mechanism 2 — Guano accumulation:* Seabird colonies on islands, rocky coasts, and isolated cliffs deposit guano rich in phosphate. In arid climates, guano preserves and concentrates. The Chincha Islands (Peru) had guano deposits 50 meters thick from centuries of seabird accumulation. Bat guano in caves similarly concentrates phosphate.

*Formation mechanism 3 — Igneous apatite:* Apatite crystallizes from most magmas as an accessory mineral, concentrated in some carbonatite intrusions. Not the primary source for bulk phosphate, but accessible as individual crystals.

*Game search signal:* Ancient continental margins, flat-lying grey nodular rock in marine sedimentary sequences. Seabird island rookeries. Cave systems with large bat populations.

---

**Sulfur** (native S, pyrite FeS₂, sulfate minerals)

*Formation mechanism 1 — Volcanic sublimation (fumarolic sulfur):* At active volcanic vents (fumaroles), sulfur dioxide and hydrogen sulfide gas emerge from the magma below. As these gases meet cooler air, native sulfur sublimates directly onto rock surfaces as bright yellow crystalline deposits. These fumarolic sulfur deposits are found at volcanoes worldwide — the sulfur mines of Sicily (exploited since antiquity) formed this way from Neogene volcanic activity.

*Formation mechanism 2 — Caprock sulfur (biogenic reduction of anhydrite):* Bacteria can reduce calcium sulfate (anhydrite or gypsum) back to hydrogen sulfide, which then oxidizes to native sulfur. This process occurs at the top of salt domes where sulfate-bearing water meets hydrocarbon seeps. The resulting caprock sulfur deposits (as at the Texas Gulf Coast domes) were the primary US sulfur source before the mid-20th century (Frasch process).

*Formation mechanism 3 — Sulfide ores (pyrite):* Pyrite (FeS₂ — fool's gold) is the most abundant sulfide mineral in the crust. It forms in almost any hydrothermal deposit, in sedimentary black shales (framboidal pyrite from bacterial sulfate reduction), and in metamorphic rocks. Pyrite is not itself the target — it is a source of sulfur for acid production (roasting pyrite yields SO₂ → H₂SO₄). Pyrite occurs everywhere that reducing conditions existed.

*Game search signal:* Yellow crystalline crust on volcanic rocks (fumarolic). Bright brass-yellow cubic crystals (pyrite) — identifiable by extreme hardness (unlike gold, which is soft) and greenish-black streak. Black shale units.

---

**Graphite** (crystalline carbon C)

*Formation mechanism 1 — Metamorphism of organic-rich sediment:* The most common source. When carbon-rich sedimentary rock (coal, organic-rich shale, carbonaceous limestone) is heated and compressed by regional metamorphism, the organic carbon recrystallizes into ordered graphite. The higher the metamorphic grade, the more perfect the graphite crystal structure. Graphite schist and marble (metamorphosed limestone with original organic matter) are the primary host rocks. Sri Lanka, Mozambique, and Canada are major producers — all in ancient high-grade metamorphic terrains.

*Formation mechanism 2 — Contact metamorphism of coal:* When an igneous intrusion bakes an adjacent coal seam, the coal is converted to graphite. These are smaller but often very high-purity deposits.

*Formation mechanism 3 — Magmatic graphite in carbonatites:* Rare. Some carbon-rich magmas crystallize graphite directly.

*Game search signal:* High-grade metamorphic terrain (gneiss, schist, marble). Dark, platy mineral with greasy feel and dark grey streak on rock. Metamorphic terrains that once contained organic sediment.

---

**Diamond** (C — cubic crystal structure)

*Formation mechanism 1 — Kimberlite pipes:* Diamonds form under extreme pressure and temperature (>45 kbar, >900°C) in the mantle, at depths of 150–200 km, within the ancient, cold keels of cratons (stable continental cores). They are brought to the surface by kimberlite eruptions — rare, violent volcanic intrusions that ascend so rapidly (several hours) that diamonds have no time to convert back to graphite. Kimberlites are funnel-shaped pipes of dark, altered volcanic rock found exclusively on ancient cratons (Africa, Siberia, Canada, Australia). Not all kimberlites are diamond-bearing; only those from depths below the continental lithosphere.

*Formation mechanism 2 — Alluvial/marine placer diamonds:* Diamonds eroded from kimberlites accumulate in river and coastal deposits. Many of the world's gem diamonds (Namibia, Sierra Leone, Botswana coast) were mined from alluvial gravels downstream of ancient kimberlites. Diamonds are dense and inert — they survive transport intact.

*Game search signal:* Ancient craton interiors — the oldest, most stable continental cores. Dark, fine-grained volcanic pipes cutting through old metamorphic terrain (kimberlites look like dark grey to bluish-green intrusives). Extremely rare — one kimberlite per several thousand square kilometers; most are not diamond-bearing.

---

#### 3.4.3 Evaporite and Sedimentary Resources

These are addressed with their minerals above (salt, gypsum, potash). See entries above.

---

#### 3.4.4 Carbon-Bearing Materials

**Coal** (peat → lignite → sub-bituminous → bituminous → anthracite)

*Formation mechanism — Compression of swamp biomass:* Coal forms in swamp forests where dead plant material accumulates faster than it decomposes. Without oxygen (waterlogged conditions), organic matter does not rot — it accumulates as peat. Burial by later sediment subjects the peat to heat and pressure over millions of years, driving off water and volatile compounds in stages: peat (50% carbon) → lignite (60–70%) → sub-bituminous (70–76%) → bituminous (76–90%) → anthracite (90–98%). Each stage requires progressively more burial and time. The Carboniferous period (359–299 Ma) produced most of the world's coal because newly evolved lignin (wood) had no organisms that could decompose it — dead trees piled up for tens of millions of years.

*Rank distribution:* Low-rank coal (lignite) is near the surface in young basins with little burial. High-rank coal (anthracite) is in deeply buried or tectonically deformed basins where heat and pressure were intense. Bituminous coal is the most abundant and most useful for metallurgical coke. Coking coal requires specific rank (medium-volatile bituminous) — not all coal makes metallurgical coke.

*Game search signal:* Flat sedimentary basins away from active tectonics. Black, layered, organic-smelling rock. Often exposed in river valleys cutting through sedimentary sequences. Abundant in Carboniferous and Permian-age terrain.

---

**Peat** (partially decomposed organic matter, >50% water)

*Formation mechanism — Waterlogged organic accumulation:* Peat is the youngest, wettest precursor to coal. It forms in bogs, fens, mires, and waterlogged forests wherever organic matter accumulates under anoxic conditions. Tropical peat domes (Southeast Asia) can be 10+ meters thick. Northern hemisphere sphagnum moss bogs (Ireland, Scotland, Scandinavia, Siberia) are also thick. Peat has ~20% of coal's energy density by weight when wet; it must be dried before burning.

*Game search signal:* Flat, wet, poorly-drained terrain. Brown-black spongy ground. Bog terrain. Accessible from the surface everywhere bogs exist — no mining needed.

---

**Oil seeps and tar pits** (bitumen, asphaltum, petroleum)

*Formation mechanism — Source rock maturation and migration:* Petroleum forms when organic-rich marine sediment (source rock) is buried to depths where heat cracks organic molecules into oil and gas. The oil migrates upward through permeable rock until it reaches a structural trap (anticline, fault seal, salt dome flank). Where the trap is breached by erosion or fracturing, oil and gas seep to the surface. Asphalt forms when light fractions evaporate from a surface seep, leaving behind thick viscous bitumen. The La Brea tar pits, the Trinidad Pitch Lake, and the Athabasca oil sands are all surface seeps or near-surface accumulations.

*Game search signal:* Black viscous liquid seeping from rock faces or pooling in low ground. Petroleum smell (light hydrocarbon volatiles). Often associated with anticlines (arched rock layers) and fault zones in sedimentary basins. Animals trapped in tar pits are a visual signal.

---

#### 3.4.5 Radioactive Materials

**Uranium** (uraninite/pitchblende UO₂, carnotite K₂(UO₂)₂(VO₄)₂, coffinite USiO₄)

*Formation mechanism 1 — Unconformity-type deposits:* The world's highest-grade uranium deposits form at the unconformity (erosional boundary) between ancient Precambrian basement rocks and overlying sandstone. Uranium-bearing oxidized groundwater flows down through porous sandstone, reaches the unconformity, and meets reducing fluids rising from the basement. The chemical contrast (oxidizing vs. reducing) causes uranium to precipitate as pitchblende. The Athabasca Basin (Saskatchewan, Canada) and Kombolgie Basin (Northern Territory, Australia) contain deposits grading over 20% uranium — compared to 0.1% for typical deposits. These are in ancient cratons.

*Formation mechanism 2 — Sandstone roll-front deposits:* Uranium in solution is carried by oxygenated groundwater through permeable sandstone. Where the oxidizing front meets reducing conditions (organic matter, iron sulfides in the sandstone), uranium precipitates in a crescent-shaped "roll front." These are lower-grade (0.05–0.3%) but widespread in sedimentary basins. The Colorado Plateau (USA) and Wyoming Basins contain many roll-front deposits.

*Formation mechanism 3 — Vein-type and granite-hosted:* Uranium concentrates in granitic magmas (incompatible element) and precipitates in late-stage hydrothermal veins in and around granite intrusions. Pitchblende (massive uraninite) fills fractures and veins. The classic Joachimsthal mines (Bohemia), where Marie Curie obtained radium, were granite-hosted vein deposits.

*Additional note:* Uranium ore has no surface expression — it cannot be detected by color or texture. Detection requires a Geiger counter or equivalent instrument. A civilization must develop radiation detection technology before uranium deposits can be located deliberately.

*Game search signal:* Precambrian cratons near unconformity boundaries. Granite intrusions in ancient terrain. Sedimentary basins in arid continental interiors. No visual signal without instrumentation. Radioactive decay produces heat — anomalous warm ground in very concentrated deposits.

---

#### 3.4.6 Biogenic and Organic Resources

**Wood**

*Formation mechanism — Forest biomass:* Wood is not a geological resource, but it is the most critical raw material for pre-industrial civilization. Its availability is entirely a function of biome: tropical rainforest produces the most biomass density but the hardest, most resin-rich wood; temperate deciduous forest produces moderate volumes of excellent hardwoods (oak, ash, hickory); boreal forest produces soft conifers good for construction but poor for smelting charcoal; tundra and desert are wood-absent. Wood availability directly limits early smelting — a bloomery needs charcoal, and charcoal is made from wood. A civilization in a forest biome advances faster through the smelting stages than one on a treeless steppe.

*Game search signal:* Forest biomes — tropical, temperate, boreal. River valleys in otherwise arid zones (riparian woodland). Islands may have limited woodland that is rapidly exhausted.

---

**Plant fibers** (flax Linum usitatissimum, hemp Cannabis sativa, nettle, jute, cotton)

*Formation mechanism — Agricultural and wild plant production:* These are biological resources tied to specific climate zones. Flax grows in cool, moist temperate climates (origin: Fertile Crescent and Egypt, now Canada and Russia). Hemp is more tolerant, growing in a broad range of temperate zones. Cotton requires hot summers and adequate moisture (subtropical to tropical). Nettle fiber (ramie) is subtropical to tropical. The availability of plant fibers determines what textile options exist: no flax in the tropics, no cotton in the north. Civilizations in different biomes develop different textile traditions.

*Game search signal:* Biome-specific. Flax and hemp in temperate grassland and mixed woodland edges. Cotton in subtropical grassland and savanna. Wild forms occur naturally; cultivated forms require NPC farming settlements.

---

**Animal products** (hide, bone, sinew, wool, beeswax, tallow, horn)

*Formation mechanism — Fauna distribution by biome:* Animal products are byproducts of hunting and herding. Cattle, sheep, and goats produce hide, tallow, bone, and wool. Wild deer and elk provide sinew. Horses provide hide and bone. The fauna present in a biome determines what animal products are accessible. A tundra biome has reindeer (hide, sinew, bone) but no cattle. A grassland has large herds of ungulates. A forest has deer. An island may have no large land mammals. Beeswax requires bee colonies — temperate, subtropical, and tropical biomes all support bees but at different population densities.

*Game search signal:* Fauna spawn points by biome. Grassland and savanna have the greatest diversity and density of large ungulates. Tracking animals and hunting — no geological context. Animal products cannot be found in rock.

---

**Clay (for ceramics)** — see section 6.4.2 above.

---

#### 3.4.7 Rare and Strategic Materials

**Platinum group metals** (platinum Pt, palladium Pd, rhodium Rh, iridium Ir, osmium Os, ruthenium Ru)

*Formation mechanism 1 — Magmatic sulfide in layered intrusions:* PGMs concentrate in the same sulfide liquid as nickel and copper in large mafic intrusions. The Bushveld Complex (South Africa) contains the Merensky Reef — a 30–90 cm thick layer of platiniferous pyroxenite that extends for hundreds of kilometers. The Bushveld supplies ~70% of world platinum and rhodium. Other layered intrusions (Stillwater Complex, Montana; Great Dyke, Zimbabwe) similarly host PGM reefs.

*Formation mechanism 2 — Alluvial placer:* Like gold, PGMs are dense and chemically resistant. They occur in river placer deposits downstream of PGM-bearing intrusions. Russia's Ural Mountains placer deposits were the world's primary platinum source in the early 19th century.

*Game search signal:* Extremely rare. Large, ancient layered igneous complexes (dark, banded mafic rock). Associated with nickel-copper sulfide zones. Not accessible until industrial metallurgy.

---

**Lithium** (spodumene LiAlSi₂O₆, lepidolite, lithium brines in salars)

*Formation mechanism 1 — Pegmatite spodumene:* Lithium concentrates in granitic pegmatites alongside tin and tantalum. Spodumene forms large prismatic crystals (up to several meters long) in pegmatite dikes. Australia (Pilbara pegmatites) is the world's largest hard-rock lithium producer.

*Formation mechanism 2 — Continental salar brines:* In the Andean altiplano (Bolivia, Chile, Argentina), ancient lakes evaporated in high-altitude endorheic basins and left behind lithium-rich brines trapped in the porous sediment beneath salt flats. The Salar de Atacama contains brine at 0.15% lithium — pumped up and evaporated in solar ponds. Continental salar brines hold ~60% of world lithium resources.

*Game search signal:* Granitic pegmatite terrain (see Tin). High-altitude dry plateau basins with salt flats — pump the brine from below the salt crust.

---

#### 3.4.8 How the Game Uses This Information

All resource node placement derives from these formation rules. The game runs a geological simulation at world generation time:

1. **Tectonic plate generation** — 12 plates via Voronoi sphere partitioning. Each plate has a type (oceanic or continental), age, velocity vector, and density.
2. **Boundary classification** — each plate boundary segment is classified: convergent (subduction or collision), divergent (rift), or transform (strike-slip).
3. **Terrain assignment** — boundary type and plate type determine terrain: convergent oceanic→continental = volcanic arc + mountains; divergent continental = rift valley + flood basalt; collision = mountain belt + fold-thrust belt; stable interior = craton + sedimentary basin.
4. **Resource seeding** — each terrain type seeds resource nodes probabilistically according to the formation rules above:
  - Volcanic arc terrain → copper (porphyry probability), gold (epithermal probability), silver, lead, zinc, sulfur
  - Craton terrain → BIF iron, diamonds, nickel-copper (magmatic), graphite, uranium (unconformity)
  - Sedimentary basin → coal, salt, gypsum, potash, limestone, clay, oil seeps
  - Granitic highland → tin, tungsten, lithium pegmatites
  - Tropical terrain → bauxite, lateritic nickel, phosphorite
  - Metamorphic terrain → graphite, talc, asbestos
  - Flood basalt province → native copper
  - River valleys → placer gold, placer tin, placer diamonds (downstream of hard-rock deposits)
5. **Player exploration signal** — each resource node has visible surface expression matching its real-world signal: green malachite staining, rusty gossan, white salt crust, black coal seam in cliff, volcanic fumarole with yellow sulfur ring. A player who has read this section can locate resources systematically.

Settlement specialties are assigned by querying what resource nodes fall within 200 meters of the settlement seed point. The most abundant or highest-value node determines the specialty. A settlement seeded near a copper porphyry becomes a copper mining town. A settlement seeded in a sedimentary basin near limestone and clay becomes a pottery and masonry town. A settlement near a forest biome boundary with good clay soil becomes a farming and charcoal settlement. No designer places these — the geology places them.


### 4.4 Atmospheric Model — Weather and Seasons

#### The Principle

Weather in reality is not random — it is the result of thermodynamics applied to a rotating sphere with uneven heating. The sun heats the equator more than the poles. Hot air rises, cold air sinks. Moisture evaporates from oceans, condenses when it cools, and falls as rain. Mountains force air upward, creating rain on the windward side and dry conditions on the leeward side (rain shadow). All of this is computable from terrain + solar angle + ocean position.

#### Atmospheric Model (Server-Side, 1 Hz Tick)

The server divides the planet into an **atmospheric grid** — one cell per terrain chunk (~64m resolution). Each cell tracks physical quantities that drive weather.

```
AtmosphereCell {
  // ── Thermodynamics ────────────────────────────────────────────────────────
  airTemperature: number             // °C — the temperature a player feels at this location
  surfaceTemperature: number         // °C — ground/water surface temp (drives convection)
  humidity: number                   // 0.0–1.0 — mass ratio of water vapor to dry air
  pressure: number                   // Pa — barometric pressure

  // ── Wind ──────────────────────────────────────────────────────────────────
  windVelocity: Vec2                 // m/s — horizontal wind vector (drives clouds, affects player)
  verticalAirSpeed: number           // m/s — updraft (+) or downdraft (-) (drives cloud formation)

  // ── Cloud and Precipitation ───────────────────────────────────────────────
  cloudCover: number                 // 0.0–1.0 — fraction of sky covered
  cloudWaterContent: number          // kg/m³ — liquid water in clouds (when > threshold → rain)
  precipitationType: 'none' | 'rain' | 'snow' | 'hail' | 'sleet'
  precipitationRate: number          // mm/hour
  snowDepth: number                  // meters of accumulated snow on ground

  // ── Derived (computed per tick) ───────────────────────────────────────────
  visibility: number                 // meters — reduced by fog, rain, snow, dust
  uvIndex: number                    // 0–11+ — affects sunburn, vitamin D, material degradation
}
```

#### Temperature Calculation

Temperature at any point is computed from first principles, not from a lookup table:

```
T_air(position) = T_base(latitude, season)
                  + ΔT_altitude(elevation)
                  + ΔT_ocean(distanceToOcean)
                  + ΔT_time(hourOfDay)
                  + ΔT_cloud(cloudCover)
                  + ΔT_wind(windChill)

Where:
  T_base(lat, season):
    // Solar angle determines base temperature
    // At equator, noon sun is nearly vertical → max heating
    // At poles, sun is always low → minimal heating
    // Season shifts the solar declination angle
    solarAngle = 90° - |latitude - solarDeclination|
    T_base = -20 + 50 × sin(solarAngle × π/180)    // -20°C at poles to +30°C at equator

  ΔT_altitude(elevation):
    // Lapse rate: temperature drops ~6.5°C per 1000m altitude
    // This is the International Standard Atmosphere lapse rate
    ΔT = -6.5 × (elevation / 1000)

  ΔT_ocean(distance):
    // Ocean moderates temperature (maritime vs continental climate)
    // Near ocean: smaller temperature swings. Inland: larger swings.
    maritimeFactor = 1.0 / (1.0 + distance / 500)    // 500m halflife
    ΔT = maritimeFactor × (oceanSurfaceTemp - T_base) × 0.3

  ΔT_time(hour):
    // Diurnal cycle: coldest at dawn (06:00), warmest in afternoon (14:00)
    // Amplitude depends on cloud cover (clouds insulate → smaller swing)
    diurnalAmplitude = 8 × (1 - cloudCover × 0.5)    // ±8°C clear, ±4°C overcast
    ΔT = diurnalAmplitude × sin((hour - 6) × π / 12)

  ΔT_cloud(cloudCover):
    // Clouds trap heat at night, block sun during day
    if (isDaytime) ΔT = -cloudCover × 5              // cooler during day
    else           ΔT = +cloudCover × 3              // warmer at night

  ΔT_wind(windSpeed):
    // Wind chill: effective temperature drop from wind
    // Uses the NWS wind chill formula (simplified):
    if (T_air < 10 && windSpeed > 1.3)
      ΔT = 13.12 + 0.6215 × T_air - 11.37 × windSpeed^0.16 + 0.3965 × T_air × windSpeed^0.16 - T_air
    else ΔT = 0
```

#### Pressure and Wind

```
Pressure at altitude:
  // Barometric formula: P = P₀ × exp(-Mgh/RT)
  P(h) = 101325 × exp(-0.0289644 × 9.81 × h / (8.314 × (T + 273.15)))

Wind generation:
  // Wind flows from high pressure to low pressure (pressure gradient force)
  // Modified by Coriolis effect (planet rotation)
  pressureGradient = (P_neighbor - P_cell) / cellDistance
  coriolisForce = 2 × ω × sin(latitude) × windSpeed    // ω = planet angular velocity

  // Mountains block and redirect wind:
  if (terrainHeight > airLayerHeight)
    windVelocity = deflect(windVelocity, terrainNormal)
    // Windward side: forced uplift → condensation → rain
    verticalAirSpeed += windSpeed × sin(terrainSlope)
```

#### Cloud Formation and Precipitation

```
Cloud formation process:
  1. Air rises (updraft from heating, terrain uplift, or pressure convergence)
  2. Rising air cools at the adiabatic lapse rate (9.8°C/km dry, 6.5°C/km wet)
  3. When air cools below dew point → water vapor condenses → cloud forms
     dewPoint = T - (100 - humidity × 100) / 5    // simplified Magnus formula
     if (T_air < dewPoint) → cloudCover increases, cloudWaterContent increases

  4. When cloudWaterContent exceeds threshold → precipitation begins
     precipThreshold = 0.3    // g/m³ — typical for real clouds
     if (cloudWaterContent > precipThreshold)
       precipitationRate = (cloudWaterContent - precipThreshold) × 10    // mm/hour

  5. Precipitation type depends on air temperature at ground level:
     if (T_ground > 2°C)   → rain
     if (T_ground ∈ [-2, 2]) → sleet (mixed)
     if (T_ground < -2°C)  → snow
     if (updraft > 10 m/s && T_cloud < -20°C) → hail (strong thunderstorm)
```

#### Rain Shadow Effect

Mountains create wet windward sides and dry leeward sides:

```
When wind hits a mountain:
  1. Air forced upward on windward side → cools → condenses → rain on windward slope
  2. Air crosses the ridge → descends on leeward side → warms (adiabatic) → humidity drops
  3. Leeward side receives much less precipitation → dry biome (desert, steppe)

  // This is why the eastern side of the Cascade Range in Washington is dry
  // while the western side gets 2000mm+ of rain per year.
  // The game replicates this from terrain + wind direction alone — no biome painting needed.
```

#### Effects on Game Systems

| Weather State | Effect on Player | Effect on Materials | Effect on NPCs | Effect on Sound |
|---------------|-----------------|--------------------|-----------------|-----------------|
| Rain | Visibility reduced to 200-500m. Body temperature drops faster. Clothing gets wet (weight increase). | Wood moisture increases (+0.01/minute exposed). Flammability drops. Metal surfaces oxidize faster. Clay becomes workable. | NPCs seek shelter. Gathering pauses. | Rain ambient noise. Footstep sounds become wet/splashy. |
| Snow | Visibility 100-300m. Hypothermia risk. Movement speed -30% in deep snow. | All moisture increases. Snow accumulates on surfaces. Melts above 0°C → water. | NPCs stay indoors. Population stress increases. | Muffled ambient. Crunching footsteps. |
| Storm | Visibility <100m. Lightning strikes random tall objects (trees, structures). Wind pushes player movement. | Unsecured items blow. Fire extinguished. Trees can break (wind > 25 m/s). | NPCs shelter. Settlement damage possible. | Loud wind, thunder (distance = sound delay). |
| Fog | Visibility 20-80m. No temperature effect. | Moisture condenses on surfaces. | NPCs navigate slowly. | All sounds muffled, close-range enhanced. |
| Clear | Full visibility. Sun exposure → sunburn if prolonged. | Materials dry (moisture -0.005/minute). Optimal for fire-making. | Full activity cycle. | Dry acoustics, bird calls. |
| Hot/dry | Heat stroke risk above 40°C. Thirst drain ×2. | Wood dries fast (fire risk). Mud cracks. Clay unusable (too dry). | NPCs rest midday. Water-seeking behavior. | Dry wind, heat shimmer visual. |

#### Material Moisture Model

Rain and weather directly change material properties in the world:

```
MaterialMoistureUpdate (per tick, exposed materials only) {
  if (raining && materialIsExposed) {
    material.moisture += precipitationRate × 0.001 × dt   // absorbs rain
    material.moisture = min(material.moisture, material.maxAbsorption)
    // maxAbsorption depends on material porosity:
    // wood: 0.8, cloth: 0.9, stone: 0.05, metal: 0.0, soil: 0.6
  }

  if (!raining && sunExposed) {
    // Evaporation: rate depends on temperature, wind, humidity
    evapRate = (1 - humidity) × (T_air / 50) × (1 + windSpeed × 0.1)
    material.moisture -= evapRate × 0.001 × dt
    material.moisture = max(material.moisture, 0)
  }

  // Wet wood can't burn:
  if (material.moisture > 0.4) material.flammability = 0
  // Partially wet wood is hard to ignite:
  else if (material.moisture > 0.1)
    material.flammability *= (1 - material.moisture × 2)
}
```

#### Season System — Orbital Mechanics

#### The Calendar

The planet orbits its star with a tilted axis (23.4° — same as Earth). This tilt causes seasons.

```
SeasonSystem {
  // ── Time scale: 4× real life ──────────────────────────────────────────────
  // 1 real hour = 4 game hours
  // 6 real hours = 1 game day (24 game hours)
  // 1 real day = 4 game days
  // ~91 real days (3 real months) = 1 game year (365 game days)
  // 1 real year ≈ 4 game years
  //
  // This means:
  //   A 2-hour play session spans 8 game hours — enough to see dawn to afternoon
  //   A 6-hour session is a full game day — experience day, night, and next dawn
  //   Seasons change every ~23 real days (~3 weeks)
  //   A player experiences all 4 seasons in ~3 real months
  //
  // Exception: world CREATION (planet formation, organism generation) runs on
  // a faster timelapse at server startup. Only an admin can change the timescale.

  timeScale: 4                               // game hours per real hour
  yearLength: 365                            // game days per year
  dayLength: 21600                           // real seconds per game day (6 real hours)
  axialTilt: 23.4                            // degrees — determines season intensity

  // Current season determined by day of year:
  // Day 0-91:    Spring (northern hemisphere) / Autumn (southern)
  // Day 91-182:  Summer / Winter
  // Day 182-273: Autumn / Spring
  // Day 273-365: Winter / Summer

  // Solar declination angle (determines which hemisphere gets more sun):
  solarDeclination = axialTilt × sin(2π × dayOfYear / yearLength)
  // +23.4° at summer solstice (day ~172), -23.4° at winter solstice (day ~355)
}
```

#### Season Effects

| Season | Temperature Modifier | Daylight Hours | Weather Bias | Gameplay Impact |
|--------|---------------------|----------------|-------------|-----------------|
| Spring | +0 to +5°C gradual warming | 12→14 hours | More rain, fog lifting | Snow melts → rivers flood. Plants grow. Animals breed. Soil workable. |
| Summer | +8 to +12°C | 14→16 hours | Clear/hot dominant, afternoon storms | Peak farming. Fire risk (dry materials). Long work days. Heat stroke risk. |
| Autumn | -2 to -5°C cooling | 12→10 hours | Increasing rain, wind | Harvest season. Leaves change. Animals fatten. Days shorten. |
| Winter | -10 to -15°C | 8→10 hours | Snow, ice, fog | Hypothermia danger. Rivers freeze (walkable). Food scarce. Short days → limited activity. |

```
Season effects on systems:
  // Organism energy budgets (§2):
  autotroph.photosynthesisRate *= daylightHours / 12    // more light = more energy
  heterotroph.metabolicRate *= 1 + (30 - T_air) × 0.01  // cold = higher metabolism to stay warm

  // Farming:
  cropGrowthRate = baseRate × seasonGrowthMultiplier × soilQuality × waterAvailability
  // Spring: ×0.5 (starting), Summer: ×1.0 (peak), Autumn: ×0.3 (slowing), Winter: ×0.0 (dormant)

  // Water state:
  if (T_air < 0) {
    // Rivers freeze: surface becomes walkable solid (ice hardness ~1.5 Mohs)
    // Lakes freeze: fishing through ice holes possible
    // Ocean edges freeze: extends walkable coastline
    // Snow accumulates: 1cm per hour of snowfall, compacts over time
    // Ice thickens: ~2cm per day below 0°C (Stefan's law of ice growth)
  }

  // Day/night cycle:
  sunriseHour = 6 - (daylightHours - 12) / 2
  sunsetHour = 18 + (daylightHours - 12) / 2
  // In summer: sunrise at 5:00, sunset at 21:00 (16h daylight)
  // In winter: sunrise at 8:00, sunset at 16:00 (8h daylight)
```



## 5. Civilization

### 5.1 Settlements

#### The Principle

A settlement does not have a "civilization level." In reality, no village wakes up one morning and says "we are now Level 3." What happens is: NPCs gather materials, build structures, discover processes, accumulate tools, and trade with neighbors. An observer looking at what they've built and what they know could describe the settlement's state — but that description is **derived from behavior**, not assigned as a stat.

The settlement's sophistication is an **emergent property** of what its NPCs have actually done, not a number that ticks up.

#### Settlement State — What Is Actually Tracked

```
Settlement {
  id: number
  name: string                               // generated from seed
  position: Vec3                             // center point on planet surface
  territory: number                          // radius in meters (starts at 100, grows with population)

  // ── Population ────────────────────────────────────────────────────────────
  npcs: NPC[]                                // actual NPC entities in this settlement
  population: number                         // npcs.length — not a stat, a count of living NPCs
  // Population grows when: food surplus sustains births (1 birth per X days if food > threshold)
  // Population shrinks when: starvation, disease, predator attacks, players killing NPCs

  // ── Physical Resources (what the settlement actually has) ─────────────────
  storage: Map<MaterialPacket, number>       // stockpiled materials with real compositions
  // Not "100 units of copper" — actual MaterialPackets with specific purity and mass
  // e.g., "34kg of Cu₀.₈₅Fe₀.₁₀S₀.₀₅ (impure copper)" and "12kg of charcoal"

  // ── Built Infrastructure (what NPCs have physically constructed) ──────────
  structures: WorldObject[]                  // every building, wall, path, workstation that exists
  // A settlement with 3 huts and a campfire is different from one with stone walls and a bloomery
  // These are actual world objects — players can see and interact with them

  // ── Workstations (what machines the settlement has built) ─────────────────
  workstations: Workstation[]                // campfire, grinding stone, bloomery, kiln, forge, etc.
  // NPCs build workstations when they have the materials and knowledge
  // A settlement can only smelt copper IF it has built a bloomery
  // A settlement cannot "unlock" smelting — it must physically construct the machine

  // ── Knowledge (what processes NPCs have discovered through practice) ──────
  knownProcesses: Set<string>                // 'fire_starting', 'copper_smelting', 'pottery', etc.
  // Knowledge grows when: an NPC successfully performs a new interaction (same discovery system as players)
  // Knowledge spreads via trade (§8.7): when settlements trade, there's a chance of knowledge transfer
  // Knowledge is NEVER assigned — it is earned through NPC practice

  // ── Trade Connections ─────────────────────────────────────────────────────
  tradePartners: Set<number>                 // IDs of other settlements this one trades with
  tradeOffers: TradeOffer[]                  // current public offers based on surplus vs need
  // Trade routes emerge from geography: settlements within walkable distance can trade
  // Settlements separated by mountains, oceans, or hostile territory cannot (until roads/boats exist)

  // ── NPC Memory ────────────────────────────────────────────────────────────
  collectiveMemory: {
    playerTrust: Map<string, number>         // per-player: -1.0 (hostile) to +1.0 (trusted)
    // Trust changes from player actions: helping = +, stealing/killing = -
    // All NPCs in the settlement share memory (word spreads within a community)
    threats: Set<string>                     // predator species, hostile player IDs
  }
}
```

#### Observed Sophistication (Derived, Never Stored)

Instead of a `civLevel` integer, the settlement's development is **observable from its state**. For UI display, companion status site, or analytics, a sophistication assessment can be computed:

```
function assessSettlement(s: Settlement): SettlementAssessment {
  // Assess based on what actually exists — like an anthropologist visiting a village

  const hasFireMaking    = s.knownProcesses.has('fire_starting')
  const hasPottery       = s.knownProcesses.has('pottery')
  const hasMetalSmelting = [...s.knownProcesses].some(p => p.includes('smelting'))
  const hasForge         = s.workstations.some(w => w.type === 'forge')
  const hasBlastFurnace  = s.workstations.some(w => w.type === 'blast_furnace')
  const stoneBuildings   = s.structures.filter(st => st.material.hardness > 4).length
  const hasWalls         = s.structures.some(st => st.subtype === 'wall' && st.material.hardness > 3)
  const tradeRoutes      = s.tradePartners.size
  const populationSize   = s.population

  // Descriptive labels (for display only — NPCs don't know or care about these):
  if (populationSize < 5)
    return { label: 'Camp', description: 'A handful of people around a fire' }
  if (!hasMetalSmelting && populationSize < 20)
    return { label: 'Hamlet', description: 'Small group with basic tools and shelter' }
  if (hasMetalSmelting && !hasForge && populationSize < 50)
    return { label: 'Village', description: 'Settled community with early metalwork' }
  if (hasForge && stoneBuildings > 5 && populationSize < 150)
    return { label: 'Town', description: 'Established settlement with smithing and stone construction' }
  if (hasBlastFurnace && hasWalls && tradeRoutes > 2 && populationSize >= 150)
    return { label: 'City', description: 'Fortified center with advanced industry and trade networks' }

  // ... and so on. These are OBSERVATIONS, not levels.
  // A "city" that loses its population to famine becomes a "town" or "hamlet" —
  // not because a counter decremented, but because the conditions no longer match.
}
```

This means:
- A settlement doesn't "level up" — it **builds things** and **learns things**
- A settlement can regress — if a plague kills half the population, or a player destroys the bloomery, the settlement's observable sophistication drops because the physical reality changed
- Two settlements with the same "assessment" might look completely different — one might be a farming village with great pottery, the other a mining camp with crude shelters but excellent metalwork
- The label is for the player's benefit (and the companion site display), not for game logic

#### Geology-Based Specialty

Specialty is not assigned — it emerges from what resources are nearby.

```
SettlementSpecialty {
  // When a settlement is founded (from world generation), NPCs begin gathering
  // whatever materials are within their territory.
  // A settlement near a copper vein gathers copper ore.
  // A settlement near a river gathers clay and fish.
  // A settlement on fertile plains gathers grain.

  // Over time, the settlement accumulates MORE of what's nearby.
  // NPCs practice processing those materials → they get better at it.
  // The settlement naturally specializes because it has the most practice
  // with its local resources.

  // There is no specialty: 'copper_mining' field in the database.
  // The specialty is observable: "this settlement has 200kg of copper ore in storage,
  // a bloomery, and NPCs who have performed 500 successful smelting operations."
  // An observer would call this a copper mining settlement.

  // If the copper vein is depleted, the settlement doesn't magically keep its specialty.
  // NPCs start gathering whatever else is available. The settlement adapts or declines.
}
```

#### Trade Economy

Supply and demand adjust prices based on settlement stockpile levels. This follows David Ricardo's principle of comparative advantage (1817): settlements trade not because one is "better" than another, but because specialization + exchange produces more total value than self-sufficiency. A settlement near copper that trades ore for grain produces more copper and more food than if both settlements tried to do everything themselves. This emerges naturally from the geology — no designer assigns what gets traded. Surplus drives trade offers.

```
TradeOffer {
  // Generated automatically when a settlement has surplus of one material and deficit of another
  gives: MaterialPacket                      // what they're offering (actual material with composition)
  givesAmount: number                        // kg
  wants: string                              // category of what they need: 'food', 'fuel', 'ore', 'tools'
  wantsMinAmount: number                     // minimum kg they'll accept

  // Price is not fixed — it's determined by scarcity:
  // High stockpile of copper + low stockpile of food → copper is cheap, food is expensive
  // The exchange rate shifts dynamically as stockpiles change
  // No currency exists. All trade is barter — material for material.
}
```

Diamond's *Guns, Germs, and Steel* adds a further insight: the east-west axis of a continent matters because settlements at similar latitudes share climate and can exchange crops and livestock. On a spherical planet with a tilted axis, equatorial settlements share growing seasons. This will eventually influence which settlements grow into trading networks and which remain isolated.


### 5.2 NPC Brain — Three-Tier Hybrid AI

#### The Principle

NPCs are not scripts. They are simulated humans with curiosity, needs, emotions, memory, and the ability to learn. An NPC doesn't follow a behavior tree — it *thinks* about what to do based on its internal state and surroundings. This requires a hybrid AI architecture: cheap fast decisions for routine moments, and deeper reasoning for novel situations.

#### Three-Tier Decision Architecture

**Tier 1 — Survival Reflex (every tick, no AI):** Am I on fire? Drowning? Being attacked? Pure reactive math, no thinking required. Like human reflexes.

**Tier 2 — Custom Small Language Model (every 10-30 game-seconds):** A purpose-trained small model (~1-4B parameters) that reasons about NPC decisions. Input: needs, emotions, personality, environment, memories. Output: next action with reasoning. Runs on the server at ~10ms per decision. Handles ~90% of all NPC behavior.

**Tier 3 — Full LLM (rare, important moments):** For genuinely novel situations the custom model wasn't trained on. Settlement-level strategic decisions, complex social conflicts, first encounters with unprecedented events. ~1-5 calls per settlement per hour.

#### Personality — Every NPC Is Different

Based on the Big Five personality model (Costa & McCrae 1992). Each NPC has permanent traits generated at birth:

- **Openness** (0-1): curiosity, willingness to explore and experiment. High = wanders far, tries new things. Low = sticks to routine.
- **Conscientiousness** (0-1): work ethic, organization. High = finishes tasks, maintains structures. Low = unreliable but sometimes creative.
- **Extraversion** (0-1): sociability. High = seeks company, talks to players, teaches. Low = works alone, productive in isolation.
- **Agreeableness** (0-1): cooperativeness. High = shares, helps, avoids conflict. Low = competitive, hoards resources, better at defending.
- **Neuroticism** (0-1): emotional reactivity. High = panics easily, avoids risk. Low = calm under pressure, handles crises.

Same scenario + different personality = different NPC decision.

#### Curiosity — How NPCs Discover

Curiosity is the engine of NPC progress. Boredom from repetition increases curiosity. Seeing something novel increases curiosity. When curiosity is high, the NPC explores, experiments, tries new material combinations at workstations. Discoveries happen through the same physics-based crafting system as players — the NPC puts materials in a furnace and the reaction engine computes the result. If it's new, the NPC remembers it and can teach others.

#### Memory — What NPCs Remember

Each NPC stores ~200 episodic memories ranked by emotional significance. Traumatic and joyful memories persist longest. Neutral memories fade first. During sleep, similar memories consolidate into general knowledge ("fishing usually works 2/3 of the time"). Social memory tracks trust and relationships with specific entities (players, other NPCs, predators).

#### Daily Life

NPCs live on a daily cycle driven by needs, not scripts. They wake at dawn, eat, work during peak energy hours, socialize at midday, continue working in the afternoon, gather around fire at dusk, and sleep at night. Every aspect varies by personality — a high-openness NPC explores instead of working, a high-neuroticism NPC goes to bed early.

#### Social Behavior

NPCs form relationships (+0.05 per shared task, +0.15 for sharing food, -0.3 for theft). High relationships lead to pair bonds, shared shelters, and eventually children. Leadership emerges from reputation — NPCs whose decisions led to good outcomes are consulted more often. Conflicts between low-agreeableness NPCs can escalate to physical confrontation (same combat physics as players).

#### Settlement Expansion

NPCs build structures through the same system as players. The AI decides what's needed ("We have 25 NPCs but only 6 shelters — I should build one"). When a settlement becomes overcrowded, adventurous NPCs leave to found new settlements elsewhere. Dead settlements leave ruins that can be re-settled.

#### Self-Improving System

Every time the full LLM (Tier 3) handles a novel situation, the response becomes a training pair for the custom model. Periodic retraining means the NPC AI gets smarter over time. Month 1: ~80% handled by custom model. Year 1: ~97%. The game's NPCs literally become more intelligent the longer the game runs.


### 5.3 NPC Language & Knowledge Transfer

#### The Language System

NPCs do not speak English, Mandarin, or any existing human language. Each settlement develops its own **constructed language** — a system of vocalizations, gestures, and symbols that evolved within that settlement's history.

#### Language Generation (Per Settlement)

Each settlement's language is **deterministically generated from the world seed + settlement ID**, ensuring all players hear the same language from the same NPCs.

```
SettlementLanguage {
  settlementId: number
  seed: number                               // worldSeed × settlementId — deterministic

  // ── Phoneme Inventory ─────────────────────────────────────────────────────
  // Each settlement selects a subset of human-possible phonemes
  // Real human languages use 11-141 phonemes (Hawaiian: 13, !Xóõ: 141)
  // Game settlements use 15-40 phonemes per language

  consonants: Phoneme[]                      // selected from universal phoneme set
  vowels: Phoneme[]                          // 3-7 vowels (5 is most common cross-linguistically)
  tones: number                              // 0 (no tonal), 2, 3, or 4 tone levels

  // The phoneme selection is biased by settlement environment:
  // Coastal settlements: more fricatives (s, sh, f) — mimics wave/wind sounds
  // Mountain settlements: more stops (k, t, p) — sharp, carries over distance
  // Forest settlements: more nasals (m, n, ng) — resonates between trees
  // This is speculative but creates flavor differences players will notice.

  // ── Syllable Structure ────────────────────────────────────────────────────
  // Determines what combinations of phonemes are allowed
  syllableTemplate: string                   // e.g., '(C)V(C)' — optional consonant, vowel, optional consonant
  maxSyllablesPerWord: number                // 1-4 (shorter words for more "advanced" settlements)

  // ── Vocabulary ────────────────────────────────────────────────────────────
  // Words are generated for ~200 core concepts:
  // - Objects: fire, water, stone, copper, food, shelter, tool
  // - Actions: give, take, make, break, go, come, look, eat, hit
  // - Qualities: hot, cold, big, small, good, bad, fast, slow
  // - Numbers: 1-10 (base system: 5 or 10 depending on settlement)
  // - Social: yes, no, friend, stranger, danger, help

  vocabulary: Map<ConceptId, Word>           // concept → word mapping

  // Word generation: chain syllables using Markov chain seeded by settlementSeed
  // This ensures words sound internally consistent (a settlement's words share phonetic patterns)
  // Different settlements produce noticeably different-sounding languages

  // ── Grammar ───────────────────────────────────────────────────────────────
  wordOrder: 'SOV' | 'SVO' | 'VSO'          // subject-object-verb order (SOV is most common worldwide)
  // Grammar is minimal — NPCs communicate mostly through context + action + gesture
  // Full grammar is not needed because players don't understand the words anyway.
  // The language exists for ATMOSPHERE, not for information transfer.
}
```

#### What Players Actually Hear

When an NPC speaks, the player hears procedurally generated speech:

```
NPCSpeech {
  // 1. NPC's intent (server-side): the NPC wants to communicate something
  intent: 'greeting' | 'warning' | 'offer_trade' | 'request_help' | 'show_process' | 'farewell'

  // 2. Word selection: intent maps to concept sequence
  //    'greeting' → [social:friend, action:come, quality:good]
  //    'warning' → [social:danger, action:go, quality:bad]
  //    'offer_trade' → [object:copper, action:give, object:food, action:take]

  // 3. Vocalization: words are synthesized or selected from phoneme-based audio
  //    Option A (cheaper): pre-record ~40 syllable sounds, concatenate per the settlement's phoneme rules
  //    Option B (richer): use Web Speech API with custom phoneme mapping, pitch-shifted per NPC voice
  //    The result sounds like speech in an unfamiliar language — recognizable as language, not understandable

  // 4. Gesture overlay: the NPC simultaneously performs a gesture
  //    'greeting': raises open hand
  //    'warning': points away + shakes head
  //    'offer_trade': extends one hand with item, other hand open (receiving)
  //    'show_process': turns toward workstation and begins working
  //    Gestures are the REAL communication channel. The spoken words are atmosphere.
}
```

#### Knowledge Transfer Through Demonstration

This is the core system. NPCs do not tell players what to do. They **do things**, and the player watches.

```
DemonstrationSystem {
  // Each NPC in a settlement runs their goal loop (§8.1):
  // idle → gather → carry → process → deliver → idle

  // During the 'process' step, the NPC performs a visible crafting action:

  ProcessDemonstration {
    npcId: string
    workstationId: string
    inputMaterials: MaterialPacket[]         // what the NPC puts into the workstation
    action: string                           // 'smelt' | 'grind' | 'shape' | 'fire' | 'weave'
    outputMaterial: MaterialPacket           // what comes out
    duration: number                         // seconds the process takes (visible to the watching player)

    // ── What the player sees ──────────────────────────────────────────────
    // 1. NPC walks to a pile of raw material (e.g., copper ore)
    // 2. NPC picks up ore (visible in NPC's hands)
    // 3. NPC walks to the bloomery
    // 4. NPC places ore into the bloomery opening (hand animation → item disappears into furnace)
    // 5. NPC adds charcoal (same sequence — NPC fetches charcoal, places it)
    // 6. NPC operates bellows (arm pumping animation, fire brightens, temperature rises)
    // 7. Time passes (NPC stands watching, occasionally pumping bellows)
    // 8. NPC reaches into bloomery and pulls out a copper blob (new item appears in hand)
    // 9. NPC carries copper to storage area

    // EVERY STEP IS VISIBLE AND PHYSICAL.
    // The player sees the inputs, the machine, the process, and the output.
    // They can infer what happened: "that rock went into the furnace with black stuff,
    // and something shiny came out."
  }

  // ── What the player does NOT get ────────────────────────────────────────
  // - No tooltip: "The NPC is smelting copper ore using a bloomery with charcoal as fuel"
  // - No recipe unlock: "You learned: Copper Smelting!"
  // - No dialogue option: "[Ask about smelting]"
  // - No journal entry: "I watched an NPC smelt copper. I should try this."

  // The player must:
  // 1. Notice what the NPC is doing (attention)
  // 2. Figure out what materials they used (observation)
  // 3. Find those materials themselves (exploration)
  // 4. Try the same process at a workstation (experimentation)
  // 5. Fail a few times and adjust (learning)
  // 6. Succeed (discovery — recorded in their discoveries set)

  // This mirrors exactly how ancient humans learned technology from each other:
  // A traveler visits a foreign village, watches their metalworkers,
  // goes home, and tries to replicate what they saw.

  // ── Companion System (Future) ───────────────────────────────────────────
  // A companion NPC that follows the player can provide HINTS, not answers:
  // - If the player fails to start a fire: companion gestures toward dry wood (not wet wood)
  // - If the player uses wrong ore in a bloomery: companion shakes head, picks up correct ore, shows it
  // - The companion learned from their OWN settlement — they only know what their settlement knows
  // - A companion from a copper settlement can't help with iron smelting
  // - This creates value in traveling to different settlements: new companions = new knowledge
}
```

#### Cultural Divergence

Different settlements know different things, creating a reason to explore:

```
SettlementKnowledge {
  // Each settlement has a knowledge set — the processes it has "discovered"
  // This is determined by settlement specialty + age + trade connections

  // A young copper mining settlement knows:
  knownProcesses: [
    'fire_starting',          // everyone knows this
    'clay_pottery',           // basic ceramics
    'copper_smelting',        // their specialty
    'copper_tool_making',     // hammering copper into tools
  ]

  // An old coastal fishing settlement knows:
  knownProcesses: [
    'fire_starting',
    'salt_extraction',        // evaporating seawater
    'fish_preservation',      // salt + fish = preserved food
    'rope_making',            // plant fiber twisting
    'net_weaving',            // rope into nets
    'boat_building',          // wood + rope + tar
  ]

  // A settlement that trades with both might know elements of each.
  // Knowledge spreads between settlements via trade routes (server simulation):
  // When two settlements trade, there's a small chance per tick that
  // the receiving settlement "learns" one of the sender's processes.
  // knowledgeSpreadRate = tradeVolume × 0.001 per server tick

  // This means the game world's total knowledge grows over time,
  // even without player intervention. Players arriving in a mature world
  // find settlements that know more processes. Players in a fresh world
  // find primitive settlements and must discover more on their own.
}
```

#### Why This Works

The knowledge transfer system works because of the synergy between three other systems:

1. **Physics-based crafting (§3)** — there are no recipes to "teach." The knowledge IS the physical process. Seeing it done IS learning it.
2. **Emergent materials (§3.3)** — the output isn't a named item. It's whatever physics produces. The NPC doesn't make "copper" — they make "the orange metal that comes from heating green rock." The player figures out the name (or doesn't — names don't matter, properties do).
3. **Workstation system (§8.1)** — the machine is a physical place. The NPC goes there. The player goes there. They're in the same space doing the same thing. No abstract menu bridges them.

The language barrier is intentional. It forces players to rely on **observation** rather than **instruction**. This is harder, slower, and more frustrating than a tutorial — and that's the point. The satisfaction of figuring out copper smelting by watching an NPC is incomparably greater than reading "combine copper ore + charcoal in bloomery."


## 6. Crafting & Production

### 6.1 Material Taxonomy

The material system operates in three tiers. **Elements** are the base layer — single-substance building blocks from the periodic table. **Minerals** are natural multi-element compounds found in the ground. **Processed materials** are what humans make by combining and transforming the first two tiers. The game's crafting arc is the process of moving up through these tiers.

> **Note on coal and salt:** Coal is not an element. It is compressed ancient organic matter — primarily carbon (C) with hydrogen, sulfur, and nitrogen impurities. Salt is not an element either. It is sodium chloride (NaCl) — two elements bonded into a compound. The game treats coal and salt as minerals (Tier 2), not elements. Their underlying elements (carbon, sodium, chlorine) are Tier 1.

---

#### Tier 1 — Elements (all 118, from the periodic table)

The universe contains all 118 elements. The simulation should model all of them — even elements the player never directly uses exist in trace amounts in rock, air, water, and living matter. The interaction engine doesn't need special cases for each one: real physical properties (reactivity, conductivity, melting point, density) produce the right chemistry automatically.

**Three categories:**

- **Naturally occurring** (Z 1–94) — found in the world's geology, atmosphere, or oceans
- **Trace natural** — occur in nature but only in vanishingly small amounts (francium: ~30 atoms exist on Earth at any moment)
- **Synthetic** (Z 95–118) — do not occur naturally, can only be made in a particle accelerator. In the game, these are only reachable with late-game technology.

---

##### Period 1 — The Simplest


| Z   | Element  | Symbol | Natural form                                    | Game relevance                                                                |
| --- | -------- | ------ | ----------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | Hydrogen | H      | Water (H₂O), organic matter, atmosphere (trace) | Fuel (combustion, fuel cells), reduction chemistry, Haber process for ammonia |
| 2   | Helium   | He     | Trapped in granite (radioactive decay product)  | Lighter-than-air lift, inert shielding gas — rare and non-reactive            |


---

##### Period 2 — Organic Chemistry Foundation


| Z   | Element   | Symbol | Natural form                                          | Game relevance                                                                         |
| --- | --------- | ------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 3   | Lithium   | Li     | Spodumene, brine lake deposits                        | Batteries, psychiatric medicine, nuclear moderator                                     |
| 4   | Beryllium | Be     | Beryl mineral (Be₃Al₂Si₆O₁₈), emeralds                | X-ray windows, aerospace alloys — toxic, rare                                          |
| 5   | Boron     | B      | Borax (Na₂B₄O₇), boric acid in volcanic springs       | Glass hardening, antiseptics, nuclear control rods                                     |
| 6   | Carbon    | C      | Coal, charcoal, diamond, graphite, all organic matter | **The backbone of life and all organic chemistry.** Fuel, steel, plastics, electronics |
| 7   | Nitrogen  | N      | Atmosphere (78%), saltpeter (KNO₃), proteins          | Fertilizer (Haber process), explosives (TNT, gunpowder), refrigerant                   |
| 8   | Oxygen    | O      | Atmosphere (21%), water, most minerals                | Combustion, respiration, oxidation of metals                                           |
| 9   | Fluorine  | F      | Fluorite (CaF₂), tooth enamel                         | Teflon, refrigerants, uranium enrichment (UF₆) — extremely reactive                    |
| 10  | Neon      | Ne     | Atmosphere (trace 0.0018%)                            | Lighting (neon signs), inert — no reactivity                                           |


---

##### Period 3 — First Metals


| Z   | Element    | Symbol | Natural form                             | Game relevance                                                                                        |
| --- | ---------- | ------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 11  | Sodium     | Na     | Halite (NaCl), seawater                  | Salt (food preservation), soap (NaOH), glass, chemistry                                               |
| 12  | Magnesium  | Mg     | Dolomite, olivine, seawater              | Lightweight alloys, flares (burns bright white), flash powder                                         |
| 13  | Aluminum   | Al     | Bauxite — tropical weathered granite     | Most abundant metal in crust — requires electrolysis (Hall-Héroult). Lightweight, corrosion-resistant |
| 14  | Silicon    | Si     | Quartz (SiO₂), sand, flint — everywhere  | Glass, concrete, semiconductors — the backbone of the digital age                                     |
| 15  | Phosphorus | P      | Apatite minerals, bone ash, guano        | Fertilizer, matches (red P), explosives, DNA backbone                                                 |
| 16  | Sulfur     | S      | Native volcanic deposits, pyrite, gypsum | Gunpowder, sulfuric acid (H₂SO₄), rubber vulcanization, medicine                                      |
| 17  | Chlorine   | Cl     | Halite (NaCl), seawater                  | Disinfectant, PVC plastic, bleach, chemical weapons (WWI)                                             |
| 18  | Argon      | Ar     | Atmosphere (0.93%)                       | Inert welding shield gas — no reactivity                                                              |


---

##### Period 4 — The Transition Metals Begin


| Z   | Element   | Symbol | Natural form                              | Game relevance                                                                 |
| --- | --------- | ------ | ----------------------------------------- | ------------------------------------------------------------------------------ |
| 19  | Potassium | K      | Potash (K₂CO₃), saltpeter (KNO₃), sylvite | Fertilizer, gunpowder (KNO₃), soap                                             |
| 20  | Calcium   | Ca     | Limestone (CaCO₃), gypsum, bone           | Lime → mortar → concrete → cement. Bone formation.                             |
| 21  | Scandium  | Sc     | Trace in many minerals                    | Aerospace alloys — rare, minor use                                             |
| 22  | Titanium  | Ti     | Rutile (TiO₂), ilmenite                   | Strong, lightweight, corrosion-proof — aerospace, armor, pigments              |
| 23  | Vanadium  | V      | Vanadinite, trace in iron ore             | Steel alloying (vanadium steel is springy), catalysts                          |
| 24  | Chromium  | Cr     | Chromite (FeCr₂O₄)                        | Stainless steel (Fe+Cr+Ni), chrome plating, pigments                           |
| 25  | Manganese | Mn     | Pyrolusite (MnO₂), ferromanganese         | Steel hardening, batteries (dry cell), pigments                                |
| 26  | Iron      | Fe     | Hematite (Fe₂O₃), magnetite (Fe₃O₄)       | **Most important structural metal.** Wrought iron → cast iron → steel          |
| 27  | Cobalt    | Co     | Cobaltite, trace with nickel ore          | Blue pigment (cobalt glass), batteries (Li-ion), magnets                       |
| 28  | Nickel    | Ni     | Pentlandite, laterite                     | Stainless steel, coins, batteries, armor plating                               |
| 29  | Copper    | Cu     | Malachite, chalcopyrite — volcanic zones  | **First metal smelted by humans.** Wire, alloys (bronze, brass), coins         |
| 30  | Zinc      | Zn     | Sphalerite (ZnS) — hydrothermal           | Galvanizing iron, brass (Cu+Zn), batteries, medicine                           |
| 31  | Gallium   | Ga     | Trace in bauxite, zinc ore                | Semiconductors (GaAs), LEDs, mirrors — low melting point (30°C, melts in hand) |
| 32  | Germanium | Ge     | Trace in zinc/coal deposits               | Early transistors, fiber optics, infrared optics                               |
| 33  | Arsenic   | As     | Arsenopyrite — gold deposits              | Poison, wood preservative, some semiconductors                                 |
| 34  | Selenium  | Se     | Trace with sulfur, copper ores            | Solar cells, glass coloring, electronics                                       |
| 35  | Bromine   | Br     | Seawater, brine deposits                  | Flame retardants, photography (silver bromide), medicine                       |
| 36  | Krypton   | Kr     | Atmosphere (trace 0.0001%)                | High-power lighting, laser isotopes — inert                                    |


---

##### Period 5 — Second Row Transition Metals


| Z   | Element    | Symbol | Natural form                              | Game relevance                                                                |
| --- | ---------- | ------ | ----------------------------------------- | ----------------------------------------------------------------------------- |
| 37  | Rubidium   | Rb     | Trace in lepidolite, potassium minerals   | Atomic clocks, research — rare                                                |
| 38  | Strontium  | Sr     | Celestite (SrSO₄), strontianite           | Red fireworks/flares, nuclear waste (Sr-90)                                   |
| 39  | Yttrium    | Y      | Xenotime, monazite — rare earth deposits  | LEDs, laser crystals, high-temperature alloys                                 |
| 40  | Zirconium  | Zr     | Zircon (ZrSiO₄)                           | Nuclear reactor cladding (low neutron absorption), gemstones (cubic zirconia) |
| 41  | Niobium    | Nb     | Columbite-tantalite                       | Superconductors, high-strength steel alloys                                   |
| 42  | Molybdenum | Mo     | Molybdenite (MoS₂)                        | High-strength steel (gun barrels, pressure vessels)                           |
| 43  | Technetium | Tc     | **Trace natural** — uranium decay product | Medical imaging (Tc-99m) — first synthetic element                            |
| 44  | Ruthenium  | Ru     | Trace in platinum ores                    | Catalysts, electronics, hardening platinum                                    |
| 45  | Rhodium    | Rh     | Trace in platinum ores                    | Catalytic converters, jewelry — extremely rare                                |
| 46  | Palladium  | Pd     | Trace in nickel/copper ores               | Catalytic converters, hydrogen storage, jewelry                               |
| 47  | Silver     | Ag     | Native nuggets, argentite — hydrothermal  | Coins, mirrors, photography, antibacterial                                    |
| 48  | Cadmium    | Cd     | Trace with zinc ore                       | Batteries (Ni-Cd), pigments — toxic                                           |
| 49  | Indium     | In     | Trace with zinc ore                       | ITO (touchscreens, solar cells), solders                                      |
| 50  | Tin        | Sn     | Cassiterite (SnO₂) — granitic veins       | **Bronze = Cu+Sn.** Cans, soldering, pewter                                   |
| 51  | Antimony   | Sb     | Stibnite (Sb₂S₃)                          | Lead-acid battery plates, flame retardants, ancient eyeliner                  |
| 52  | Tellurium  | Te     | Trace with copper/gold ores               | Solar cells (CdTe), thermoelectrics                                           |
| 53  | Iodine     | I      | Seawater, brine, kelp                     | Antiseptic, thyroid function, photography                                     |
| 54  | Xenon      | Xe     | Atmosphere (trace 0.0000087%)             | Ion propulsion (xenon thrusters), anesthesia, lighting                        |


---

##### Period 6 — Heavy Metals and Rare Earths


| Z   | Element      | Symbol | Natural form                                        | Game relevance                                                                                   |
| --- | ------------ | ------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 55  | Cesium       | Cs     | Pollucite mineral — rare                            | Atomic clocks (most accurate timekeeping)                                                        |
| 56  | Barium       | Ba     | Barite (BaSO₄), witherite                           | Drilling mud, X-ray contrast, fireworks (green)                                                  |
| 57  | Lanthanum    | La     | Monazite, bastnäsite — rare earth                   | Camera lenses, hybrid batteries, catalysts                                                       |
| 58  | Cerium       | Ce     | Monazite, bastnäsite — most abundant rare earth     | Lighter flints, catalytic converters, glass polishing                                            |
| 59  | Praseodymium | Pr     | Rare earth deposits                                 | Magnets (Nd-Fe-B alloy), green glass coloring                                                    |
| 60  | Neodymium    | Nd     | Rare earth deposits                                 | **Strongest permanent magnets (Nd₂Fe₁₄B)** — electric motors, speakers, MRI                      |
| 61  | Promethium   | Pm     | **Trace natural** — uranium fission product         | Nuclear batteries — no stable isotope                                                            |
| 62  | Samarium     | Sm     | Rare earth deposits                                 | Magnets (SmCo), cancer treatment                                                                 |
| 63  | Europium     | Eu     | Rare earth deposits                                 | Red/blue phosphors in TV screens                                                                 |
| 64  | Gadolinium   | Gd     | Rare earth deposits                                 | MRI contrast agent, neutron absorption                                                           |
| 65  | Terbium      | Tb     | Rare earth deposits                                 | Green phosphors, magnets                                                                         |
| 66  | Dysprosium   | Dy     | Rare earth deposits                                 | High-temperature magnets (EV motors)                                                             |
| 67  | Holmium      | Ho     | Rare earth deposits                                 | Magnets, nuclear control rods                                                                    |
| 68  | Erbium       | Er     | Rare earth deposits                                 | Fiber optic amplifiers, laser surgery                                                            |
| 69  | Thulium      | Tm     | Rare earth — very rare                              | Portable X-ray sources                                                                           |
| 70  | Ytterbium    | Yb     | Rare earth deposits                                 | Atomic clocks, fiber lasers                                                                      |
| 71  | Lutetium     | Lu     | Rare earth — rarest stable                          | PET scanners, catalysts                                                                          |
| 72  | Hafnium      | Hf     | Zircon minerals (always with Zr)                    | Nuclear reactor control rods, semiconductor gates                                                |
| 73  | Tantalum     | Ta     | Columbite-tantalite                                 | Capacitors in phones/laptops, surgical implants                                                  |
| 74  | Tungsten     | W      | Wolframite, scheelite                               | Highest melting point of all metals (3422°C). Lightbulb filaments, cutting tools, armor-piercing |
| 75  | Rhenium      | Re     | Trace with molybdenum                               | Jet engine alloys, catalysts — very rare                                                         |
| 76  | Osmium       | Os     | Trace in platinum ores                              | Hardest natural metal — pen tips, compass needles                                                |
| 77  | Iridium      | Ir     | Trace in platinum ores, meteorites                  | Crucibles, spark plugs — extremely corrosion-resistant. K-Pg boundary marker                     |
| 78  | Platinum     | Pt     | Native nuggets, sperrylite — rare                   | Catalytic converters, jewelry, lab equipment                                                     |
| 79  | Gold         | Au     | Native nuggets — hydrothermal veins                 | Coins, jewelry, electronics (non-corroding contacts)                                             |
| 80  | Mercury      | Hg     | Cinnabar (HgS) — volcanic                           | Thermometers, barometers, amalgam fillings, gold extraction — liquid metal at room temperature   |
| 81  | Thallium     | Tl     | Trace in zinc/lead smelting                         | Infrared optics, rat poison — very toxic                                                         |
| 82  | Lead         | Pb     | Galena (PbS) — sedimentary veins                    | Pipes, bullets, batteries, radiation shielding — soft, dense                                     |
| 83  | Bismuth      | Bi     | Native, bismuthinite                                | Low melting alloys (sprinklers), cosmetics, medicine — least toxic heavy metal                   |
| 84  | Polonium     | Po     | **Trace natural** — uranium decay (1 part per 10¹⁰) | Nuclear initiators — intensely radioactive                                                       |
| 85  | Astatine     | At     | **Trace natural** — most rare natural element       | Cancer treatment (At-211) — only ~28g exists on Earth                                            |
| 86  | Radon        | Rn     | **Trace natural** — uranium decay gas               | Radioactive gas seeping from granite — health hazard                                             |


---

##### Period 7 — Actinides and Synthetic Elements


| Z      | Element       | Symbol | Natural / Synthetic                                       | Game relevance                                                                                                                                    |
| ------ | ------------- | ------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 87     | Francium      | Fr     | **Trace natural** — 30 atoms exist on Earth at any moment | None — decays in 22 minutes                                                                                                                       |
| 88     | Radium        | Ra     | **Trace natural** — uranium decay                         | Luminous paint (historical), cancer treatment — highly radioactive                                                                                |
| 89     | Actinium      | Ac     | **Trace natural** — uranium decay                         | Cancer treatment, neutron source                                                                                                                  |
| 90     | Thorium       | Th     | Monazite mineral — fairly common                          | Alternative nuclear fuel to uranium — more abundant, safer reactor                                                                                |
| 91     | Protactinium  | Pa     | **Trace natural** — uranium decay                         | No commercial use                                                                                                                                 |
| 92     | Uranium       | U      | Uraninite (pitchblende) — granite                         | **Nuclear fission fuel.** U-235 fissions; U-238 breeds plutonium in reactors                                                                      |
| 93     | Neptunium     | Np     | **Trace natural** — uranium decay                         | Produces plutonium in reactors                                                                                                                    |
| 94     | Plutonium     | Pu     | **Trace natural** — 1 part per 10¹¹ in uranium ore        | Nuclear weapons, space RTG power sources                                                                                                          |
| 95–118 | Am through Og | —      | **Synthetic only** — particle accelerator                 | Only reachable in the game with extreme late-game technology. Americium (Am-241) is in smoke detectors. Californium (Cf-252) is a neutron source. |


---

##### Why All 118 Belong in the Simulation

A universe that only contains elements useful for a game is not a universe — it is a prop. Real rock contains trace amounts of every naturally occurring element. Real air contains argon. Real seawater contains lithium, iodine, bromine, and trace gold. Real soil contains phosphorus, potassium, sulfur, iron, manganese, and dozens more.

The interaction engine does not need individual cases for all 118. It needs accurate properties — and the properties themselves produce the right behavior:

- **Noble gases** (He, Ne, Ar, Kr, Xe, Rn): `reactivity = 0`. They do nothing. They exist.
- **Alkali metals** (Li, Na, K, Rb, Cs, Fr): extremely high reactivity, low melting points. Sodium explodes in water. This emerges from the property, not a hardcoded case.
- **Halogens** (F, Cl, Br, I, At): high reactivity, bond easily with metals. Fluorine is the most reactive element — it corrodes glass.
- **Transition metals**: variable reactivity, high melting points, magnetic properties (Fe, Ni, Co), conductivity (Cu, Ag, Au).
- **Rare earths** (La–Lu): similar chemistry, critical for magnets, phosphors, and modern electronics. Players in the late game will need to find and separate them.
- **Actinides** (Th, U, Pu): radioactive, heavy, fissile or fertile. The nuclear age requires them.

The full periodic table is the game's chemistry engine. Every element has a role — even if that role is "this exists in trace amounts and does nothing the player notices."

---

#### Tier 2 — Minerals (natural compounds, found in the ground)

Minerals are what the world is actually made of. Players find minerals, not elements. Extracting the element from the mineral is the crafting challenge. Organized by mineral class — each class shares chemical structure and geological origin.

---

##### Silicates — largest mineral group, ~90% of Earth's crust

Silicon and oxygen bonded into frameworks. The rock that makes up most of the planet's surface and mantle is silicate. Everything from sand to emeralds to asbestos is a silicate.


| Mineral                | Formula                          | Geological source                      | Game relevance                                                              |
| ---------------------- | -------------------------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| Quartz                 | SiO₂ (crystalline)               | Granite, pegmatite veins, everywhere   | Glass production, abrasive, optical lenses                                  |
| Flint / Chert          | SiO₂ (microcrystalline)          | Sedimentary chalk beds, coastal cliffs | **First tool material.** Knapping, fire-striking                            |
| Obsidian               | SiO₂ (volcanic glass, amorphous) | Lava flows near volcanic zones         | Sharpest possible cutting edge — sharper than steel                         |
| Sand                   | SiO₂ + feldspar + impurities     | River beds, deserts, beaches           | Glass, mortar, concrete, abrasive                                           |
| Feldspar (orthoclase)  | KAlSi₃O₈                         | Granite, most igneous rock             | Ceramics, porcelain, glazing                                                |
| Feldspar (plagioclase) | NaAlSi₃O₈ / CaAl₂Si₂O₈           | Basalt, gabbro — oceanic crust         | Ceramics                                                                    |
| Mica (muscovite)       | KAl₂(AlSi₃O₁₀)(OH)₂              | Granite, schist, metamorphic           | Heat insulation (window in early ovens), electrical insulator               |
| Mica (biotite)         | K(Mg,Fe)₃(AlSi₃O₁₀)(OH)₂         | Granite, metamorphic                   | Same as muscovite                                                           |
| Clay (kaolinite)       | Al₂Si₂O₅(OH)₄                    | Weathered feldspar, river banks        | Pottery, bricks, porcelain, cement, paper coating                           |
| Clay (smectite)        | (Na,Ca)(Al,Mg)₆(Si₄O₁₀)₃(OH)₆    | River sediment, hydrothermal           | Drilling mud, cat litter — highly absorptive                                |
| Olivine                | (Mg,Fe)₂SiO₄                     | Mantle rock, basalt                    | Refractory material, gemstone (peridot)                                     |
| Pyroxene               | MgSiO₃ / CaMgSi₂O₆               | Basalt, volcanic rock                  | Rock-forming — little direct use                                            |
| Amphibole              | Ca₂Mg₅Si₈O₂₂(OH)₂                | Metamorphic, igneous                   | Asbestos (tremolite/actinolite forms) — fire resistant, toxic fibers        |
| Talc                   | Mg₃Si₄O₁₀(OH)₂                   | Metamorphic — lowest Mohs hardness (1) | Lubricant, powder, filler — softest mineral                                 |
| Serpentine             | Mg₃Si₂O₅(OH)₄                    | Altered olivine, seafloor              | Asbestos (chrysotile form), carved stone                                    |
| Zircon                 | ZrSiO₄                           | Granite, river placer deposits         | Gemstone, zirconium ore, geochronology (oldest minerals on Earth)           |
| Beryl                  | Be₃Al₂Si₆O₁₈                     | Granite pegmatites                     | Gemstones (emerald = Cr-bearing, aquamarine = Fe-bearing). Beryllium source |
| Garnet                 | Fe₃Al₂(SiO₄)₃                    | Metamorphic rock                       | Abrasive (sandpaper), gemstone                                              |
| Tourmaline             | Complex borosilicate             | Granite pegmatites                     | Gemstone, piezoelectric properties                                          |
| Zeolite                | Aluminosilicate framework        | Volcanic ash altered by water          | Water softening, molecular sieves, catalysts                                |
| Topaz                  | Al₂SiO₄(F,OH)₂                   | Granite pegmatites                     | Mohs hardness 8 — abrasive, gemstone                                        |
| Asbestos (various)     | Fibrous silicates                | Metamorphic ultramafic rock            | Fireproof insulation — health hazard when fibers inhaled                    |


---

##### Oxides — elements bonded with oxygen

The most common ores. Most metals are found as oxides in nature — reduced to pure metal by smelting with carbon.


| Mineral     | Formula           | Geological source                                                  | Game relevance                                             |
| ----------- | ----------------- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| Hematite    | Fe₂O₃             | Sedimentary basins — ancient ocean floors (banded iron formations) | **Primary iron ore.** Red pigment (ochre)                  |
| Magnetite   | Fe₃O₄             | Igneous, metamorphic, sedimentary                                  | Iron ore, compass needles (lodestone), magnetic properties |
| Cassiterite | SnO₂              | Granitic pegmatite veins, placer deposits                          | **Only significant tin ore** → bronze                      |
| Rutile      | TiO₂              | Heavy mineral sands, metamorphic                                   | Titanium ore, white pigment (paint)                        |
| Ilmenite    | FeTiO₃            | Igneous, heavy mineral sands                                       | Titanium ore (most common), iron source                    |
| Corundum    | Al₂O₃             | Metamorphic, igneous                                               | Ruby and sapphire (trace Cr/Fe/Ti), abrasive (Mohs 9)      |
| Pyrolusite  | MnO₂              | Sedimentary, hydrothermal                                          | Manganese ore → steel hardening, dry cell batteries        |
| Chromite    | FeCr₂O₄           | Ultramafic (mantle) rock                                           | **Only chromium ore** → stainless steel                    |
| Uraninite   | UO₂               | Granite formations                                                 | **Primary uranium ore** → nuclear fuel                     |
| Bauxite     | Al(OH)₃ / AlO(OH) | Tropical deeply weathered granite                                  | **Only economical aluminum ore** — requires electrolysis   |
| Cuprite     | Cu₂O              | Oxidized copper deposits                                           | Secondary copper ore                                       |
| Spinel      | MgAl₂O₄           | Metamorphic, basalt                                                | Gemstone, refractory ceramics                              |
| Periclase   | MgO               | Metamorphic marble                                                 | Refractory linings, magnesia cement                        |
| Ice         | H₂O (solid)       | Polar regions, high altitude, glaciers                             | Fresh water, cooling, preservation                         |


---

##### Sulfides — elements bonded with sulfur

Most important metal ores. Sulfide minerals concentrate metals because sulfur preferentially bonds with heavy metals at hydrothermal temperatures. The smell of rotten eggs near hot springs is H₂S — the same chemistry.


| Mineral      | Formula    | Geological source                        | Game relevance                                                      |
| ------------ | ---------- | ---------------------------------------- | ------------------------------------------------------------------- |
| Pyrite       | FeS₂       | Hydrothermal veins, sedimentary          | Fire-striking sparks, sulfur source, fool's gold                    |
| Chalcopyrite | CuFeS₂     | Hydrothermal veins near plate boundaries | **Most common copper ore**                                          |
| Bornite      | Cu₅FeS₄    | Hydrothermal                             | Copper ore (peacock ore — iridescent purple/blue)                   |
| Galena       | PbS        | Sedimentary hydrothermal veins           | **Primary lead ore.** Silver byproduct                              |
| Sphalerite   | ZnS        | Hydrothermal, sedimentary                | **Primary zinc ore** → brass, galvanizing                           |
| Cinnabar     | HgS        | Volcanic hot springs, hydrothermal       | **Only mercury ore** — liquid metal at room temp                    |
| Arsenopyrite | FeAsS      | Hydrothermal veins — with gold           | Arsenic source, gold indicator mineral                              |
| Molybdenite  | MoS₂       | Granite-related hydrothermal             | **Primary molybdenum ore** → high-strength steel. Natural lubricant |
| Pentlandite  | (Fe,Ni)₉S₈ | Magmatic, basic igneous                  | **Primary nickel ore**                                              |
| Cobaltite    | CoAsS      | Hydrothermal                             | **Primary cobalt ore** → batteries, blue pigment                    |
| Argentite    | Ag₂S       | Hydrothermal veins                       | Silver ore                                                          |
| Stibnite     | Sb₂S₃      | Hydrothermal                             | **Primary antimony ore**                                            |
| Realgar      | AsS        | Volcanic, hydrothermal                   | Arsenic pigment (orange-red), insecticide — toxic                   |


---

##### Carbonates — compounds with CO₃²⁻

Formed primarily in shallow warm seas from shell and skeletal material. The most common sedimentary minerals.


| Mineral       | Formula                   | Geological source                               | Game relevance                                                     |
| ------------- | ------------------------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| Calcite       | CaCO₃                     | Shallow ancient ocean floors — limestone, chalk | **Lime (CaO) → mortar → concrete.** Also marble when metamorphosed |
| Aragonite     | CaCO₃ (different crystal) | Recent marine sediment, shells                  | Same as calcite — converts to calcite over time                    |
| Dolomite      | CaMg(CO₃)₂                | Sedimentary basins (replaced limestone)         | Refractory bricks, magnesium source                                |
| Malachite     | Cu₂CO₃(OH)₂               | Oxidized copper deposits (near surface)         | **Visible copper ore — bright green.** First copper ore smelted    |
| Azurite       | Cu₃(CO₃)₂(OH)₂            | Oxidized copper deposits                        | Copper ore, brilliant blue pigment                                 |
| Siderite      | FeCO₃                     | Sedimentary, hydrothermal                       | Iron ore — lower grade than hematite                               |
| Rhodochrosite | MnCO₃                     | Hydrothermal veins                              | Manganese ore, pink gemstone                                       |
| Smithsonite   | ZnCO₃                     | Oxidized zinc deposits                          | Zinc ore                                                           |
| Magnesite     | MgCO₃                     | Metamorphic, hydrothermal alteration            | Refractory bricks (magnesium oxide)                                |
| Cerussite     | PbCO₃                     | Oxidized lead deposits                          | Lead ore                                                           |


---

##### Halides — compounds with halogens (F, Cl, Br, I)


| Mineral    | Formula     | Geological source                                               | Game relevance                                                        |
| ---------- | ----------- | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| Halite     | NaCl        | Evaporated ancient seas — inland basins, underground salt domes | **Salt.** Food preservation, electrolysis (NaOH + Cl₂), road de-icing |
| Sylvite    | KCl         | Evaporite deposits with halite                                  | Potassium fertilizer                                                  |
| Fluorite   | CaF₂        | Hydrothermal veins, limestone contact                           | Flux in smelting, HF acid production, optical lenses (low dispersion) |
| Carnallite | KMgCl₃·6H₂O | Deep evaporite deposits                                         | Potassium fertilizer, magnesium source                                |
| Cryolite   | Na₃AlF₆     | Rare — Greenland                                                | Aluminum smelting flux (Hall-Héroult process solvent)                 |


---

##### Sulfates — compounds with SO₄²⁻


| Mineral      | Formula         | Geological source                             | Game relevance                                                     |
| ------------ | --------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| Gypsum       | CaSO₄·2H₂O      | Evaporite deposits, volcanic steam alteration | Plaster of Paris (dehydrated), drywall, soil amendment             |
| Anhydrite    | CaSO₄           | Deep evaporite                                | Same as gypsum (dehydrated form)                                   |
| Barite       | BaSO₄           | Hydrothermal veins                            | Drilling mud (heavy), barium source, X-ray shielding               |
| Alunite      | KAl₃(SO₄)₂(OH)₆ | Volcanic altered rock                         | Alum production → mordant for dyeing, water purification           |
| Chalcanthite | CuSO₄·5H₂O      | Oxidized copper ore (mine drainage)           | Copper source, fungicide (Bordeaux mixture) — bright blue crystals |
| Epsom salt   | MgSO₄·7H₂O      | Evaporite, mineral springs                    | Magnesium supplement, laxative, plant fertilizer                   |


---

##### Phosphates — compounds with PO₄³⁻


| Mineral      | Formula               | Geological source             | Game relevance                                                                 |
| ------------ | --------------------- | ----------------------------- | ------------------------------------------------------------------------------ |
| Apatite      | Ca₅(PO₄)₃(F/Cl/OH)    | Igneous, sedimentary (marine) | **Primary phosphate ore** → fertilizer, matches, bone substitute               |
| Vivianite    | Fe₃(PO₄)₂·8H₂O        | Reduced sediment, peat bogs   | Blue pigment, phosphorus source                                                |
| Turquoise    | CuAl₆(PO₄)₄(OH)₈·4H₂O | Oxidized copper in arid zones | Gemstone, pigment — ancient                                                    |
| Pyromorphite | Pb₅(PO₄)₃Cl           | Oxidized lead deposits        | Lead ore (minor), bright green crystals                                        |
| Monazite     | (Ce,La,Nd,Th)PO₄      | Placer sand deposits, granite | **Rare earth ore** (Ce, La, Nd) + thorium — strategic for magnets, electronics |


---

##### Nitrates — nitrogen compounds (rare in wet climates, concentrated in deserts)


| Mineral           | Formula | Geological source                         | Game relevance                                       |
| ----------------- | ------- | ----------------------------------------- | ---------------------------------------------------- |
| Saltpeter (niter) | KNO₃    | Cave floors (bat guano), dry desert soils | **Gunpowder** (75% KNO₃ + 15% C + 10% S). Fertilizer |
| Chile saltpeter   | NaNO₃   | Atacama-type hyper-arid deserts           | Industrial nitric acid source, fertilizer            |


---

##### Native Elements (minerals that are pure single elements)

A small category — most elements are locked in compounds. These occur in elemental form because they are either too unreactive to bond (gold, platinum) or were deposited in a reduced environment.


| Mineral  | Element | Geological source                                | Game relevance                                             |
| -------- | ------- | ------------------------------------------------ | ---------------------------------------------------------- |
| Gold     | Au      | Hydrothermal quartz veins, placer river deposits | Native — **found directly.** Coins, non-corroding contacts |
| Silver   | Ag      | Hydrothermal veins, weathered argentite          | Native (partial) — coins, mirrors, antibacterial           |
| Copper   | Cu      | Oxidized copper zones, native copper flows       | Native (partial) — **first metal ever worked by humans**   |
| Sulfur   | S       | Volcanic fumaroles, hot spring deposits          | Native — gunpowder, sulfuric acid, medicine                |
| Diamond  | C       | Kimberlite pipes (deep volcanic)                 | Mohs 10 — hardest material, cutting tools, optics          |
| Graphite | C       | Metamorphic rock, hydrothermal                   | Lubricant, crucibles, pencils, electrodes                  |
| Platinum | Pt      | Ultramafic rock, placer deposits                 | Native — catalytic converters, lab equipment               |
| Bismuth  | Bi      | Hydrothermal (trace native)                      | Low-melting alloys, cosmetics — least toxic heavy metal    |


---

##### Organic Minerals and Fossil Materials

Not minerals in the strict sense, but naturally occurring solid materials formed from organic processes.


| Material              | Composition                          | Geological source                           | Game relevance                                                                  |
| --------------------- | ------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------- |
| Coal (lignite)        | ~60–70% C, woody structure visible   | Wetland forests compressed 1–60 My          | Early fuel — low energy density                                                 |
| Coal (bituminous)     | ~80–90% C                            | Further compressed, 60–300 My               | **Main industrial coal** — fuel, coke production                                |
| Coal (anthracite)     | >92% C, nearly pure                  | Highest compression/metamorphism            | Highest energy density, slowest burning                                         |
| Peat                  | Partially decomposed organic, ~50% C | Active wetlands, bogs                       | Fuel precursor, soil amendment                                                  |
| Amber                 | Polymerized resin (C₁₀H₁₆O + more)   | Ancient tree resin, preserved in sediment   | Preserved specimens, early electrical experiment (static), gemstone             |
| Jet                   | Compact lignite                      | Highly compressed driftwood, marine         | Carved black jewelry, mourning jewelry                                          |
| Petroleum (crude oil) | Mixture of hydrocarbons CₙH₂ₙ₊₂      | Marine organic matter in sedimentary basins | **Gasoline, diesel, plastics, asphalt, lubricants** — enormous late-game unlock |
| Natural gas           | Mostly CH₄                           | Same basins as petroleum, shallower traps   | Fuel (highest H:C ratio), ammonia feedstock                                     |
| Oil shale             | Kerogen in shale matrix              | Ancient lake sediment                       | Low-grade petroleum source — requires retorting                                 |
| Asphalt               | Heavy petroleum residue              | Natural petroleum seeps                     | Waterproofing, road construction                                                |


---

#### Tier 3 — Processed Materials (human-made, organized by technological era)

These do not occur naturally. They are what the player makes. Organized by the era in which they become possible — each era requires mastering the previous one first. This is the bootstrapping chain.

---

##### Stone Age Processing (~300,000 BCE onward)

The first human-made materials. No smelting, no chemistry — just mechanical transformation, fire, and biology.


| Material              | Composition         | Made by                                      | Required conditions                                                |
| --------------------- | ------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| Charcoal              | ~C (99% pure)       | Wood + restricted oxygen (smothered fire)    | 300–500°C, sealed pit or mound — no open flame                     |
| Fired pottery         | Al₂Si₂O₅ → ceramic  | Clay shaped + kiln firing                    | 600–1200°C — clay undergoes irreversible vitrification             |
| Dried/smoked food     | Dehydrated organic  | Heat + time + smoke                          | <100°C sustained — removes moisture, antimicrobial smoke compounds |
| Salted food           | Organic + NaCl      | Salt + food + time                           | Osmosis draws water out — stops bacterial growth                   |
| Tanned leather        | Treated collagen    | Hide + tannin (tree bark) + water            | Weeks of soaking — tannins cross-link collagen fibers              |
| Rope / cordage        | Twisted plant fibre | Plant fibres (hemp, flax, nettle) + twisting | Mechanical — spindle or thigh-rolling                              |
| Woven cloth (linen)   | Cellulose fibres    | Flax → retted → spun → woven                 | Retting (bacterial decomposition of outer stalk), spinning, loom   |
| Woven cloth (wool)    | Keratin fibres      | Sheep fleece → carded → spun → woven         | Shearing, carding, spinning, loom                                  |
| Sinew cord            | Collagen fibres     | Animal tendon dried and stripped             | Drying, splitting — extremely strong                               |
| Bone tools            | Ca₅(PO₄)₃ shaped    | Bone + abrasion on sandstone                 | Mechanical shaping — needles, awls, hooks                          |
| Ochre pigment         | Fe₂O₃ powder        | Hematite ground to powder                    | Grinding — red/yellow pigment, oldest known human pigment          |
| Lime plaster          | CaO + H₂O → Ca(OH)₂ | Limestone heated then slaked with water      | 900°C calcination → add water → paste                              |
| Adhesive (birch tar)  | Phenolic compounds  | Birch bark dry distillation                  | 340–400°C, no oxygen — Neanderthals made this                      |
| Adhesive (pine resin) | Terpene polymers    | Pine tree resin + heat                       | Collected from bark wounds, heated to thicken                      |


---

##### Copper / Bronze Age (~5000–1200 BCE)

The smelting revolution. Fire reaches high enough temperatures to reduce metal oxides. The first true metallurgy.


| Material         | Composition           | Made by                                     | Required conditions                               |
| ---------------- | --------------------- | ------------------------------------------- | ------------------------------------------------- |
| Copper (smelted) | Cu                    | Malachite/chalcopyrite + charcoal           | 1085°C reduction furnace                          |
| Tin (smelted)    | Sn                    | Cassiterite + charcoal                      | 232°C — lowest melting metal ore                  |
| Lead (smelted)   | Pb                    | Galena + heat                               | 327°C — very easy to smelt                        |
| Bronze           | Cu + Sn (90:10)       | Copper + tin → alloy                        | 950°C — harder than copper alone                  |
| Arsenical bronze | Cu + As (~3%)         | Copper + arsenopyrite                       | 950°C — predates tin bronze historically          |
| Gold (refined)   | Au purified           | Gold nuggets + fire test                    | Cupellation — lead absorbs impurities at 1000°C   |
| Silver (refined) | Ag purified           | Argentite or lead ore byproduct             | Cupellation — standard refining process           |
| Lime (quicklime) | CaO                   | Limestone + heat                            | 900°C (calcination)                               |
| Slaked lime      | Ca(OH)₂               | Quicklime + water                           | Exothermic — produces plaster, mortar             |
| Basic mortar     | Ca(OH)₂ + SiO₂        | Lime + sand + water                         | Mix — hardens slowly by CO₂ absorption from air   |
| Basic glass      | SiO₂ + Na₂CO₃ + CaO   | Sand + natron + limestone                   | 1400°C furnace — earliest glass ~3500 BCE Egypt   |
| Beer / ale       | Ethanol solution ~4%  | Malted grain + water + yeast + warmth       | 30–35°C fermentation, 7–14 days                   |
| Wine             | Ethanol ~12%          | Grape juice + wild yeast                    | Spontaneous fermentation, temperature control     |
| Vinegar          | Acetic acid (CH₃COOH) | Dilute wine + air + Acetobacter bacteria    | Acetobacter oxidizes alcohol — preservation       |
| Leavened bread   | Starch + CO₂ pockets  | Grain flour + water + wild yeast + heat     | Fermentation rises dough; 200°C baking            |
| Papyrus          | Cellulose mat         | Papyrus plant stem strips pressed crosswise | Hammering + pressing — not true paper             |
| Dyed cloth       | Fabric + chromophore  | Plant or mineral dye + mordant (alum)       | Alum fixes color — without mordant, dyes wash out |


---

##### Iron Age (~1200–500 BCE)

Iron is harder and more abundant than copper but requires much higher temperatures (>1200°C) and a reducing atmosphere. Mastering it requires understanding charcoal chemistry.


| Material                 | Composition                     | Made by                                     | Required conditions                                      |
| ------------------------ | ------------------------------- | ------------------------------------------- | -------------------------------------------------------- |
| Wrought iron             | Fe + <0.08% C                   | Hematite + charcoal in bloomery             | 1200°C reduction — spongy bloom, hammered to expel slag  |
| Cast iron                | Fe + 2–4% C                     | High-carbon iron melt                       | 1150°C — flows liquid, brittle when cold                 |
| Pig iron                 | Fe + ~4% C + Si, Mn             | Blast furnace output                        | 1500°C — intermediate product                            |
| Steel (early)            | Fe + 0.2–2% C                   | Wrought iron + carburization (cementation)  | 900°C + charcoal + days — carbon diffuses into iron      |
| Tempered steel           | Fe + C + internal stress relief | Steel + rapid quench + controlled reheating | Quench in water/oil, temper at 150–300°C                 |
| Wootz / Damascus steel   | Fe + C in banded microstructure | High-C iron + forge welding                 | 1400°C + specific cooling — carbide bands                |
| Cement (Roman pozzolana) | CaO + volcanic ash (SiO₂·Al₂O₃) | Lime + volcanic ash + water                 | Reacts with lime — hardens underwater (hydraulic cement) |
| Soap                     | Fatty acid salts (RCOONa)       | Lye (NaOH/KOH) + animal fat                 | Saponification — boiling 1–2 hours                       |
| Potash                   | K₂CO₃                           | Wood ash + water → evaporate                | Lye leaching, evaporation                                |
| Lye (wood ash lye)       | KOH solution                    | Potash dissolved in water                   | Simple — pour water through ash                          |
| Tar                      | Polycyclic hydrocarbons         | Wood destructive distillation               | 400°C, closed vessel, no oxygen                          |
| Pitch                    | Polymerized tar residue         | Tar heated to boil off volatiles            | 200°C concentration — waterproofing ships                |
| Tallow                   | Rendered animal fat             | Boiling fatty tissue                        | Cooking — candles, soap, lubrication                     |
| Beeswax                  | Fatty acid esters               | Honeycomb from bees                         | Collected — candles, waterproofing, writing tablets      |


---

##### Medieval / Early Chemistry (500–1700 CE)

The alchemical period — systematic experimentation with chemistry, distillation, and acids. Many discoveries were made without understanding why they worked.


| Material                  | Composition                  | Made by                                                   | Required conditions                                                |
| ------------------------- | ---------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------ |
| Distilled alcohol         | Ethanol ~95%                 | Beer or wine + fractional distillation                    | 78°C (ethanol boils before water at 100°C)                         |
| Sulfuric acid (vitriol)   | H₂SO₄                        | Green vitriol (FeSO₄) roasted, or sulfur + steam          | Lead chamber process — 300°C + moisture                            |
| Nitric acid (aqua fortis) | HNO₃                         | Saltpeter + sulfuric acid + heat                          | Distillation — corrosive, dissolves most metals                    |
| Aqua regia                | HNO₃ + HCl (3:1)             | Nitric acid + hydrochloric acid                           | Mixed — **dissolves gold and platinum**                            |
| Hydrochloric acid         | HCl                          | Salt + sulfuric acid                                      | Simple reaction — salt + H₂SO₄ → NaHSO₄ + HCl gas                  |
| Gunpowder                 | KNO₃ 75% + C 15% + S 10%     | Saltpeter + charcoal + sulfur + grinding                  | Mixing + corning (granulating) — ignites at 300°C                  |
| Alum                      | KAl(SO₄)₂·12H₂O              | Alunite rock + sulfuric acid                              | Dissolve + crystallize — dye mordant, tanning                      |
| Saltpeter (manufactured)  | KNO₃                         | Nitrifying bacteria in dung heaps + potash                | 12–18 months biological process — was state-controlled             |
| Plaster of Paris          | CaSO₄·½H₂O                   | Gypsum heated to 150°C                                    | Dehydration — adds water → hard cast (dental, sculpture)           |
| Ink                       | Carbon black + gum arabic    | Soot + resin dissolved in water                           | Ground soot, suspension chemistry                                  |
| Paper                     | Cellulose network            | Rag or plant fibre + maceration + pressing                | Beating to separate fibres, sheet forming, pressing, drying        |
| Stained glass             | SiO₂ + metal oxide colorants | Sand + soda + metal oxides (Cu=green, Co=blue, Mn=purple) | 1400°C with colorant oxides added                                  |
| White lead pigment        | 2PbCO₃·Pb(OH)₂               | Lead + acetic acid vapor + CO₂                            | Dutch process — corrosive vapor over lead sheets. Toxic            |
| Prussian blue             | Fe₄[Fe(CN)₆]₃                | Iron salt + potassium ferrocyanide                        | 1704 — first synthetic pigment                                     |
| Phosphorus (white)        | P₄                           | Bone ash + sand + charcoal + heat                         | 1200°C reduction — discovered 1669, glows in dark, ignites at 30°C |


---

##### Industrial Revolution (1760–1900 CE)

Scale and steam. Chemistry moves from craft to industry. New energy sources (coal → coke → steam) drive new temperatures and new processes.


| Material                        | Composition                          | Made by                                      | Required conditions                                                 |
| ------------------------------- | ------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------- |
| Coke                            | C (purified from coal)               | Coal + restricted oxygen (coking oven)       | 1000–1100°C — drives out S, N, H impurities. Blast furnace fuel     |
| Pig iron (blast furnace)        | Fe + ~4% C                           | Iron ore + coke + limestone in blast furnace | 1500°C + forced air — continuous process                            |
| Bessemer steel                  | Fe + 0.1–0.3% C                      | Molten pig iron + blown air                  | 1600°C — air burns out excess carbon in minutes                     |
| Portland cement                 | CaO·SiO₂·Al₂O₃                       | Limestone + clay → kiln                      | 1450°C clinkering — hydraulic, hardens with water                   |
| Reinforced concrete             | Concrete + iron/steel rebar          | Pour concrete around steel mesh              | Combines compressive strength (concrete) + tensile strength (steel) |
| Vulcanized rubber               | Polyisoprene + sulfur bridges        | Natural rubber + sulfur + heat               | 150°C + 5% sulfur — dramatically increases strength and elasticity  |
| Chlorine gas                    | Cl₂                                  | Salt electrolysis (chlor-alkali)             | Electrical current through NaCl brine                               |
| Sodium hydroxide (caustic soda) | NaOH                                 | Salt electrolysis (byproduct with Cl₂)       | Same process — disinfectant, soap, paper making                     |
| Ammonia (Haber process)         | NH₃                                  | N₂ + 3H₂ → 2NH₃                              | 450°C + 200 atm + iron catalyst — revolutionized agriculture        |
| Synthetic fertilizer            | NH₄NO₃, (NH₄)₂SO₄                    | Ammonia + acids                              | After Haber — enabled feeding 4+ billion extra people               |
| Kerosene                        | C₁₀–C₁₆ hydrocarbons                 | Crude oil fractional distillation            | 150–300°C fraction — replaced whale oil for lighting                |
| Gasoline                        | C₅–C₁₂ hydrocarbons                  | Crude oil fractional distillation            | 35–200°C fraction — internal combustion engine fuel                 |
| Asphalt / bitumen               | Heavy hydrocarbons                   | Crude oil distillation residue               | >500°C residue — road paving, waterproofing                         |
| Dynamite                        | Nitroglycerin absorbed in kieselguhr | Nitroglycerine + diatomaceous earth          | Nobel (1867) — stable handling of nitroglycerine                    |
| TNT                             | C₇H₅N₃O₆                             | Toluene (coal tar) + nitric acid             | Nitration reaction — stable, detonates only with shockwave          |
| Aniline dyes                    | Various organic chromophores         | Coal tar + nitric acid + reduction           | Perkin (1856) — first synthetic dye (mauveine)                      |
| Stainless steel                 | Fe + 13–25% Cr + Ni                  | Iron + chromite + nickel                     | Electric arc furnace — Cr₂O₃ passive layer prevents rust            |


---

##### Electrical Age (1880–1940 CE)

Electricity enables new processes: electrolysis frees aluminum (impossible before), electroplating coats metals, arc furnaces reach temperatures no combustion can achieve.


| Material                      | Composition         | Made by                                          | Required conditions                                      |
| ----------------------------- | ------------------- | ------------------------------------------------ | -------------------------------------------------------- |
| Aluminum (refined)            | Al                  | Bauxite → alumina (Al₂O₃) → electrolysis         | Hall-Héroult (1886): 960°C + 5V DC in cryolite bath      |
| Copper wire (drawn)           | Cu 99.9%            | Smelted copper → rod → wire drawing              | Wire drawing dies — progressively smaller holes          |
| Galvanized steel              | Fe + Zn coating     | Steel dipped in molten zinc                      | 450°C zinc bath — Zn sacrificially corrodes, protects Fe |
| Electroplated gold/silver     | Metal coating       | Electrolysis — metal ion solution + DC           | Very thin layer — jewelry, contacts, mirrors             |
| Silicon (semiconductor grade) | Si 99.9999999%      | Quartz → SiCl₄ → reduction → Czochralski crystal | Zone refining, crystal pulling — ultra-pure              |
| Tungsten filament             | W (drawn wire)      | Wolframite → tungsten powder → sintered          | 3000°C+ capable — highest melting point metal            |
| Nichrome                      | Ni 80% + Cr 20%     | Nickel + chromium alloy                          | Electric resistance wire — toasters, heating elements    |
| Lead-acid battery             | Pb + PbO₂ + H₂SO₄   | Lead plates + sulfuric acid electrolyte          | Assembled — reversible electrochemistry                  |
| Carbon arc                    | C electrodes in air | Graphite rods + high current                     | 3500°C arc — first electric lighting, searchlights       |
| Ferrochrome                   | Fe + Cr             | Chromite + iron + coke in electric arc furnace   | 2800°C electric arc — stainless steel additive           |
| Ferrosilicon                  | Fe + Si             | Quartz + iron + coke in arc furnace              | 1500°C — steel deoxidizer                                |


---

##### Chemical / Polymer Age (1920–1970 CE)

Organic chemistry scales from laboratory to factory. Carbon chains become the basis for entirely new materials — plastics, synthetic fibers, pharmaceuticals.


| Material                    | Composition               | Made by                                          | Required conditions                                                  |
| --------------------------- | ------------------------- | ------------------------------------------------ | -------------------------------------------------------------------- |
| Bakelite                    | Phenol-formaldehyde resin | Phenol (coal tar) + formaldehyde + heat/pressure | 150°C compression molding — first fully synthetic plastic (1907)     |
| Nylon                       | Polyamide chains          | Hexamethylenediamine + adipic acid               | Condensation polymerization at ~280°C — first synthetic fiber (1935) |
| Polyethylene (PE)           | (CH₂-CH₂)ₙ                | Ethylene gas + catalyst                          | Ziegler-Natta catalyst, 70°C — most-produced plastic                 |
| PVC                         | (CH₂-CHCl)ₙ               | Vinyl chloride + catalyst                        | Radical polymerization — pipes, insulation, clothing                 |
| Polystyrene                 | (CH₂-CHC₆H₅)ₙ             | Styrene + catalyst                               | Radical polymerization — packaging foam, cups                        |
| Teflon (PTFE)               | (CF₂-CF₂)ₙ                | Tetrafluoroethylene polymerization               | Radical process — lowest friction coefficient of any solid           |
| Synthetic rubber            | Styrene-butadiene (SBR)   | Styrene + butadiene + catalyst                   | Emulsion polymerization — tires, seals                               |
| Neoprene                    | Polychloroprene           | Chloroprene polymerization                       | Oil-resistant rubber — wetsuits, hoses                               |
| Epoxy                       | Diglycidyl ether + amine  | Bisphenol-A + epichlorohydrin                    | Two-part cure — structural adhesive, coatings                        |
| Acrylic (PMMA)              | Polymethyl methacrylate   | Methyl methacrylate polymerization               | Transparent — "plexiglass," optical fiber predecessor                |
| Synthetic fertilizer (urea) | CO(NH₂)₂                  | Ammonia + CO₂                                    | 200°C + 150 atm — 50% of food production depends on this             |
| DDT                         | C₁₄H₉Cl₅                  | Chlorobenzene + chloral + H₂SO₄                  | First modern insecticide — effective, persistent, ecosystem harm     |
| Penicillin                  | β-lactam antibiotic       | Penicillium mold fermentation                    | 25°C fermentation — first antibiotic at scale (1943)                 |


---

##### Nuclear Age (1940–1960 CE)

Radioactive materials and neutron physics. Requires rare materials (uranium, heavy water) and extreme precision. Unlocked only after mastering electrical and chemical ages.


| Material                 | Composition                    | Made by                                          | Required conditions                                                |
| ------------------------ | ------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------ |
| Enriched uranium         | U-235 ~3–90% (vs natural 0.7%) | UF₆ gas centrifuge or gaseous diffusion          | Thousands of centrifuge stages — mass separation                   |
| Plutonium-239            | Pu-239                         | U-238 in nuclear reactor (neutron capture)       | Sustained fission reaction in reactor — no other way               |
| Heavy water              | D₂O                            | Electrolysis of water (D concentrates)           | D:H natural ratio 1:6400 — large electrolysis cascade              |
| Graphite (nuclear grade) | C, ultra-pure                  | Petroleum coke + high-temperature graphitization | <1 ppm boron (absorbs neutrons) — reactor moderator                |
| Uranium hexafluoride     | UF₆                            | Uranium + fluorine gas                           | Corrosive gas — centrifuge feedstock                               |
| Reactor steel (Zircaloy) | Zr + Sn alloy                  | Zircon + reduction + alloying                    | Near-zero neutron absorption — fuel rod cladding                   |
| Tritium                  | H-3                            | Li-6 + neutron in reactor                        | Neutron bombardment of lithium — fusion fuel, nuclear weapon boost |


---

##### Silicon / Digital Age (1960–2000 CE)

The information revolution. Materials science at atomic precision. Every component depends on everything below — no shortcuts.


| Material                    | Composition                        | Made by                                                  | Required conditions                                                      |
| --------------------------- | ---------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| Silicon wafer               | Si, 99.9999999%                    | Silica → trichlorosilane → Siemens process → Czochralski | Crystal pulling at 1415°C — entire semiconductor industry                |
| Germanium (semiconductor)   | Ge, ultra-pure                     | Zone refining of germanium dioxide reduction             | First transistor material (1947) — now replaced by Si mostly             |
| Gallium arsenide            | GaAs                               | Gallium + arsenic vapor deposition                       | Molecular beam epitaxy — faster than Si, used in phones/LEDs             |
| Indium tin oxide (ITO)      | In₂O₃·SnO₂                         | Sputtering onto glass                                    | Transparent conductor — **every touchscreen and LCD**                    |
| Photovoltaic cell (silicon) | p-n junction Si                    | Doped wafer + contact metallization                      | Boron (p-type) + phosphorus (n-type) diffusion                           |
| Optical fiber               | SiO₂ + GeO₂ core                   | Chemical vapor deposition + drawing                      | Ultra-pure glass drawn to 125 μm — total internal reflection             |
| Lithium-ion battery         | LiCoO₂ + graphite + LiPF₆          | Layered oxide cathode, graphite anode, electrolyte       | Intercalation chemistry — Li⁺ moves between electrodes                   |
| Carbon fiber                | C (graphitic)                      | Polyacrylonitrile (PAN) pyrolysis + tension              | 1500°C in inert atmosphere — strongest material by weight                |
| Kevlar                      | Poly-paraphenylene terephthalamide | Aromatic diamine + diacid chloride polymerization        | Dry spinning into fibers — 5× stronger than steel by weight              |
| OLED material               | Organic semiconductor              | Molecular vapor deposition                               | Ultra-thin layers, angstrom precision — emits light when current applied |


---

##### Advanced / Emerging Materials (2000 CE–present and beyond)


| Material                     | Composition                        | Made by                                       | Required conditions                                               |
| ---------------------------- | ---------------------------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| Graphene                     | Single-layer carbon lattice        | Mechanical exfoliation or CVD                 | Tape method (Nobel 2010) or 1000°C CVD — strongest material known |
| Carbon nanotube              | Cylindrical graphene               | Catalytic CVD                                 | Metal nanoparticle catalyst + 700°C hydrocarbon gas               |
| Aerogel                      | SiO₂ network, 99.8% air            | Silica gel + supercritical drying             | CO₂ supercritical drying — lightest solid material                |
| Shape-memory alloy (Nitinol) | Ni + Ti (50:50)                    | Vacuum arc melting + cold working + annealing | Returns to memorized shape at transition temperature              |
| High-temp superconductor     | YBa₂Cu₃O₇ (YBCO)                   | Solid-state synthesis + oxygen annealing      | Superconducts below 93K (−180°C) — levitation, lossless power     |
| Metamaterial                 | Structured sub-wavelength geometry | Nanofabrication — photolithography            | Negative refractive index — invisibility cloak research           |
| Solid-state battery          | Li + ceramic electrolyte           | Thin-film deposition                          | No liquid — fire-safe, higher energy density                      |
| Synthetic diamond            | C (CVD)                            | Hydrogen + methane plasma                     | 800–1200°C microwave plasma — gem-quality or industrial           |
| Room-temp superconductor     | LuH₂(N) — under research           | High-pressure synthesis                       | Still experimental — would transform power transmission           |


---

#### What This Means for the Interaction Engine

The game never has a "recipe" for any of these. Instead:

- A player finds **malachite** (Tier 2 mineral, green copper ore)
- They build a fire hot enough to reach 1085°C (requires charcoal + bellows — charcoal from wood, bellows from leather)
- The interaction engine checks: `malachite.meltingPoint ≤ currentTemp` + `reducingAtmosphere (charcoal present)` → produces copper
- The player has discovered copper smelting — not because a recipe unlocked, but because they created the right physical conditions

Every row in the Tier 3 table is a discovery to be made, not a recipe to be found.

**Scientific grounding — material properties:**
Every numerical value in `MaterialRegistry.ts` is sourced from the *CRC Handbook of Chemistry and Physics* (the definitive scientific reference, updated annually). Mohs hardness values follow Friedrich Mohs' original 1812 scale anchored to real minerals: talc (1), gypsum (2), calcite (3), fluorite (4), apatite (5), orthoclase (6), quartz (7), topaz (8), corundum (9), diamond (10). Flint scores 7 — harder than iron (4–5) — which is why striking flint against iron produces sparks rather than the other way around.

Mark Miodownik's *Stuff Matters* (2013) describes the experiential reality behind these numbers: why steel feels different from cast iron (carbon content changes crystal structure, shifting the balance between tensile and compressive strength), why glass is brittle (no grain boundaries to deflect cracks), why concrete is strong in compression but weak in tension (the inverse of steel). These distinctions are what the `brittleness`, `tensileStrength`, and `compressiveStrength` properties capture — and why a player will eventually discover that concrete + steel rebar produces a stronger structure than either alone.

**Design grounding — no recipe list:**
The decision to derive all interactions from properties rather than a lookup table follows directly from how *Dwarf Fortress* handles material simulation. In that game, fire spreads based on each material's ignition temperature and combustion energy — not because a designer wrote "wood catches fire." The same principle applies here: gunpowder is not a recipe. It is what happens when three materials — each with high reactivity, sufficient combustion energy, and a low ignition threshold — are combined and struck.


### 6.2 Complete Production System — How Every Material Is Made

The game has no recipe database. Instead it has **transformation rules** — physical and chemical laws that govern what happens when materials are combined under specific conditions. Every Tier 3 material is produced by one or more of five transformation types.

#### The Five Transformation Types

**Heat (H)** — material changes state or chemical composition when temperature reaches a threshold. The assembly determines the maximum achievable temperature. An open campfire caps at ~400°C. A clay-walled bloomery with bellows reaches ~1100°C. A blast furnace with coke reaches ~1500°C.

**Mechanical (M)** — physical force changes shape, separates fibers, or breaks material apart. Requires the right tool hardness (Mohs scale). A flint chisel (Mohs 7) can shape limestone (Mohs 3). An iron hammer can shape hot iron. A grinding stone converts grain to flour.

**Chemical (C)** — two or more substances react in the right ratio under specific conditions. Temperature, pH, catalyst, and atmosphere all matter. Gunpowder is not a recipe — it is what happens when an oxidizer (KNO₃), a carbon fuel, and a sulfur fuel are ground together and ignited.

**Biological (B)** — living organisms do the work. The player provides the right environment (temperature, nutrients, moisture, oxygen level) and time. Yeast ferments sugar to alcohol. Bacteria nitrify ammonia into saltpeter. Fungi produce penicillin. The player cannot rush this — biological time scales are real.

**Electrical (E)** — electrical current drives chemical reactions that cannot be achieved by heat alone. Aluminum cannot be smelted from bauxite with fire — it requires electrolysis. This transformation type is only possible once a civilization has built electrical generation infrastructure.

---

#### Stone Age Processing

**Charcoal**

- Type: H — pyrolysis (anaerobic combustion)
- Inputs: Wood logs (hardwood preferred: oak, hickory, ash — higher fixed carbon content)
- Assembly: Sealed pit (dig hole, fill with wood, cover with earth leaving 3–4 small vent holes) OR clay-sealed mound with vents
- Conditions: 300–500°C, severely restricted oxygen. Light fire at vents, partially seal. Run 6–12 hours. Done when vents emit blue flame instead of white smoke
- Physics: Without oxygen, wood cannot fully combust. Pyrolysis drives off water (~~20%), tars and oils (~~30%), and volatile gases — leaving ~45% nearly pure carbon skeleton
- Prerequisite: Fire only
- Prerequisite for: All smelting, all high-temperature chemistry, glass, cement, steel

**Fired pottery**

- Type: H — vitrification
- Inputs: Wet clay, shaped and slowly air-dried (fast drying = cracking from uneven shrinkage)
- Assembly: Pit fire surrounds clay vessels in fuel — no kiln needed for basic earthenware
- Conditions: Heat gradually to 600°C minimum, hold 2 hours, cool slowly (thermal shock = breakage). 1000–1200°C produces stoneware (denser, watertight, rings when struck)
- Physics: Above 600°C, clay minerals (Al₂Si₂O₅) permanently restructure. Silica partially vitrifies, fusing clay particles
- Prerequisite: Fire, wet clay, shade-drying
- Note: First pots fire in a campfire. A kiln is not needed until stoneware quality is required

**Dried / smoked food**

- Type: H — dehydration + chemical preservation
- Inputs: Raw meat, fish, or fruit + aromatic wood fuel (oak, hickory, apple produce antimicrobial phenolics)
- Assembly: Campfire + smoking rack (sticks suspended above coals) OR enclosed smoke chamber (clay walls or hide draped over frame)
- Conditions: 60–80°C hot smoking (cooks + preserves), 20–35°C cold smoking (preserves without cooking). Duration: 6–24 hours depending on thickness of product
- Physics: Water activity reduced below 0.85 prevents bacterial growth. Smoke deposits guaiacol, syringol, formaldehyde — antimicrobial and antifungal compounds. Low pH from acids inhibits Clostridium botulinum
- Prerequisite: Fire, cordage for rack

**Salted food**

- Type: C — osmotic preservation
- Inputs: Food (meat, fish, vegetables) + halite (NaCl — mined from deposits or seawater evaporated in clay pans over days)
- Assembly: Clay vessel or hide-lined pit
- Conditions: Pack food in dry salt OR submerge in brine (200 g NaCl per liter water). Hours for surface cure, months for deep-preserved meat. Room temperature
- Physics: Osmotic pressure differential draws water from food cells. NaCl disrupts bacterial enzyme function. Salt-tolerant lactobacillus survives and produces lactic acid — adds a second preservation mechanism
- Prerequisite: Salt mining or seawater + clay evaporation pans

**Tanned leather**

- Type: B — enzymatic crosslinking
- Inputs: Fresh animal hide (scraped clean of flesh and fat) + tannin source (oak bark, chestnut bark, mimosa bark — ~20% tannic acid content)
- Assembly: Clay pit or large vessel deep enough to submerge full hide. Water access
- Conditions: Soak hide in progressively stronger tannin solution — weak for weeks 1–2, medium weeks 3–4, full strength weeks 5 onward. Total: 1–6 months (thin hides faster). Optimal temperature: 10–20°C — warmth accelerates but risks hide rot
- Physics: Tannin molecules form hydrogen bonds and covalent crosslinks with collagen fibers in hide. Fills interfibrillar space, stabilizes the triple-helix collagen structure against heat, water, and microbial attack
- Prerequisite: Animal hunting, bark identification, clay vessel, water source
- Prerequisite for: Bellows (the critical unlock for all metallurgy), water skins, footwear

**Rope and cordage**

- Type: M — fiber twisting (plying)
- Inputs: Plant fibers (hemp, nettle, flax inner bark, cattail leaves, spruce root) OR sinew strips or rawhide
- Assembly: Hands + thigh-rolling OR drop spindle (weighted stick with clay or stone whorl)
- Conditions: Fibers must be dry and separated. Two bundles twisted clockwise, then plied together counter-clockwise — opposing twist locks them (tensile interlocking)
- Physics: Individual fibers have high tensile strength along their axis but no lateral cohesion. Twisting converts adjacent fiber compression into longitudinal tension — the whole bundle resists pulling
- Prerequisite: Fire for drying. Linen requires retting first

**Woven cloth (linen)**

- Type: B + M — retting → spinning → weaving
- Inputs: Flax stalks (Linum usitatissimum)
- Assembly: Retting pit or slow stream, drying rack, break/scutch tools (wood paddle + board), hackle (comb with fine tines), spindle, loom (two parallel beams + heddle bars + shuttle)
- Conditions:
  1. Retting: Submerge bundled stalks in slow water 1–3 weeks. Bacteria soften pectin binding bast fibers to the woody core
  2. Breaking/scutching: Beat dried stalks to break and remove woody core
  3. Hackling: Comb to align fibers into long parallel bundles
  4. Spinning: Draft fibers thin and twist into continuous thread
  5. Weaving: Interlace warp (lengthwise) + weft (crosswise) on loom
- Prerequisite: Flax identification, loom construction (worked timber), rope making (spindle knowledge)

**Woven cloth (wool)**

- Type: M — carding → spinning → weaving
- Inputs: Sheep fleece (sheared or gathered from bushes where sheep rub)
- Assembly: Carding paddles (wood + fine wire teeth or teasel plant heads), spindle, loom
- Simpler than linen — no retting required. Card to align fibers, spin to thread, weave
- Prerequisite: Sheep access (animal domestication or proximity), carding tool construction

**Sinew cord**

- Type: M — drying and stripping
- Inputs: Large animal tendons (Achilles tendon or backstrap from deer, cattle, horse)
- Assembly: Drying rack, rounded stone for pounding
- Conditions: Dry 1–3 days. Pound dried tendon to separate fiber bundles. Moisten and twist like rope
- Physics: Dried tendon is nearly pure collagen — tensile strength ~1000 MPa, stronger than most plant fibers. Stretches when wet, shrinks dry — bowstrings tighten in humidity (this is a material property the interaction engine tracks)

**Bone tools**

- Type: M — abrasion shaping
- Inputs: Long bones (deer, cattle), fish bones for needles
- Assembly: Coarse sandstone + fine sandstone + water for wet grinding
- Conditions: Score with flint to create blank, snap, grind to shape on wet stone. Drill eye holes with rotating flint point
- Physics: Bone is hydroxyapatite crystals embedded in collagen matrix. Wet grinding prevents heat above 60°C which denatures collagen and makes bone brittle

**Ochre pigment**

- Type: M — grinding
- Inputs: Hematite (Fe₂O₃, red) or goethite (FeO(OH), yellow-brown) — soft iron oxide minerals
- Assembly: Grinding stone + flat stone base + water
- Conditions: Grind wet to fine powder. Mix with animal fat or plant oil for paint
- Most stable pigment known — iron oxide survives intact in 70,000-year-old cave paintings

**Lime plaster**

- Type: H + C — calcination then slaking
- Inputs: Limestone (CaCO₃) — marble and chalk also work
- Assembly: Kiln or sustained high fire (charcoal preferred) for calcination. Clay-lined pit for slaking
- Conditions:
  1. Calcination: 900°C for 2–12 hours until stone crumbles → quicklime (CaO) + CO₂
  2. Slaking: Add water to quicklime CAREFULLY — violently exothermic, steam and spatter, severe burn risk. Produces slaked lime paste (Ca(OH)₂)
  3. Mix slaked lime + sand (2:1 ratio). Apply. Hardens over weeks as CO₂ from air reconverts it to CaCO₃
- Prerequisite: Sustained 900°C fire, limestone identification
- Game hazard: Quicklime + water reaction can cause burns if player character is near and unprotected

**Birch tar (adhesive)**

- Type: H — dry distillation (anaerobic pyrolysis)
- Inputs: Birch bark (inner bark layer — Betula species)
- Assembly: Clay vessel sealed except for one small exit hole, fire beneath. Clay collection vessel below exit hole
- Conditions: 340–400°C, zero oxygen. Volatile phenolic compounds (catechol, guaiacol, betulin) condense at exit hole as they cool
- Physics: Without oxygen, volatile aromatic compounds are driven off by heat but cannot combust. They condense as viscous black tar
- Note: Predates pottery in the archaeological record — Neanderthals produced birch tar ~200,000 years ago using rolled bark tubes as vessels. Can be made without a clay pot
- Prerequisite: Fire. Clay pot OR tightly rolled birch bark + clay seal
- Prerequisite for: Hafting (attaching stone tools to wooden handles — critical for axes and spears)

**Pine resin adhesive**

- Type: H — concentration and addition
- Inputs: Pine resin (collected from bark wounds) + charcoal powder (10–20% by weight, for strength)
- Assembly: Clay vessel + low campfire
- Conditions: Heat to 80–100°C — must not boil (volatile terpenes escape, leaving brittle residue). Add charcoal powder, stir, apply while hot to hafting joint

---

#### Copper / Bronze Age

**Copper (smelted)**

- Type: H — chemical reduction (oxide to metal)
- Inputs: Malachite (Cu₂CO₃(OH)₂ — bright green, found at surface in oxidized copper zones) or chalcopyrite (CuFeS₂, primary sulfide ore) + charcoal
- Assembly: Bloomery — clay cylinder 50–80 cm tall, tuyere hole at base, leather bellows attached to tuyere
- Conditions: 1085°C in reducing CO atmosphere. Bellows drives oxygen into charcoal → charcoal burns hotter → CO gas produced → CO reduces copper oxide to metal
- Reactions: Cu₂CO₃(OH)₂ + heat → 2CuO + CO₂ + H₂O, then CuO + CO → Cu + CO₂
- Discovery path: Green malachite stones placed in fire ring → player notices metallic drips at base → primitive smelting → eventually learns enclosed fire with charcoal is required
- Prerequisite: Bloomery construction (clay walls + bellows from tanned leather), charcoal, malachite identification
- Note: Chalcopyrite requires roasting step first (open fire, 600°C) to drive off sulfur as SO₂ before reducing. SO₂ is toxic — game hazard

**Tin (smelted)**

- Type: H — reduction
- Inputs: Cassiterite (SnO₂ — dark, very heavy mineral in river gravels and granite veins) + charcoal
- Assembly: Even a clay pit fire works — tin melts at only 232°C
- Conditions: 232°C in reducing atmosphere. Reaction: SnO₂ + 2CO → Sn + 2CO₂
- Historical note: Cassiterite's dark, unremarkable appearance makes identification genuinely hard. Bronze Age civilizations traded tin across 3000+ km. The game's geology should make cassiterite rare and scattered, as it was historically

**Lead (smelted)**

- Type: H — roast-reduction
- Inputs: Galena (PbS — very heavy, cubic silver-gray crystals) + charcoal
- Assembly: Simple open furnace or campfire (lead melts at 327°C — very accessible temperature)
- Conditions: Roast galena in open air → PbS + O₂ → PbO + SO₂ (toxic). Then reduce with charcoal: PbO + CO → Pb + CO₂. Or combined process with charcoal present during roasting
- Game hazard: SO₂ gas is toxic — player health damage if nearby. Lead handling over time is a slow poison — progressive neurological degradation stat

**Bronze**

- Type: H — alloying
- Inputs: Copper (smelted, liquid at 1084°C) + tin (~10% by weight)
- Assembly: Clay crucible inside furnace or bloomery, clay stirring rod, stone or clay casting mold
- Conditions: Heat copper to liquid. Add tin — melts instantly at 232°C and mixes. Stir. Pour into mold. Cool slowly to prevent cracking
- Physics: Tin atoms substitute for copper in the crystal lattice (substitutional solid solution). 10% Sn: harder than copper alone (Brinell 60–100 vs copper's 35), lower melting point (950°C vs 1085°C), better casting fluidity

**Arsenical bronze**

- Type: H — co-smelting (often accidental)
- Inputs: Copper ore contaminated with arsenopyrite (FeAsS — found near gold deposits) + charcoal
- Assembly: Same as copper smelting
- Conditions: 950°C, reducing atmosphere
- Game hazard: Arsenic vapor released during smelting is cumulative poison — repeated exposure causes peripheral neuropathy (weakened legs over time), skin lesions. This is the mythological origin of lame divine smiths (Hephaestus, Wayland the Smith)
- Discovery: Player may produce this accidentally by smelting copper ore that contains arsenopyrite contamination

**Gold (refined)**

- Type: H — cupellation
- Inputs: Native gold (nuggets or gold-bearing quartz) + lead (7–10× the gold weight)
- Assembly: Porous clay cupel (small shallow dish of fine clay, fired) inside small furnace
- Conditions: Mix gold + lead, melt at 1000°C in open air. Lead oxidizes to litharge (PbO), absorbs all base metal impurities, soaks into porous cupel. Pure gold bead remains
- Note: Alluvial gold can be found directly by river panning — gravity separation, no heat needed. Cupellation is only needed to remove silver or base metal impurities from mixed native gold

**Silver (refined)**

- Same cupellation process. Silver is often a byproduct of lead smelting — galena frequently contains 0.01–0.3% silver recoverable by this method

**Quicklime**

- CaCO₃ + 900°C sustained → CaO + CO₂ released. Same calcination as Stone Age lime plaster. Now needed at larger scale for mortar and construction

**Slaked lime**

- CaO + H₂O → Ca(OH)₂. Exothermic — perform in clay-lined pit with water added gradually, not in a clay vessel (reaction produces violent steam)

**Basic mortar**

- Slaked lime + sand (2:1 by volume) + optional plant fiber (horse hair, straw — reduces cracking) + water. Mix to paste. Hardens over weeks by absorbing CO₂ from air

**Basic glass**

- Type: H — fusion
- Inputs: Quartz sand (SiO₂) + natron (Na₂CO₃ from dry lake beds) OR wood ash (K₂CO₃) + limestone (CaCO₃)
- Assembly: Clay crucible inside high-temperature furnace capable of sustained 1400°C (requires tall stack + strong bellows + charcoal fuel). Annealing oven (slower cool-down kiln)
- Conditions: 1400°C for 2–4 hours. Melt all components together. Pour onto flat stone or into mold. Anneal: hold at 500°C for 1 hour, then cool over 4+ hours (rapid cooling = stress fractures from thermal gradient)
- Physics: SiO₂ forms a covalent tetrahedral network (network glass). Na₂O or K₂O breaks network bonds (network modifiers), lowering melting point from ~1720°C (pure silica) to ~1400°C. CaO stabilizes the glass against water dissolution
- Prerequisite: Furnace reaching 1400°C (requires strong double bellows, charcoal, tall draft stack), natron or wood ash, clay crucible that survives that temperature

**Beer / ale**

- Type: B — yeast fermentation
- Inputs: Barley (or wheat, rye, millet) + water + wild yeast (captured in sourdough starter or naturally present on grain)
- Assembly: Clay pot for mashing (heating grain + water), clay fermentation vessel with loose cover (allows CO₂ to escape, excludes insects)
- Conditions:
  1. Malt: Soak grain 48 hours, allow to sprout 3–4 days at 15–20°C (amylase enzymes develop in sprouting embryo), dry at 50°C to stop germination
  2. Mash: Mix malted grain + hot water at 65–70°C for 1–2 hours (amylase converts starch → maltose sugar)
  3. Cool wort to 25–30°C. Inoculate with sourdough yeast or expose to open air. Ferment 7–14 days
- Physics: Amylase enzymes catalyze starch → maltose. Saccharomyces cerevisiae metabolizes sugars anaerobically → ethanol + CO₂. Natural cap: ~10% ABV (yeast dies above this concentration)
- Prerequisite: Grain cultivation or collection, clay pot, fire for mashing, yeast capture

**Wine**

- Type: B — wild yeast fermentation
- Inputs: Ripe grapes (wild or cultivated, Vitis species)
- Assembly: Crushing surface (flat stone), clay amphora or vessel
- Conditions: Crush grapes, transfer to vessel with skins. Wild yeast present on grape skin begins fermentation at 18–25°C. Ferment 1–3 weeks. Rack off sediment (pour into second vessel, leaving sediment). Seal with wax
- Simpler than beer — no malting or mashing step required

**Vinegar**

- Type: B — bacterial oxidation
- Inputs: Dilute wine or beer (4–8% ethanol) + Acetobacter bacteria (present in open air)
- Assembly: Open clay pot or porous wooden barrel
- Conditions: Expose to air at 25–30°C for 2–8 weeks. Acetobacter oxidizes ethanol to acetic acid
- Physics: CH₃CH₂OH + O₂ → CH₃COOH + H₂O. Must not be sealed — requires oxygen, opposite of fermentation
- Uses: Food preservation (lowers pH below pathogen growth threshold), cleaning, dissolving limestone for chemistry

**Leavened bread**

- Type: B + H — fermentation then baking
- Inputs: Ground grain flour + water + sourdough starter (captured wild yeast maintained as live culture in flour-water)
- Assembly: Grinding stone for flour, clay bowl for dough, clay or stone oven
- Conditions: Mix flour + water + starter. Ferment dough 4–12 hours at 25–30°C (yeast produces CO₂ that inflates dough). Bake at 200°C for 20–40 minutes
- Prerequisite: Grinding stone, grain cultivation, yeast capture and maintenance

**Papyrus**

- Type: M — fiber layering under compression
- Inputs: Papyrus plant stems (Cyperus papyrus — grows in shallow freshwater)
- Assembly: Flat stone or wood surface, heavy stone weight, smooth polishing stone
- Conditions: Cut stems lengthwise into thin strips. Lay horizontal layer. Place second set perpendicular on top while wet. Pound with stone mallet. Press under heavy stone 6+ hours. Dry flat. Polish with smooth stone or shell
- Physics: Cell sap acts as natural adhesive. Perpendicular layers create two-directional fiber reinforcement (same principle as plywood)

**Dyed cloth**

- Type: C — mordant complexation
- Inputs: Woven cloth + plant dye (weld for yellow, woad for blue, madder for red, walnut hulls for brown) + alum mordant (KAl(SO₄)₂·12H₂O, from alunite mineral processed with sulfuric acid)
- Assembly: Two clay pots, fire
- Conditions: Mordant bath first — dissolve alum in hot water, simmer cloth 1 hour. Transfer wet cloth to dye bath (simmering, ~80°C) for 1–2 hours. Rinse in cool water
- Physics: Alum forms coordination complexes with both the cloth fiber and the dye chromophore — acts as a molecular bridge locking color to fiber. Without mordant, dye washes out within weeks

---

#### Iron Age

**Wrought iron**

- Type: H — reduction in upgraded bloomery
- Inputs: Hematite (Fe₂O₃) or magnetite (Fe₃O₄) + charcoal (large quantities)
- Assembly: Upgraded bloomery — taller stack (1.0–1.5 m), stronger double-acting bellows, clay tuyere pipe penetrating wall at base, stone or iron anvil, iron hammer
- Conditions: 1200°C in strongly reducing CO atmosphere. Ore + charcoal loaded in alternating layers from top. Bellows run continuously 2–4 hours. Output: "bloom" — spongy iron mass saturated with slag
- Post-processing: Extract bloom while still hot (~1000°C). Hammer on anvil repeatedly while reheating between passes — slag (liquid silicates) squeezes out under hammer blows. Fold and reheat repeatedly until slag is expelled
- Physics: Fe₂O₃ + 3CO → 2Fe + 3CO₂. Iron never melts in a bloomery (solidus 1538°C — too high). It forms as a solid sponge. Hammering expels liquid slag mechanically
- Prerequisite: Upgraded bloomery, large charcoal supply, anvil (stone first, then iron), hammer

**Cast iron**

- Type: H — high-carbon smelting
- Inputs: Iron ore + charcoal in blast furnace running at high carbon ratio
- Assembly: Blast furnace — taller stack than bloomery (2+ m), multiple bellows or trompe (water-powered air pump), taphole at base
- Conditions: 1150°C with high charcoal loading → iron absorbs 2–4% carbon → melting point drops to ~1150°C → liquid iron flows to base and can be tapped
- Physics: Carbon dissolves into iron crystal lattice in large quantities at high temperature, dramatically lowering the liquidus temperature. Result can be cast into sand or clay molds
- Properties: Hard but brittle — high carbon as cementite creates stress concentration sites. Cannot be cold-worked without cracking

**Pig iron**

- Cast iron tapped from blast furnace and poured into sand molds shaped like rows of small ingots radiating from a central channel (the "piglets" suckling from a "sow"). Intermediate product for steel-making

**Steel (early — cementation)**

- Type: H — carbon diffusion into iron
- Inputs: Wrought iron bars + charcoal + clay for sealing vessel
- Assembly: Clay chest or box packed with charcoal. Wrought iron bars buried in charcoal. Sealed with clay. Placed in sustained furnace
- Conditions: 900–1100°C for 1–14 days (longer = deeper carbon penetration). Carbon from charcoal diffuses into iron surface: 0.2–0.8% C = mild steel; 0.8–2.0% C = high-carbon steel
- Physics: Carbon atoms (small) fit in interstitial sites of iron's BCC crystal lattice. At high temperature, concentration gradient drives diffusion from charcoal surface into iron following Fick's law: depth ∝ √(time × diffusivity)
- Prerequisite: Wrought iron, sustained furnace, charcoal, clay for sealing

**Tempered steel**

- Type: H — quench-temper cycle
- Inputs: High-carbon steel + water or oil quench medium
- Assembly: Fire (forge), quench vessel (clay pot of water or oil barrel nearby)
- Conditions:
  1. Heat steel to orange (~850°C, above austenite transition temperature)
  2. Quench rapidly in water or oil → martensite forms (hard, brittle tetragonal crystal structure)
  3. Reheat to 150–300°C for 30–60 minutes → some martensite converts to tougher phases
- Physics: Rapid quench traps carbon in supersaturated solution → martensite (very hard). Controlled reheating allows partial stress relief and carbide precipitation → balance of hardness and toughness
- Note: Water quench = harder but more brittle. Oil quench = softer but tougher. Different applications need different tradeoffs — the player learns this through results

**Wootz / Damascus steel**

- Type: H — controlled crystallization
- Inputs: High-carbon iron (~1.5% C) + specific trace minerals (vanadium, molybdenum from contaminated ore)
- Assembly: Sealed clay crucible, high-temperature furnace
- Conditions: Melt iron + carbon at 1400°C. Cool slowly and precisely — cementite carbides precipitate in dendritic bands following the flow pattern of the solidifying liquid
- Physics: The visible wavy banding is dendritic carbide precipitation during controlled solidification. Trace vanadium and molybdenum form carbides that nucleate into the characteristic pattern. Modern metallurgists only fully understood this mechanism in 2006
- Discovery: Specific ore composition + specific cooling rate + chance → player discovers unusual banded pattern in metal

**Roman cement (pozzolana)**

- Type: C — hydraulic setting
- Inputs: Quicklime (CaO) + volcanic ash (from volcanic biome) + water + aggregate (crushed pottery, gravel)
- Assembly: Mixing pit
- Conditions: Mix quicklime + volcanic ash (2:1 by weight) + water → paste. Sets in 24 hours, continues hardening for years. Sets and hardens underwater (unlike ordinary lime mortar)
- Physics: Pozzolanic reaction: Ca(OH)₂ + SiO₂ + Al₂O₃ + H₂O → calcium silicate hydrate (CSH gel) + calcium aluminate hydrate — dense, water-resistant. Roman harbors built with this still exist today
- Prerequisite: Lime production, volcanic ash identification (biome-specific — not available everywhere)

**Soap**

- Type: C — saponification
- Inputs: Lye solution (KOH from wood ash + water) + animal fat (tallow, lard, fish oil)
- Assembly: Clay pot, fire
- Conditions: Mix lye + fat at ~3:1 fat:lye ratio. Boil 1–2 hours stirring. Test: drip on cold surface — if it congeals firm, done
- Physics: KOH hydrolyzes ester bonds in fat triglycerides: R-COO-R' + KOH → R-COOK + R'-OH. The resulting fatty acid potassium salt has a hydrophilic head (ionic carboxylate) and hydrophobic tail (long carbon chain) — this is what makes soap emulsify oils in water
- Prerequisite: Lye production, fat rendering (tallow from boiled fatty tissue), fire

**Potash**

- Type: C — leaching and evaporation
- Inputs: Wood ash (hardwood: oak, beech, hickory — higher potassium content)
- Assembly: Ash leaching vessel (clay with holes at base), clay evaporation pot, fire
- Conditions: Pour water through packed wood ash — leachate contains K₂CO₃, KOH, K₂SO₄. Evaporate leachate to dryness → crude potash. Optional: calcine at 1000°C → purer K₂CO₃

**Lye**

- Potash dissolved in water → KOH solution. Concentration test: float a fresh egg — if it sinks, too weak; if it floats about 1 cm above the bottom, correct concentration for soap-making

**Tar**

- Type: H — destructive distillation
- Inputs: Pine wood (best) or hardwood
- Assembly: Sealed clay vessel with exit tube OR sloped stone channel lined with clay above fire, collection pit at low end
- Conditions: 400°C, no oxygen. Heavy phenolic compounds condense and flow out through exit. Lighter compounds escape as smoke
- Prerequisite: Clay vessel or stone-clay channel, fire

**Pitch**

- Tar heated in open vessel at 200°C — light volatile compounds boil off, leaving thick adhesive residue. Waterproofs ship hulls, seals barrel seams, preserves rope

**Tallow**

- Rendered animal fat: chop fatty tissue, boil in water 1–2 hours, skim fat from surface, pour into molds, cool → solid white fat. Used for candles, soap, leather conditioning, metalwork lubrication

**Beeswax**

- Collected honeycomb melted and strained through cloth. No chemical processing. Used for candles, writing tablets (wax tablets), waterproofing, lost-wax casting (cire perdue method for metal casting)

---

#### Medieval / Early Chemistry

**Distilled alcohol (~95% ethanol)**

- Type: H — fractional distillation
- Inputs: Beer or wine (~5–12% ethanol)
- Assembly: Copper or clay still — boiler vessel + coiling condensing tube (copper or clay, long, immersed in cold water barrel) + collection vessel
- Conditions: Heat wine to 78.4°C (ethanol boiling point, below water's 100°C). Ethanol vapor rises first and condenses in cool coil. First fractions contain methanol — discard (toxic, causes blindness)
- Physics: Ethanol-water azeotrope limits distillation to ~95.6% ABV maximum. Further purification requires desiccant drying (quicklime absorbs remaining water)
- Prerequisite: Beer or wine production, copper or clay coil construction, water cooling

**Sulfuric acid (H₂SO₄ — vitriol)**

- Type: H + C — roasting and vapor absorption
- Path A — from iron vitriol: Green vitriol (FeSO₄·7H₂O, from pyrite weathering in wet areas) roasted at 700°C → SO₃ gas + iron oxide. SO₃ bubbled through water → H₂SO₄
- Path B — from sulfur: Burn sulfur → SO₂. Mix with steam over iron catalyst → SO₃ → H₂SO₄ (lead chamber process)
- Assembly: Lead-lined chamber (acid resists lead but destroys clay and iron vessels). Lead condensing coil
- Conditions: 300°C for roasting, lead chamber maintained at 60–80°C for absorption
- Game hazard: Highly corrosive — burns through clay vessels, skin, eyes. Lead vessels required. Contact with player character causes severe injury
- Prerequisite: Vitriol mineral identification or sulfur + advanced furnace. Lead vessel construction

**Nitric acid (HNO₃ — aqua fortis)**

- Type: H + C — acid displacement and condensation
- Inputs: Saltpeter (KNO₃) + sulfuric acid (concentrated)
- Assembly: Clay or glass retort, lead or glass condensing tube, lead collection vessel (nitric acid attacks clay)
- Conditions: Mix KNO₃ + hot concentrated H₂SO₄ → KHSO₄ + HNO₃ gas released. Condense in cooled vessel
- Physics: Sulfuric acid has higher boiling point and stronger proton affinity — it displaces nitric acid from its salt
- Prerequisite: Saltpeter (harvested or manufactured), sulfuric acid, glass or lead vessel

**Aqua regia**

- Type: C — oxidizing acid mixture
- Inputs: Nitric acid (1 part) + hydrochloric acid (3 parts) — mixed fresh; decomposes within hours into NOCl + Cl₂
- Assembly: Lead or glass vessel
- Conditions: Mix at room temperature — no heat needed. Generate toxic orange-yellow fumes (nitrogen dioxide, chlorine)
- Physics: NOCl oxidizes gold metal, Cl⁻ ions form stable AuCl₄⁻ complex — this complexation is why gold dissolves despite being chemically inert to all single acids
- Note: The only way in the game to dissolve gold or platinum. Required for gold recovery from mixed ores and for certain chemical processes

**Hydrochloric acid (HCl — spirit of salt)**

- Type: H + C — acid displacement
- Inputs: Halite (NaCl) + sulfuric acid (concentrated)
- Assembly: Clay retort with lead or glass collection vessel (HCl gas absorbed into water in collection vessel)
- Conditions: NaCl + H₂SO₄ → NaHSO₄ + HCl gas. Gentle heat to drive gas off. Dissolve gas in water
- Prerequisite: Salt, sulfuric acid

**Gunpowder**

- Type: C + M — mechanical mixing of reactive components
- Inputs: Saltpeter (KNO₃) 75% + charcoal 15% + sulfur (native) 10% by weight — all ground separately to fine powder first
- Assembly: Separate grinding stones for each component (mixing before grinding = explosion risk). Wet mixing vessel. Corning press (force wet paste through coarse screen to granulate)
- Conditions:
  1. Grind each component separately to fine powder (wet grinding for KNO₃ and S is safer)
  2. Wet-mix in precise mass ratios (balance scale or known weights required)
  3. Corn (granulate): press wet paste through screen. Dry granules. More consistent burn than powder
- Physics: KNO₃ supplies oxygen for the reaction. C and S are fuels. Reaction: 2KNO₃ + S + 3C → K₂S + N₂ + 3CO₂. Gas volume expansion ~5000× in under 1 millisecond = explosion. Power determined by granule size and compression
- Game hazard: Grinding dry mixture near sparks or fire = immediate detonation. Player must keep components separate until wet mixing

**Alum (KAl(SO₄)₂·12H₂O)**

- Type: C — acid dissolution and crystallization
- Inputs: Alunite rock (KAl₃(SO₄)₂(OH)₆) + dilute sulfuric acid OR calcined shale + potash
- Assembly: Clay dissolving vessel, clay crystallization tank
- Conditions: Dissolve alunite in dilute sulfuric acid, boil to concentrate, cool slowly → large alum crystals precipitate. Filter and dry
- Uses: Mordant for dyeing (see dyed cloth), water purification (flocculation), tanning, pickling

**Saltpeter (manufactured — biological process)**

- Type: B — microbial nitrification
- Inputs: Organic nitrogen waste (dung, urine-saturated earth, decaying organic matter) + potash + aerated shelter
- Assembly: Saltpeter bed — layered dung, straw, mortar rubble, soil in a roofed structure open on sides for airflow. Moisten weekly with urine
- Conditions: Nitrifying bacteria (Nitrosomonas, Nitrobacter) oxidize ammonia from organic matter → nitrite → nitrate. With potash present → KNO₃ crystallizes on walls and soil surface. Duration: 12–18 months
- Harvest: Scrape crystalline deposits from walls and soil. Dissolve in water, filter, boil, cool → KNO₃ crystals form
- Historical note: Saltpeter beds were strategic state assets in gunpowder nations. Government "saltpetermen" had legal right to dig up anyone's stable floor

**Plaster of Paris**

- Type: H — partial dehydration
- Inputs: Gypsum (CaSO₄·2H₂O)
- Assembly: Clay vessel or kiln shelf
- Conditions: 150°C for 30–60 minutes → drives off 3/4 of water → CaSO₄·½H₂O. Mix with water → exothermic set in 30–45 minutes → hard solid
- Warning: Above 180°C → anhydrite (CaSO₄) — no longer sets with water. Temperature precision matters here

**Ink (carbon black)**

- Type: M + C — grinding and suspension
- Inputs: Soot (carbon black from oil lamp or pine resin combustion) + gum arabic (resin dissolved from acacia tree) + water
- Assembly: Grinding stone for fine soot particle size, mixing vessel
- Conditions: Grind soot with a small amount of water until uniform. Add gum arabic solution. Mix to smooth paste, dilute to writing viscosity
- Gum arabic prevents soot particles from settling and binds them to parchment or paper on drying

**Paper**

- Type: M — maceration and sheet forming
- Inputs: Linen or cotton rags OR plant fibers (hemp stalks, mulberry bark inner layer)
- Assembly: Water-powered or hand-powered stamping mill for maceration, wooden frame with fine mesh screen, felt blankets for pressing, drying boards
- Conditions:
  1. Soak rags in water several days
  2. Stamp or pound in water until individual cellulose fibers separate (pulp)
  3. Dilute pulp to ~1% concentration in large water tub
  4. Dip screen frame through tub — fibers settle uniformly on mesh
  5. Couch (press) onto felt while still wet. Stack alternating felt-sheet layers. Press under heavy weight to remove water
  6. Dry flat on boards. Size with starch or gelatin to reduce ink absorbency
- Prerequisite: Metal wire mesh screen (fine wire — requires metalworking), old cloth or specific fiber plants

**Stained glass**

- Type: H — colorant fusion into glass
- Inputs: Glass batch (sand + soda ash + lime) + metal oxide colorants: CuO = green, CoO = blue, MnO₂ = purple, SnO₂ = opaque white, FeO = green/amber, Fe₂O₃ = yellow
- Assembly: High-temperature furnace (1400°C), clay crucible, iron blowing pipe
- Conditions: Melt glass batch. Add metal oxide colorant while molten. Gather on blowing pipe. Blow cylinder, slit lengthwise, reheat, flatten on stone — flat colored glass sheet

**White lead pigment (2PbCO₃·Pb(OH)₂)**

- Type: C — vapor corrosion
- Inputs: Lead sheets + acetic acid vapor (from vinegar) + CO₂ (from dung fermentation)
- Assembly: Sealed clay container. Lead sheets suspended above vinegar in lower compartment. Dung packed around outside generates heat and CO₂
- Conditions: 2–4 weeks sealed. Acetic acid vapor + CO₂ attack lead surface → white lead carbonate forms
- Game hazard: Extremely toxic — lead poisoning accumulates silently. Painters who used white lead historically suffered neurological damage and early death

**Prussian blue (Fe₄[Fe(CN)₆]₃)**

- Type: C — precipitation
- Inputs: Iron sulfate solution (FeSO₄, from pyrite weathering) + potassium ferrocyanide (K₄[Fe(CN)₆], made by fusing animal horn + potash + iron filings at high temperature)
- Assembly: Clay mixing vessel
- Conditions: Mix iron sulfate solution + potassium ferrocyanide solution at room temperature → immediate deep blue precipitate. Filter, wash, dry
- Historical note: First synthetic pigment, discovered 1704 in Berlin by accidental contamination of a cochineal red dye batch with iron salts and potash

**White phosphorus (P₄)**

- Type: H — reduction of bone ash
- Inputs: Bone ash (Ca₃(PO₄)₂ — calcined animal bones) + sand (SiO₂) + charcoal
- Assembly: High-temperature sealed clay retort (1200°C), condensing tube, water collection vessel (phosphorus collected UNDER water — it ignites in air spontaneously at 30°C)
- Conditions: Ca₃(PO₄)₂ + 3SiO₂ + 5C → 3CaSiO₃ + P₂ vapor + 5CO. Phosphorus vapor exits tube, condenses under water
- Game hazard: White phosphorus ignites spontaneously in air at body temperature (30°C). Burns continuously — water does not extinguish it. Causes deep tissue burns. Must be stored immersed in water at all times. Extreme handling risk

---

#### Industrial Revolution

**Coke**

- Type: H — coking pyrolysis
- Inputs: Bituminous coal (not lignite — too low volatile content; not anthracite — won't coke properly)
- Assembly: Coking oven (sealed clay or brick chamber) OR beehive coke oven (open-top domed brick, partial air supply from edges)
- Conditions: 1000–1100°C for 12–24 hours. Drives out sulfur, nitrogen, hydrogen, coal tar (volatile fraction). Leaves porous strong carbon sponge
- Physics: Same fundamental process as charcoal but from coal. Coke is stronger than charcoal under load — doesn't crush in blast furnace under weight of iron ore. Higher energy density. Enables industrial-scale iron production charcoal never could
- Prerequisite: Bituminous coal identification, coking oven construction

**Pig iron (blast furnace scale)**

- Type: H — continuous reduction at industrial scale
- Inputs: Iron ore (hematite/magnetite) + coke (fuel + reducing agent) + limestone (CaCO₃ as flux)
- Assembly: Blast furnace — 10–25 m tall stone/brick tower, tuyeres around circumference (bellows or steam-powered air pump), taphole at base, slag notch above taphole
- Conditions: 1500°C at tuyere zone. Ore + coke + limestone loaded from top (continuous feed). Iron ore reduces to iron, absorbs carbon from coke (2–4% C). Limestone combines with silica impurities → liquid slag (lighter, floats above iron). Tap iron every 6–8 hours from taphole. Slag tapped from upper notch
- Continuous process — runs 24/7 for weeks or months without shutting down

**Bessemer steel**

- Type: H + C — oxidative decarburization
- Inputs: Molten pig iron (from blast furnace)
- Assembly: Bessemer converter — pear-shaped iron vessel lined with refractory brick, mounted on pivot trunnions, tuyeres in bottom for compressed air
- Conditions: Pour liquid pig iron (~1300°C). Blow compressed air through bottom tuyeres. Oxygen burns out excess carbon, silicon, manganese (all exothermic — temperature rises to ~1600°C). Watch flame at top: bright orange → red → colorless (carbon burned off). Tilt converter to pour into ladle. Total process: 20 minutes
- Result: 0.1–0.3% carbon steel — enough for structural use. This process converted days (cementation) to 20 minutes

**Portland cement**

- Type: H — clinkering
- Inputs: Limestone (CaCO₃) + clay (Al₂Si₂O₅(OH)₄) in ratio ~4:1 by mass
- Assembly: Rotary kiln (long rotating cylinder, brick-lined, fired at one end) OR vertical shaft kiln for smaller scale
- Conditions: 1450°C clinkering temperature. Limestone decomposes (→ CaO + CO₂). CaO combines with clay minerals (SiO₂, Al₂O₃, Fe₂O₃) → calcium silicates + aluminates + aluminoferrite (clinker minerals). Grind cooled clinker + ~5% gypsum → fine gray powder
- Physics: When mixed with water, CSH gel and ettringite crystals grow and interlock within hours → hydraulic hardening. Continues gaining strength for years

**Reinforced concrete**

- Type: M — composite assembly
- Inputs: Portland cement + sand + gravel + water (concrete) + iron or steel bars (rebar), deformed surface for bond
- Assembly: Wooden formwork molds. Steel rebar placed and tied within mold. Concrete mixed and poured around it
- Physics: Concrete strong in compression, weak in tension (fails at ~10% of compressive strength). Steel strong in tension, weak in buckling. Together: concrete surrounds steel (protecting from corrosion and buckling), steel handles tensile loads. Bond between them comes from surface friction, deformations in rebar, and cement gel adhesion

**Vulcanized rubber**

- Type: H + C — sulfur crosslinking
- Inputs: Natural rubber latex (Hevea brasiliensis, tropical tree — tap bark, collect white sap) + sulfur powder (5–30%)
- Assembly: Clay vessel or rubber milling rollers (iron cylinders pressed together), vulcanizing press or oven
- Conditions: Mix rubber + sulfur. Heat at 150°C for 30–60 minutes
- Physics: Sulfur forms disulfide bridges (-S-S-) between polyisoprene chains. Without crosslinks, rubber flows at warm temperatures (thermoplastic). Crosslinks make it elastic (thermoset) — stretches and recovers. Sulfur % controls properties: 3% = soft rubber, 30% = hard rubber (ebonite)
- Prerequisite: Rubber tree cultivation (tropical biome), sulfur source

**Chlorine gas (Cl₂)**

- Type: E — electrolysis of brine
- Inputs: Saltwater brine (NaCl saturated solution) + electrical current
- Assembly: Electrolysis cell with carbon or platinum electrodes
- Conditions: DC current through brine. Cl⁻ oxidized at anode → Cl₂ gas. Na⁺ migrates to cathode, forms NaOH in solution. H₂ released at cathode
- Game hazard: Cl₂ is a dense yellow-green toxic gas — heavier than air, settles in low areas. Causes severe respiratory damage. First used as chemical weapon in WWI

**Sodium hydroxide (NaOH — caustic soda)**

- Byproduct of chlorine electrolysis. Same cell simultaneously produces NaOH solution. Evaporate → NaOH flakes
- Uses: Soap, paper making, drain cleaner, aluminum production (Bayer process)

**Ammonia (Haber-Bosch process)**

- Type: H + C + E — catalytic synthesis under pressure
- Inputs: Nitrogen (N₂, from air — requires liquefaction at -196°C OR from ammonia decomposition cycle) + hydrogen (H₂, from steam reforming: CH₄ + H₂O → CO + 3H₂, then CO + H₂O → CO₂ + H₂)
- Assembly: High-pressure reactor vessel (200 atm rated — requires advanced steel and precision machining), hydrogen production unit (steam reformer or electrolysis), nitrogen separation unit, refrigeration for ammonia condensation
- Conditions: 450°C + 200 atm + iron catalyst (Fe with K₂O and Al₂O₃ promoters). N₂ + 3H₂ → 2NH₃. Only ~15% conversion per pass — unreacted gases recycled
- Historical note: Before Haber (1909), all fixed nitrogen for agriculture came from guano, saltpeter mines, or legume crops. Synthetic ammonia enabled synthetic fertilizer — currently sustains ~50% of the world's population
- Scale: Industrial civilization only. Requires precision pressure vessels, compressors, continuous operation, steel infrastructure

**Synthetic fertilizer (ammonium nitrate / ammonium sulfate)**

- Type: C — acid-base neutralization
- Inputs: Ammonia (NH₃) + nitric acid (HNO₃) → ammonium nitrate (NH₄NO₃) OR ammonia + sulfuric acid → ammonium sulfate
- Assembly: Reaction vessels, evaporators, prilling tower (ammonium nitrate: spray molten droplets downward in cool air tower → form round pellets)
- Note: NH₄NO₃ is a high explosive when detonated — same material used in fertilizer bombs. Dual-use material in the game

**Kerosene**

- Type: H — fractional distillation
- Inputs: Crude petroleum oil
- Assembly: Distillation column — tall copper or iron tower with bubble-cap trays at different heights, heated at base
- Conditions: Crude petroleum heated. Vapors rise, condense at different heights based on boiling point. Kerosene (C₁₀–C₁₆ hydrocarbons) condenses at 150–300°C fraction level, drawn from side port
- Prerequisite: Petroleum discovery and drilling, distillation apparatus (tall copper column), fuel source for heating

**Gasoline**

- Same fractional distillation apparatus. Lighter fraction (35–200°C, C₅–C₁₂) taken from higher point in column
- Historical note: Early petroleum refiners discarded gasoline as dangerous waste. It only became the most valuable fraction once the internal combustion engine existed

**Asphalt / bitumen**

- Residue from petroleum distillation after all lighter fractions removed (>500°C residue). Also occurs naturally at surface petroleum seeps. Road paving, waterproofing, roofing

**Dynamite**

- Type: C — stabilized explosive
- Step 1 — Nitroglycerin: Glycerol + concentrated nitric acid + concentrated sulfuric acid in ice-cooled vessel (<10°C). Extremely exothermic — temperature spike = detonation. Nitroglycerine forms as oily liquid (density separates from acid layer). Wash carefully with sodium carbonate solution to remove acid
- Step 2 — Dynamite: Absorb nitroglycerin (3 parts) into kieselguhr diatomaceous earth (1 part). Press into paper cylinders. Insert detonator cavity
- Physics: Kieselguhr absorbs nitroglycerin into its porous structure — renders it stable to shock and friction. Only detonates when blasting cap fires (shock wave triggers rapid decomposition)
- Game hazard: Nitroglycerin step is lethal if temperature exceeds threshold during mixing. Player must actively maintain cooling. This is a real interaction — the game checks ambient temperature + player proximity + mixing speed

**TNT (trinitrotoluene)**

- Type: C — three-stage nitration
- Inputs: Toluene (C₇H₈, from coal tar distillation fraction or petroleum reforming) + mixed acid (concentrated HNO₃ + H₂SO₄)
- Assembly: Three sequential nitration vessels (glass or lead-lined), temperature-controlled water baths, washing tanks, crystallization tanks
- Conditions: Three successive nitration stages, each using progressively stronger mixed acid. Mono → di → trinitrotoluene. Wash each stage. Final TNT crystallizes from hot solution on cooling to pale yellow crystals
- Unlike nitroglycerin: TNT does NOT detonate on impact. Requires a detonator (blasting cap firing a primary explosive). Safe to handle, machine, and melt-load into shells

**Aniline dyes**

- Type: C — oxidative polymerization / dye synthesis
- Inputs: Aniline (C₆H₅NH₂, from coal tar distillation or nitrobenzene reduction) + oxidizing agent (chromic acid, ferric chloride, or peroxide)
- Assembly: Chemical reaction vessels, filtration apparatus, crystallization tanks
- Historical note: Perkin accidentally synthesized mauveine (first synthetic dye) in 1856 while attempting to synthesize quinine from coal tar. Spawned the entire synthetic chemical dye industry and eventually pharmaceutical chemistry

**Stainless steel**

- Type: H — alloying in electric arc furnace
- Inputs: Iron scrap + chromite (FeCr₂O₄, for chromium) + pentlandite (for nickel) — or ferrochrome and ferronickel as intermediate alloys
- Assembly: Electric arc furnace (EAF) — steel shell, carbon electrodes, high electrical current (no coke needed)
- Conditions: Arc furnace melts iron scrap. Add ferrochrome (13–25% Cr target) and ferronickel (8–10% Ni for austenitic grades). Argon-oxygen decarburization (AOD) removes carbon while retaining chromium
- Physics: Chromium content above ~11% causes Cr₂O₃ passivation layer to form spontaneously on the steel surface — this nanometer-thick oxide prevents oxygen reaching the iron underneath → no rust

---

#### Electrical Age

**Aluminum (Hall-Héroult electrolysis)**

- Type: E — electrolytic reduction
- Full chain from bauxite:
  1. Bayer process: Bauxite + hot NaOH solution → sodium aluminate solution. Filter out iron oxide red mud. Cool → Al(OH)₃ precipitates. Calcine at 1000°C → Al₂O₃ (alumina powder)
  2. Hall-Héroult: Dissolve Al₂O₃ in molten cryolite (Na₃AlF₆) at 960°C in carbon-lined steel cell. Apply 5V DC at 100,000–300,000 A. Al³⁺ reduced at carbon cathode → liquid aluminum pools at bottom (tapped every few hours). O²⁻ oxidizes carbon anode → CO₂ (anode consumed at ~0.5 kg C per kg Al)
- Scale: Industrial — even a small pot requires >100 kW continuous electrical power
- Historical note: Before 1886, aluminum was more expensive than gold. Napoleon III reserved aluminum cutlery for honored guests; lesser guests used gold and silver

**Copper wire (drawn)**

- Type: M — progressive wire drawing
- Inputs: Cast copper rod (from smelted copper, cast in rod molds)
- Assembly: Draw plate (hardened iron or steel plate with series of progressively smaller tapered holes), draw bench (lever or winch for pulling force), annealing furnace
- Conditions: Lubricate rod with tallow or beeswax. Pull through successively smaller holes — each pass reduces cross-section ~10–15%. After every 3–5 passes, anneal (heat to 400°C, cool slowly) to restore ductility. Continue until final diameter
- Physics: Each drawing pass work-hardens the copper (dislocation density increases → harder, less ductile). Annealing recrystallizes the grain structure, eliminating dislocations → restores ductility for next series of draws

**Galvanized steel**

- Type: H — hot-dip zinc coating
- Inputs: Steel sheet or wire + zinc (from sphalerite roasting and reduction) + zinc chloride flux
- Assembly: Acid pickling tank (dilute H₂SO₄ removes oxide scale), flux tank (ZnCl₂ solution), molten zinc bath (steel vessel, 450°C)
- Conditions: Clean steel, flux, dip in molten zinc, withdraw at controlled speed, cool. Zinc-iron intermetallic layers form at interface during dipping
- Physics: Zinc corrodes sacrificially — it has lower reduction potential than iron. Even where the coating is scratched, zinc surrounding the scratch electrochemically protects the exposed iron (galvanic protection)

**Electroplated gold / silver**

- Type: E — electrodeposition
- Inputs: Metal object to plate + gold or silver salt solution (gold chloride or silver nitrate) + DC current source
- Assembly: Electrolysis vessel (lead or glass), two electrodes
- Conditions: Object connected as cathode (negative). Gold/silver anode slowly dissolves into solution. Metal ions deposit on cathode surface. Plating thickness controlled by current × time
- Result: Very thin, even metallic coating — jewelry, electrical contacts, mirrors

**Silicon (semiconductor grade)**

- Type: H + C — multi-stage purification and crystal growth
- Full chain:
  1. Quartz + coke → metallurgical Si (electric arc furnace, 2000°C, 98% pure)
  2. Si + 3HCl → SiHCl₃ (trichlorosilane gas, 300°C)
  3. Fractional distillation of SiHCl₃ through multiple columns — removes boron (ppb level), phosphorus, metals
  4. SiHCl₃ + H₂ → pure Si + 3HCl (Siemens reactor, 1100°C, deposition on hot silicon rod) → polysilicon (99.9999999%)
  5. Czochralski crystal growth: melt polysilicon in quartz crucible at 1415°C + dopant (B for p-type, P for n-type). Dip seed crystal. Rotate and slowly withdraw (1 mm/min) → single crystal ingot up to 300mm diameter
  6. Diamond wire saw into 700–900 μm wafers. Chemical-mechanical polish to atomic flatness
- Scale: Industrial only. Requires Class 1 cleanroom, ultra-pure chemicals, precision temperature control

**Tungsten filament**

- Type: H + M — powder metallurgy route (tungsten cannot be melted conventionally)
- Inputs: Wolframite (FeWO₄) or scheelite (CaWO₄) → WO₃ (calcine in air) → H₂ reduction at 900°C → tungsten metal powder → sinter + forge + swage + draw
- Assembly: H₂ reduction furnace, hydraulic press and sinter furnace, rotary swaging machine, wire drawing dies
- Conditions: Sinter at 2000°C in H₂ → dense tungsten bar. Hot forge at 1500°C. Swage to reduce diameter. Draw through diamond dies. Anneal between passes (tungsten is brittle — must be worked hot)
- Physics: Tungsten melts at 3422°C — highest melting point of any element. Cannot be cast or melted in any conventional furnace. Powder metallurgy (press + sinter) is the only practical processing route

**Nichrome (Ni 80% + Cr 20%)**

- Type: H — alloying
- Inputs: Nickel (from pentlandite smelting) + chromium (from chromite reduction)
- Assembly: Electric arc furnace or induction furnace
- Conditions: Melt nickel, add chromium to target composition. Cast to rod, draw to wire using same process as copper wire but at higher temperatures (nichrome work-hardens more)
- Properties: High electrical resistivity (1.1 μΩ·m — 66× more resistive than copper), oxidation resistance at 1200°C → toasters, furnace elements, resistance wire

**Lead-acid battery**

- Type: C — electrochemical cell assembly
- Inputs: Lead plates + lead dioxide (PbO₂, made by anodizing lead in dilute H₂SO₄) + sulfuric acid electrolyte (37% concentration) + rubber or wood separators
- Assembly: Alternate lead and lead dioxide plates with separators. Immerse in sulfuric acid in sealed lead-lined container
- Conditions: Formation charge required (first charge cycle establishes electrode structure). Discharge: Pb + PbO₂ + 2H₂SO₄ → 2PbSO₄ + 2H₂O. Recharge by reversing reaction with external current
- Prerequisite: Lead, lead dioxide synthesis (electrochemical), sulfuric acid, separator material (rubber requires vulcanization)

---

#### Chemical / Polymer Age

**Bakelite**

- Type: H + C — condensation polymerization
- Inputs: Phenol (from coal tar distillation, 210°C fraction) + formaldehyde (from methanol oxidation, or from formic acid dehydration)
- Assembly: Reaction vessel with temperature control + reflux condenser, compression mold press
- Conditions: Mix phenol + formaldehyde with acid or base catalyst. Heat to 80–100°C → resole resin (still fusible). Pour into mold. Heat under pressure at 150°C → fully 3D-crosslinked thermoset (cannot be remelted)
- Physics: Phenol groups react with formaldehyde to form methylene bridges (CH₂) linking phenol rings into a rigid 3D network. First fully synthetic polymer (1907)

**Nylon (nylon-6,6)**

- Type: H + C — condensation polymerization
- Inputs: Hexamethylenediamine (H₂N(CH₂)₆NH₂) + adipic acid (HOOC(CH₂)₄COOH) — both from petroleum-derived cyclohexane/benzene
- Assembly: Stainless steel reaction vessel, spinneret (metal plate with calibrated holes), draw frame
- Conditions: Mix equimolar diamine + diacid in water → "nylon salt" precipitates. Heat to 280°C under pressure → water eliminated, amide bonds form (polyamide). Melt spin through spinneret. Draw fibers 4× length → chains align → high tensile strength

**Polyethylene (PE)**

- Type: C — addition polymerization
- Inputs: Ethylene gas (CH₂=CH₂, from petroleum cracking or ethanol dehydration at 350°C over alumina) + Ziegler-Natta catalyst (TiCl₄ + triethylaluminum)
- Assembly: Pressurized reactor vessel
- Conditions: Low pressure (1–50 atm) + catalyst → HDPE (linear, dense, rigid). High pressure (100–300 atm) + radical initiator (no catalyst) → LDPE (branched, flexible)

**PVC (polyvinyl chloride)**

- Type: C — radical polymerization
- Inputs: Vinyl chloride monomer (CH₂=CHCl, from ethylene + Cl₂ → EDC → cracking at 500°C → VCM) + peroxide initiator
- Assembly: Suspension polymerization reactor (pressurized, stirred), degassing vessel
- Conditions: VCM + water + initiator + suspending agent. 50–60°C, 5–10 atm. Radical polymerization → PVC suspension (white powder)

**Teflon (PTFE)**

- Type: C — radical polymerization
- Inputs: Tetrafluoroethylene (TFE, CF₂=CF₂, from chloroform + HF → HCFC-22 → pyrolysis at 600°C → TFE) + radical initiator
- Assembly: Pressure reactor (TFE is a flammable explosive gas)
- Conditions: Aqueous emulsion or suspension polymerization at 50°C, 7–14 atm
- Physics: The C-F bond (544 kJ/mol) is the strongest single bond in organic chemistry. PTFE has the lowest surface energy of any known solid — van der Waals interactions so weak nothing adheres. Chemically inert to aqua regia, fuming sulfuric acid, virtually everything

**Synthetic rubber (SBR)**

- Type: C — emulsion copolymerization
- Inputs: Styrene (from petroleum benzene + ethylene) + butadiene (from petroleum C₄ cracking fraction) + soap + potassium persulfate initiator
- Assembly: Emulsion polymerization reactor (stirred, temperature-controlled)
- Conditions: 50°C, 8–10 hours. Styrene + butadiene copolymerize in water emulsion → latex. Coagulate with salt/acid. Dry → SBR bale

**Neoprene (polychloroprene)**

- Type: C — emulsion polymerization
- Inputs: Chloroprene (CH₂=CCl-CH=CH₂, from acetylene + HCl or butadiene + Cl₂)
- Conditions: Emulsion polymerization at 40°C → polychloroprene latex → coagulate → dry
- Properties: Oil, ozone, and flame resistant — wetsuits, gaskets, industrial hose

**Epoxy**

- Type: C — two-part crosslinking (epoxide ring opening)
- Part A: Bisphenol-A + epichlorohydrin + NaOH → diglycidyl ether of bisphenol-A (DGEBA)
- Part B: Amine hardener (diethylenetriamine or similar)
- Conditions: Mix A + B in correct stoichiometric ratio. Amine nitrogen attacks and opens epoxide rings → covalent C-N bonds form. Exothermic at room temperature — sets in 30 minutes to 24 hours depending on temperature and hardener

**Acrylic (PMMA — polymethyl methacrylate)**

- Type: C — radical polymerization
- Inputs: Methyl methacrylate monomer (MMA, from acetone + HCN → acetone cyanohydrin → methacrylamide → MMA via acid catalyst + methanol)
- Assembly: Polymerization mold (glass plates with gasket), UV lamp or thermal oven
- Conditions: Add benzoyl peroxide initiator to MMA. Pour between glass plates. UV or 60°C curing → cast PMMA sheet. Alternatively: suspension polymerization → PMMA beads → melt process

**Synthetic fertilizer (urea)**

- Type: H + C — from ammonia and CO₂
- Inputs: Ammonia (NH₃) + carbon dioxide (CO₂, from steam reforming exhaust)
- Assembly: Pressure reactor (150 atm), evaporators, prilling tower
- Conditions: 2NH₃ + CO₂ → NH₄OCONH₂ (ammonium carbamate) at 180°C + 150 atm. Decompose carbamate → CO(NH₂)₂ (urea) + H₂O. Evaporate. Melt and prill
- Note: 50% of all food production currently depends on urea fertilizer — nitrogen source for protein synthesis in crops

**Penicillin**

- Type: B + C — fungal fermentation then chemical extraction
- Inputs: Penicillium chrysogenum mold (found on rotting citrus, stale bread, damp environments) + corn steep liquor (nutrient medium from corn wet milling) + phenylacetic acid (precursor) + organic solvent (butyl acetate) + potassium acetate
- Assembly: Fermentation tank (sealed, airtight, with sterile air sparging, stirring, pH and temperature control), centrifuge or filter press, extraction vessel
- Conditions:
  1. Inoculate sterile nutrient medium with Penicillium at 25°C, aerobic, pH 6.5–7.5, sterile conditions. Ferment 7–10 days
  2. Filter off mold. Lower pH to 2 → penicillin becomes lipophilic, partitions into organic solvent
  3. Re-extract into aqueous potassium acetate at pH 7. Freeze-dry or crystallize
- Discovery path: Player finds green-blue mold growing near bacteria colony → notices bacteria dying in vicinity → isolates and experiments with mold extract → develops crude extraction
- Scale: Crude production achievable in clay fermentation pots. Pharmaceutical purity requires industrial sterile equipment

**DDT (dichlorodiphenyltrichloroethane)**

- Type: C — condensation reaction
- Inputs: Chlorobenzene + chloral (trichloroacetaldehyde, from acetaldehyde + Cl₂) + sulfuric acid catalyst
- Assembly: Chemical reaction vessel with cooling, mixing
- Conditions: Mix chlorobenzene + chloral in concentrated H₂SO₄ at 15–25°C → DDT precipitates
- Game ecology note: DDT accumulates through food chains (biomagnification). Game organisms that eat DDT-contaminated food accumulate it — predators at top of food chain (raptors, large fish) accumulate lethal concentrations. This should be a visible, measurable ecological consequence in the organism simulation

---

#### Nuclear Age

**Enriched uranium**

- Type: E + M — isotope separation (centrifuge cascade)
- Full chain: Uranium ore → yellowcake (U₃O₈) via acid leaching + precipitation → UO₃ → UO₂ → UF₄ (via HF) → UF₆ (via fluorine gas)
- Assembly: Gas centrifuge cascade (thousands of individual centrifuges in series and parallel stages)
- Conditions: Natural uranium: 0.72% U-235 (fissile), 99.28% U-238. Each centrifuge enriches slightly (separation factor ~1.05 per stage). Power reactor fuel needs 3–5% U-235 → requires ~1000 stages. Weapon grade (>90%) requires ~3000+ stages
- Scale: Nation-state infrastructure. One enrichment plant consumes gigawatts of electricity

**Plutonium-239**

- Type: Nuclear — neutron capture in operating reactor
- Inputs: Uranium-238 fuel in nuclear reactor + sustained fission chain reaction
- Conditions: U-238 absorbs a neutron → U-239 → beta-decays (23 min half-life) → Np-239 → beta-decays (2.4 day half-life) → Pu-239
- No other pathway to plutonium exists — requires a working nuclear reactor as the source

**Heavy water (D₂O)**

- Type: E — electrolysis concentration cascade
- Inputs: Normal water (D:H natural ratio = 1:6400)
- Assembly: Multi-stage electrolysis plant (hundreds of cells in series). Water electrolyzed: H₂ and O₂ released — deuterium concentrates slightly in remaining water each stage
- Conditions: Electrolysis kinetic isotope effect: H₂ electrolyzed ~6.3× faster than D₂ → deuterium enriches in residual water. Hundreds of stages → D₂O

**Nuclear-grade graphite**

- Type: H — ultra-high-purity graphitization
- Inputs: Petroleum coke (very low sulfur grade) → graphitization at 2800°C in Acheson electric furnace → purification in chlorine gas at 2500°C (removes boron, which absorbs neutrons)
- Conditions: Must achieve <1 ppm boron (boron cross-section for neutron absorption is enormous — even 2 ppm boron can prevent a sustained chain reaction from operating)

**Uranium hexafluoride (UF₆)**

- Type: C — fluorination
- Inputs: UO₂ (reduced uranium oxide) + fluorine gas (F₂, from electrolysis of HF in KF)
- Conditions: UO₂ + 3F₂ → UF₆ at 300°C. UF₆ is a volatile corrosive solid (sublimes at 56°C) — centrifuge feedstock
- Game hazard: UF₆ reacts with moisture in air → HF (hydrofluoric acid, extremely corrosive, penetrates skin, causes systemic fluoride poisoning) + uranyl fluoride. Catastrophic if containment fails

**Zircaloy (nuclear fuel rod cladding)**

- Type: H — alloying with hafnium-free zirconium
- Inputs: Zircon (ZrSiO₄) → zirconia (ZrO₂) → zirconium tetrachloride → reduction with magnesium → sponge zirconium. Critically: hafnium (chemically identical to zirconium, always found together in zircon) must be completely removed — hafnium absorbs neutrons aggressively
- Assembly: Arc melting furnace, hot rolling, tube extrusion
- Conditions: Zr-Sn alloy (Zircaloy-2/4). Near-zero neutron absorption cross-section is the critical property — enables nuclear reaction without absorbing neutrons meant to sustain the chain

**Tritium (H-3)**

- Type: Nuclear — neutron bombardment
- Inputs: Lithium-6 (⁶Li) + neutrons from operating nuclear reactor
- Conditions: ⁶Li + neutron → ⁴He + ³H (tritium). Lithium-6 is loaded in targets inside a reactor. Tritium recovered by gas extraction. Half-life: 12.3 years — must be continuously produced for fusion weapons and fusion reactors

---

#### Silicon / Digital Age

**Silicon wafer**

- Type: H + C + M — multi-stage purification, crystal growth, precision cutting
- Full chain from sand to wafer:
  1. Quartz + coke → metallurgical-grade Si (electric arc furnace, 2000°C) — 98% pure
  2. Si + 3HCl → SiHCl₃ (trichlorosilane, 300°C, fluidized bed reactor)
  3. SiHCl₃ fractionally distilled through tall columns — removes boron, phosphorus, all metals to ppb level
  4. SiHCl₃ + H₂ → ultra-pure Si deposited on hot silicon rod (Siemens reactor, 1100°C rod, 1050°C gas) → polysilicon rods (99.9999999% pure — "nine nines")
  5. Czochralski growth: melt polysilicon in quartz crucible at 1415°C. Add precise dopant (B for p-type, P for n-type). Dip seed crystal. Rotate 10 rpm, withdraw at 1 mm/min → single crystal ingot 300 mm diameter, 2 m long
  6. Diamond wire saw into 775 μm wafers. Chemical-mechanical polish (CMP) to atomic flatness (<0.1 nm roughness)
- Scale: Industrial only. Requires Class 1 cleanroom (less than 1 particle >0.5 μm per cubic foot of air)

**Germanium (semiconductor)**

- Type: H + C — zone refining
- Inputs: Zinc or coal deposits (germanium concentrated there) → GeO₂ → H₂ reduction → Ge metal → zone refining
- Assembly: Zone refining furnace (narrow molten zone moved slowly along rod — impurities concentrate in melt and migrate to one end)
- Historical note: First transistor material (1947). Now mainly replaced by silicon, except for infrared optics and fiber optic amplifiers

**Gallium arsenide (GaAs)**

- Type: H — compound semiconductor synthesis
- Inputs: Gallium metal (trace in bauxite/zinc ores, recovered from Bayer process filtrate) + arsenic (from arsenopyrite, volatile at 615°C)
- Assembly: Sealed quartz ampoule, synthesis furnace
- Conditions: Gallium + arsenic vapor sealed in quartz, heated to 1238°C → GaAs compound synthesizes. Crystal grown by Bridgman or liquid encapsulated Czochralski method
- Properties: 2× faster electron mobility than silicon → faster transistors, efficient LEDs and laser diodes

**Indium tin oxide (ITO — touchscreen coating)**

- Type: H — physical vapor deposition (sputtering)
- Inputs: Indium (recovered from zinc smelting flue dust) + tin oxide (SnO₂) sintered target material
- Assembly: Vacuum sputtering system (magnetron sputter target, vacuum chamber at 10⁻⁶ torr)
- Conditions: Argon plasma bombardment sputters ITO atoms from target. Atoms deposit on glass substrate as transparent, electrically conductive film (10–200 nm thick)
- Properties: Simultaneously transparent (>90% visible light transmission) and electrically conductive — makes touchscreens and LCDs possible

**Silicon photovoltaic cell**

- Type: H + C + E — semiconductor doping and junction formation
- Inputs: Silicon wafer + boron dopant (p-type substrate) + phosphorus (n-type surface layer) + silver or aluminum electrical contacts + anti-reflection coating (silicon nitride)
- Assembly: Diffusion furnace (phosphorus diffusion from POCl₃ vapor at 850°C), screen printer (silver paste contacts), sintering furnace, PECVD for anti-reflection layer
- Conditions: Create p-n junction at wafer surface. Anti-reflection coating reduces reflection from 30% to 3%. Silver contacts fire through nitride layer at 800°C in 2 seconds (rapid thermal process)
- Physics: Photons above bandgap energy (~1.1 eV for Si) create electron-hole pairs. Built-in electric field at p-n junction separates them → current flows

**Optical fiber**

- Type: H + C — chemical vapor deposition then fiber drawing
- Inputs: SiCl₄ + GeCl₄ (for germanium-doped core, higher refractive index) + O₂ → SiO₂ + GeO₂ (core glass) / pure SiO₂ (cladding)
- Assembly: CVD torch deposits glass layers inside silica tube (MCVD method) building up preform. Preform drawn in tower: 30 m tall, 2200°C draw furnace at top, fiber drawn at 20 m/s, UV-cured coating applied immediately
- Conditions: Core must contain <1 ppb iron (iron absorbs light → attenuation). Draw at precisely controlled speed and tension → 125 μm diameter, uniform. Coat immediately to protect surface from moisture-induced strength degradation
- Physics: Total internal reflection at core-cladding interface (higher core refractive index) traps light. Attenuation <0.2 dB/km at 1550 nm → light travels 100 km before halving in power

**Lithium-ion battery**

- Type: C + H — electrode synthesis and cell assembly
- Inputs: Lithium cobalt oxide cathode (LiCoO₂, from Li₂CO₃ + Co₃O₄ calcined at 800°C) + graphite anode (petroleum coke graphitized at 3000°C) + electrolyte (LiPF₆ in ethylene carbonate/dimethyl carbonate) + polyethylene separator
- Assembly: Coat cathode and anode slurries onto aluminum/copper foil current collectors. Dry in vacuum oven. Slit, stack or wind with separator. Insert in can. Fill with electrolyte in dry room (<1% RH). Seal. Formation charge cycle
- Conditions: Assembly must occur in dry room — LiPF₆ hydrolyzes in moisture → HF (destroys cell). Formation charge: first charge establishes SEI (solid electrolyte interphase) layer on graphite — critical for long cycle life
- Physics: Intercalation chemistry — Li⁺ ions insert between graphite layers during charge, extract during discharge. No metallic lithium deposited (safer than Li-metal batteries)

**Carbon fiber**

- Type: H — controlled thermal decomposition
- Inputs: Polyacrylonitrile (PAN) fiber as precursor (from acrylonitrile polymerization → wet or dry-jet wet spinning into fibers)
- Assembly: Stabilization oven (air atmosphere, 200–300°C), carbonization furnace (N₂ atmosphere, 1000–1500°C), optional graphitization furnace (2500°C), surface treatment and sizing application
- Conditions:
  1. Stabilize PAN under tension in air at 200–300°C for 30–120 minutes — ladder polymer forms, preventing melting
  2. Carbonize in N₂ at 1000–1500°C — removes N, H, O leaving turbostratic carbon network
  3. Optional graphitize at 2500°C → more ordered graphene planes → higher modulus (stiffness)
- Properties: Tensile strength 3500–7000 MPa (steel: 400–2000 MPa), density 1.8 g/cm³ (steel: 7.8 g/cm³) — strongest-by-weight structural material practical at scale

**Kevlar (para-aramid)**

- Type: C + M — solution polymerization and dry-jet wet spinning
- Inputs: Para-phenylenediamine (PPD) + terephthaloyl dichloride (TDC) — both from petroleum-derived benzene + reactions
- Assembly: Anhydrous reaction vessel (moisture destroys acid chloride reactant), dry-jet wet spinneret, coagulation bath, drawing frame
- Conditions: Polymerize in sulfuric acid solvent (forms lyotropic liquid crystal solution — chains self-align). Extrude through air gap into water bath → fibers precipitate. Draw while gelled → chains remain aligned in fiber direction → high tensile strength
- Properties: 5× stronger than steel by weight. Used for body armor, cut-resistant gloves, reinforced composites

**OLED material**

- Type: C + H — organic semiconductor synthesis and vacuum deposition
- Inputs: Small-molecule organic semiconductors (complex aromatic and heteroaromatic compounds synthesized from petroleum precursors via multi-step organic chemistry)
- Assembly: Molecular vapor deposition system (ultra-high vacuum, 10⁻⁸ torr, thermal evaporation cells)
- Conditions: Organic molecules evaporate from heated crucibles in vacuum. Deposit in layers angstroms thick on substrate. Each layer (hole injection, hole transport, emissive, electron transport, electron injection) deposited separately without breaking vacuum
- Physics: When current applied, holes and electrons meet in emissive layer → form excitons → emit light. Color determined by molecular structure (bandgap)

---

#### Advanced / Emerging

**Graphene**

- Type: M OR H+C — mechanical exfoliation or CVD
- Method A (mechanical): Highly ordered pyrolytic graphite (HOPG) + adhesive tape. Repeatedly peel tape → thinner flakes. Deposit on 90 nm SiO₂ substrate → graphene visible optically by interference color. Nobel Prize 2010
- Method B (chemical vapor deposition): Copper foil substrate in quartz tube furnace. Reduce Cu surface in H₂ (1000°C). Flow CH₄ + H₂ — methane cracks, carbon adsorbs and forms graphene monolayer on Cu. Cool. Transfer: coat with PMMA, etch Cu in iron(III) chloride solution, place on target substrate, dissolve PMMA
- Discovery path: Method A is achievable in game with graphite (Tier 2) + tape-equivalent. Method B requires CVD furnace + gas flow control + vacuum

**Aerogel (silica)**

- Type: C + H — sol-gel synthesis and supercritical drying
- Inputs: Tetraethyl orthosilicate (TEOS, Si(OC₂H₅)₄, from silicon tetrachloride + ethanol) + water + ethanol + acid or base catalyst
- Assembly: Gel casting molds, autoclave rated for supercritical CO₂ (304 bar, 50°C)
- Conditions:
  1. TEOS + water + catalyst → silica gel (3D SiO₂ network, pores filled with solvent)
  2. Solvent exchange: replace ethanol with liquid CO₂ in autoclave
  3. Heat above CO₂ critical point (31°C, 74 bar). Vent slowly → CO₂ exits as supercritical fluid → gas without passing through liquid phase
  4. Surface tension never develops → gel structure never collapses
- Result: 99.8% air by volume, density 1.9 kg/m³ (just above air), thermal conductivity 0.015 W/m·K (below still air)

**Nitinol (shape-memory alloy)**

- Type: H — vacuum arc melting + shape-memory programming
- Inputs: Nickel (50.8 atomic%) + titanium (49.2 atomic%) — ratio must be precise to ±0.1 at% (shifts transformation temperature by ~10°C per 0.1%)
- Assembly: Vacuum arc furnace (titanium reacts violently with air and water), cold rolling mill, annealing oven, constraint fixture
- Conditions: Melt in vacuum → cast. Cold work to desired wire/tube form. Constrain in desired final shape. Anneal at 500°C for 30 minutes → shape memory programmed into high-temperature austenite phase. Cool below transformation temperature → martensitic phase (soft, easily deformed). Deform freely. Heat above transition → returns to programmed shape

**YBCO superconductor (YBa₂Cu₃O₇)**

- Type: H — solid-state synthesis and oxygen annealing
- Inputs: Yttrium oxide (Y₂O₃) + barium carbonate (BaCO₃) + copper oxide (CuO) in molar ratio 1:4:6
- Assembly: High-temperature tube furnace (1000°C), oxygen supply, slow cooling apparatus
- Conditions: Mix oxides/carbonates. Calcine at 900°C to react components. Grind and press into pellet. Sinter at 1000°C in flowing oxygen. Cool slowly to 500°C in oxygen (critical — oxygen content determines superconducting properties). Rapid cool below 93K → superconducting state
- Physics: Superconducts below 93K (-180°C) — first high-temperature superconductor above liquid nitrogen boiling point (77K). Enables practical superconducting applications without liquid helium

**Metamaterial (electromagnetic)**

- Type: H + M + E — nanofabrication
- Inputs: Gold, silver, or titanium nitride nanostructures on substrate. Structure size must be smaller than wavelength of light (< 400 nm for visible light)
- Assembly: Electron beam lithography system (writes sub-100 nm patterns) OR focused ion beam milling. Physical vapor deposition for metal deposition. Reactive ion etching for pattern transfer
- Conditions: Electron beam writes pattern in electron-sensitive resist. Develop pattern. Deposit metal. Lift off resist. Resulting sub-wavelength metallic structures interact with light in ways bulk materials cannot (negative refractive index, cloaking effect for specific wavelengths)

**Solid-state battery**

- Type: H + C — thin-film deposition
- Inputs: Lithium metal anode + solid ceramic electrolyte (Li₇La₃Zr₂O₁₂, LLZO — garnet structure) + cathode (same as Li-ion) + no liquid electrolyte
- Assembly: Solid electrolyte fabrication: mix precursor oxides, sinter at 1100°C + hot press. Or thin-film: sputter deposition in vacuum
- Conditions: LLZO solid electrolyte must be sintered to dense ceramic without cracks (challenging — requires hot pressing or spark plasma sintering at 1000°C + 100 MPa). Interfaces between all layers must be intimate contact — no voids
- Properties: No liquid → cannot leak, burn, or explode. Wider temperature operating range. Higher energy density possible

**Synthetic diamond (CVD)**

- Type: H + C — chemical vapor deposition
- Inputs: Hydrogen gas + methane gas (or other carbon source) + diamond seed substrate
- Assembly: Microwave plasma CVD reactor (2.45 GHz microwave at 3–6 kW), diamond seed substrate, cooling system
- Conditions: H₂ + CH₄ mixture (1–3% CH₄) in microwave plasma → plasma dissociates H₂ → atomic H. Atomic H etches non-diamond carbon (graphite). CH₃ radicals deposit carbon on substrate. Only diamond survives the atomic H etching → diamond grows at ~10 μm/hour
- Physics: Diamond is metastable at atmospheric pressure — graphite is thermodynamically stable. But kinetically, atomic hydrogen continuously removes graphite-phase carbon while leaving diamond intact. Diamond nucleates and grows on the seed crystal

---


### 6.3 Physics-Based Crafting & Workstations

116 materials with 11 physics properties each. Five physics interactions: bow-drill fire, flint-and-iron fire, stone knapping, clay pottery, copper/iron smelting. Success rates computed from material properties. Hidden practice tracking. Discovery system for first successes.

---


Crafting happens **at a location**, not in a menu. The player walks to a machine, stands next to it, and works with it. The machine is a physical object with a 3D position in the world.

#### Two Separate Things: Tools vs. Machines

**Tools** are carried in inventory. They affect *how well* the player does something — better tools mean higher success rate and better quality output.


| Tool    | Made from                     | Improves                           |
| ------- | ----------------------------- | ---------------------------------- |
| Hammer  | Stone → Copper → Iron → Steel | Metalworking success rate, quality |
| Chisel  | Flint → Iron                  | Stone shaping precision            |
| Saw     | Flint → Iron                  | Wood splitting, bone               |
| Needle  | Bone → Bronze                 | Leatherwork, cloth quality         |
| Spindle | Wood                          | Spinning speed, thread quality     |


**Machines** are fixed in the world. They control *what the player can do at all* — copper cannot be smelted without a furnace nearby, regardless of inventory contents.

#### Machine Types by Era


| Machine            | Era        | Enables                                                 | Max temperature |
| ------------------ | ---------- | ------------------------------------------------------- | --------------- |
| Campfire           | Stone Age  | Cooking, drying, birch tar, fire adhesives              | ~400°C          |
| Grinding stone     | Stone Age  | Flour, ochre powder, seed crushing                      | —               |
| Stone anvil        | Bronze Age | Basic hammering, knapping on a stable surface           | —               |
| Bloomery           | Bronze Age | Copper, tin, lead smelting                              | ~1100°C         |
| Kiln               | Bronze Age | High-temperature ceramics, fired bricks                 | ~1200°C         |
| Blast furnace      | Iron Age   | Iron smelting (requires coke or charcoal + bellows)     | ~1500°C         |
| Forge              | Iron Age   | Steel-level metalwork (anvil + bellows + fire combined) | ~1300°C         |
| Quench bucket      | Iron Age   | Steel tempering (hot steel plunged into water)          | —               |
| Distillation still | Medieval   | Alcohol concentration, acid production                  | —               |
| Loom               | Medieval   | Cloth weaving from spun thread                          | —               |


Temperature determines what smelts. A campfire cannot smelt copper ore — it never reaches 1085°C. A bloomery can. A blast furnace can smelt iron. The player cannot bypass this by carrying a recipe card or unlocking a skill.

#### How a Crafting Moment Works

1. Player walks within 5 meters of a machine
2. `[F] Use Bloomery` appears on screen
3. Player presses F — a simple panel opens with a plain-language description: *"A bloomery. Reaches ~1100°C with charcoal. Hot enough to smelt copper ore."*
4. Player has malachite and charcoal in inventory. They select them and choose "Smelt"
5. The interaction engine checks the physics: Is temperature high enough? Does the ore's melting point match? Is a reducing agent (charcoal) present?
6. If yes → copper produced. Player discovered copper smelting — not because a recipe unlocked, but because the right physical conditions existed.
7. If no → natural feedback: *"The bloomery isn't hot enough yet. Add more charcoal and wait."*

No recipe list appears at any point.

#### Settlements Use Their Machines

Each settlement generates workstations matching its specialty. A copper mining settlement has a bloomery. The settlement's NPCs use it — their behavior follows a repeating goal loop:

1. **Gather** — walk to the nearest copper ore deposit within territory
2. **Mine** — pause at the deposit for several seconds (simulates extraction)
3. **Carry** — walk to the bloomery with ore in hand
4. **Process** — stand at the bloomery while it smelts (workstation is "occupied")
5. **Deliver** — walk to the settlement's storage area
6. **Deposit** — add smelted copper to the settlement's trade inventory
7. **Idle** — brief rest, then repeat

Players can walk into any settlement and use their workstations too. The bloomery is not locked to the NPCs — it is a shared physical resource, like a village blacksmith's forge.

#### What This Means for the Codebase

**New files:**

- `src/world/WorkstationManager.ts` — client registry of all workstation positions, proximity detection (5m radius), temperature sampling from fire simulation
- `src/store/workstationStore.ts` — tracks the currently-focused workstation
- `src/ui/WorkstationPanel.tsx` — the F-key panel showing machine capability and contextual actions
- `src/rendering/WorkstationRenderer.tsx` — 3D mesh per machine type (campfire = log cone, bloomery = stone cylinder with ember glow, kiln = beehive dome)

**Modified files:**

- `src/crafting/InteractionEngine.ts` — `CraftEnvironment` gains two new optional fields: `nearbyWorkstation` (controls temperature ceiling and available actions) and `heldTool` (affects success rate)
- `universe-server/src/SettlementManager.js` — settlements generate workstations deterministically from seed + specialty; NPCs get a state machine (idle → gather → carry → process → deliver → deposit → idle) ticking at 0.5 Hz


### 6.4 Precision Crafting Mode — Zoom-In Interaction

#### The Principle

Some crafting actions require fine motor control — shaping clay on a wheel, knapping a stone tool's edge, carving wood, drawing on a surface. For these, the camera zooms in and the player's mouse directly controls hand movements.

```
PrecisionCraftMode {
  // ── Activation ────────────────────────────────────────────────────────────
  // Triggered when a player interacts with a workstation or material that requires precision:
  //   - Clay on a pottery wheel
  //   - Stone held for knapping (flint knapping)
  //   - Wood held for carving
  //   - Metal on anvil for detailed shaping
  //   - Drawing/marking on surfaces (charcoal on rock, etc.)

  // ── Camera behavior ───────────────────────────────────────────────────────
  // Camera smoothly zooms in to focus on the work piece
  // FOV narrows from 90° to ~40°
  // Camera orbit: player can orbit around the object with right-click drag
  // Depth of field: background blurs (the player is "focusing")
  // The rest of the world continues — NPCs walk by, weather changes, time passes
  // Other players see this player hunched over their work

  // ── Controls in precision mode ────────────────────────────────────────────
  // Mouse position → cursor on the work surface
  // Left click: primary tool action (strike, push, pull, mark)
  // Right click + drag: rotate camera around object
  // Mouse wheel: zoom in/out within precision range
  // Keyboard:
  //   Q/E: rotate the work piece on its axis
  //   R: switch between tools (if multiple equipped — chisel, hammer, knife)
  //   Shift + click: fine/gentle action (lighter touch)
  //   ESC: exit precision mode

  // ── Physics of precision actions ──────────────────────────────────────────
  // Each click applies a force at the cursor position on the material
  // The material deforms based on its properties:

  ClayCrafting {
    // Clay is soft and plastic when wet (moisture > 0.3)
    // Mouse movement pushes/pulls clay surface
    // Push: indent inward (making a bowl shape)
    // Pull: raise outward (making a rim)
    // Smooth: drag along surface to even it out
    // If pottery wheel is spinning: centrifugal force shapes symmetrically
    // Result: the shape the player creates IS the final object
    //   No pre-defined "pot" or "bowl" shape — it's whatever they sculpt
    //   Properties (volume, wall thickness, symmetry) determine function
    //   A lopsided pot holds less water. A thin-walled pot breaks easily.
  }

  FlintKnapping {
    // Player holds a flint core and strikes with a hammerstone
    // Each click removes a flake from the flint at the cursor position
    // Flake size depends on: angle of strike, force (shift = lighter), proximity to edge
    // Strike too hard near the center → core shatters (broken, start over)
    // Strike correctly along the edge → sharp flake detaches
    //   The flake is a new item (can be used as a cutting edge)
    //   The core becomes smaller and changes shape with each removal
    //   A skilled player creates a symmetrical hand axe
    //   An unskilled player creates jagged fragments (still usable, just worse)
    // Hidden practice count improves the consistency of flake removal
  }

  WoodCarving {
    // Held wood piece + chisel/knife tool
    // Mouse drags remove thin shavings from the surface
    // Drag direction determines grain interaction:
    //   With the grain: smooth cut, clean shaving
    //   Against the grain: rough cut, risk of splitting
    // Player can carve: handles, bowls, pegs, figurines, structural joints
    // The carved shape determines function (a smooth handle grips better)
  }

  MetalShaping {
    // Hot metal on anvil + hammer
    // Each click is a hammer blow at the cursor position
    // Metal deforms based on temperature:
    //   Hot (>800°C): deforms easily (large displacement per hit)
    //   Warm (400-800°C): moderate resistance
    //   Cold (<400°C): very hard to deform (tiny displacement, tool can break)
    // The player hammers the metal into shape: blade, tool head, nail, bracket
    // Quenching (dipping in water): freezes the shape, hardens the metal
  }
}
```


## 7. Player Systems

### 7.1 Character Creation, Body & Animation

#### Camera System

The player uses **first-person view only**. No third-person toggle — this is a survival game where you experience the world through your eyes, not from behind a floating camera.

```
CameraRig {
  // Camera position: at the player's eye height
  eyeHeight: height_cm × 0.0087              // meters (eye level is ~87% of height: 150cm→1.31m, 190cm→1.65m)
  crouchEyeHeight: 1.0                       // when crouching
  proneEyeHeight: 0.3                        // when lying down

  // Head bob: subtle, tied to movement speed
  bobAmplitude: 0.03                         // meters of vertical oscillation while walking
  bobFrequency: 2.0                          // Hz (matches ~4 steps/second walk cycle)
  runBobAmplitude: 0.06                      // increased when running
  runBobFrequency: 3.0

  // Look constraints
  pitchRange: [-85°, +85°]                   // can't look directly up/down (neck limit)
  yawRange: unlimited                        // full 360° horizontal look

  // First-person arms: separate mesh layer rendered on top of world
  // These are the only part of the player's own body visible to them
  armModel: 'first_person_arms'              // simplified mesh: shoulder → elbow → wrist → hand → fingers
  armFOV: 70°                                // slightly narrower than world FOV to prevent hand clipping
}
```

#### Skeletal Rig — Realistic Human Anatomy

Every player character (and every humanoid NPC) uses the same skeletal rig with **67 bones** matching real human anatomy. This is not a simplified game skeleton — it is an anatomically accurate hierarchy that enables realistic movement.

```
HumanSkeleton {
  // ── Spine (5 bones) ──────────────────────────────────────────────────────────
  root                                       // pelvis — the root of all movement
  ├── spine_lumbar                           // lower back (bending, twisting)
  │   ├── spine_thoracic                     // upper back (ribcage rotation)
  │   │   ├── spine_cervical                 // neck
  │   │   │   └── head                       // head (follows camera yaw/pitch for own player)
  │   │   │       ├── jaw                    // mouth open/close (eating, speaking)
  │   │   │       ├── eye_L, eye_R           // eye direction (look-at target)
  │   │   │
  // ── Arms (2 × 11 bones = 22 bones) ──────────────────────────────────────────
  │   │   ├── clavicle_L                     // collarbone (shoulder raise/drop)
  │   │   │   └── shoulder_L                 // ball-and-socket joint
  │   │   │       └── upperArm_L
  │   │   │           └── forearm_L          // elbow (hinge joint, 0°–145° flexion)
  │   │   │               └── hand_L
  │   │   │                   ├── thumb_L (3 bones: metacarpal, proximal, distal)
  │   │   │                   ├── index_L (3 bones)
  │   │   │                   ├── middle_L (3 bones)
  │   │   │                   ├── ring_L (3 bones)
  │   │   │                   └── pinky_L (3 bones)    // not all finger bones animated individually —
  │   │   │                                             // ring+pinky often share a single curl parameter
  │   │   │
  │   │   └── [mirror: clavicle_R → ... → pinky_R]
  │   │
  // ── Legs (2 × 7 bones = 14 bones) ───────────────────────────────────────────
  ├── hip_L                                  // ball-and-socket joint
  │   └── thigh_L
  │       └── shin_L                         // knee (hinge joint, 0°–140° flexion)
  │           └── foot_L
  │               ├── toe_L                  // forefoot bend (push-off during walk)
  │               └── heel_L                 // IK target for terrain planting
  │
  └── [mirror: hip_R → ... → heel_R]
}
// Total: root + 5 spine + 1 head + 2 jaw/eyes + 22 arm + 14 leg + ~20 finger detail = ~67 bones
```

**Bone constraints (real human joint limits):**

| Joint | Type | Range of Motion |
|-------|------|-----------------|
| Neck | Ball-and-socket | Pitch: -40°/+60°, Yaw: ±75°, Roll: ±35° |
| Shoulder | Ball-and-socket | Flexion: 180°, Abduction: 180°, Rotation: 90° internal / 90° external |
| Elbow | Hinge | Flexion: 0°–145°, Pronation/Supination: ±90° (forearm rotation) |
| Wrist | Condyloid | Flexion: 80°, Extension: 70°, Deviation: ±20° |
| Fingers | Hinge (per phalanx) | Metacarpophalangeal: 0°–90°, Interphalangeal: 0°–110° |
| Hip | Ball-and-socket | Flexion: 120°, Extension: 30°, Abduction: 45° |
| Knee | Hinge | Flexion: 0°–140° (no hyperextension) |
| Ankle | Hinge + rotation | Dorsiflexion: 20°, Plantarflexion: 50°, Inversion/Eversion: ±20° |
| Spine (per segment) | Limited ball | Flexion: ~15° per segment, Rotation: ~10° per segment |

These constraints prevent impossible poses (arms bending backwards, knees inverting) and make IK solutions look natural.

#### Inverse Kinematics (IK) System

IK drives three systems: **foot placement**, **hand targeting**, and **look-at**.

**Foot IK — terrain adaptation:**
```
FootIK {
  // Every frame, two raycasts from hip downward find terrain contact points
  rayOrigin: hipBone.worldPosition + [0, 0.1, 0]
  rayDirection: -surfaceNormal                // down relative to planet surface (spherical world)
  rayLength: legLength × 1.2                 // slightly longer than max leg reach

  // Terrain contact point becomes the IK target for the ankle bone
  // The solver adjusts hip height, knee bend, and ankle rotation to plant the foot
  // On slopes: uphill leg bends more, downhill leg extends more
  // On stairs/rocks: each foot independently finds its surface

  // Pelvis height adjustment:
  pelvisOffset = min(leftFootDrop, rightFootDrop)  // pelvis lowers to match the lower foot
  // This prevents the character from hovering above uneven terrain
}
```

**Hand IK — interaction targeting:**
```
HandIK {
  // When the player interacts with something (mine, pick up, use workstation),
  // the hand reaches toward the interaction point

  // Mining: dominant hand grips tool, follows swing arc (pre-authored animation)
  //         but IK adjusts the endpoint to hit the actual rock surface position

  // Picking up: hand reaches down to the item's world position
  //             spine bends forward, knees may flex if item is low

  // Workstation: hands position to the machine's interaction points
  //              (e.g., hands on bellows handles, or placing ore into furnace opening)

  // The IK chain: shoulder → elbow → wrist → hand
  // Solver: FABRIK (Forward And Backward Reaching Inverse Kinematics)
  //   - Faster than CCD for chains of this length
  //   - Converges in 3-5 iterations
  //   - Respects joint constraints (elbow doesn't bend backwards)
}
```

**Look-at IK — head and eye tracking:**
```
LookAtIK {
  // Other players' heads turn toward things they're looking at
  // This is NOT the local player's camera (that's direct control)
  // This is how OTHER players see each other

  // Network sends: each player's camera forward vector (compressed to 2 bytes: yaw + pitch as uint8)
  // Receiving client: rotates the neck + head bones to match
  // Eyes: slight additional rotation toward the look target (±5° offset from head)

  // Weight falloff: if look target is behind the player (>90° from forward),
  // head rotates only to ~75° and eyes handle the remaining offset
  // Beyond 90°: the character's body must turn (not just the head)
}
```

#### What the Local Player Sees vs. What Others See

| Part | Local Player | Other Players |
|------|-------------|---------------|
| Head | Invisible (camera is inside it) | Full head mesh + face |
| Torso | Invisible | Full torso with clothing |
| Arms | First-person arm model (higher detail hands, different FOV) | Full arm mesh from shoulder |
| Legs | Invisible (look down → see nothing, or optional: see own feet/knees) | Full leg mesh |
| Shadow | Full body shadow cast on ground (gives spatial awareness) | Full body shadow |
| Held items | Visible in first-person hand model | Visible in third-person hand |

The first-person arms are a **separate mesh and render pass** from the world. They render at `armFOV` (70°) on top of the world rendered at `worldFOV` (90°). This prevents the common FPS problem of hands clipping through walls — the arm mesh exists in its own depth space.

#### Injury Visualization

Injuries are not HP bars — they are visible physical states that change how the character looks and moves:

```
InjurySystem {
  // Each body region can be independently injured
  regions: {
    head:      { health: 0-100, bleedRate: number },
    torso:     { health: 0-100, bleedRate: number },
    leftArm:   { health: 0-100, bleedRate: number },
    rightArm:  { health: 0-100, bleedRate: number },
    leftLeg:   { health: 0-100, bleedRate: number },
    rightLeg:  { health: 0-100, bleedRate: number },
  }

  // Visual effects per region health level:
  // 100-70%: no visible change
  // 70-40%:  slight discoloration (bruising shader overlay), minor movement penalty
  // 40-10%:  visible wound texture, blood decal, significant movement penalty
  // <10%:    limb barely functional

  // Movement penalties:
  // Injured leg: walkSpeed × (legHealth / 100), limp animation blends in below 50%
  // Injured arm: interaction speed × (armHealth / 100), tool swing is slower and less accurate
  // Injured torso: stamina regeneration × (torsoHealth / 100)
  // Injured head: vision blur at <30%, screen darkening at <15%

  // Healing: injuries heal at baseHealRate × (nutrition_factor) × (rest_factor) × (temperature_factor)
  // baseHealRate: 0.5 HP/minute (a bad cut takes ~2 real hours to heal fully at rest with food)
  // Bandaging (cloth + pressure): stops bleedRate, doubles healRate for that region
  // Infection risk: open wound (bleedRate > 0) in dirty environment → bacterial growth (see §8.2 death causes)
}
```

**Limp animation blend:**
When `leftLeg.health < 50%`, the walk cycle blends a limp animation:
- Stance phase on injured leg is shorter (hurrying to get weight off it)
- Swing phase on injured leg has reduced knee flexion (can't bend it fully)
- Compensatory lean toward the uninjured side
- Blend weight: `limpWeight = 1.0 - (legHealth / 50)` (0% at 50 HP, 100% at 0 HP)

Other players see all of this. A player limping toward you with a bloody arm and slow movements is visually communicating their state without any HP bar.

#### Character Creation — First-Time Face and Body

When a player logs in for the first time, before they enter the world, they enter the **Character Creator**. This is the only time they can customize their appearance. After confirmation, the face and body shape are permanent — stored in the database forever. The only in-game way to change facial features is through plastic surgery (a late-game medical technology requiring advanced tools and another player with medical knowledge).

**Character Creator Screen Layout:**

```
CharacterCreatorUI {
  // ── Background ────────────────────────────────────────────────────────────
  // The game world renders behind the character, blurred (Gaussian blur, radius 20px)
  // This shows the world the player is about to enter — atmospheric, not a blank screen
  // Time of day and weather from the live server are visible through the blur

  // ── Character model ───────────────────────────────────────────────────────
  // Full-body character model stands in the center of the screen
  // Default pose: relaxed standing, arms slightly away from body
  // Player can rotate the model by clicking and dragging (orbit around vertical axis)
  // Scroll to zoom in/out (face detail ↔ full body)
  // The model updates in real-time as sliders are adjusted

  // ── Customization panels ──────────────────────────────────────────────────
  // Left side or bottom: tabbed panels for each customization category
  // Each panel has sliders, color pickers, and preset options
}
```

**Customizable Parameters — Face:**

```
FaceCustomization {
  // All values are normalized 0.0–1.0 and drive blend shapes on the head mesh.
  // Blend shapes = morph targets: each parameter smoothly deforms the base mesh.
  // This is the same system used by Black Desert Online, Skyrim, Baldur's Gate 3.

  // ── Head Shape ────────────────────────────────────────────────────────────
  headWidth: 0.0–1.0              // narrow ↔ wide
  headLength: 0.0–1.0             // short ↔ long (front to back)
  jawWidth: 0.0–1.0               // narrow/pointed ↔ square/wide
  jawHeight: 0.0–1.0              // short chin ↔ long chin
  cheekboneWidth: 0.0–1.0         // flat ↔ prominent
  cheekboneHeight: 0.0–1.0        // low ↔ high
  foreheadHeight: 0.0–1.0         // short ↔ tall
  foreheadSlope: 0.0–1.0          // flat ↔ angled back

  // ── Eyes ──────────────────────────────────────────────────────────────────
  eyeSize: 0.0–1.0                // small ↔ large
  eyeSpacing: 0.0–1.0             // close together ↔ far apart
  eyeHeight: 0.0–1.0              // low on face ↔ high on face
  eyeTilt: 0.0–1.0                // downward outer corner ↔ upward outer corner
  eyeDepth: 0.0–1.0               // protruding ↔ deep-set
  eyeColor: Color                  // iris color (full color picker)
  pupilSize: 0.0–1.0              // small ↔ large (cosmetic, not functional)
  eyelidShape: 0.0–1.0            // single eyelid ↔ double eyelid (monolid ↔ crease)
  eyebrowThickness: 0.0–1.0       // thin ↔ thick
  eyebrowHeight: 0.0–1.0          // low (close to eye) ↔ high (far from eye)
  eyebrowArch: 0.0–1.0            // flat ↔ high arch
  eyebrowColor: Color              // independent of hair color

  // ── Nose ──────────────────────────────────────────────────────────────────
  noseWidth: 0.0–1.0              // narrow ↔ wide
  noseLength: 0.0–1.0             // short ↔ long
  noseBridge: 0.0–1.0             // low/flat bridge ↔ high/prominent bridge
  noseTip: 0.0–1.0                // pointed ↔ rounded
  nostrilFlare: 0.0–1.0           // narrow nostrils ↔ wide/flared
  noseTipAngle: 0.0–1.0           // downturned ↔ upturned

  // ── Mouth and Lips ────────────────────────────────────────────────────────
  mouthWidth: 0.0–1.0             // small ↔ wide
  upperLipThickness: 0.0–1.0      // thin ↔ full
  lowerLipThickness: 0.0–1.0      // thin ↔ full
  lipColor: Color                  // natural lip color (subtle range — pink to brown)
  mouthHeight: 0.0–1.0            // position on face (low ↔ high)
  smileDefault: 0.0–1.0           // neutral resting expression (slight frown ↔ slight smile)

  // ── Ears ──────────────────────────────────────────────────────────────────
  earSize: 0.0–1.0                // small ↔ large
  earAngle: 0.0–1.0               // flat against head ↔ protruding
  earPointedness: 0.0–1.0         // rounded ↔ pointed (allows elf-like ears if desired)
  earlobeAttachment: 0.0–1.0      // attached ↔ free-hanging

  // ── Skin ──────────────────────────────────────────────────────────────────
  skinColor: Color                 // full range of human skin tones
  skinTexture: 0.0–1.0            // smooth ↔ rough/weathered
  freckles: 0.0–1.0               // none ↔ dense freckles
  moles: 0.0–1.0                  // none ↔ several beauty marks
  scarPreset: number               // 0 = none, 1-5 = different scar patterns (starting scars)
  wrinkleDepth: 0.0–1.0           // smooth (young) ↔ deep wrinkles (starting age appearance)

  // ── Hair ──────────────────────────────────────────────────────────────────
  hairStyle: number                // preset selection from ~20 hairstyles
  // Styles: bald, buzz cut, short messy, medium straight, medium wavy, medium curly,
  //         long straight, long wavy, long curly, ponytail, braids, dreadlocks,
  //         mohawk, top knot, side shave, afro, cornrows, bob, shoulder-length layered
  hairColor: Color                 // full color picker (natural range: black, brown, blonde, red, grey, white)
  hairLength: 0.0–1.0             // additional length control within the style
  facialHairStyle: number          // 0 = none, 1 = stubble, 2 = short beard, 3 = full beard,
                                   // 4 = goatee, 5 = mustache, 6 = long beard
  facialHairColor: Color           // can differ from head hair (realistic — beards often redder)
  facialHairDensity: 0.0–1.0      // patchy ↔ full

  // Total blend shape count: ~40 facial parameters
  // Each is a morph target on the head mesh — GPU-driven, no performance cost at runtime
  // The final face is stored as a Float32Array of 40 values (160 bytes) in the database
}
```

**Customizable Parameters — Body:**

```
BodyCustomization {
  // ── Dimensions ────────────────────────────────────────────────────────────
  height: number                   // centimeters, range: 150–190 cm
  // Height affects:
  //   eyeHeight in camera rig (height × 0.87 — eye level is ~87% of height)
  //   reach distance for interactions (taller = can reach higher shelves, farther objects)
  //   stride length (taller = faster walk at same animation speed)
  //   hitbox size (taller = easier to hit)
  //   weight baseline (taller people weigh more at same build)

  // ── Body Type ─────────────────────────────────────────────────────────────
  // Two axes that determine body shape and affect stats:
  muscularity: 0.0–1.0            // lean/thin ↔ muscular/broad
  bodyFat: 0.0–1.0                // low body fat ↔ high body fat

  // These are independent axes — all 4 combinations exist:
  //   Low muscle + low fat    = thin/wiry build    (high speed, low strength, low insulation)
  //   Low muscle + high fat   = soft/heavy build   (low speed, low strength, high insulation)
  //   High muscle + low fat   = athletic build     (moderate speed, high strength, low insulation)
  //   High muscle + high fat  = powerlifter build  (low speed, very high strength, high insulation)

  // ── Stat Effects from Body Type ───────────────────────────────────────────
  // These modify the BASE values of the fitness stats in §8.11:
  //
  // Strength baseline:     0.4 + muscularity × 0.3 + bodyFat × 0.05
  //   thin build: 0.4, muscular: 0.7, powerlifter: 0.75
  //
  // Speed baseline:        0.6 - bodyFat × 0.15 + muscularity × 0.05
  //   thin: 0.6, athletic: 0.65, heavy: 0.45, powerlifter: 0.5
  //
  // Endurance baseline:    0.5 + muscularity × 0.1 - bodyFat × 0.1
  //   thin: 0.5, athletic: 0.6, heavy: 0.4, powerlifter: 0.5
  //
  // Cold resistance:       bodyFat × 0.15 (fat insulates — real physiology)
  //   thin build: almost no insulation, high body fat: significant cold resistance
  //
  // Swim buoyancy:         0.5 + bodyFat × 0.3 - muscularity × 0.1
  //   fat floats, muscle sinks (muscle is denser than water, fat is less dense)
  //
  // Calorie burn rate:     BMR × (1 + muscularity × 0.2) (more muscle = burns more at rest)
  //   muscular characters need to eat more to maintain their body

  // ── Body proportions (visual) ─────────────────────────────────────────────
  shoulderWidth: 0.0–1.0          // narrow ↔ broad
  hipWidth: 0.0–1.0               // narrow ↔ wide
  armLength: 0.0–1.0              // short ↔ long (proportional to height)
  legLength: 0.0–1.0              // short ↔ long (proportional to height)
  handSize: 0.0–1.0               // small ↔ large
  neckThickness: 0.0–1.0          // thin ↔ thick

  // Body shape stored as ~10 morph target values (40 bytes)
  // Total character appearance data: face (160 bytes) + body (40 bytes) = 200 bytes per player
}
```

**Permanence and Storage:**

```
CharacterAppearance {
  // Stored in database on first creation:
  character_appearance {
    user_id:      TEXT PRIMARY KEY
    face_params:  FLOAT[40]          // 40 blend shape values
    body_params:  FLOAT[10]          // 10 body morph values
    height_cm:    SMALLINT           // 150-190
    hair_style:   SMALLINT
    hair_color:   INT                // packed RGB
    facial_hair:  SMALLINT
    skin_color:   INT                // packed RGB
    eye_color:    INT                // packed RGB
    created_at:   TIMESTAMP
    birth_day:    INT                // game-day when character was created (for aging)
  }

  // This record is created ONCE and never modified (except by:)
  //   - Aging system (wrinkleDepth increases over time)
  //   - Plastic surgery (late-game: another player with medical tools can modify face_params)
  //   - Hair growth (hairLength slowly increases, player must cut it — or not)
  //   - Fitness changes (muscularity/bodyFat morph slightly with §8.11 training over long periods)

  // When a player's character is rendered by another client:
  //   1. Client receives face_params + body_params in the player's first WORLD_SNAPSHOT appearance
  //   2. Client creates the character mesh with those blend shapes applied
  //   3. Mesh is cached — only re-created if the player changes (aging tick, rare)
  //   4. Bandwidth: 200 bytes once per player encounter, then cached
}
```

#### Clothing Appearance and Equipment Screen

Clothing is not just inventory (§8.9) — it is visible on the character model. Every piece of clothing the player wears changes how they look to other players. **Clothing is also a primary monetization channel — cosmetic clothing skins/patterns can be sold.**

**Equipment Screen Layout:**

```
EquipmentScreenUI {
  // ── Activation ────────────────────────────────────────────────────────────
  // Player presses C (character key) to open the equipment screen
  // The game world continues behind with a Gaussian blur (same as character creator)
  // The player's full body model stands in the center, slowly rotating

  // ── Layout ────────────────────────────────────────────────────────────────
  //
  //          [Hat]
  //            │
  //     ┌──────┴──────┐
  //     │   [Necklace] │
  //     │      │       │
  // [Outer]──[Torso]   │
  //     │      │       │
  //  [Belt]───┤     [Bracelet_R]
  //     │      │       │
  // [Bracelet_L]──[Ring_L]  [Ring_R]
  //     │      │
  //     │   [Legs]
  //     │      │
  //     │   [Shoes]
  //     │
  //  [Backpack] (behind)
  //
  // Lines connect from each slot to the corresponding body part on the 3D model
  // Dotted lines for empty slots, solid glowing lines for equipped items
  // Hovering over a slot highlights the body region on the model

  // ── Clothing Slots ────────────────────────────────────────────────────────
  slots: {
    head:         'hat' | 'helmet' | 'headband' | null
    necklace:     'necklace' | 'amulet' | 'scarf' | null
    torso:        'shirt' | 'tunic' | 'armor_chest' | null
    outerLayer:   'jacket' | 'cloak' | 'coat' | 'poncho' | null  // worn OVER torso
    belt:         'belt' | 'tool_belt' | 'sash' | null
    legs:         'pants' | 'skirt' | 'armor_legs' | null
    feet:         'shoes' | 'boots' | 'sandals' | null
    back:         'backpack' | 'satchel' | 'quiver' | null
    leftWrist:    'bracelet' | 'wristguard' | null
    rightWrist:   'bracelet' | 'wristguard' | null
    leftRing:     'ring' | null
    rightRing:    'ring' | null
    gloves:       'gloves' | 'mittens' | null
  }
  // Total: 13 visible equipment slots

  // Each slot accepts a ClothingItem (defined in §8.9)
  // Drag from inventory pocket/backpack to an equipment slot to equip
  // Drag from equipment slot back to inventory to unequip
  // If no free inventory slot: can't unequip (must drop something first)
}
```

**Clothing Rendering:**

```
ClothingMeshSystem {
  // Each clothing item has a 3D mesh that attaches to the character skeleton.
  // The mesh is skinned to the same bones as the body — it moves with the character.

  // ── Layering order (render front to back) ─────────────────────────────────
  // 1. Skin (base body mesh)
  // 2. Underwear/base layer (always present — decency layer)
  // 3. Torso clothing (shirt, tunic)
  // 4. Legs clothing (pants, skirt)
  // 5. Belt (overlaps torso and legs)
  // 6. Outer layer (jacket, cloak — rendered on top)
  // 7. Accessories (necklace, bracelets, rings — small meshes on bones)
  // 8. Head gear (hat, helmet — on head bone)
  // 9. Shoes/boots (on foot bones)
  // 10. Backpack (on spine_thoracic, hanging from shoulders)

  // Layering prevents z-fighting: each layer has a small vertex offset outward from body
  // layer1: body mesh
  // layer2: body mesh + 0.5cm offset on normals (underwear)
  // layer3: body mesh + 1.0cm offset (shirt)
  // layer4: body mesh + 1.5cm offset (jacket)
  // This creates physically plausible thickness — a jacket looks thicker than a shirt

  // ── Material appearance ───────────────────────────────────────────────────
  // Clothing material (leather, cloth, fur, metal) determines the shader:
  //   Cloth: diffuse, slightly rough, subtle weave normal map
  //   Leather: glossy, darkens when wet, grain texture
  //   Fur: hair-card rendering (layered alpha planes), fluffy silhouette
  //   Metal (armor): PBR metallic shader, reflects environment
  //   Hide/raw: matte, rough, organic texture

  // Color comes from the crafting process:
  //   Undyed cloth: cream/beige
  //   Dyed with plant pigments: limited color range (brown, green, yellow, red, blue)
  //   Dyed with mineral pigments: brighter colors (available later in tech tree)
  //   Tanned leather: brown range
  //   Metal: silver/grey for iron, orange for copper, gold for brass

  // ── Cosmetic skins (MONETIZATION) ─────────────────────────────────────────
  // Players can purchase cosmetic patterns/textures for clothing slots:
  //   Pattern overlays: stripes, checks, embroidery, tribal patterns, symbols
  //   These do NOT affect stats — purely visual
  //   Applied on top of the base material color
  //   Stored per-player in the database
  //   Other players see the cosmetic skin
  //
  // Example purchasable cosmetics:
  //   "Embroidered tunic pattern" — decorative stitching texture on any torso clothing
  //   "War paint set" — face/body paint overlays (applied to skin layer)
  //   "Tooled leather pattern" — ornate carving pattern for leather items
  //   "Fur trim" — adds fur edge rendering to any outer layer
  //
  // These are the primary monetization — NOT pay-to-win stats.
  // A player with purchased cosmetics looks different but has no gameplay advantage.
}
```

#### Aging System

The player character ages in real-time — very slowly, because the world runs in real time relative to in-game time.

```
AgingSystem {
  // ── Time scale: 4× real life (from §7) ──────────────────────────────────
  // 1 real hour = 4 game hours
  // 1 real year ≈ 4 game years
  //
  // Starting age: 18 game-years (player creates an adult character)
  // After 1 real year: character is 22 years old
  // After 5 real years: character is 38 years old
  // After 10 real years: character is 58 years old
  // After 18 real years: character is 90 years old (old age zone)
  //
  // Aging is slow but noticeable over years of play. A dedicated long-term
  // player will see their character visibly age and eventually face old age.
  //
  // Aging progresses in game-time, whether the player is ONLINE or OFFLINE.
  // The character exists in the world — time passes for them like everyone else.
  // A player who doesn't log in for a real year returns to a character 4 years older.

  // ── Visual aging (gradual, continuous) ────────────────────────────────────
  // Every game-year (~91 real days):

  ageEffectsPerGameYear: {
    wrinkleDepth:   +0.02           // face wrinkles deepen (blend shape)
    skinTexture:    +0.01           // skin becomes rougher
    hairGreying:    +0.015          // hair color lerps toward grey/white (starts at ~40 game-years)
    muscleDecay:    -0.005          // max muscularity slightly decreases after 50 game-years
    postureStooping: +0.005         // spine_thoracic forward bend increases slightly after 60
  }

  // Age 18-35 game-years: peak physical condition, no visible aging
  // Age 35-50: very subtle lines around eyes and mouth, no stat effect
  // Age 50-65: visible wrinkles, hair starts greying, slight stat decline
  // Age 65-80: prominent wrinkles, mostly grey hair, noticeable stat decline
  // Age 80-95: deeply weathered face, white hair, significant stat decline
  // Age 95+: death from old age becomes possible (daily survival check)

  // ── Stat effects of aging ─────────────────────────────────────────────────
  // These modify the FITNESS CAPS from §8.11:
  //
  // Age 18-35:  all caps at 1.0 (peak human)
  // Age 35-50:  speed cap = 1.0 - (age - 35) × 0.005       // loses 0.5% per year
  //             strength cap = 1.0 - (age - 40) × 0.003     // starts declining at 40
  //             endurance cap = 1.0 - (age - 35) × 0.004
  // Age 50-65:  speed cap = 0.925 - (age - 50) × 0.008
  //             strength cap = 0.97 - (age - 50) × 0.006
  //             stamina recovery rate × 0.85
  // Age 65+:    accelerating decline
  //             max health: 100 - (age - 65) × 1.5 (at 90: max health = 62.5)
  //
  // An old character is weaker, slower, less durable — but has all their knowledge,
  // discoveries, practice counters, built infrastructure, and social connections.
  // Age is a tradeoff: you lose physical ability but your accumulated knowledge
  // and world modifications are irreplaceable.

  // ── Death from old age ────────────────────────────────────────────────────
  // After 90 game-years (~18 real years of play):
  // Each game-day, survival check: random(0,1) > (age - 90) × 0.01
  // At age 90: 0% daily chance of death (just entering the zone)
  // At age 95: 5% daily chance
  // At age 100: 10% daily chance
  // At age 110: 20% daily chance (virtually guaranteed within a game-month)
  //
  // A very dedicated player could reach old age after ~18 real years.
  // NPCs age at the same rate — creating generational turnover in settlements.
  // The aging system rewards long-term play: your character's accumulated
  // knowledge, discoveries, and world modifications become legacy.
  //
  // When death from old age occurs:
  //   - Same death mechanics as §8.2 (item drop, corpse, respawn)
  //   - BUT: the character is reborn as a NEW character (back to age 18)
  //   - They KEEP: discoveries, shelter, placed objects, friend list
  //   - They LOSE: physical appearance (must re-customize face), fitness progress,
  //     inventory (dropped at death location), body type resets to new creation
  //   - This is "generational" play — your knowledge persists through lifetimes
  //   - The new character is narratively "a descendant" or "a new inhabitant"

  // ── Hair growth ───────────────────────────────────────────────────────────
  // Hair grows at the real human rate in game-time: ~0.4mm per game-day
  // At 4× time scale: 1 game-day = 6 real hours, so hair grows ~1.6mm per real day
  //   hairLength += 0.0004 per game-day (0.4mm per game-day = real human rate)
  //   ~48mm per real month, ~600mm (60cm) per real year
  //   After 1 week of play: hair has grown ~1.1cm from starting length
  //   After 1 month: ~4.8cm — noticeably longer
  //
  // Players can cut hair:
  //   Using a sharp tool (flint blade, knife, scissors) → precision craft mode
  //   Player controls the cut — can make it any length/style they want
  //   Bad haircut? Live with it until it grows back.
  //
  // Facial hair grows at the same rate (if the character has facial hair enabled)
  // Shaving requires a sharp edge — stone blade works, metal razor works better
}
```

#### Animation State Machine — How the Body Moves

The character's body is always in one animation state. States blend smoothly into each other. The animation system uses a **layered state machine** with full-body states and additive overlays.

```
AnimationStateMachine {
  // ── Implementation: Three.js AnimationMixer ───────────────────────────────
  // Three.js provides AnimationMixer, AnimationAction, and blend weights.
  // Each state is a pre-authored animation clip (skeletal keyframes).
  // The state machine manages which clips play and how they blend.

  // ── Layer 0: Locomotion (full body) ───────────────────────────────────────
  // This layer controls the whole body's base pose and movement.
  // Only ONE locomotion state is active at a time (with crossfade transitions).

  locomotionStates: {
    idle: {
      clip: 'idle_breathe'           // subtle breathing, weight shifting
      loop: true
      // Trigger: velocity = 0, not interacting
    }

    walk: {
      clip: 'walk_cycle'             // 4-step cycle, arms swing naturally
      loop: true
      speed: proportionalToVelocity  // animation speed scales with movement speed
      // Trigger: velocity > 0.1 m/s AND velocity < runThreshold
    }

    run: {
      clip: 'run_cycle'              // faster cycle, arms pump, torso leans forward
      loop: true
      speed: proportionalToVelocity
      // Trigger: velocity > runThreshold (shift held)
    }

    sprint: {
      clip: 'sprint_cycle'           // maximum speed, body leans significantly, arms pump high
      loop: true
      // Trigger: velocity > sprintThreshold (double-tap shift)
    }

    crouch_idle: {
      clip: 'crouch_idle'            // knees bent, torso lowered, arms ready
      loop: true
      // Trigger: crouch key (C) held, velocity = 0
    }

    crouch_walk: {
      clip: 'crouch_walk'            // slow, low movement
      loop: true
      // Trigger: crouch + velocity > 0
    }

    jump: {
      clip: 'jump'                   // push off, airborne pose, land
      loop: false
      duration: 0.8                  // seconds
      // Trigger: space key (must have stamina > 15)
      // On land: blend back to idle/walk based on velocity
    }

    fall: {
      clip: 'falling'                // arms spread, legs trailing
      loop: true
      // Trigger: not grounded AND vertical velocity < -2 m/s
      // Transitions to 'land_hard' or 'land_soft' based on impact velocity
    }

    land_soft: {
      clip: 'land_soft'              // knees absorb, brief crouch
      loop: false
      duration: 0.3
      // Trigger: landing with velocity < 8 m/s (no damage)
    }

    land_hard: {
      clip: 'land_hard'              // collapse forward, roll
      loop: false
      duration: 0.8
      // Trigger: landing with velocity > 8 m/s (fall damage)
      // Player is immobilized during this animation
    }

    swim_surface: {
      clip: 'swim_surface'           // freestyle arms, kick, head above water
      loop: true
      // Trigger: in water, head above surface, velocity > 0
    }

    swim_idle: {
      clip: 'tread_water'            // legs kick gently, arms sculling
      loop: true
      // Trigger: in water, head above surface, velocity = 0
    }

    swim_dive: {
      clip: 'swim_underwater'        // full body undulation, arms pulling
      loop: true
      // Trigger: in water, head below surface
    }

    climb: {
      clip: 'climb'                  // hands reach up, pull body, feet find holds
      loop: true
      // Trigger: against a climbable surface (steep rock face, ladder)
      // IK overrides hand/foot positions to actual surface holds
    }

    sit: {
      clip: 'sitting'                // on ground or on object (bench, rock)
      loop: true
      // Trigger: player chooses to sit (rest action)
    }

    sleep: {
      clip: 'sleeping'               // lying down, eyes closed, breathing
      loop: true
      // Trigger: player chooses to sleep (at shelter or safe spot)
    }

    dead: {
      clip: 'death_collapse'         // ragdoll-like fall, settle
      loop: false
      // Trigger: health = 0
      // Transitions to static corpse pose
    }
  }

  // ── Transitions ───────────────────────────────────────────────────────────
  // All transitions use crossfade blending:
  //   idle ↔ walk: 0.2s crossfade
  //   walk ↔ run: 0.15s crossfade (smooth speed change)
  //   run ↔ sprint: 0.1s crossfade
  //   any → jump: 0.1s crossfade (snappy response)
  //   fall → land: 0.05s (instant on ground contact)
  //   any → swim: 0.3s crossfade (body adjusts to water)
  //   any → dead: 0.0s (immediate ragdoll)
  //
  // Three.js: action.crossFadeTo(nextAction, fadeDuration, warpBoolean)

  // ── Layer 1: Upper Body Override (additive) ───────────────────────────────
  // This layer plays ON TOP of locomotion, affecting only upper body bones.
  // It allows the character to walk/run while doing something with their hands.
  // Uses AnimationMixer with skeleton masking (only affect spine_thoracic and above).

  upperBodyOverrides: {
    tool_swing: {
      clip: 'swing_pickaxe' | 'swing_axe' | 'swing_hammer'
      loop: false
      duration: 0.6–0.8              // depends on tool weight and player strength
      // Trigger: left click while holding a tool
      // Plays on upper body only — legs continue walking/standing
      // IK adjusts hand endpoint to actual target position
    }

    carry_item: {
      clip: 'carry_one_hand' | 'carry_two_hands' | 'carry_shoulder'
      loop: true
      // Selection based on item weight:
      //   < 2kg: one hand carry (arm at side)
      //   2-15kg: two hand carry (arms in front of torso)
      //   15-40kg: shoulder carry (one arm up, resting on shoulder)
      //   > 40kg: can't carry while moving (must drag or use equipment)
    }

    pour: {
      clip: 'pour_liquid'             // tilt container, control angle
      loop: false
      // Trigger: pour action with a container
    }

    eat: {
      clip: 'eat'                     // hand to mouth, chewing
      loop: false
      duration: 2.0                   // seconds per food item
    }

    drink: {
      clip: 'drink'                   // container to mouth, tilt, swallow
      loop: false
      duration: 1.5
    }

    throw: {
      clip: 'throw'                   // wind up, release
      loop: false
      duration: 0.5
      // Item velocity = playerStrength × throwForce × arm animation peak speed
    }

    wave: {
      clip: 'wave_hand'              // friendly gesture
      loop: false
      duration: 1.5
      // Trigger: emote key
    }

    point: {
      clip: 'point_direction'         // extend arm toward look direction
      loop: false
      duration: 1.0
      // Trigger: emote key — useful for non-verbal communication
    }
  }

  // ── Layer 2: Injury Modifiers (additive) ──────────────────────────────────
  // These modify the base animations based on injury state (§8.4 injury system).
  // They are ALWAYS active but with weight = 0 when healthy.

  injuryModifiers: {
    limp_left: {
      clip: 'limp_left_leg'          // shortened stance on left, lean right
      weight: max(0, 1.0 - leftLeg.health / 50)   // 0 above 50 HP, 1.0 at 0 HP
      // Additive on top of walk/run — walk becomes limping walk
    }

    limp_right: {
      clip: 'limp_right_leg'
      weight: max(0, 1.0 - rightLeg.health / 50)
    }

    arm_favor_left: {
      clip: 'favor_left_arm'          // left arm held close to body, reduced swing
      weight: max(0, 1.0 - leftArm.health / 50)
    }

    arm_favor_right: {
      clip: 'favor_right_arm'
      weight: max(0, 1.0 - rightArm.health / 50)
    }

    torso_hunch: {
      clip: 'hunch_forward'           // protective hunching from torso injury
      weight: max(0, 1.0 - torso.health / 40)
    }

    head_daze: {
      clip: 'head_wobble'             // slight head instability from head injury
      weight: max(0, 1.0 - head.health / 30)
    }
  }

  // ── Layer 3: Fatigue Modifiers (additive) ──────────────────────────────────
  fatigueModifiers: {
    tired_posture: {
      clip: 'tired_slouch'            // shoulders drop, head lowers
      weight: max(0, (fatigue - 50) / 50)   // kicks in above 50 fatigue
    }

    exhausted_stumble: {
      clip: 'random_stumble'          // occasional trip/catch
      weight: max(0, (fatigue - 80) / 20)   // kicks in above 80 fatigue
      // Randomly triggers every 10-30 seconds when weight > 0
    }
  }

  // ── How it all combines (Three.js implementation) ──────────────────────────
  //
  // const mixer = new THREE.AnimationMixer(characterModel)
  //
  // // Layer 0: locomotion (full body)
  // const idleAction = mixer.clipAction(idleClip)
  // const walkAction = mixer.clipAction(walkClip)
  // const runAction  = mixer.clipAction(runClip)
  // // Only one plays at a time, others crossfade to weight 0
  //
  // // Layer 1: upper body (masked to spine_thoracic and children)
  // const swingAction = mixer.clipAction(swingClip)
  // swingAction.weight = 0  // set to 1 when player swings
  // // Apply skeleton mask: only bones from spine_thoracic upward
  // // Three.js doesn't have built-in masking, so we zero out
  // // leg bone influences in the clip or use a custom mixer
  //
  // // Layer 2+3: injury + fatigue (additive)
  // const limpAction = mixer.clipAction(limpClip)
  // limpAction.blendMode = THREE.AdditiveAnimationBlendMode
  // limpAction.weight = computedLimpWeight  // updated per frame
  //
  // // Per frame:
  // mixer.update(deltaTime)
  // // Then IK runs on top to fix foot placement, hand targets, look-at
}
```

**Animation Clip Count (Minimum Viable):**

| Category | Clips | Notes |
|----------|-------|-------|
| Locomotion | 15 | idle, walk, run, sprint, crouch×2, jump, fall, land×2, swim×3, climb, sit, sleep, death |
| Upper body actions | 12 | swing×3 (pick/axe/hammer), carry×3, pour, eat, drink, throw, wave, point |
| Injury modifiers | 6 | limp×2, arm_favor×2, torso_hunch, head_daze |
| Fatigue modifiers | 2 | tired_slouch, random_stumble |
| Precision craft | 4 | clay_shape, knapping, carving, hammering |
| Facial expressions | 5 | neutral, pain, exertion, cold_shiver, eating |
| **Total** | **~44 clips** | Each is a skeletal keyframe animation (GLB/GLTF format) |

These clips can be authored in Blender using the same 67-bone skeleton rig, exported as GLB, and loaded by Three.js's GLTFLoader. The same clips work for all characters regardless of face/body customization because blend shapes and skeletal animation are independent systems.


### 7.2 Human Body Simulation — Survival Stats

#### The Principle

The player character is a human body. It needs food, water, sleep, and air. It gets tired, cold, hot, injured, and sick. Every stat is modeled after real human physiology with real numbers. The game does not use abstract "hunger points" — it uses caloric deficit, glycogen reserves, and basal metabolic rate.

#### The Five Stats (Internal Model)

```
HumanBodyState {
  // ── Energy (Calories) ─────────────────────────────────────────────────────
  // The human body burns calories continuously. This is the master resource.
  calories: number                   // current caloric reserve (kcal)
  // Well-fed human: ~2000 kcal reserve (glycogen in liver + muscles)
  // Starvation threshold: 0 kcal → body begins consuming muscle/fat
  // Lethal: sustained 0 kcal for 4 game-days (~24 real hours — compressed from real 3-4 day limit)

  basalMetabolicRate: number         // kcal/hour at rest
  // Average human: ~75 kcal/hour (1800 kcal/day)
  // Affected by: body mass, ambient temperature, fitness level

  // Calorie drain rates by activity:
  //   Sleeping:     0.8 × BMR
  //   Standing:     1.0 × BMR
  //   Walking:      1.5 × BMR
  //   Running:      3.0 × BMR
  //   Mining:       4.0 × BMR
  //   Swimming:     5.0 × BMR
  //   Fighting:     4.5 × BMR
  //   Crafting:     1.2 × BMR
  //   In cold (<10°C): BMR × (1 + (10 - T_ambient) × 0.03)  // shivering burns calories

  // ── Hydration (Water) ─────────────────────────────────────────────────────
  hydration: number                  // liters of body water
  // Normal: ~2.5 liters (above minimum)
  // Dehydration begins: < 1.5 liters
  // Lethal: < 0.5 liters (sustained for 2-3 game-days — ~12-18 real hours)

  waterLossRate: number              // liters/hour
  // Base: 0.1 L/hour (breathing, sweating at rest)
  // Hot weather (>30°C): 0.3 L/hour (heavy sweating)
  // Running: 0.4 L/hour
  // Running in heat: 0.8 L/hour (can be lethal in <3 hours without water)

  // Restoration:
  // Drinking water: +volume consumed (up to 0.5L per drink action)
  // Eating juicy fruit: +0.1-0.3L per fruit (watermelon, berries, etc.)
  // Rain: can collect in containers, or drink from streams/rivers

  // ── Stamina ───────────────────────────────────────────────────────────────
  stamina: number                    // 0-100 (percentage of maximum)
  maxStamina: number                 // depends on fitness level (see training below)
  // Stamina = short-burst energy (anaerobic capacity)
  // Real-world analogy: how long you can sprint before gasping

  // Drain rates:
  //   Running: -10/second (can sprint ~10 seconds when full)
  //   Jumping: -15 per jump
  //   Mining (each swing): -5 per swing
  //   Swimming (each stroke): -3 per stroke
  //   Climbing: -8/second
  //   Holding heavy object: -2/second

  // Recovery:
  //   Standing still: +5/second
  //   Walking: +2/second (slow recovery while moving)
  //   Sitting/resting: +8/second
  //   At 0 stamina: player cannot run, jump, or swing tools until stamina > 20
  //   Recovery blocked if: calories = 0 OR hydration < 1.0 OR bodyTemperature < 30°C

  // ── Body Temperature ──────────────────────────────────────────────────────
  bodyTemperature: number            // °C (normal: 37°C)
  // Regulated by the body + clothing + environment

  // Heat gain:
  //   Metabolism: proportional to activity level (running generates heat)
  //   External heat: fire, hot environment, hot objects
  //   Clothing insulation: traps body heat

  // Heat loss:
  //   Convection: wind carries heat away (wind chill from §6)
  //   Radiation: body radiates heat to cold surroundings
  //   Evaporation: sweating (only works if humidity < 0.9)
  //   Conduction: touching cold surfaces (standing in snow, swimming in cold water)

  // dT_body/dt = (heatGeneration - heatLoss) / bodyThermalMass
  // bodyThermalMass ≈ 3.5 kJ/(kg·°C) × bodyMass
  // Clothing adds insulation: reduces heatLoss by warmth factor

  // Danger zones:
  //   > 40°C: heat exhaustion (vision blur, stamina drain ×3)
  //   > 42°C: lethal (heat stroke, organ failure — see §8.2)
  //   < 35°C: hypothermia (shivering, stamina drain ×2, movement slow)
  //   < 28°C: lethal (cardiac arrhythmia — see §8.2)

  // ── Sleep / Fatigue ───────────────────────────────────────────────────────
  fatigue: number                    // 0-100 (0 = fully rested, 100 = exhausted)
  // Fatigue accumulates at ~6.25/game-hour of wakefulness (100 in ~16 game-hours = ~4 real hours)
  // Real human: can stay awake ~16 hours comfortably — at 4× time, that's 4 real hours
  // The player must sleep their character every ~4 real hours of play

  // Effects of high fatigue:
  //   50-70: stamina recovery rate halved, crafting success rate -10%
  //   70-85: vision darkening at edges, movement speed -15%, reaction time +50%
  //   85-95: hallucinations possible (visual glitches), random stumbling
  //   95-100: forced sleep (player collapses where they are — vulnerable to everything)

  // Sleep:
  //   Player must find a safe place and use "sleep" action
  //   Sleep duration: minimum 6 game-hours for full rest (~1.5 real hours)
  //   Fatigue recovery: -12/game-hour while sleeping (full rest in ~8 game-hours = 2 real hours)
  //   The player can skip the wait: "Sleep" action fast-forwards the character's sleep
  //   while the world continues. Player sees a dark screen with time passing indicator.
  //   They can wake early (partial rest) or be woken by events (damage, loud sounds).
  //   Fast-forward compresses 8 game-hours into ~30 real seconds of black screen + time display.
  //   Interrupted sleep: player can be woken by damage, loud sounds, NPC interaction
  //   Sleeping outdoors: vulnerable to weather, predators, other players
  //   Sleeping in shelter: protected, faster recovery (+15/game-hour)

  // ── Health / Hit Points ───────────────────────────────────────────────────
  health: number                     // 0-100
  // This is NOT an abstract HP bar. It represents overall body integrity.
  // Damage comes from: physical injury (§8.4 injury system), disease, poison, starvation
  // Health regeneration: 0.5 HP/hour when well-fed, hydrated, rested, warm
  // At 0 health: death (§8.2)
}
```

#### Food and Nutrition

```
FoodSystem {
  // Food is a MaterialPacket with nutritional properties derived from composition.
  // There are no "food items" — there are materials that happen to be edible.

  // Edibility is a material property:
  //   Organic materials (plant matter, meat, fish) → edible
  //   Minerals, metals, wood → not edible (eating them causes damage or nothing)

  // Caloric content (kcal per kg) — derived from material composition:
  //   Raw meat: ~1500 kcal/kg
  //   Cooked meat: ~2500 kcal/kg (cooking breaks down proteins → more digestible)
  //   Raw fish: ~1000 kcal/kg
  //   Berries: ~500 kcal/kg
  //   Grain: ~3500 kcal/kg (very calorie-dense when processed)
  //   Nuts: ~6000 kcal/kg (highest calorie density)
  //   Root vegetables: ~800 kcal/kg

  // Cooking effect:
  //   Heating food above 70°C for sufficient time:
  //   - Increases digestibility (caloric content ×1.5-2.0)
  //   - Kills bacteria (eliminates food poisoning risk)
  //   - Changes material properties (texture, color, moisture)
  //   Overcooking (>200°C): burns food → reduces calories, produces carcinogens
  //   Charred food: ~100 kcal/kg (mostly carbon)

  // Food poisoning:
  //   Raw meat has a bacterial load that grows over time (see §8.2 infection model)
  //   Fresh raw meat (just killed): low risk
  //   Meat left in warm environment for hours: high risk
  //   Preserved meat (salted, smoked, dried): low risk indefinitely
  //   Spoilage rate: bacterialGrowth = initialLoad × e^(growthRate × time × temperatureFactor)
  //     temperatureFactor = 0 below 4°C (refrigeration), 1.0 at 37°C, 0.5 above 60°C

  // Water content in food:
  //   Fruits: 0.8-0.95 (eating fruit provides hydration)
  //   Meat: 0.6-0.75
  //   Grain: 0.10-0.15
  //   Dried meat: 0.05-0.10 (preserved but provides no hydration)
}
```

#### Physical Strength and Training

```
CharacterFitness {
  // The character has physical attributes that improve with use — like real muscles.
  // These are HIDDEN stats (the player never sees numbers).

  strength: number                   // 0.5–1.0 (affects dig rate, carry capacity, melee force)
  endurance: number                  // 0.5–1.0 (affects max stamina, stamina recovery rate)
  speed: number                      // 0.5–1.0 (affects walk/run/swim speed)

  // Starting values: all 0.5 (untrained human)
  // Maximum: 1.0 (peak human fitness — Olympic athlete level)
  // Training rate: extremely slow, like real life
  //   Each relevant action adds a tiny amount:
  //   Mining, carrying heavy loads → strength += 0.0001 per action
  //   Running, swimming → endurance += 0.0001 per sustained minute
  //   Sprinting → speed += 0.0001 per sprint burst
  //   At this rate: reaching 0.7 from 0.5 takes ~2000 actions (~hours of gameplay)
  //   Reaching 1.0 takes ~5000 actions (~days of gameplay)

  // Decay: fitness decays if not used
  //   -0.00005 per game-day for unused attributes (very slow)
  //   A player who stops running for many game-days slowly loses speed
  //   Minimum: never drops below 0.5 (baseline human capability)

  // Real-world limits: the maximum (1.0) represents what a real human body can achieve
  //   Max carry: ~60 kg comfortably (short distances more, but stamina drains fast)
  //   Max sprint speed: ~10 m/s (Usain Bolt: 12.4 m/s — 1.0 speed gets close)
  //   Max sustained run: ~4 m/s for hours (marathon pace)
  //   Max breath hold: ~90 seconds (trained ~120s)
  //   These caps are hard limits — no training exceeds peak human performance
}
```


### 7.3 Inventory — Clothing Determines Capacity

#### The Principle

In real life, you carry things in your pockets, your hands, a bag, or a backpack. A person wearing only pants has two small pockets. A person wearing a jacket has more pockets. A person with a backpack can carry much more. The inventory system mirrors this exactly. There is no abstract "inventory" with 40 slots — your carrying capacity is determined by **what you are wearing**.

#### Inventory Structure

```
PlayerInventory {
  // ── Equipped clothing determines available slots ──────────────────────────
  clothing: {
    head:       ClothingItem | null    // hat, helmet → 0 slots (protection only)
    torso:      ClothingItem | null    // shirt, jacket → 0-4 internal pockets
    legs:       ClothingItem | null    // pants → 2 pockets standard
    feet:       ClothingItem | null    // shoes, boots → 0 slots (protection only)
    back:       ClothingItem | null    // backpack, satchel → 4-20 slots
    belt:       ClothingItem | null    // tool belt → 2-4 slots (tools only)
    hands:      ClothingItem | null    // gloves → 0 slots (hand protection)
  }

  // ── Hands (always available) ──────────────────────────────────────────────
  leftHand:     ItemSlot               // always 1 slot — can hold 1 object
  rightHand:    ItemSlot               // always 1 slot — can hold 1 object or tool

  // ── Slots from clothing ───────────────────────────────────────────────────
  pocketSlots:  ItemSlot[]             // from pants + torso pockets
  backpackSlots: ItemSlot[]            // from back-worn container
  beltSlots:    ItemSlot[]             // from belt (tool-only slots)
}

ClothingItem {
  material: MaterialPacket             // what it's made of (affects durability, warmth, weight)
  slots: number                        // how many inventory slots it provides
  slotCapacity: number                 // max weight per slot (kg) — pockets hold less than backpack
  warmth: number                       // °C of insulation (reduces heat loss to environment)
  waterResistance: number              // 0-1 (leather = 0.7, woven cloth = 0.2, fur = 0.5)
  durability: number                   // 0-1 (wears out from use, weather, damage)
  slotType: 'any' | 'tools_only'      // belt slots only hold tools
}

ItemSlot {
  content: MaterialPacket | null       // what's in this slot
  maxWeight: number                    // kg — determined by clothing's slotCapacity
  // Pocket slots: maxWeight = 0.5 kg (small items only)
  // Backpack slots: maxWeight = 5.0 kg per slot
  // Hand slots: maxWeight = player's carry strength (see §8.11 character body)
  // Belt slots: maxWeight = 2.0 kg (tool weight)
}
```

#### Starting State (New Player)

A new player spawns with minimal clothing:
- Basic cloth pants (2 pocket slots, 0.5 kg each)
- Basic cloth shirt (0 pockets)
- No shoes, no backpack, no belt
- **Total capacity: 2 pocket slots + 2 hands = 4 items max**

The first priority for a new player is making better clothing and a carrying container. This is the real-world equivalent of "you wake up with nothing — first thing you do is figure out how to carry stuff."

#### Material Packets in Inventory

Every item in inventory IS a MaterialPacket (§3.3). It has composition, mass, temperature, and phase.

```
Inventory rules for MaterialPackets:
  // Temperature: items in inventory gradually equalize to body temperature (37°C)
  // Rate: Newton's law of cooling, k = 0.001 (slow — a hot rock stays warm for minutes)
  // A player carrying a torch keeps it warm. A player carrying ice watches it melt.
  item.temperature += (37 - item.temperature) × 0.001 × dt

  // Phase changes: if a solid item's temperature exceeds its melting point while in inventory,
  // it becomes liquid. Liquid in a pocket = disaster (leaks out, inventory slot ruined until dried).
  // Hot items can burn the player: if item.temperature > 60°C → injury to carrying body region.

  // Weight: total carried weight affects movement speed and stamina drain
  totalCarriedWeight = sum(all inventory items' mass + clothing mass)
  movementSpeedMultiplier = max(0.3, 1.0 - totalCarriedWeight / maxCarryWeight)
  staminaDrainMultiplier = 1.0 + totalCarriedWeight / maxCarryWeight
```

#### Liquid and Container Rules

```
LiquidInInventory {
  // You CANNOT carry liquid without a container.
  // If you try to pick up water with bare hands → you scoop some but it drains quickly
  // (hands are a very temporary container — ~0.2 liters, leaks at 0.1 L/s)

  // Containers are items with an internal volume:
  Container {
    material: MaterialPacket           // what the container is made of (clay, wood, leather, metal)
    maxVolume: number                  // liters — clay pot: 2L, bucket: 8L, waterskin: 1L
    currentVolume: number              // how full it is
    contents: MaterialPacket | null    // the liquid inside (composition, temperature)
    sealed: boolean                    // sealed containers don't spill when tilted/carried
    porosity: number                   // how quickly liquid seeps through (clay: low, basket: high)
  }

  // Fill amount is controllable: player can partially fill a container
  // The fill level is set by how long they hold the pour/scoop action

  // Carrying an unsealed container:
  // - Walking: no spill if container is < 90% full
  // - Running: spills if > 70% full (sloshing)
  // - Jumping: spills if > 50% full
  // - Inverting (looking down): spills everything

  // Container contents are ephemeral (see §8.3):
  // On server restart, containers are empty. The container itself persists.
}
```

#### Stacking Rules

```
StackingRules {
  // Two items can occupy the same inventory slot ONLY if:
  // 1. They are the same phase (both solid)
  // 2. They are loose materials (ore chunks, dirt, sand, grain — not tools or crafted objects)
  // 3. Combined weight ≤ slot's maxWeight

  // IMPORTANT: Stacking does NOT merge composition.
  // Two copper ore chunks in the same slot are still two separate objects.
  // They have independent composition (one might be 85% Cu, the other 91% Cu).
  // They just share a slot for convenience, like putting two rocks in your pocket.

  // To actually merge them into one object, the player must:
  // 1. Melt both (they become liquid SPH particles)
  // 2. Mix in the same container (compositions merge by mass-weighted average)
  // 3. Cool/solidify (becomes one solid with the blended composition)

  // This is physically accurate: there is no such thing as 100% pure anything.
  // Real copper ore is 0.5-5% copper mixed with rock, sulfur, and other minerals.
  // The purity of the player's refined metal depends on their smelting process quality.

  // Tools, clothing, containers: NEVER stack. Each is a unique crafted object.
  // A stone axe and another stone axe are in separate slots (different wear, different edge).
}
```

#### Inventory UI Appearance

```
InventoryUI {
  // When player presses I (inventory key):
  // The UI shows a silhouette of the player's body with clothing slots around it

  // Layout:
  //   [Head]          ← clothing slot (click to equip/unequip)
  //   [Torso]         ← clothing slot
  //   [Left Hand] [Right Hand]  ← always visible, shows held items
  //   [Legs]          ← clothing slot
  //   [Feet]          ← clothing slot
  //   [Belt]          ← tool belt slots shown below waist
  //   [Back]          ← backpack contents shown as grid on the side

  // Pocket slots appear as small squares near the pants/jacket
  // Backpack slots appear as a grid panel on the right
  // Empty slots are dark/locked if no clothing provides them

  // Each slot shows:
  // - A small icon of the item (or material color blob for raw materials)
  // - Weight in bottom corner
  // - Temperature indicator if not ambient (red = hot, blue = cold)
  // - Fill level bar if it's a container with liquid
}
```


### 7.4 Terrain Interaction — Digging & Building

#### The Principle

Terrain is not an indestructible backdrop. It is made of materials with physical properties. Dirt can be dug with bare hands (slowly). Rock requires tools and enormous effort. Sand shifts when disturbed. The difficulty of modifying terrain is determined entirely by the material properties of the terrain and the tool being used — not by an arbitrary "dig speed" stat.

#### Digging

```
DigSystem {
  // A player swings a tool at terrain. The server computes what happens.

  // ── Dig rate formula ──────────────────────────────────────────────────────
  // digVolume = (toolEfficiency × playerStrength × swingEnergy) / terrainResistance
  //
  // Where:
  //   toolEfficiency: depends on tool type × terrain type match
  //     bare hands on dirt: 0.3
  //     bare hands on rock: 0.001 (nearly impossible)
  //     wooden shovel on dirt: 0.8
  //     stone pickaxe on rock: 0.15
  //     iron pickaxe on rock: 0.4
  //     iron shovel on dirt: 1.0
  //
  //   playerStrength: 0.5–1.0 based on character fitness (see §8.11)
  //     newPlayer: 0.5, trained player: 0.8, maximum human: 1.0
  //
  //   swingEnergy: kinetic energy of the tool swing (joules)
  //     = 0.5 × toolMass × swingSpeed²
  //     A 2kg iron pickaxe swung at 5 m/s = 25 J per hit
  //
  //   terrainResistance: derived from material properties
  //     dirt: 50 (easy to move)
  //     sand: 30 (very easy but collapses)
  //     wet clay: 80 (sticky, heavy)
  //     dry clay: 200 (hard and crumbly)
  //     sandstone: 500
  //     limestone: 800
  //     granite: 2000 (very hard)
  //     basalt: 2500
  //     obsidian: 3000
  //     iron ore vein: 1500

  // Result: digVolume in cm³ per swing
  // A player with an iron pickaxe (efficiency 0.4, strength 0.7, energy 25J) hitting granite (2000):
  // digVolume = (0.4 × 0.7 × 25) / 2000 = 0.0035 m³ = 3.5 cm³ per swing
  // At 1 swing per second, digging 1 cubic meter of granite takes ~285 seconds ≈ 5 minutes
  // Dirt with bare hands: (0.3 × 0.5 × 5) / 50 = 0.015 m³ per swing = 15 cm³
  // 1 cubic meter of dirt with bare hands: ~67 seconds ≈ 1 minute

  // ── Debris physics ────────────────────────────────────────────────────────
  // Each dig swing produces debris particles:
  // The removed volume spawns as MaterialPacket objects in the world
  // These are physical objects: they arc through the air, bounce, scatter, settle
  // The player's swing direction determines the throw direction
  // Debris mass = terrain density × digVolume
  // Velocity = swing direction × tool speed × 0.3 (30% energy transfers to debris)

  // ── Depth limits (physical, not arbitrary) ────────────────────────────────
  // There is no code-enforced depth limit. You can theoretically dig to the core.
  // But physics makes it increasingly impossible:
  //
  // Depth 0-50m: normal digging. Dirt, rock, occasional ore.
  // Depth 50-200m: temperature rises (geothermal gradient: +25°C per km depth)
  //   At 200m: ambient temp = surface + 5°C. Manageable.
  // Depth 200-1000m: rock gets harder (pressure compaction). Tools wear faster.
  //   At 1km: ambient temp = surface + 25°C. Getting hot.
  // Depth 1-5km: extreme pressure. Only the hardest tools work.
  //   Player needs cooling equipment. Cave-ins become a risk.
  //   Air gets thin (ventilation needed for oxygen).
  // Depth 5-10km: temperature exceeds 100°C. Water boils. Player takes heat damage.
  //   This requires advanced technology (insulated suits, ventilation, reinforced tunnels).
  // Depth >10km: approaching mantle temperatures (1000°C+). Effectively impossible
  //   without extreme late-game technology.
  //
  // No player in normal gameplay will dig deeper than a few hundred meters.
  // The physics naturally prevents griefing — digging is HARD and gets harder.

  // ── Cave-in mechanics ─────────────────────────────────────────────────────
  // Unsupported ceilings can collapse:
  // Each terrain block has a structural integrity value
  // When surrounding support is removed (adjacent blocks dug out), integrity drops
  // If integrity < threshold → ceiling block falls (becomes debris, damages anything below)
  // Support structures (wooden beams, stone pillars) prevent cave-ins
  // This is why real mines use pit props — the game requires the same
}
```

#### Building and Placing

```
BuildSystem {
  // Building is the physical act of placing objects in the world.
  // There is no "build mode" grid or snapping system. You hold an object and put it down.

  // ── Holding and placing ───────────────────────────────────────────────────
  // Player holds an object in their hands (visible in first-person view)
  // They aim at where they want to place it
  // Server validates: is the position reachable? Is there ground to place on?
  // Object is placed at the aimed position with the current orientation

  // Rotation: player can rotate the held object before placing
  // Using mouse scroll or Q/E keys to rotate in 15° increments
  // Free rotation, not grid-snapped — like putting a rock down in real life

  // ── Physics validation ────────────────────────────────────────────────────
  // Placed objects obey gravity. You cannot place a stone floating in midair.
  // If you place a block with nothing underneath, it falls.
  // Stacking: objects can be stacked if the lower object can support the weight
  //   stone wall on dirt foundation: stable
  //   stone wall on sand: might sink or tilt over time
  //   stone wall on stone: stable

  // ── Bonding materials ─────────────────────────────────────────────────────
  // Simply stacking objects creates a loose structure (can be knocked over, blown by storm)
  // To create a solid structure, materials must be bonded:
  //   Mud/clay mortar: smear between stones → dries → holds (weak bond, dissolves in rain)
  //   Lime mortar: calcium oxide + water → strong bond (Roman concrete recipe)
  //   Concrete: cement + aggregate + water → very strong bond (requires kiln for clinite)
  //   Wooden joinery: notches, pegs, lashing with rope → moderate bond
  //   Metal fasteners: nails, bolts, brackets → strong bond (requires smithing)

  // ── Machines and heavy objects ────────────────────────────────────────────
  // Objects too heavy to carry by hand:
  //   Use a lever (physics: force × distance = load × distance)
  //   Use a ramp/inclined plane (reduces force needed at cost of distance)
  //   Use a pulley system (mechanical advantage from multiple rope runs)
  //   Use a cart (wheel + axle reduces friction)
  //   Multiple players can carry together (each contributes their strength)
  //   These are real physics — the game computes whether the applied force
  //   exceeds the object's weight × friction. If yes, it moves. If no, it doesn't.
}
```


### 7.5 Combat — Physics-Based Damage

#### The Principle

Combat is not a separate system. It is what happens when a moving object contacts a body. A pickaxe swing that hits a wolf deals damage because of kinetic energy, not because there's a "weapon damage" stat. The same pickaxe hitting terrain digs rock. The same pickaxe hitting a player deals the same physics-based damage. There are no "weapons" — there are tools that happen to be dangerous when swung at a living thing.

#### Damage Calculation

```
PhysicsDamage {
  // Any rigid body collision with a character (player or NPC or animal) computes damage:

  // Kinetic energy of impact:
  // KE = ½ × m × v²
  // where m = mass of the striking object (kg), v = velocity at contact (m/s)

  // Damage to the hit region:
  // baseDamage = KE / damageThreshold
  // damageThreshold = how much energy the body region can absorb before injury
  //   Head: 15 J (very vulnerable — a 1kg rock at 5.5 m/s is lethal)
  //   Torso: 50 J (ribcage protects organs)
  //   Arms: 30 J
  //   Legs: 40 J

  // Armor/clothing reduces damage:
  // effectiveDamage = baseDamage × (1 - armorAbsorption)
  //   Bare skin: absorption = 0.0
  //   Cloth: absorption = 0.05 (almost nothing)
  //   Leather: absorption = 0.2
  //   Hardened leather: absorption = 0.35
  //   Copper armor: absorption = 0.5
  //   Iron armor: absorption = 0.7
  //   Steel armor: absorption = 0.85

  // Hit region determined by collision point:
  // Raycast from tool/projectile → character mesh → which body region (§8.4 injury system)
  // Head hits deal more damage (lower threshold) AND have additional effects (daze, vision blur)

  // Tool sharpness matters:
  //   A sharp flint edge concentrates force into a small area → higher pressure → more tissue damage
  //   sharpnessFactor = 1.0 + (toolSharpness × 0.5)  // dull tool: ×1.0, razor sharp: ×1.5
  //   Sharpness degrades with use (blade dulls after N impacts)

  // Examples:
  //   Stone axe (2kg) swung at 4 m/s at an unarmored torso:
  //     KE = 0.5 × 2 × 16 = 16 J, baseDamage = 16/50 = 0.32 (32% of torso health)
  //   Iron sword (1.5kg) swung at 6 m/s at a leather-armored arm:
  //     KE = 0.5 × 1.5 × 36 = 27 J, base = 27/30 = 0.9, ×(1-0.2) = 0.72 (72% arm health)
  //   Thrown rock (0.5kg) at 8 m/s hitting unarmored head:
  //     KE = 0.5 × 0.5 × 64 = 16 J, base = 16/15 = 1.07 (instant lethal to head)
  //   Fist punch (~0.7kg fist at 5 m/s) to unarmored torso:
  //     KE = 0.5 × 0.7 × 25 = 8.75 J, base = 8.75/50 = 0.175 (17.5% — hurts but not lethal)
}
```

#### PvP Toggle

```
PvPSystem {
  // Each player has a PvP toggle: ON or OFF
  // Default: OFF (new players are protected)

  // PvP OFF:
  //   Other players' attacks pass through you (no collision for damage purposes)
  //   You cannot deal damage to other players either
  //   You CAN still be damaged by: animals, falls, environment, starvation, etc.
  //   You CANNOT be robbed (dropped items during trade are still physics objects though)
  //   Your shelter territory is always protected regardless of PvP state

  // PvP ON:
  //   Full physics damage from other PvP-ON players
  //   You can attack and be attacked
  //   Dropped items on death are lootable by anyone
  //   Risk/reward: PvP-ON players can fight for resources, defend territory, raid

  // Toggle cooldown: switching PvP state takes 30 game-seconds (7.5 real seconds)
  //   This prevents exploits: can't toggle OFF mid-fight to avoid a killing blow
  //   Visual indicator: PvP-ON players have a subtle red glow on their character border
  //   (visible to other players, so you know who can hurt you)

  // Settlement territory: always safe. PvP damage is disabled within any settlement's territory.
  // Shelter territory: always safe. PvP damage is disabled within the shelter owner's territory.
}
```

#### Tool Grip — Player-Defined Hold Points

```
ToolGripSystem {
  // When a player crafts a tool (§8.14 precision craft mode), they don't just
  // create a tool — they also define HOW to hold it.

  // After crafting, the player enters "grip setup":
  //   The tool floats in front of them (precision mode view)
  //   Player clicks to place grip points:
  //     Click 1: primary hand position (where the dominant hand grabs)
  //     Click 2: secondary hand position (for two-handed tools — optional)
  //   Player can also set the "business end" (which end is the blade/head):
  //     Click 3: strike point (the part that hits things)

  // This means:
  //   A player who makes a stone axe decides where the handle is gripped
  //   and which end is the cutting edge
  //   Two players making axes from the same materials might hold them differently
  //   The grip position affects swing arc, leverage, and effective force

  // Grip stored with the tool:
  ToolGrip {
    primaryGrip: Vec3                  // local-space position on tool mesh where hand goes
    secondaryGrip: Vec3 | null         // second hand (null for one-handed tools)
    strikePoint: Vec3                  // which end hits things
    handedness: 'right' | 'left'       // which hand holds it (player preference)
  }

  // During use: IK positions the player's hand bones to the grip points on the tool mesh
  // The tool moves with the hand, and the hand moves with the animation
  // Strike point determines where damage/dig is applied on impact
}
```


### 7.6 Death, Respawn & Loot

#### What Happens Physically When a Player Dies

Death is not an abstract game state — it is a physical event. The player's body collapses, items scatter, and the world continues without them.

#### The Death Sequence (Server-Authoritative)

The entire death sequence is controlled by the server. The client receives events and renders them, but cannot fabricate or skip any step.

```
DeathEvent {
  // Server generates this when player health reaches 0
  playerId: string
  causeOfDeath: DeathCause           // 'starvation' | 'hypothermia' | 'drowning' | 'fall' | 'burn' | 'infection' | 'attack' | 'poison'
  deathPosition: Vec3                // world-space position where the player died
  deathTimestamp: number             // server monotonic clock (ms)
  droppedItems: DroppedItem[]        // what fell out of inventory (server-determined)
  corpseId: string                   // unique ID for the corpse entity
}

DroppedItem {
  itemId: string                     // references the MaterialPacket or tool
  worldPosition: Vec3                // where it lands (deathPosition + random scatter offset)
  velocity: Vec3                     // initial physics velocity (items tumble outward from body)
  despawnTimestamp: number            // server clock + 300,000ms (5 minutes)
}
```

**Step 1 — Item Drop Calculation (server-side)**

The server determines what drops using a seeded random from the server clock + playerId hash. The drop rules:

- **Drop count:** `floor(inventorySize × dropRate)` where `dropRate` is a random value between **0.05 and 0.20** (5%–20% of inventory slots). A player with 30 items drops 1–6 items.
- **Selection:** Random without replacement. Each slot has equal probability. Tools the player is currently holding have **2× weight** (you drop what's in your hands when you die — real-world physics).
- **Scatter physics:** Each dropped item spawns at `deathPosition + randomUnitVector × radius` where `radius ∈ [0.5m, 2.0m]`. Initial velocity: `randomDirection × 1.5 m/s + upward 2.0 m/s` (items tumble outward and fall). After spawning, items are standard physics entities — they roll downhill, settle in crevices, can fall into water.
- **What NEVER drops:** The player's discovery knowledge (stored in DB, not inventory). Their shelter registration. Their practice counters. Only physical items drop.

```
// Server-side drop calculation
function calculateDrops(player: Player, serverRng: SeededRandom): DroppedItem[] {
  const dropRate = 0.05 + serverRng.next() * 0.15          // 5-20%
  const dropCount = Math.max(1, Math.floor(player.inventory.length * dropRate))

  // Build weighted pool: held items get 2× weight
  const pool: WeightedSlot[] = player.inventory.map((item, i) => ({
    item, weight: (i === player.equippedSlot) ? 2.0 : 1.0
  }))

  const drops: DroppedItem[] = []
  for (let i = 0; i < dropCount; i++) {
    const selected = weightedRandomRemove(pool, serverRng)
    const angle = serverRng.next() * Math.PI * 2
    const dist = 0.5 + serverRng.next() * 1.5
    drops.push({
      itemId: selected.item.id,
      worldPosition: vec3Add(player.position, [Math.cos(angle) * dist, 0.3, Math.sin(angle) * dist]),
      velocity: [Math.cos(angle) * 1.5, 2.0, Math.sin(angle) * 1.5],
      despawnTimestamp: Date.now() + 300_000   // 5 minutes
    })
  }
  return drops
}
```

**Step 2 — Corpse Entity**

The corpse is a server-managed entity with a fixed lifetime:

```
CorpseEntity {
  corpseId: string
  playerId: string                   // whose corpse this is
  position: Vec3                     // death location
  rotation: Quaternion               // body orientation (falls in direction of last movement)
  poseState: 'collapsed'             // ragdoll at death, then settles
  spawnTimestamp: number
  despawnTimestamp: number            // spawnTimestamp + 60,000ms (1 minute)
  skeletalPose: Float32Array         // final bone positions from ragdoll settling
}
```

- **Duration:** 60 seconds after death, the corpse fades out over 3 seconds and is removed from the server entity list.
- **Duplicate prevention:** If the same `playerId` dies again while a previous corpse exists, the old corpse is **immediately removed** (server deletes the old CorpseEntity before creating the new one). This prevents a player dying repeatedly in the same spot from filling the server with corpse entities.
- **Rendering:** The client renders corpses as the full player body model (same skeleton rig as §8.4) in a collapsed ragdoll pose. The pose is calculated once on the server when death occurs (simple ragdoll settle: body falls, limbs sprawl based on terrain slope) and sent as a static skeletal pose. No ongoing ragdoll physics — just a frozen body.

**Step 3 — Dropped Item World Entities**

Dropped items become standard world entities visible to all players within render distance:

- **Physics:** After initial scatter velocity, items are simulated as rigid bodies. They bounce off terrain, roll downhill, can fall into water (where they sink or float depending on density — a wooden tool floats, a stone axe sinks).
- **Pickup:** Any player can pick up any dropped item by walking within **1.5m** and pressing the interact key. Server validates proximity and item existence before granting the item. First valid pickup request wins.
- **Despawn:** Each item has an independent 5-minute timer from spawn. When the timer expires, the server removes the entity and broadcasts removal. Items do NOT persist across server restarts.
- **Stacking:** If items land on the same spot, they pile up visually. No special stacking logic — just physics objects resting on each other.

**Step 4 — Respawn**

```
RespawnSequence {
  deathTimestamp: number
  respawnDelay: 10_000               // 10 seconds, constant
  respawnPosition: Vec3              // player's registered shelter position (from database)
  adSlotWindow: [2_000, 8_000]      // milliseconds 2-8 after death: available for ad display (future)
}
```

- **What the player sees:** Screen fades to black over 1 second. For the next 10 seconds, the player sees a minimal UI: death cause text ("You froze to death"), a countdown timer, and (future) an ad slot in the center.
- **Respawn location:** The player's registered shelter (stored in the database).
- **State on respawn:** Full health, full hunger/thirst/energy (you "rested" while dead), same discovery knowledge, same practice counters, inventory minus whatever dropped. The player is not punished twice — the item loss IS the punishment.

#### Causes of Death — Physical Triggers

Each death cause maps to a real physical condition crossing a lethal threshold:

| Cause | Trigger | Physics |
|-------|---------|---------|
| Starvation | `hunger ≤ 0` for 120 continuous seconds | Glycogen depleted → organ failure |
| Dehydration | `thirst ≤ 0` for 90 continuous seconds | Blood volume drops → cardiac arrest |
| Hypothermia | `bodyTemperature < 28°C` | Core temp below threshold → heart arrhythmia. Body temp follows Newton's law of cooling: `dT/dt = -k(T_body - T_env)` where k depends on clothing insulation |
| Hyperthermia | `bodyTemperature > 42°C` | Protein denaturation → organ failure |
| Drowning | `oxygenLevel ≤ 0` while submerged | Breath-hold timer (90s base) depletes, then health drops at 20 HP/s |
| Fall damage | `impactVelocity > 8 m/s` | Damage = `mass × (v - 8)² / 2` (kinetic energy above safe threshold). Lethal above ~15 m/s (~11m fall) |
| Burn | `skinTemperature > 60°C` for sustained contact | Tissue damage rate = `k × (T - 45)²` per second. Third-degree at >70°C |
| Infection | `bacterialLoad > 10⁹` (logistic growth model) | Untreated wound → bacterial population doubles every ~4 hours at 37°C, slower when cold. Lethal when load overwhelms immune response |
| Attack | `health ≤ 0` from physical damage | Impact force from another entity (animal, player, falling object) exceeds body's structural tolerance |
| Poison | `toxinLevel > lethalDose` | LD50 per toxin type. Dose-response curve: `mortality_probability = 1 / (1 + e^(-k(dose - LD50)))` |


### 7.7 Multiplayer Conflict Resolution

There is no conflict resolution "system." There is physics. Two players interacting with the same object are two physical entities in the same space, and the simulation resolves their actions the same way it resolves any other physics interaction.

#### Resource Extraction (Mining, Gathering, Harvesting)

```
MiningInteraction {
  // A resource node is a physical object with:
  nodeHealth: number                         // starts at node's total extractable mass (e.g., 50kg copper ore)
  fragmentMass: number                       // mass per extraction hit (e.g., 0.5kg per swing)

  // When a player swings a tool at the node:
  // 1. Server validates: is the player within 2m? Is the tool appropriate? Is the swing animation complete?
  // 2. Server deducts fragmentMass from nodeHealth
  // 3. Server spawns a DroppedItem (ore fragment) at the node's surface position
  //    - The fragment has initial velocity: outward from the impact point + downward gravity
  //    - It is a standard physics entity — it falls, bounces, rolls, settles
  // 4. Server broadcasts the spawn to all nearby clients

  // Two players mining the same node simultaneously:
  // - Both hit the node. Both produce fragments. Fragments scatter in different directions.
  // - Each player must physically walk to and pick up the fragments they want.
  // - If player A's fragment rolls toward player B, player B can grab it. No ownership tag.
  // - When nodeHealth reaches 0, the node is depleted. No more fragments.
  // - Server processes mining hits in order of arrival (monotonic timestamp).
  //   If two hits arrive in the same server tick (16ms), both are processed — the node loses 2× fragmentMass.
}
```

#### Item Pickup

```
PickupProtocol {
  // Items on the ground have no owner. Anyone can pick them up.

  // Client sends: PICKUP_REQUEST { itemId, playerPosition, timestamp }
  // Server checks:
  //   1. Does the item still exist? (another player might have grabbed it already)
  //   2. Is the player within 1.5m of the item's current position?
  //   3. Is the player's inventory not full?

  // If all checks pass:
  //   - Item is removed from world entities
  //   - Item is added to the requesting player's inventory
  //   - Server broadcasts ITEM_REMOVED { itemId } to all clients
  //   - Server sends INVENTORY_UPDATE to the picking player

  // If the item no longer exists (race condition):
  //   - Server sends PICKUP_FAILED { reason: 'gone' } to the requesting player
  //   - Client shows brief feedback: the item vanishes from their screen
  //   - No retry. The item is gone. Someone else got it.

  // No locking. No reservation. No "I saw it first" system.
  // Server timestamp order determines the winner. Network latency means
  // the closer player (lower ping) has a slight advantage — same as real life
  // where the closer person reaches the object first.
}
```

#### Liquid Containers

```
ContainerPhysics {
  // A container (clay pot, bucket, trough) has:
  capacity: number                           // volume in liters
  currentVolume: number                      // how full it is
  contents: MaterialPacket                   // the liquid inside (composition, temperature)

  // Pouring liquid in:
  // 1. Player holds a container with liquid and presses "pour" while aiming at the target container
  // 2. Server creates a pour stream (SPH particles or visual) from source to target
  // 3. Target container's contents update: mass-weighted composition merge (§3.3 compounding rule)
  //    newComposition[element] = (existingMass × existingFraction[element] + addedMass × addedFraction[element]) / totalMass
  //    newTemperature = (existingMass × existingTemp + addedMass × addedTemp) / totalMass
  // 4. If two players pour simultaneously:
  //    - Both pour streams execute. The container receives both.
  //    - The three-way merge is just two sequential two-way merges (order doesn't matter — addition is commutative).
  //    - If total volume exceeds capacity, excess overflows as SPH particles that spill and flow.
}
```

#### Workstation Access

```
WorkstationAccess {
  // A workstation has a single operator slot.
  state: 'vacant' | 'occupied'
  operatorId: string | null                  // userId of current operator

  // Player presses F within 5m:
  //   If vacant: server sets operatorId = playerId, state = 'occupied'
  //              client opens WorkstationPanel
  //   If occupied: client shows "[Workstation in use by another player]"
  //               player must wait or find another workstation

  // Operator leaves (walks away >5m, presses Esc, disconnects):
  //   Server sets state = 'vacant', operatorId = null
  //   Any in-progress craft continues if it doesn't require active input
  //   (a smelt that's already started keeps going — the furnace doesn't need a babysitter)
  //   But a craft requiring active input (hammering on anvil) pauses.

  // No queue system. No reservation. You walk up, if it's free you use it.
  // Two players approaching at the same time: first WORKSTATION_USE request to reach the server wins.
}
```


### 7.8 Player-to-Player Interaction

#### Trade

```
TradeSystem {
  // There is no trade UI. Trade is physical.
  // Two players meet in the world. They drop items on the ground between them.
  // One drops copper ingots. The other drops food. Both pick up what they want.
  // Trust is implicit — there is always a risk of the other player grabbing everything.

  // This is how trade worked in the ancient world: you meet, you show your goods,
  // you exchange on the spot, and you hope the other party is honest.

  // ── Robbery risk ──────────────────────────────────────────────────────────
  // A player can grab dropped items and run. There is no enforcement.
  // This creates emergent social dynamics:
  //   - Players who rob get a reputation (other players remember)
  //   - Trading in a settlement is safer (NPCs react to violence)
  //   - Players may bring friends as guards
  //   - Remote trade (leaving items at a designated spot) is risky but possible

  // ── Friend system ─────────────────────────────────────────────────────────
  // Players can add each other as friends (mutual consent)
  // Friends can see each other's position on the map (approximate — within 50m)
  // This enables meeting up for trade or cooperative work
  // Friend list stored in player DB record
}
```

#### Communication

```
ChatSystem {
  // Players can communicate via text, but ONLY locally — not globally.
  // There is no world chat. No private messages. No radio (until invented in-game).

  // ── Proximity chat ────────────────────────────────────────────────────────
  // Player types a message (press Enter to open chat input)
  // Message appears as floating text above the player's head
  // Maximum: 500 characters
  // Visible to: all players within 30 meters
  // Duration: text fades after 10 seconds
  // Font size: scales with distance (smaller when farther away)

  // ── No remote communication ───────────────────────────────────────────────
  // Until the player invents communication technology:
  //   No global chat, no whisper, no mail
  //   To talk to someone, you must physically walk to them
  //   This is realistic: ancient humans had no way to communicate at distance
  //   Smoke signals (visible fire at distance): possible with the fire system
  //   Drums (sound carries farther than voice): possible with the sound system

  // ── Future technology unlocks ─────────────────────────────────────────────
  // Messenger pigeon (medieval): send a written note to a known location (slow, unreliable)
  // Signal fire/mirror: visible at 1-5km, binary messaging
  // Telegraph (industrial): electrical signal over wire between two connected stations
  // Radio (§9 late-game): wireless text over any distance to anyone with a receiver
  // Phone: voice communication (future, requires advanced electronics)

  // Each advancement mirrors the real history of human communication technology.
}
```


### 7.9 Swimming & Underwater

```
SwimmingSystem {
  // ── Entering water ────────────────────────────────────────────────────────
  // Transition is physical, not instant:
  // Player walks toward water → at ankle depth: footstep sounds become splashy
  // At knee depth: movement speed -20%
  // At waist depth: movement speed -40%, player starts bobbing
  // At chest depth: movement switches from walking to treading water
  // At head depth: swimming animation begins

  // ── Swimming mechanics ────────────────────────────────────────────────────
  swimSpeed: baseSpeed × speed × 0.4        // swimming is ~40% of running speed
  // Arm strokes propel forward (player presses W to swim forward)
  // Mouse aims swimming direction
  // Dive: hold shift to angle downward
  // Surface: release shift to float upward (buoyancy)

  // Stamina drain:
  //   Treading water (not moving): -2/second
  //   Swimming forward: -3/second
  //   Diving (active swim down): -5/second
  //   Sprint swimming: -8/second

  // At 0 stamina in water: player can no longer swim
  //   → starts sinking
  //   → if head goes underwater: drowning timer begins (90s base, reduced by low fitness)
  //   → player can still slowly paddle to stay afloat for a few seconds
  //   → if they reach shallow water: they can stand and recover

  // ── Underwater ────────────────────────────────────────────────────────────
  breathHold: 90                             // seconds at full stamina
  // Breath hold shortened by: low stamina (-1s per 2 stamina below 50)
  //                           exertion (-2× drain if swimming actively)
  //                           training (endurance 1.0 → 120s max)

  // When breath runs out:
  //   Health drains at 20 HP/s (drowning — see §8.2)
  //   Vision darkens from edges
  //   Player must surface or die

  // Underwater visibility: depends on water clarity
  //   Clear ocean: 30m
  //   River: 5-15m (sediment)
  //   Murky/swamp: 1-3m
  //   At depth > 20m: light dims (exponential absorption by water)

  // Underwater sound: §8.6 applies — low-pass filter at 800 Hz, speed 1500 m/s

  // ── Carried items while swimming ──────────────────────────────────────────
  // All items are still in inventory. But:
  //   Total carried weight affects buoyancy:
  //   if (totalWeight > buoyancyThreshold) → player sinks faster, swims slower
  //   Heavy tools (stone axe, iron ingot) can make swimming impossible
  //   Player can drop items to become lighter (items sink to bottom — retrievable)
  //   Wooden items float (can be recovered from surface)

  // Skill improvement: swimming frequently increases speed attribute
  // Maximum swim speed at speed=1.0: ~2.5 m/s (real competitive swimmer: ~2 m/s)
}
```


### 7.10 Lighting

#### The Principle

Light in reality comes from the sun, fire, and (later in the technology arc) artificial sources. Darkness is real — without a light source, you cannot see. The game does not have a minimum brightness. Night is dark. Caves are pitch black. Fire is survival.

```
LightingSystem {
  // ── Sun ───────────────────────────────────────────────────────────────────
  // Sun position is computed from: time of day + season (§7)
  sunAzimuth = (hourOfDay / 24) × 360 - 180          // degrees (east to west)
  sunElevation = maxElevation × sin(hourFraction × π)  // arc across sky
  // maxElevation depends on latitude + season (higher in summer, lower in winter)

  sunColor:
    dawn/dusk (elevation < 10°): warm orange [1.0, 0.5, 0.2] (Rayleigh scattering)
    midday (elevation > 40°):    white-yellow [1.0, 0.95, 0.85]
    overcast:                    dim grey [0.4, 0.42, 0.45] × cloudCover reduction

  sunIntensity:
    clear noon:    1.0 (full brightness)
    cloudy:        0.2–0.5 (diffused through clouds)
    dawn/dusk:     0.1–0.3 (low angle)
    night:         0.0 (no sun)
    moonlight:     0.02–0.05 (reflected sunlight — enough to see outlines)

  // ── Fire light ────────────────────────────────────────────────────────────
  // Every burning object is a point light source
  // Intensity proportional to fuel burn rate × combustion energy
  // Color: 1800K (candlelike warm orange) for small fires, 3000K for large fires
  // Flicker: random intensity modulation at 5-15 Hz (simulates turbulent combustion)

  fireLightRadius:
    torch:       5m radius (handheld, carried)
    campfire:    12m radius (stationary, needs fuel)
    furnace:     8m radius (contained, directional glow from opening)
    forest fire: 50m+ (out of control)

  // Light falloff: inverse square law
  // intensity_at_distance = intensity_source / (distance² + 1)

  // Shadows: fire casts dynamic shadows (Three.js shadow maps)
  // A player carrying a torch casts moving shadows on cave walls

  // ── Darkness ──────────────────────────────────────────────────────────────
  // There is no ambient minimum light. At night without a moon, without fire:
  //   outdoors: visibility ~5m (starlight only, barely anything)
  //   in a cave: visibility 0m (absolute blackness — screen is literally black)
  //   underwater at depth: visibility 0m

  // This makes fire-making the first essential survival skill.
  // A player who cannot make fire cannot explore caves, cannot see at night,
  // cannot cook food, cannot stay warm. Fire is life.

  // ── Future: artificial light sources ───────────────────────────────────────
  // Oil lamp (medieval): 8m radius, steady, needs oil fuel
  // Candle: 3m radius, very long-lasting
  // Gas lamp: 10m radius, brighter, needs refined fuel
  // Electric light (industrial era): 15m radius, no flicker, needs power
  // Each follows the same inverse-square falloff with different intensity and color temperature
}
```


### 7.11 Map & Navigation

```
NavigationSystem {
  // ── Compass ───────────────────────────────────────────────────────────────
  // The player has an innate sense of direction (the sun rises in the east)
  // A compass item (magnetized iron needle + water bowl) gives precise heading
  // Without compass: player can estimate direction from sun position and shadows
  // HUD shows: small compass indicator showing cardinal directions
  //   The needle points to magnetic north
  //   The direction the player is facing is highlighted

  // ── Map ───────────────────────────────────────────────────────────────────
  // The map is NOT a pre-revealed satellite view. It is a player-drawn map.
  // The player starts with NO map. They must explore to reveal terrain.

  // Fog of war: areas the player has never visited are blank
  // Explored areas are recorded as a rough sketch (not photorealistic)
  // Map updates as the player moves through new terrain

  // Map display (press M):
  //   Shows explored terrain as a stylized top-down view
  //   Player position: glowing dot
  //   Player facing direction: cone of light from the dot (where they're looking)
  //   Friend positions: smaller dots (if friend system active)
  //   Settlements: marked with settlement name (if visited)
  //   Rivers, mountains, coastlines: drawn as discovered

  // Map accuracy depends on the player's observation:
  //   Walking through a valley: map shows the valley floor, not the ridge above
  //   Climbing a mountain: reveals a wide area (can see far from high elevation)
  //   The map is personal — each player has their own explored map

  // ── Landmarks ─────────────────────────────────────────────────────────────
  // Players can place markers on their map (up to 20)
  // Markers have a color and short label
  // These are personal notes — other players can't see them
  // "Found copper here", "Dangerous wolves", "Good clay by this river"

  // ── Minimap ────────────────────────────────────────────────────────────────
  // A small minimap is always visible in the corner of the screen.
  // Shows top-down view of immediate surroundings (~100m radius).
  //
  // Position depends on the player's dominant hand (set in character creation):
  //   Right-handed player: minimap at BOTTOM-LEFT corner
  //   Left-handed player: minimap at BOTTOM-RIGHT corner
  // Keeps the minimap opposite the dominant hand's interaction zone.
  //
  // Content: terrain relief, water, player dot with facing cone,
  //          nearby players, settlement icons, compass ring, fog of war.
  // Only shows explored terrain — not a satellite view.
  // Toggleable in settings. Clicking it opens the full map (M key).

  // ── No GPS ────────────────────────────────────────────────────────────────
  // No waypoint arrows, no distance-to-target, no turn-by-turn
  // Navigation by memory, landmarks, sun, compass, and minimap
}
```


### 7.12 Persistence Model

#### The Two-Tier Architecture

The world has two categories of state, determined by a single principle: **did a player intentionally create this, or is it physics running on its own?** Player-created changes are sacred and permanent. Physics-in-progress is ephemeral and can be recomputed or reset.

#### Tier 1 — Permanent State (database)

These tables survive server restarts, crashes, and migrations. They are the canonical truth of the world.

```
// ── Terrain Modifications ─────────────────────────────────────────────────────
terrain_modifications {
  id:           UUID PRIMARY KEY
  world_seed:   BIGINT NOT NULL               // which world this belongs to
  chunk_x:      INT NOT NULL                  // terrain chunk coordinates
  chunk_z:      INT NOT NULL
  modification: JSONB NOT NULL                // { type: 'dig'|'fill'|'flatten', vertices: [...], depth: number }
  created_by:   TEXT NOT NULL                 // player userId who made the change
  created_at:   TIMESTAMP DEFAULT NOW()
  INDEX (world_seed, chunk_x, chunk_z)        // spatial lookup for chunk loading
}

// When a client loads a terrain chunk, the server sends: base procedural terrain (from seed) + all modifications for that chunk.
// The client applies modifications on top of procedural terrain. This means terrain generation is still deterministic from seed — modifications are a diff layer.

// ── Placed Objects ────────────────────────────────────────────────────────────
world_objects {
  id:           UUID PRIMARY KEY
  world_seed:   BIGINT NOT NULL
  object_type:  TEXT NOT NULL                 // 'container'|'workstation'|'shelter'|'wall'|'door'|'torch'|...
  subtype:      TEXT                          // 'bloomery'|'kiln'|'clay_pot'|'stone_wall'|...
  position:     FLOAT[3] NOT NULL            // world-space [x, y, z]
  rotation:     FLOAT[4] NOT NULL            // quaternion [x, y, z, w]
  placed_by:    TEXT NOT NULL                 // player userId
  placed_at:    TIMESTAMP DEFAULT NOW()
  state:        JSONB DEFAULT '{}'            // object-specific state (container contents, fuel level, etc.)
  durability:   FLOAT DEFAULT 1.0            // 0.0 = destroyed, 1.0 = pristine
  INDEX (world_seed, position)               // spatial queries via cube distance
}

// ── Resource Node Depletion (already exists) ──────────────────────────────────
resource_nodes {
  node_id:      TEXT PRIMARY KEY              // deterministic from seed + position
  world_seed:   BIGINT NOT NULL
  depleted:     BOOLEAN DEFAULT FALSE
  remaining:    FLOAT DEFAULT 1.0            // fraction remaining (1.0 = full, 0.0 = empty)
  last_mined:   TIMESTAMP
}

// ── Settlement State ──────────────────────────────────────────────────────────
settlements {
  id:           SERIAL PRIMARY KEY
  world_seed:   BIGINT NOT NULL
  name:         TEXT NOT NULL
  position:     FLOAT[3] NOT NULL
  specialty:    TEXT NOT NULL                 // 'copper_mining'|'iron_mining'|'farming'|...
  population:   INT DEFAULT 20
  // No civ_level — sophistication is derived from what NPCs have built and learned (§5)
  known_processes: TEXT[] DEFAULT '{}'       // processes NPCs have discovered: 'fire_starting', 'copper_smelting', ...
  storage:      JSONB DEFAULT '{}'           // MaterialPacket array with real compositions and masses
  trade_offers: JSONB DEFAULT '[]'           // current public trade offers
  updated_at:   TIMESTAMP DEFAULT NOW()
}

// ── Player State ──────────────────────────────────────────────────────────────
players {
  user_id:      TEXT PRIMARY KEY
  world_seed:   BIGINT NOT NULL
  inventory:    JSONB NOT NULL               // array of MaterialPacket serializations
  discoveries:  TEXT[] DEFAULT '{}'           // discovery IDs
  practice:     JSONB DEFAULT '{}'           // { "fire_friction": 47, "copper_smelt": 12, ... }
  stats:        JSONB NOT NULL               // { health, hunger, thirst, energy, stamina, bodyTemp }
  position:     FLOAT[3]                     // last known position (for offline reference)
  updated_at:   TIMESTAMP DEFAULT NOW()
}

shelters {
  id:           SERIAL PRIMARY KEY
  user_id:      TEXT NOT NULL
  world_seed:   BIGINT NOT NULL
  position:     FLOAT[3] NOT NULL
  registered_at: TIMESTAMP DEFAULT NOW()
  INDEX (user_id, world_seed)
}
```

**Write frequency:** Player state saves every **30 seconds** during active play and immediately on disconnect. Terrain modifications and placed objects save **immediately** on creation (these are rare, high-value events — a player digs maybe once per minute, not 60 times per second). Settlement state saves every **60 seconds**.

**Chunk loading protocol:** The client never generates terrain. The server is the sole authority on what the world looks like. The client receives fully computed terrain data and renders it.

When a player enters a new terrain chunk:
1. Client sends `CHUNK_REQUEST { chunkX, chunkZ }` to the server
2. Server generates the terrain for that chunk (base from seed + all modifications applied)
3. Server sends `CHUNK_DATA` back — a compressed terrain payload:

```
CHUNK_DATA {
  chunkX: number
  chunkZ: number
  // Heightmap: 64×64 grid of terrain heights (Float16 = 2 bytes each → 8 KB)
  heightmap: Float16Array[4096]
  // Material IDs per vertex: what the surface is made of (Uint8 → 4 KB)
  materialMap: Uint8Array[4096]
  // Normal map: compressed vertex normals for lighting (optional, can be computed client-side from heightmap)
  // Color tint: per-vertex color variation (Uint8×3 → 12 KB)
  colorMap: Uint8Array[12288]
  // Total per chunk: ~24 KB compressed (gzip: ~8-12 KB on wire)
}
```

4. Client builds a Three.js mesh from the received data and adds it to the scene
5. Chunks are cached on the client — no re-request until the server notifies of a modification
6. When terrain is modified (dig, build), server pushes `CHUNK_UPDATE` for affected chunks

**Bandwidth cost:**
- A player moving through the world loads ~9 chunks at a time (3×3 grid around them)
- Initial load: 9 × ~10 KB = ~90 KB (one-time on login or entering new area)
- Steady state: 0 KB/s (chunks are cached, only updates when modifications happen)
- Terrain modification: ~10 KB per updated chunk (rare events)

**Why this approach:**
- The client is truly "eyes only" — it renders what the server shows it, nothing more
- No game logic runs on the client — no terrain generation code to reverse-engineer or exploit
- The server can change terrain generation algorithms without updating clients
- Terrain modifications are seamlessly integrated — the client never sees "base + diff," it just sees terrain

#### Tier 2 — Ephemeral State (Server RAM Only)

These exist only while the server is running. On restart, they vanish.

```
// ── Active Physics Simulations ────────────────────────────────────────────────
EphemeralState {
  // SPH particles: all active liquid/gas simulations in the world
  sphParticles: Map<ParticleId, SPHParticle>     // see §3.4 for SPHParticle structure
  // typically 0–20,000 active at any time; 0 when no one is melting/pouring

  // Temperature field: materials in the world that are not at ambient temperature
  heatedObjects: Map<ObjectId, { temperature: number, coolingRate: number }>
  // a campfire heats nearby objects; when fire dies, they cool back to ambient

  // Active crafting: smelting in progress, pottery firing, etc.
  activeCrafts: Map<CraftId, { workstationId: string, startTime: number, materials: MaterialPacket[], progress: number }>

  // Dropped loot: items on the ground from player death or intentional drop
  groundItems: Map<ItemId, { packet: MaterialPacket, position: Vec3, velocity: Vec3, despawnAt: number }>

  // Weather particles: rain drops, snow flakes, dust (visual only, no persistence needed)
  // NPC pathfinding state: current waypoint, walk progress (NPCs restart their goal loop from idle on server restart)
}
```

**What happens on server restart:**
- All SPH particles vanish. Any liquid that was mid-flow is gone. Rivers and ocean return to their static/shader state. This is acceptable because liquid simulations are short-lived events (a pour takes 5 seconds, lava flow takes 30 seconds).
- All heated objects snap to ambient temperature. A forge that was at 1200°C goes cold. The player must relight it. This matches reality — if you leave a forge overnight, it's cold in the morning.
- All active crafts are lost. If a player was mid-smelt, the materials are gone (consumed but product not produced). This is the penalty for being online during a restart. Restarts should be rare and announced.
- All ground items vanish. Dropped loot from recent deaths is gone. This is acceptable — 5-minute despawn means most loot is already gone anyway.
- NPCs restart from `idle` state. They don't remember they were carrying ore to the bloomery. They start a new goal loop iteration.

#### The Boundary: When Ephemeral Becomes Permanent

Some ephemeral processes produce permanent results:

- **Smelting completes** → the output MaterialPacket is added to the player's inventory (permanent)
- **Lava cools and solidifies** → new terrain is created (terrain modification → permanent). The SPH particles that made up the lava flow are deleted, but the solidified rock they became is a permanent terrain modification.
- **Player digs a hole** → terrain modification record created (permanent). The dirt particles that flew out are ephemeral visual effects.
- **Container filled with liquid** → the container is permanent (world_objects table), but the liquid inside it is ephemeral. On restart, containers are empty. If this becomes a problem (players complain about losing stored water), we can promote container contents to permanent state later by storing composition in the container's `state` JSONB field.


### 7.13 New Player Experience — First Spawn

#### What the Player Sees on First Login

After character creation (§8.4), the player spawns in the world for the first time. This moment must be intuitive without tutorials.

```
FirstSpawnDesign {
  // ── Spawn location ────────────────────────────────────────────────────────
  // Every new player spawns at their assigned shelter.
  // Shelters for new players are clustered near each other and near an NPC settlement.
  // This ensures:
  //   1. The player is not alone — other player shelters are within 100-200m
  //   2. An NPC settlement is within 300-500m (observable from the shelter)
  //   3. Basic resources (wood, stone, water) are within 50m of spawn

  // ── The shelter ───────────────────────────────────────────────────────────
  // The default shelter is a simple house shape:
  //   4 walls (wood or clay depending on biome)
  //   A roof (thatch or wood planks)
  //   A door opening (no actual door — player can craft one later)
  //   A small yard area (5m radius around the house)
  //   A campfire in the yard (already built — gives light and warmth on first night)

  // The yard is the player's TERRITORY:
  //   PvP is disabled within the territory regardless of toggle
  //   Other players cannot modify terrain within the territory
  //   Other players CAN enter and look around (it's not invisible-walled)
  //   The owner can expand territory later by building walls/fences

  // ── What the player sees immediately ──────────────────────────────────────
  // Standing inside their shelter, looking out the door:
  //   Nearby terrain (biome-appropriate: grass, sand, snow, etc.)
  //   A few trees/rocks within arm's reach (gathering materials)
  //   Smoke rising from the campfire in the yard
  //   In the distance (~300-500m): the NPC settlement — visible huts, moving NPCs
  //   Other player shelters nearby (some may have players moving around)
  //   The sky — sun position tells time of day, weather is visible

  // ── No tutorial, no popup, no quest marker ────────────────────────────────
  // The player figures it out by doing:
  //   They see the campfire → they approach it → they feel warmth
  //   They see trees → they try to interact → they gather wood
  //   They see the NPC settlement → they walk toward it → they watch NPCs working
  //   They get hungry after a few game-hours → they look for food
  //   They notice it getting dark → the campfire becomes essential
  //
  // The companion system (§8.7) can provide subtle hints if the player
  // seems stuck (no actions for several minutes), but never explicit instructions.

  // ── Nearby resources guaranteed at spawn ──────────────────────────────────
  // The server ensures every new player shelter has within 50m:
  //   At least 3 gatherable trees (wood)
  //   At least 5 loose stones (stone tools)
  //   A water source within 100m (stream, pond, or river)
  //   Edible plants (berries, roots) within 100m
  //   Clay deposit within 200m (for pottery)
  //
  // This is not random — the spawn location selection algorithm checks for
  // resource availability before assigning a shelter position.
}
```

---


---

## 8. All UI Panels and Hotkeys


| Key | Panel            | Status                                                       |
| --- | ---------------- | ------------------------------------------------------------ |
| I   | Inventory        | Working                                                      |
| C   | Crafting         | Working (physics interactions replace recipe list)           |
| B   | Build            | Working; admin-only ecosystem dashboard also on B for admins |
| S   | Science          | Working                                                      |
| T   | Tech Tree        | Working — 10 tiers, ReactFlow graph                          |
| E   | Evolution        | Working — biological traits                                  |
| J   | Journal          | Working — discovery log with category filter                 |
| M   | Map              | Working — fog of war, compass, player dot                    |
| CHR | Character        | Working — identity, vitals, genome display                   |
| H   | Register shelter | New 2026-03-27 — saves current position as respawn point     |
| G   | Spectator camera | Admin-only 2026-03-27                                        |
| O   | Organism seeding | Admin-only 2026-03-27                                        |
| Esc | Settings         | Placeholder only                                             |


---

---

# PART VII — REFERENCES
---


---

## 9. References

These works directly inform the design and scientific grounding of Universe Sim. Each is cited in the relevant section above.

### Science & Material Properties

**CRC Handbook of Chemistry and Physics** (annual edition)
The authoritative numerical reference for every material property in `MaterialRegistry.ts` — melting points, thermal conductivity, electrical conductivity, density, ignition temperatures. All values should be traceable here.

**Mohs, Friedrich.** *Treatise on Mineralogy* (1812)
Established the 0–10 hardness scale the game uses. Each integer corresponds to a real mineral that scratches all minerals below it and is scratched by all above.

**Lotka, Alfred J.** *Elements of Physical Biology* (1925)
**Volterra, Vito.** "Fluctuations in the Abundance of a Species Considered Mathematically" — *Nature* (1926)
The two independent derivations of the predator-prey differential equations governing the organism ecosystem's population oscillations.

**Whittaker, Robert H.** *Communities and Ecosystems* (1975)
The biome classification system the game's 20 biomes are built from. Temperature on one axis, annual precipitation on the other — every biome falls out of that grid.

### Civilizational Arc & Technology History

**Dartnell, Lewis.** *The Knowledge: How to Rebuild Our World from Scratch* (2014)
The closest thing to a game design document for Universe Sim's crafting arc. Maps exactly what knowledge and materials are needed in what order to rebuild civilization from nothing. The bootstrapping problem — needing X to make Y, needing Y to make X — is documented in detail for fire, agriculture, chemistry, metallurgy, and electricity.

**Diamond, Jared.** *Guns, Germs, and Steel: The Fates of Human Societies* (1997)
The argument that geography determines civilizational outcome — not intelligence or culture. Directly informs why settlements specialize from geology, why trade emerges from comparative advantage, and why some regions develop faster than others.

**Miodownik, Mark.** *Stuff Matters: Exploring the Marvellous Materials That Shape Our Man-Made World* (2013)
Ten chapters on ten materials (steel, glass, paper, concrete, plastic, chocolate, foam, carbon, silicon, implants) — what physical properties make each one remarkable and how those properties translate into what humans could build with them. Good reference for what the properties in MaterialRegistry.ts feel like as real phenomena.

**Ricardo, David.** *On the Principles of Political Economy and Taxation* (1817)
The original statement of comparative advantage — the economic principle underlying the settlement trade system. Specialization + exchange produces more than self-sufficiency.

### Game Design & Emergence

**Koster, Raph.** *A Theory of Fun for Game Design* (2004)
The argument that fun is the act of learning the rules of a system. Physics-based discovery crafting — where players learn that dry cedar + flint makes fire — is inherently satisfying because the learning is real, not synthetic.

**Adams, Tarn.** *Dwarf Fortress* (Bay 12 Games, ongoing since 2006)
The primary precedent for material-property-driven simulation in games. Fire spreads based on ignition temperature and combustion energy. Metals melt at their actual melting points. No behavior is hardcoded — it emerges from properties.

**Freehold Games.** *Caves of Qud* (ongoing since 2015)
The only other game implementing procedural chemistry similar to what is planned here. Liquids have viscosity, reactivity, and temperature thresholds. Acid dissolves metal. Oil ignites. The design is documented in their developer posts.

**Dawkins, Richard.** *The Selfish Gene* (1976)

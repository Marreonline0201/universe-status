# Simulation Grid Phase 1 — Thermodynamics + Fire Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make fire real — player gathers tinder+wood, strikes flint, fire ignites in the simulation grid, heat spreads by Fourier conduction, player feels ambient temperature. Completes Vertical Slice 3 from the survival spec.

**Architecture:** The existing `Grid3D` (64×32×64 SharedArrayBuffer) becomes a player-local simulation volume anchored at spawn. A `GridCoords` module maps world positions to grid cells. The thermal worker is fixed to use per-material conductivity from `MaterialRegistry`. The chem worker implements the Arrhenius combustion reaction. `LocalSimManager` bridges player actions to the grid. `FireRenderer` reads hot cells and renders point lights.

**Tech Stack:** TypeScript, SharedArrayBuffer, Web Workers (Vite `?worker`), Three.js / `@react-three/fiber`, vitest

**Spec reference:** `docs/2026-03-19-survival-world-redesign.md` — Section 2 (simulation grid), Section 3 Vertical Slice 3

---

## Existing code to understand before starting

Read these files first — they define interfaces the plan builds on:

- `src/engine/Grid.ts` — `Grid3D`, `CELL_FLOATS=25`, cell layout: material=[0], temp=[1], pressure=[2], density=[3], vel=[4-6], chemicals=[7-14], quantities=[15-22], energy=[23], light=[24]
- `src/engine/constants.ts` — `THERMO` (Cp_wood=1700, k_wood=0.12, Cp_granite=790, k_granite=2.9), `PHYSICS.sigma`, `PHYSICS.R=8.314`, `CHEMISTRY.Ea_*`
- `src/engine/SimulationEngine.ts` — creates Grid3D(64,32,64), spawns 4 workers, sends `{type:'init',descriptor}`, ticks with `{type:'tick',dtSim,dtWall}`
- `src/engine/workers/thermal.worker.ts` — Fourier conduction skeleton (uses hardcoded k_water — broken)
- `src/engine/workers/chem.worker.ts` — placeholder (no reactions yet)
- `src/player/Inventory.ts` — `MAT` constants: STONE=1, FLINT=2, WOOD=3, BARK=4, FIBER=21, COAL=17
- `src/world/SpherePlanet.ts` — `terrainHeightAt(dir: THREE.Vector3): number`, `PLANET_RADIUS=2000`, `getSpawnPosition(): [number,number,number]`
- `src/rendering/SceneRoot.tsx` — creates engine, spawns player, contains resource node gather loop
- `src/store/playerStore.ts` — current player state (hunger, thirst, health, energy, fatigue, x/y/z)
- `src/ui/HUD.tsx` — renders vitals bars

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/engine/MaterialRegistry.ts` | **Create** | Per-material thermal + combustion constants |
| `src/engine/MaterialRegistry.test.ts` | **Create** | Unit tests for material lookups |
| `src/engine/GridCoords.ts` | **Create** | World ↔ grid coordinate conversion, grid origin |
| `src/engine/GridCoords.test.ts` | **Create** | Unit tests for coord math |
| `src/engine/Arrhenius.ts` | **Create** | Pure Arrhenius rate function + combustion step |
| `src/engine/Arrhenius.test.ts` | **Create** | Unit tests for reaction math |
| `src/engine/LocalSimManager.ts` | **Create** | Grid lifecycle: terrain init, ignite, placeWood, readTemp |
| `src/engine/workers/thermal.worker.ts` | **Modify** | Use per-material k/Cp from inline table |
| `src/engine/workers/chem.worker.ts` | **Modify** | Arrhenius combustion, IGNITE message handler |
| `src/engine/SimulationEngine.ts` | **Modify** | Accept + store gridOrigin, expose to LocalSimManager |
| `src/rendering/FireRenderer.tsx` | **Create** | Three.js: PointLight + mesh for cells > 400°C |
| `src/rendering/SceneRoot.tsx` | **Modify** | Wire LocalSimManager; add fire-start interaction; add `<FireRenderer>` |
| `src/store/playerStore.ts` | **Modify** | Add `ambientTemp: number` field and `setAmbientTemp` action |
| `src/ui/HUD.tsx` | **Modify** | Display ambient temperature reading |

---

## Task 1: MaterialRegistry

**Goal:** Pure lookup table mapping material IDs to thermal + combustion constants. No dependencies on Three.js or workers.

**Files:**
- Create: `src/engine/MaterialRegistry.ts`
- Create: `src/engine/MaterialRegistry.test.ts`

### Step-by-step

- [ ] **Step 1: Write the failing test**

Create `src/engine/MaterialRegistry.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { getMaterialProps, MAT_AIR, MAT_STONE, MAT_WOOD } from './MaterialRegistry'

describe('MaterialRegistry', () => {
  it('returns air properties for material 0', () => {
    const p = getMaterialProps(0)
    expect(p.k).toBeCloseTo(0.026, 3)      // THERMO.k_air
    expect(p.Cp).toBeCloseTo(1005, 0)       // THERMO.Cp_air
    expect(p.density).toBeCloseTo(1.225, 3) // kg/m³ standard air
    expect(p.ignitionTemp).toBe(Infinity)   // air doesn't ignite
    expect(p.combustionJ_kg).toBe(0)
  })

  it('returns wood properties for material 3', () => {
    const p = getMaterialProps(3)
    expect(p.k).toBeCloseTo(0.12, 3)
    expect(p.Cp).toBeCloseTo(1700, 0)
    expect(p.density).toBeCloseTo(600, 0)
    expect(p.ignitionTemp).toBeCloseTo(250, 0)
    expect(p.combustionJ_kg).toBeCloseTo(16_700_000, -5)
  })

  it('returns granite properties for material 1 (stone)', () => {
    const p = getMaterialProps(1)
    expect(p.k).toBeCloseTo(2.9, 2)
    expect(p.Cp).toBeCloseTo(790, 0)
    expect(p.density).toBeCloseTo(2700, 0)
    expect(p.ignitionTemp).toBe(Infinity)
  })

  it('falls back to air for unknown material', () => {
    const p = getMaterialProps(999)
    expect(p.k).toBeCloseTo(0.026, 3)
  })
})
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd universe-sim && npx vitest run src/engine/MaterialRegistry.test.ts
```
Expected: `Cannot find module './MaterialRegistry'`

- [ ] **Step 3: Create MaterialRegistry.ts**

Create `src/engine/MaterialRegistry.ts`:

```typescript
// MaterialRegistry — per-material thermodynamic + combustion properties.
// All values are real-world data. Sources: NIST, engineering handbooks.

export interface MaterialProps {
  k: number             // thermal conductivity (W/m·K)
  Cp: number            // specific heat capacity (J/kg·K)
  density: number       // kg/m³ at standard conditions
  ignitionTemp: number  // °C — Infinity if non-combustible
  combustionJ_kg: number // J/kg heat of combustion (0 if non-combustible)
}

// Export named constants for clarity at call sites
export const MAT_AIR   = 0
export const MAT_STONE = 1  // granite
export const MAT_FLINT = 2
export const MAT_WOOD  = 3
export const MAT_BARK  = 4
export const MAT_COAL  = 17
export const MAT_TINDER = 21 // fiber/dry plant matter — ignites easier than wood

const PROPS: Record<number, MaterialProps> = {
  // Air
  0:  { k: 0.026, Cp: 1005,  density: 1.225,  ignitionTemp: Infinity, combustionJ_kg: 0 },
  // Stone (granite)
  1:  { k: 2.9,   Cp: 790,   density: 2700,   ignitionTemp: Infinity, combustionJ_kg: 0 },
  // Flint (silica — same thermal as stone)
  2:  { k: 1.4,   Cp: 730,   density: 2650,   ignitionTemp: Infinity, combustionJ_kg: 0 },
  // Wood (dry softwood average)
  3:  { k: 0.12,  Cp: 1700,  density: 600,    ignitionTemp: 250,      combustionJ_kg: 16_700_000 },
  // Bark (drier than wood, ignites slightly easier)
  4:  { k: 0.10,  Cp: 1600,  density: 400,    ignitionTemp: 220,      combustionJ_kg: 15_500_000 },
  // Leaf/fiber (tinder — lowest ignition temperature)
  5:  { k: 0.06,  Cp: 1600,  density: 80,     ignitionTemp: 170,      combustionJ_kg: 14_000_000 },
  // Clay
  8:  { k: 1.1,   Cp: 920,   density: 1800,   ignitionTemp: Infinity, combustionJ_kg: 0 },
  // Coal — burns hot and long
  17: { k: 0.2,   Cp: 710,   density: 1300,   ignitionTemp: 350,      combustionJ_kg: 29_000_000 },
  // Fiber / dry plant tinder (materialId 21 in MAT constants)
  21: { k: 0.06,  Cp: 1600,  density: 80,     ignitionTemp: 170,      combustionJ_kg: 14_000_000 },
  // Copper
  25: { k: 400,   Cp: 385,   density: 8960,   ignitionTemp: Infinity, combustionJ_kg: 0 },
  // Iron
  15: { k: 80,    Cp: 449,   density: 7874,   ignitionTemp: Infinity, combustionJ_kg: 0 },
}

const AIR_PROPS = PROPS[0]

export function getMaterialProps(materialId: number): MaterialProps {
  return PROPS[materialId] ?? AIR_PROPS
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npx vitest run src/engine/MaterialRegistry.test.ts
```
Expected: 4 tests pass.

- [ ] **Step 5: TypeScript check**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/engine/MaterialRegistry.ts src/engine/MaterialRegistry.test.ts
git commit -m "feat: MaterialRegistry — per-material thermal + combustion constants"
```

---

## Task 2: GridCoords — World ↔ Grid Conversion

**Goal:** Pure math module. Given a grid origin in world space and cell size, convert between world positions and integer grid coordinates. Also provides O₂ initialization helper.

**Files:**
- Create: `src/engine/GridCoords.ts`
- Create: `src/engine/GridCoords.test.ts`

### Step-by-step

- [ ] **Step 1: Write the failing tests**

Create `src/engine/GridCoords.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { worldToGrid, gridToWorldCenter, isInBounds, initO2Moles } from './GridCoords'

const ORIGIN = { x: -32, y: 1996, z: -32 }  // 64×32×64 grid origin, spawn at center
const CELL_SIZE = 1.0
const GRID = { sizeX: 64, sizeY: 32, sizeZ: 64 }

describe('GridCoords.worldToGrid', () => {
  it('maps origin-corner world pos to cell 0,0,0', () => {
    const g = worldToGrid(-32, 1996, -32, ORIGIN, CELL_SIZE)
    expect(g).toEqual({ gx: 0, gy: 0, gz: 0 })
  })

  it('maps spawn world pos to grid center cell 32,4,32', () => {
    // spawn is at approximately (0, 2000, 0) — origin + (32, 4, 32) cells
    const g = worldToGrid(0, 2000, 0, ORIGIN, CELL_SIZE)
    expect(g.gx).toBe(32)
    expect(g.gy).toBe(4)
    expect(g.gz).toBe(32)
  })

  it('floors fractional positions', () => {
    const g = worldToGrid(0.9, 1996.9, 0.9, ORIGIN, CELL_SIZE)
    expect(g.gx).toBe(32)
    expect(g.gy).toBe(0)
    expect(g.gz).toBe(32)
  })
})

describe('GridCoords.gridToWorldCenter', () => {
  it('round-trips through worldToGrid', () => {
    const w = gridToWorldCenter(32, 4, 32, ORIGIN, CELL_SIZE)
    expect(w.x).toBeCloseTo(0.5, 5)
    expect(w.y).toBeCloseTo(2000.5, 5)
    expect(w.z).toBeCloseTo(0.5, 5)
  })
})

describe('GridCoords.isInBounds', () => {
  it('returns true for valid coords', () => {
    expect(isInBounds(0, 0, 0, GRID)).toBe(true)
    expect(isInBounds(63, 31, 63, GRID)).toBe(true)
  })
  it('returns false for out-of-bounds', () => {
    expect(isInBounds(-1, 0, 0, GRID)).toBe(false)
    expect(isInBounds(64, 0, 0, GRID)).toBe(false)
  })
})

describe('GridCoords.initO2Moles', () => {
  it('returns ~8.7 mol/m³ for air at 20°C 1 atm', () => {
    // n/V = P/(RT) * 0.21 = 101325/(8.314*293) * 0.21
    expect(initO2Moles(20, 101325, 1.0)).toBeCloseTo(8.72, 1)
  })
  it('returns 0 for solid material (no O2 in rock)', () => {
    expect(initO2Moles(20, 101325, 1.0, false)).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npx vitest run src/engine/GridCoords.test.ts
```
Expected: `Cannot find module './GridCoords'`

- [ ] **Step 3: Create GridCoords.ts**

Create `src/engine/GridCoords.ts`:

```typescript
// GridCoords — world ↔ grid coordinate conversion.
//
// The simulation grid is a 3D box anchored at `gridOrigin` in world space.
// Cell (gx, gy, gz) occupies the volume:
//   [origin.x + gx*cs, origin.x + (gx+1)*cs)  (and same for y, z)
// where cs = cellSize in meters.

import { PHYSICS } from './constants'

export interface GridOrigin { x: number; y: number; z: number }
export interface GridSize   { sizeX: number; sizeY: number; sizeZ: number }
export interface GridCoord  { gx: number; gy: number; gz: number }

/**
 * Convert a world-space position to grid integer coordinates.
 * Returns the cell that contains the point (floor division).
 */
export function worldToGrid(
  wx: number, wy: number, wz: number,
  origin: GridOrigin,
  cellSize: number,
): GridCoord {
  return {
    gx: Math.floor((wx - origin.x) / cellSize),
    gy: Math.floor((wy - origin.y) / cellSize),
    gz: Math.floor((wz - origin.z) / cellSize),
  }
}

/**
 * Convert grid coordinates to the world-space center of that cell.
 */
export function gridToWorldCenter(
  gx: number, gy: number, gz: number,
  origin: GridOrigin,
  cellSize: number,
): { x: number; y: number; z: number } {
  return {
    x: origin.x + (gx + 0.5) * cellSize,
    y: origin.y + (gy + 0.5) * cellSize,
    z: origin.z + (gz + 0.5) * cellSize,
  }
}

/** True if (gx, gy, gz) is within grid bounds. */
export function isInBounds(gx: number, gy: number, gz: number, grid: GridSize): boolean {
  return gx >= 0 && gx < grid.sizeX &&
         gy >= 0 && gy < grid.sizeY &&
         gz >= 0 && gz < grid.sizeZ
}

/**
 * Initial O₂ moles in an air cell using ideal gas law: n = P·V / (R·T).
 * O₂ is 21% of air by mole fraction.
 * @param tempC   cell temperature in °C
 * @param pressurePa  cell pressure in Pa
 * @param cellVolumeM3  cell volume in m³
 * @param isAir   false for solid cells (rock, etc.) which have no free O₂
 */
export function initO2Moles(
  tempC: number,
  pressurePa: number,
  cellVolumeM3: number,
  isAir = true,
): number {
  if (!isAir) return 0
  const T_K = tempC + 273.15
  const totalMoles = (pressurePa * cellVolumeM3) / (PHYSICS.R * T_K)
  return totalMoles * 0.21
}

/**
 * Compute the grid origin so the player spawn position maps to cell (halfX, groundY, halfZ).
 * groundY = 4 — spawn sits 4 cells above the grid floor.
 */
export function computeGridOrigin(
  spawnX: number,
  spawnY: number,
  spawnZ: number,
  sizeX: number,
  sizeY: number,
  sizeZ: number,
  cellSize: number,
): GridOrigin {
  void sizeY  // not needed for x/z center
  return {
    x: spawnX - (sizeX / 2) * cellSize,
    y: spawnY - 4 * cellSize,
    z: spawnZ - (sizeZ / 2) * cellSize,
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npx vitest run src/engine/GridCoords.test.ts
```
Expected: 7 tests pass.

- [ ] **Step 5: TypeScript check + commit**

```bash
npx tsc --noEmit
git add src/engine/GridCoords.ts src/engine/GridCoords.test.ts
git commit -m "feat: GridCoords — world↔grid coordinate conversion + O2 init helper"
```

---

## Task 3: Arrhenius Module — Pure Reaction Math

**Goal:** Extract reaction rate calculation and one-tick combustion step as pure functions. These run in the main thread AND in the chem worker (the worker imports this file at build time).

**Files:**
- Create: `src/engine/Arrhenius.ts`
- Create: `src/engine/Arrhenius.test.ts`

### Step-by-step

- [ ] **Step 1: Write failing tests**

Create `src/engine/Arrhenius.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { arrheniusRate, combustionStep, WOOD_Ea, WOOD_A } from './Arrhenius'

describe('arrheniusRate', () => {
  it('returns 0 below activation temperature (250°C wood ignition)', () => {
    // k is very small but not zero — check it's below a practical threshold
    const k = arrheniusRate(WOOD_A, WOOD_Ea, 200)  // 200°C
    expect(k).toBeLessThan(1e-10)
  })

  it('returns meaningful rate at 400°C (fire temperature)', () => {
    const k = arrheniusRate(WOOD_A, WOOD_Ea, 400)
    // At 400°C (~673K): k = 1e8 * exp(-125000/(8.314*673)) ≈ 0.05 /s
    expect(k).toBeGreaterThan(0.01)
    expect(k).toBeLessThan(1.0)
  })

  it('rate increases with temperature (Arrhenius is monotonic)', () => {
    const k300 = arrheniusRate(WOOD_A, WOOD_Ea, 300)
    const k500 = arrheniusRate(WOOD_A, WOOD_Ea, 500)
    expect(k500).toBeGreaterThan(k300)
  })
})

describe('combustionStep', () => {
  it('does nothing below ignition temp', () => {
    const result = combustionStep({
      materialId: 3,       // MAT.WOOD
      tempC: 200,          // below 250°C ignition
      woodFraction: 1.0,
      o2Moles: 8.0,
      cellVolume: 1.0,
      dt: 1.0,
    })
    expect(result.dTempC).toBeCloseTo(0, 3)
    expect(result.dWoodFraction).toBeCloseTo(0, 3)
    expect(result.dO2Consumed).toBeCloseTo(0, 3)
  })

  it('produces heat and consumes wood at 400°C', () => {
    const result = combustionStep({
      materialId: 3,
      tempC: 400,
      woodFraction: 1.0,
      o2Moles: 8.0,
      cellVolume: 1.0,
      dt: 1.0,
    })
    expect(result.dTempC).toBeGreaterThan(0)
    expect(result.dWoodFraction).toBeLessThan(0)   // wood consumed
    expect(result.dO2Consumed).toBeGreaterThan(0)  // O2 consumed
  })

  it('produces no heat when O2 is exhausted', () => {
    const result = combustionStep({
      materialId: 3,
      tempC: 600,
      woodFraction: 1.0,
      o2Moles: 0,       // no oxygen
      cellVolume: 1.0,
      dt: 1.0,
    })
    expect(result.dTempC).toBeCloseTo(0, 3)
  })
})
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npx vitest run src/engine/Arrhenius.test.ts
```

- [ ] **Step 3: Create Arrhenius.ts**

Create `src/engine/Arrhenius.ts`:

```typescript
// Arrhenius reaction engine — pure math functions.
//
// Rate equation: k = A × exp(-Ea / (R × T))
//   A  = pre-exponential frequency factor (s⁻¹)
//   Ea = activation energy (J/mol)
//   R  = 8.314 J/mol·K (universal gas constant)
//   T  = temperature in Kelvin
//
// For wood (cellulose pyrolysis/combustion):
//   Ea ≈ 125,000 J/mol  (real experimental value, Grønli 1996)
//   A  ≈ 1×10⁸ s⁻¹
//   Ignition at ~250°C, active combustion 400–700°C
//
// Combustion reaction (simplified):
//   C_cell (wood) + O₂ → CO₂ + H₂O + heat
//   ΔH_wood ≈ 16.7 MJ/kg

import { PHYSICS } from './constants'
import { getMaterialProps } from './MaterialRegistry'

// Kinetics constants for wood/organic combustion
export const WOOD_Ea = 125_000        // J/mol
export const WOOD_A  = 1e8            // s⁻¹ pre-exponential factor

// Cellulose O₂ stoichiometry: ~1.17 kg O₂ per kg wood (real value)
// In molar terms: 6 mol O₂ per mol cellulose (MW 162 g/mol)
// Simplified per-kg: 1.17 kg O₂/kg wood
const O2_KG_PER_KG_WOOD = 1.17
const O2_MOLAR_MASS = 0.032  // kg/mol

/**
 * Arrhenius rate constant k (s⁻¹).
 * @param A   pre-exponential factor (s⁻¹)
 * @param Ea  activation energy (J/mol)
 * @param tempC  temperature (°C)
 */
export function arrheniusRate(A: number, Ea: number, tempC: number): number {
  const T_K = tempC + 273.15
  return A * Math.exp(-Ea / (PHYSICS.R * T_K))
}

export interface CombustionInput {
  materialId: number    // MAT.WOOD, MAT.BARK, etc.
  tempC: number         // current cell temperature (°C)
  woodFraction: number  // 0.0 (burned) to 1.0 (full)
  o2Moles: number       // moles of O₂ available in cell
  cellVolume: number    // m³ (= cellSize³)
  dt: number            // seconds
}

export interface CombustionResult {
  dTempC: number        // temperature rise (°C)
  dWoodFraction: number // change in wood fraction (negative = consumed)
  dO2Consumed: number   // moles of O₂ consumed
}

/**
 * Compute one combustion step for a cell.
 * Returns zero deltas if conditions aren't met (below ignition, no O₂, no fuel).
 */
export function combustionStep(input: CombustionInput): CombustionResult {
  const zero: CombustionResult = { dTempC: 0, dWoodFraction: 0, dO2Consumed: 0 }
  const { materialId, tempC, woodFraction, o2Moles, cellVolume, dt } = input

  const props = getMaterialProps(materialId)
  if (props.combustionJ_kg === 0) return zero          // non-combustible
  if (tempC < props.ignitionTemp) return zero           // below ignition
  if (woodFraction <= 0) return zero                    // no fuel
  if (o2Moles <= 0) return zero                         // no oxygen

  const k = arrheniusRate(WOOD_A, WOOD_Ea, tempC)       // s⁻¹

  // Fraction of fuel burned this tick (capped at 1.0)
  const burnedFraction = Math.min(woodFraction, k * woodFraction * dt)
  if (burnedFraction <= 0) return zero

  // Mass burned (kg)
  const massBurned = burnedFraction * props.density * cellVolume

  // Heat released (J)
  const heatJ = massBurned * props.combustionJ_kg

  // O₂ consumed (mol)
  const o2Required = (massBurned * O2_KG_PER_KG_WOOD) / O2_MOLAR_MASS  // kg O₂ → moles
  const o2Consumed = Math.min(o2Moles, o2Required)

  // Scale heat by O₂ availability (can't burn more than O₂ allows)
  const o2Scale = o2Required > 0 ? o2Consumed / o2Required : 0
  const actualHeatJ = heatJ * o2Scale
  const actualBurned = burnedFraction * o2Scale

  // Temperature rise: dT = Q / (m * Cp)
  // Use remaining fuel mass as thermal mass (conservative)
  const thermalMass = Math.max(woodFraction - actualBurned, 0.01) * props.density * cellVolume
  const dTempC = actualHeatJ / (thermalMass * props.Cp)

  return {
    dTempC: Math.min(dTempC, 2000),    // cap to avoid numerical explosion
    dWoodFraction: -actualBurned,
    dO2Consumed: o2Consumed,
  }
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npx vitest run src/engine/Arrhenius.test.ts
```
Expected: 6 tests pass.

- [ ] **Step 5: TypeScript check + commit**

```bash
npx tsc --noEmit
git add src/engine/Arrhenius.ts src/engine/Arrhenius.test.ts
git commit -m "feat: Arrhenius reaction engine — wood combustion pure functions"
```

---

## Task 4: Fix Thermal Worker — Per-Material Conductivity

**Goal:** `thermal.worker.ts` currently uses hardcoded `k_water` for all cells. Fix it to look up k and Cp per material ID.

**IMPORTANT:** Workers cannot import `MaterialRegistry.ts` directly (tree-shaking works fine, but to be safe we inline a compact property table in the worker). Do NOT import from `MaterialRegistry.ts` in the worker — it has no side effects but keeps the worker dependency-free.

**Files:**
- Modify: `src/engine/workers/thermal.worker.ts`

### Step-by-step

- [ ] **Step 1: Read current thermal.worker.ts carefully**

Check current state at `src/engine/workers/thermal.worker.ts`. It:
- Receives `{type:'init', descriptor}` and `{type:'tick', dtSim}`
- Uses hardcoded `kappa = THERMO.k_water` and `cp = THERMO.Cp_water`

- [ ] **Step 2: Replace thermal.worker.ts**

Replace the file content entirely with:

```typescript
import type { GridTransferDescriptor } from '../Grid'
import { CELL_FLOATS } from '../Grid'
import { PHYSICS } from '../constants'

// Inline material thermal properties (k in W/m·K, Cp in J/kg·K)
// Must stay in sync with MaterialRegistry.ts — kept inline to avoid worker import chain.
const MATERIAL_K: Record<number, number> = {
  0: 0.026,  // air
  1: 2.9,    // granite/stone
  2: 1.4,    // flint
  3: 0.12,   // wood
  4: 0.10,   // bark
  5: 0.06,   // fiber/tinder
  8: 1.1,    // clay
  15: 80,    // iron
  17: 0.2,   // coal
  21: 0.06,  // fiber (tinder)
  25: 400,   // copper
}
const MATERIAL_Cp: Record<number, number> = {
  0: 1005,   // air
  1: 790,    // granite
  2: 730,    // flint
  3: 1700,   // wood
  4: 1600,   // bark
  5: 1600,   // fiber
  8: 920,    // clay
  15: 449,   // iron
  17: 710,   // coal
  21: 1600,  // fiber
  25: 385,   // copper
}
const DEFAULT_K  = 0.026  // air fallback
const DEFAULT_Cp = 1005

let data: Float32Array
let sizeX: number, sizeY: number, sizeZ: number

function idx(x: number, y: number, z: number): number {
  return (x + sizeX * (y + sizeY * z)) * CELL_FLOATS
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data
  if (msg.type === 'init') {
    const desc = msg.descriptor as GridTransferDescriptor
    data  = new Float32Array(desc.buffer)
    sizeX = desc.sizeX
    sizeY = desc.sizeY
    sizeZ = desc.sizeZ
    self.postMessage({ type: 'ready' })
    return
  }
  if (msg.type === 'tick') {
    tickThermal(msg.dtSim as number)
  }
}

function tickThermal(dt: number): void {
  const dx = 1.0  // cell size in meters

  // Clamp dt to avoid thermal explosion at high time scales
  const dtCapped = Math.min(dt, 0.05)

  for (let z = 1; z < sizeZ - 1; z++) {
    for (let y = 1; y < sizeY - 1; y++) {
      for (let x = 1; x < sizeX - 1; x++) {
        const b = idx(x, y, z)
        const mat     = data[b] >>> 0
        const T       = data[b + 1]
        const density = Math.max(data[b + 3], 0.001)

        const k  = MATERIAL_K[mat]  ?? DEFAULT_K
        const Cp = MATERIAL_Cp[mat] ?? DEFAULT_Cp

        const Tx1 = data[idx(x+1,y,z)+1], Tx0 = data[idx(x-1,y,z)+1]
        const Ty1 = data[idx(x,y+1,z)+1], Ty0 = data[idx(x,y-1,z)+1]
        const Tz1 = data[idx(x,y,z+1)+1], Tz0 = data[idx(x,y,z-1)+1]

        // Fourier conduction: dT/dt = α·∇²T,  α = k/(ρ·Cp)
        const lapT  = (Tx1 + Tx0 + Ty1 + Ty0 + Tz1 + Tz0 - 6*T) / (dx * dx)
        const alpha = k / (density * Cp)
        data[b + 1] += alpha * lapT * dtCapped

        // Stefan-Boltzmann radiation from very hot cells (> 500°C)
        if (T > 500) {
          const T_K = T + 273.15
          const emissivity = 0.9
          const radiated = emissivity * PHYSICS.sigma * T_K**4 * dtCapped  // J/m²
          data[b + 1] -= radiated / (density * Cp * dx)
        }
      }
    }
  }
}
```

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/engine/workers/thermal.worker.ts
git commit -m "fix: thermal worker uses per-material k/Cp instead of hardcoded water values"
```

---

## Task 5: Chem Worker — Arrhenius Combustion

**Goal:** Implement combustion reaction in the chem worker. Handle `IGNITE` message (deposits energy to start a fire). Handle `PLACE_MATERIAL` message (sets a cell material). Run combustion tick every frame.

**Files:**
- Modify: `src/engine/workers/chem.worker.ts`

### Step-by-step

- [ ] **Step 1: Replace chem.worker.ts**

Replace the entire file with:

```typescript
import type { GridTransferDescriptor } from '../Grid'
import { CELL_FLOATS } from '../Grid'

// Inline Arrhenius constants (avoid worker import chain)
const WOOD_Ea  = 125_000   // J/mol
const WOOD_A   = 1e8       // s⁻¹
const R        = 8.314     // J/mol·K

// Inline material props needed for combustion
// [ignitionTemp°C, combustionJ_kg, density_kg_m3, Cp_J_kg_K]
const COMBUSTION_PROPS: Record<number, [number, number, number, number]> = {
  3:  [250, 16_700_000, 600,  1700],  // wood
  4:  [220, 15_500_000, 400,  1600],  // bark
  5:  [170, 14_000_000, 80,   1600],  // fiber/tinder
  17: [350, 29_000_000, 1300, 710],   // coal
  21: [170, 14_000_000, 80,   1600],  // fiber (alt mat ID)
}
const O2_KG_PER_KG_WOOD = 1.17
const O2_MOLAR_MASS = 0.032  // kg/mol
// Chemical slot 0 stores O₂ moles (quantity index 0)
const O2_QUANT_SLOT = 0  // index into quantities[0..7]

let data: Float32Array
let sizeX: number, sizeY: number, sizeZ: number

function idx(x: number, y: number, z: number): number {
  return (x + sizeX * (y + sizeY * z)) * CELL_FLOATS
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data

  if (msg.type === 'init') {
    const desc = msg.descriptor as GridTransferDescriptor
    data  = new Float32Array(desc.buffer)
    sizeX = desc.sizeX
    sizeY = desc.sizeY
    sizeZ = desc.sizeZ
    self.postMessage({ type: 'ready' })
    return
  }

  if (msg.type === 'tick') {
    tickChem(msg.dtSim as number)
    return
  }

  // IGNITE: deposit ignition energy into a cell to start combustion.
  // The energy is added as temperature increase in the cell + neighbors.
  if (msg.type === 'ignite') {
    const { gx, gy, gz, energyJ } = msg as { gx: number; gy: number; gz: number; energyJ: number }
    depositIgnitionEnergy(gx, gy, gz, energyJ)
    return
  }

  // PLACE_MATERIAL: set a cell's material and density (e.g. place a wood pile)
  if (msg.type === 'place_material') {
    const { gx, gy, gz, materialId, density } = msg as {
      gx: number; gy: number; gz: number; materialId: number; density: number
    }
    if (gx < 0 || gx >= sizeX || gy < 0 || gy >= sizeY || gz < 0 || gz >= sizeZ) return
    const b = idx(gx, gy, gz)
    data[b]     = materialId
    data[b + 3] = density
    return
  }
}

function depositIgnitionEnergy(gx: number, gy: number, gz: number, energyJ: number): void {
  if (gx < 0 || gx >= sizeX || gy < 0 || gy >= sizeY || gz < 0 || gz >= sizeZ) return
  const b = idx(gx, gy, gz)
  const mat     = data[b] >>> 0
  const density = Math.max(data[b + 3], 0.001)
  // Use wood Cp as default for organic cells, air Cp otherwise
  const Cp = COMBUSTION_PROPS[mat] ? COMBUSTION_PROPS[mat][3] : 1005
  // dT = energy / (mass * Cp), mass = density * 1m³
  const dT = energyJ / (density * Cp)
  data[b + 1] += dT
}

function tickChem(dt: number): void {
  const dtCapped = Math.min(dt, 0.05)

  for (let z = 0; z < sizeZ; z++) {
    for (let y = 0; y < sizeY; y++) {
      for (let x = 0; x < sizeX; x++) {
        const b   = idx(x, y, z)
        const mat = data[b] >>> 0

        const props = COMBUSTION_PROPS[mat]
        if (!props) continue  // non-combustible

        const [ignitionTemp, combustionJ_kg, density0, Cp] = props
        const tempC   = data[b + 1]
        const density = data[b + 3]  // current density tracks remaining fuel (kg/m³)

        if (tempC < ignitionTemp) continue
        if (density < 1) {
          // Burned out — become air
          data[b]     = 0      // materialId = 0 (air)
          data[b + 3] = 1.225  // air density
          continue
        }

        // O₂ available in this cell (stored in quantities[slot 0])
        const o2Slot = b + 15 + O2_QUANT_SLOT
        const o2Moles = data[o2Slot]
        if (o2Moles <= 0) continue  // smothered

        // Arrhenius rate
        const T_K = tempC + 273.15
        const k   = WOOD_A * Math.exp(-WOOD_Ea / (R * T_K))

        // Wood fraction = density / density0 (1.0 = full, 0.0 = burned out)
        const woodFraction = Math.min(1, density / density0)
        const burnedFraction = Math.min(woodFraction, k * woodFraction * dtCapped)
        if (burnedFraction <= 0) continue

        // Mass burned this tick (kg)
        const massBurned = burnedFraction * density0 * 1.0  // 1 m³ cell

        // O₂ required
        const o2Required = (massBurned * O2_KG_PER_KG_WOOD) / O2_MOLAR_MASS
        const o2Consumed = Math.min(o2Moles, o2Required)
        const o2Scale    = o2Required > 0 ? o2Consumed / o2Required : 0

        const actualBurned = burnedFraction * o2Scale
        const heatJ        = actualBurned * density0 * combustionJ_kg * o2Scale

        // Update density (fuel consumed)
        data[b + 3] = Math.max(0, density - actualBurned * density0)

        // Update O₂
        data[o2Slot] = Math.max(0, o2Moles - o2Consumed)

        // Heat released → temperature rise
        const remainingMass = Math.max(data[b + 3], 0.01) * 1.0
        const dT = Math.min(heatJ / (remainingMass * Cp), 500)  // cap 500°C/tick
        data[b + 1] += dT
      }
    }
  }
}
```

- [ ] **Step 2: TypeScript check**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/engine/workers/chem.worker.ts
git commit -m "feat: chem worker — Arrhenius combustion, IGNITE + PLACE_MATERIAL handlers"
```

---

## Task 6: LocalSimManager — Grid Lifecycle and Player Bridge

**Goal:** A class that manages the simulation grid's world-space anchor, initializes terrain into the grid, and exposes clean methods for player interaction.

**Files:**
- Modify: `src/engine/SimulationEngine.ts` — add `gridOrigin` field, expose chem worker reference
- Create: `src/engine/LocalSimManager.ts`

### Step-by-step

- [ ] **Step 1: Modify SimulationEngine.ts**

Add a public `gridOrigin` field and a `sendToChem` helper. Read `SimulationEngine.ts` first, then add:

```typescript
// Add this field in the class body (after `readonly grid: Grid3D`):
gridOrigin: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }

// Add this method (at end of class, before `dispose()`):
/** Send a message directly to the chemistry worker. */
sendToChem(msg: Record<string, unknown>): void {
  this.workers.get('chem')?.postMessage(msg)
}
```

- [ ] **Step 2: Create LocalSimManager.ts**

Create `src/engine/LocalSimManager.ts`:

```typescript
// LocalSimManager — player-local simulation grid controller.
//
// Responsibilities:
//  • Compute and store grid origin when player spawns
//  • Initialize grid cells from sphere terrain data (rock below surface, air above)
//  • Initialize O₂ in air cells
//  • Expose ignite() / placeWood() for player interaction
//  • Expose getTemperatureAt() for reading ambient temp near player

import * as THREE from 'three'
import { CELL_FLOATS } from './Grid'
import { computeGridOrigin, worldToGrid, isInBounds, initO2Moles } from './GridCoords'
import { getMaterialProps, MAT_AIR, MAT_STONE, MAT_WOOD } from './MaterialRegistry'
import type { SimulationEngine } from './SimulationEngine'
import { terrainHeightAt, PLANET_RADIUS } from '../world/SpherePlanet'

// O₂ chemical ID stored in chemical slot 0
const O2_CHEM_SLOT   = 0   // index into chemicals[0..7]  (offset +7 from base)
const O2_QUANT_SLOT  = 0   // index into quantities[0..7] (offset +15 from base)
const CHEM_OFFSET    = 7
const QUANT_OFFSET   = 15
const CELL_SIZE      = 1.0  // meters — matches SimulationEngine config

// Ignition energy deposited by flint strike (Joules)
// Flint spark ≈ 1–2 mJ per spark; we model it as applying many sparks worth of energy
export const FLINT_IGNITION_J = 5000  // 5 kJ — heats tinder cell to ~170°C

export class LocalSimManager {
  private engine: SimulationEngine
  private data: Float32Array
  private sizeX: number
  private sizeY: number
  private sizeZ: number

  constructor(engine: SimulationEngine) {
    this.engine = engine
    const g     = engine.grid
    this.data   = new Float32Array(g.buffer)
    this.sizeX  = g.sizeX
    this.sizeY  = g.sizeY
    this.sizeZ  = g.sizeZ
  }

  /**
   * Call once after player spawns. Sets grid origin so spawn = center of grid.
   * Then initializes all cells from terrain.
   */
  initFromSpawn(spawnX: number, spawnY: number, spawnZ: number): void {
    const origin = computeGridOrigin(spawnX, spawnY, spawnZ, this.sizeX, this.sizeY, this.sizeZ, CELL_SIZE)
    this.engine.gridOrigin = origin

    this._fillFromTerrain(origin)
  }

  private _fillFromTerrain(origin: { x: number; y: number; z: number }): void {
    const { sizeX, sizeY, sizeZ, data } = this
    const dir = new THREE.Vector3()

    for (let gz = 0; gz < sizeZ; gz++) {
      for (let gx = 0; gx < sizeX; gx++) {
        // World position of this column's center (x,z)
        const wx = origin.x + (gx + 0.5) * CELL_SIZE
        const wz = origin.z + (gz + 0.5) * CELL_SIZE

        // Terrain height at this (x,z) on the sphere
        // Get direction vector pointing to this surface position
        const approxR = PLANET_RADIUS
        dir.set(wx, Math.sqrt(Math.max(0, approxR*approxR - wx*wx - wz*wz)), wz).normalize()
        const heightAboveSurface = terrainHeightAt(dir)
        const surfaceY = PLANET_RADIUS + heightAboveSurface

        for (let gy = 0; gy < sizeY; gy++) {
          const wy  = origin.y + (gy + 0.5) * CELL_SIZE
          const b   = (gx + sizeX * (gy + sizeY * gz)) * CELL_FLOATS
          const isAir = wy > surfaceY

          if (isAir) {
            data[b]     = MAT_AIR     // material = air
            data[b + 1] = 15          // 15°C
            data[b + 2] = 101_325     // 1 atm
            data[b + 3] = 1.225       // air density
            // Set O₂ in chemical slot 0
            data[b + CHEM_OFFSET  + O2_CHEM_SLOT] = 8   // chemical ID 8 = O₂
            data[b + QUANT_OFFSET + O2_QUANT_SLOT] = initO2Moles(15, 101_325, CELL_SIZE ** 3, true)
          } else {
            data[b]     = MAT_STONE  // material = granite
            data[b + 1] = 12         // slightly cooler underground
            data[b + 2] = 101_325
            data[b + 3] = getMaterialProps(MAT_STONE).density
            data[b + QUANT_OFFSET + O2_QUANT_SLOT] = 0  // no O₂ in rock
          }
        }
      }
    }
  }

  /**
   * Place a combustible material at a world position.
   * Call this when a player drops or places wood/tinder in the world.
   */
  placeWood(wx: number, wy: number, wz: number, materialId = MAT_WOOD): void {
    const gc = worldToGrid(wx, wy, wz, this.engine.gridOrigin, CELL_SIZE)
    if (!isInBounds(gc.gx, gc.gy, gc.gz, { sizeX: this.sizeX, sizeY: this.sizeY, sizeZ: this.sizeZ })) return
    const props = getMaterialProps(materialId)
    this.engine.sendToChem({
      type: 'place_material',
      gx: gc.gx, gy: gc.gy, gz: gc.gz,
      materialId,
      density: props.density,
    })
  }

  /**
   * Deposit ignition energy at a world position.
   * Call this when player strikes flint near tinder/wood.
   */
  ignite(wx: number, wy: number, wz: number, energyJ = FLINT_IGNITION_J): void {
    const gc = worldToGrid(wx, wy, wz, this.engine.gridOrigin, CELL_SIZE)
    if (!isInBounds(gc.gx, gc.gy, gc.gz, { sizeX: this.sizeX, sizeY: this.sizeY, sizeZ: this.sizeZ })) return
    this.engine.sendToChem({ type: 'ignite', gx: gc.gx, gy: gc.gy, gz: gc.gz, energyJ })
  }

  /**
   * Read ambient temperature at a world position from the grid.
   * Returns 15°C if the position is out of bounds.
   */
  getTemperatureAt(wx: number, wy: number, wz: number): number {
    const gc = worldToGrid(wx, wy, wz, this.engine.gridOrigin, CELL_SIZE)
    if (!isInBounds(gc.gx, gc.gy, gc.gz, { sizeX: this.sizeX, sizeY: this.sizeY, sizeZ: this.sizeZ })) return 15
    const b = (gc.gx + this.sizeX * (gc.gy + this.sizeY * gc.gz)) * CELL_FLOATS
    return this.data[b + 1]
  }

  /**
   * Return world positions and temperatures of all cells currently above 200°C.
   * Used by FireRenderer to place visual fire.
   * Returns at most 32 hot cells (the hottest ones) for performance.
   */
  getHotCells(minTempC = 200): Array<{ wx: number; wy: number; wz: number; tempC: number }> {
    const { sizeX, sizeY, sizeZ, data } = this
    const origin = this.engine.gridOrigin
    const result: Array<{ wx: number; wy: number; wz: number; tempC: number }> = []

    for (let gz = 0; gz < sizeZ; gz++) {
      for (let gy = 0; gy < sizeY; gy++) {
        for (let gx = 0; gx < sizeX; gx++) {
          const b = (gx + sizeX * (gy + sizeY * gz)) * CELL_FLOATS
          const tempC = data[b + 1]
          if (tempC >= minTempC) {
            result.push({
              wx: origin.x + (gx + 0.5) * CELL_SIZE,
              wy: origin.y + (gy + 0.5) * CELL_SIZE,
              wz: origin.z + (gz + 0.5) * CELL_SIZE,
              tempC,
            })
          }
        }
      }
    }

    // Return the 32 hottest for performance
    result.sort((a, b) => b.tempC - a.tempC)
    return result.slice(0, 32)
  }
}
```

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit
```
Fix any errors before continuing.

- [ ] **Step 4: Commit**

```bash
git add src/engine/LocalSimManager.ts src/engine/SimulationEngine.ts
git commit -m "feat: LocalSimManager — terrain init, fire ignition bridge to chem worker"
```

---

## Task 7: Player Vitals — Add Ambient Temperature

**Goal:** Add `ambientTemp` to `playerStore` so the HUD can display it and future damage code can read it.

**Files:**
- Modify: `src/store/playerStore.ts`

### Step-by-step

- [ ] **Step 1: Read playerStore.ts** — note the existing `updateVitals` pattern.

- [ ] **Step 2: Add ambientTemp field and setter**

In `src/store/playerStore.ts`, add to the interface and implementation:

```typescript
// Add to PlayerState interface:
ambientTemp: number
setAmbientTemp: (t: number) => void
```

```typescript
// Add to the create() call defaults and implementation:
ambientTemp: 15,
setAmbientTemp: (t) => set({ ambientTemp: t }),
```

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/store/playerStore.ts
git commit -m "feat: playerStore — add ambientTemp vital + setAmbientTemp action"
```

---

## Task 8: Wire LocalSimManager into SceneRoot + Fire-Start Interaction

**Goal:** After engine init, create LocalSimManager, initialize grid from terrain. Add fire-start interaction: player with `flint` equipped left-clicks on a wood/bark resource node → placeWood + ignite. Update ambient temp each frame.

**Files:**
- Modify: `src/rendering/SceneRoot.tsx`

### Step-by-step

- [ ] **Step 1: Read SceneRoot.tsx** — understand the full file (engine init useEffect, resource node gather loop, popAttack game loop).

- [ ] **Step 2: Add LocalSimManager import and ref**

At the top of SceneRoot.tsx, add imports:
```typescript
import { LocalSimManager } from '../engine/LocalSimManager'
import { MAT } from '../player/Inventory'
```

Inside `SceneRoot()`, add a ref alongside `engineRef`:
```typescript
const simManagerRef = useRef<LocalSimManager | null>(null)
```

- [ ] **Step 3: Initialize LocalSimManager after engine.init()**

In the engine lifecycle `useEffect`, after `setEngineReady(true)`, add:

```typescript
// Initialize local simulation grid from terrain
const simManager = new LocalSimManager(engine)
simManager.initFromSpawn(spawnX, spawnY, spawnZ)
simManagerRef.current = simManager
```

Also add to the cleanup function:
```typescript
simManagerRef.current = null
```

- [ ] **Step 4: Add fire-start interaction in the game loop**

Find the existing `useFrame` game loop (the one that calls `controllerRef.current?.popAttack()`). After the harvest block, add:

```typescript
// ── Fire-starting: equipped flint + left-click on wood/bark node ─────────
const equippedSlot = usePlayerStore.getState().equippedSlot
const equippedItem = equippedSlot !== null ? inventory.getSlot(equippedSlot) : null
const hasFlint     = equippedItem?.materialId === MAT.FLINT

if (!gs.inputBlocked && hasFlint && controllerRef.current?.popAttack() && simManagerRef.current) {
  const ps = usePlayerStore.getState()
  // Check if any wood/bark node is within 3m
  let nearestWoodNode: ResourceNode | null = null
  let nearestDist = 3.0
  for (const node of RESOURCE_NODES) {
    if (gatheredNodeIds.has(node.id)) continue
    if (node.matId !== MAT.WOOD && node.matId !== MAT.BARK && node.matId !== MAT.FIBER) continue
    const nodeY = terrainYAt(node.x, node.z)
    const dx = ps.x - node.x, dy = ps.y - nodeY, dz = ps.z - node.z
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz)
    if (dist < nearestDist) { nearestDist = dist; nearestWoodNode = node }
  }
  if (nearestWoodNode) {
    const nodeY = terrainYAt(nearestWoodNode.x, nearestWoodNode.z)
    simManagerRef.current.placeWood(nearestWoodNode.x, nodeY, nearestWoodNode.z, nearestWoodNode.matId)
    simManagerRef.current.ignite(nearestWoodNode.x, nodeY, nearestWoodNode.z)
    useGameStore.getState().setGatherPrompt('Fire started!')
    setTimeout(() => useGameStore.getState().setGatherPrompt(null), 2000)
  }
}
```

- [ ] **Step 5: Update ambient temperature each frame**

In the same `useFrame` callback, add (after position update code):

```typescript
// Update ambient temperature from sim grid
if (simManagerRef.current) {
  const ps = usePlayerStore.getState()
  const tempC = simManagerRef.current.getTemperatureAt(ps.x, ps.y, ps.z)
  usePlayerStore.getState().setAmbientTemp(tempC)
}
```

- [ ] **Step 6: TypeScript check**

```bash
npx tsc --noEmit
```
Fix any errors.

- [ ] **Step 7: Commit**

```bash
git add src/rendering/SceneRoot.tsx
git commit -m "feat: wire LocalSimManager into SceneRoot — fire-start action + ambient temp"
```

---

## Task 9: FireRenderer — Visual Fire

**Goal:** A Three.js component that reads hot cells from LocalSimManager and renders a point light + orange glow mesh at each fire location. Updates at 10Hz (not every frame) for performance.

**Files:**
- Create: `src/rendering/FireRenderer.tsx`
- Modify: `src/rendering/SceneRoot.tsx` — mount `<FireRenderer>`

### Step-by-step

- [ ] **Step 1: Create FireRenderer.tsx**

Create `src/rendering/FireRenderer.tsx`:

```typescript
// FireRenderer — renders visual fire for simulation grid cells above 200°C.
// Reads hot cell list from LocalSimManager at 10Hz and renders:
//  - PointLight at each fire location (orange, intensity scales with temperature)
//  - Small orange sphere mesh as the fire glow
// Mounted inside the R3F Canvas.

import { useRef, useState, useEffect } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { LocalSimManager } from '../engine/LocalSimManager'

interface HotCell {
  wx: number; wy: number; wz: number; tempC: number
}

interface Props {
  simManager: LocalSimManager | null
}

export function FireRenderer({ simManager }: Props) {
  const [hotCells, setHotCells] = useState<HotCell[]>([])
  const lastUpdateRef = useRef(0)

  useFrame((_, delta) => {
    if (!simManager) return
    lastUpdateRef.current += delta
    if (lastUpdateRef.current < 0.1) return  // update at ~10Hz
    lastUpdateRef.current = 0
    setHotCells(simManager.getHotCells(200))
  })

  if (hotCells.length === 0) return null

  return (
    <>
      {hotCells.map((cell, i) => {
        const intensity = Math.min(5, (cell.tempC - 200) / 200)  // 0 at 200°C, 5 at 1200°C
        const color = cell.tempC > 800 ? '#ffffff' : cell.tempC > 500 ? '#ffaa33' : '#ff5500'
        return (
          <group key={i} position={[cell.wx, cell.wy, cell.wz]}>
            <pointLight
              color={color}
              intensity={intensity}
              distance={8}
              decay={2}
            />
            {/* Fire glow sphere */}
            <mesh>
              <sphereGeometry args={[0.3, 8, 8]} />
              <meshBasicMaterial color={color} transparent opacity={Math.min(0.9, intensity * 0.3)} />
            </mesh>
          </group>
        )
      })}
    </>
  )
}
```

- [ ] **Step 2: Add FireRenderer to SceneRoot**

In `SceneRoot.tsx`, import and add inside the Canvas:

```typescript
import { FireRenderer } from './FireRenderer'
```

Pass simManagerRef.current to it. Since it's inside the Canvas and needs to be reactive, use a state variable instead of just the ref:

```typescript
// In SceneRoot, add state for simManager:
const [simManager, setSimManager] = useState<LocalSimManager | null>(null)

// In engine lifecycle useEffect, after creating simManager:
setSimManager(simManager)

// In cleanup:
setSimManager(null)
```

Then inside the Canvas JSX, add:
```tsx
<FireRenderer simManager={simManager} />
```

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/rendering/FireRenderer.tsx src/rendering/SceneRoot.tsx
git commit -m "feat: FireRenderer — point lights + glow mesh for hot simulation cells"
```

---

## Task 10: HUD Temperature Display + Integration Polish

**Goal:** Show ambient temperature in the HUD. Fix any integration issues found during manual playtest.

**Files:**
- Modify: `src/ui/HUD.tsx`

### Step-by-step

- [ ] **Step 1: Read HUD.tsx** — understand the existing vitals bar layout.

- [ ] **Step 2: Add temperature display to HUD**

In `HUD.tsx`, read `ambientTemp` from playerStore and display it:

```typescript
const ambientTemp = usePlayerStore(s => s.ambientTemp)
```

Add a temperature indicator near the other vitals. Format it as: `15°C` with color coding:
- Below 0°C: `#88bbff` (cold blue)
- 0–30°C: `#88ff88` (comfortable green)
- 30–50°C: `#ffaa44` (warm orange)
- Above 50°C: `#ff4444` (danger red)

```tsx
{/* Ambient temperature */}
<div style={{ fontSize: 11, color: tempColor, fontFamily: 'monospace' }}>
  {ambientTemp.toFixed(0)}°C
</div>
```

Where `tempColor` is computed as:
```typescript
const tempColor = ambientTemp < 0 ? '#88bbff' : ambientTemp < 30 ? '#88ff88' : ambientTemp < 50 ? '#ffaa44' : '#ff4444'
```

- [ ] **Step 3: TypeScript check**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Manual smoke test**

Start the dev server and verify the following manually:

```bash
npm run dev
```

Open browser, click to play. Walk near the spawn area:
1. Open inventory (I) — should show empty inventory
2. Gather wood node (F near tree) — wood appears in inventory
3. Gather flint node (F near flint) — flint appears in inventory
4. Equip flint (select flint in inventory → Equip)
5. Walk near a wood/bark resource node
6. Left-click — should see "Fire started!" message briefly
7. Walk very close to where fire should be — temperature reading in HUD should rise from 15°C
8. Wait 10–15 seconds — temperature should continue rising as fire spreads

If step 6 does nothing: check browser console for errors. Common issue: `popAttack()` not firing — verify PlayerController has `mousedown` listener (added in previous work session).

If temperature doesn't rise: check that the thermal worker is receiving ticks. Add a temporary `console.log` in `thermal.worker.ts` inside `tickThermal()` and verify it appears in the DevTools worker thread.

- [ ] **Step 5: Fix any issues found in smoke test**

The most likely issues:
- **Grid origin wrong** — fire ignites at wrong location. Fix `computeGridOrigin` or the spawn position passed to it.
- **Temperature never rises in HUD** — `getTemperatureAt()` returning stale data. The `LocalSimManager.data` Float32Array is a view on the SharedArrayBuffer — it should read live. If not, verify the engine's grid buffer is the same SAB the manager wraps.
- **Fire doesn't spread** — thermal worker not using per-material k. Add `console.log(mat, k, Cp)` in thermal worker tick.

- [ ] **Step 6: Final TypeScript check + commit**

```bash
npx tsc --noEmit
git add src/ui/HUD.tsx
git commit -m "feat: HUD ambient temperature display — color-coded °C reading from sim grid"
```

---

## Vertical Slice 3 Pass/Fail Criteria

**This plan is COMPLETE when all of the following are verifiable by a playtester:**

| # | Action | Expected outcome |
|---|--------|-----------------|
| 1 | Walk to wood resource node, press F | Wood in inventory |
| 2 | Walk to flint node, press F | Flint in inventory |
| 3 | Open inventory (I), select flint, click Equip | Flint held in hand (visible 3D mesh) |
| 4 | Walk within 3m of wood/bark node, left-click | "Fire started!" message appears |
| 5 | Stand next to fire location for 5 seconds | HUD temperature rises above 15°C |
| 6 | Stand very close to fire for 30 seconds | Temperature reaches 100°C+ |
| 7 | Move 20m away from fire | Temperature returns toward 15°C |

**Zero console errors during the entire playtest.**

---

## What this plan does NOT include

The following are out of scope for this plan (next plans):

- **Procedural terrain** (smooth sphere replaced with geology) — next priority
- **Fire visual particles** (current: sphere mesh; future: particle system)
- **Temperature damage** (hypothermia/hyperthermia → health loss) — vertical slice 5
- **Cooking food on fire** — vertical slice 4
- **Adaptive grid resolution** (0.5m / 5m / 50m tiers) — post v1
- **NPC AI, combat, building** — much later

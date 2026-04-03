# Future Implementation Roadmap

What needs to be added to the simulation to make it more complete and precise.
Sorted by priority — top items block technology progression, bottom items improve precision.

Last updated: 2026-04-03

---

## TIER 1 — Blocks Technology Progression (Must Have)

These systems prevent the player from advancing past roughly 1800 CE.
Without them, the civilization arc stalls at waterwheels and windmills.

### 1. Electromagnetism
**What:** Static electricity, magnetism, electric current, circuits, electromagnetic induction.
**Why blocked without it:** Batteries, motors, generators, arc furnaces, aluminum smelting, radio, computers — the entire electrical age is impossible.
**Key formulas needed:**
- Coulomb's law: F = k * q1 * q2 / r^2 (static charge)
- Ohm's law: V = I * R (circuits)
- Kirchhoff's laws (circuit networks)
- Faraday's law: EMF = -d(phi_B)/dt (generators, motors)
- Lorentz force: F = q(E + v x B) (motor torque)
- Nernst equation: E = E0 - (RT/nF) * ln(Q) (battery voltage from chemistry)
**Connects to:** electricalConductivity (already on MaterialPacket), reaction engine (electrochemistry), temperature (resistive heating I^2*R), rotational mechanics (motors/generators), lightning (Connection 18)
**Estimated doc size:** ~800 lines (new §3.9)
**Estimated implementation:** Major — new physics stage, new MaterialPacket properties (charge, magnetic permeability), circuit graph solver

### 2. Optics (Light Propagation)
**What:** Refraction, reflection, lenses, mirrors, focused light.
**Why blocked without it:** Telescopes, microscopes, cameras, concentrated solar heat, optical signaling — the Scientific Revolution depends on lenses.
**Key formulas needed:**
- Snell's law: n1 * sin(theta1) = n2 * sin(theta2)
- Thin lens equation: 1/f = (n-1)(1/R1 - 1/R2)
- Mirror equation: 1/f = 1/do + 1/di
- Inverse square law for illumination: I = P / (4*pi*r^2)
- Color dispersion: n varies with wavelength (prism effect)
**Connects to:** refractiveIndex (already computed in §3.2 optical pipeline), reflectivity (on MaterialPacket), precision crafting (grinding glass = lens), astronomy, lighting system (§7.11)
**Estimated doc size:** ~500 lines (new §3.10)
**Estimated implementation:** Moderate — ray tracing for gameplay optics (not rendering), lens entity type

### 3. Heat Engines (Thermodynamic Cycles)
**What:** Converting heat into mechanical work. Steam engines, internal combustion, refrigeration.
**Why blocked without it:** Steam power, turbines, internal combustion engines, refrigeration — the Industrial Revolution requires extracting work from heat.
**Key formulas needed:**
- Ideal gas law: PV = nRT
- Work from expansion: W = integral(P dV)
- Carnot efficiency: eta_max = 1 - T_cold/T_hot
- Rankine cycle (steam engines): pump -> boiler -> expansion -> condenser
- Refrigeration COP: COP = T_cold / (T_hot - T_cold)
**Connects to:** phase transitions (§3.2 — steam already exists), temperature propagation (§3.0), rotational mechanics (§3.8 — piston drives crankshaft), gas dynamics (need gas pressure model)
**Estimated doc size:** ~600 lines (could be part of §3.8 or new §3.11)
**Estimated implementation:** Moderate — ideal gas law added to SPH pressure, piston-crankshaft coupling already in §3.8

### 4. Rope/Cable/Flexible Body Physics
**What:** Tension along flexible bodies, pulleys, catenary curves, mechanical advantage.
**Why blocked without it:** Pulleys (simplest machine), cranes, bows, suspension bridges, rigging, block-and-tackle, wells — all require rope physics.
**Key formulas needed:**
- Verlet chain: particles connected by distance constraints (position-based dynamics)
- Catenary: y = a * cosh(x/a)
- Mechanical advantage: MA = number of supporting rope segments
- Tension propagation: T constant along frictionless rope, reduced at each pulley by friction
- Breaking: tension > cross_section * tensileStrength
**Connects to:** structural system (§3.4 — rope lashing), rotational mechanics (§3.8 — belt/rope drives), crafting (rope making from twisted fibers), sailing, combat (bows)
**Estimated doc size:** ~400 lines (new §3.12 or extend §3.8)
**Estimated implementation:** Moderate — Verlet chain solver, tension constraints, pulley detection

### 5. Projectile Aerodynamics
**What:** Air resistance on moving objects, spin stabilization, ballistic trajectories.
**Why blocked without it:** Every thrown/shot object flies as if in vacuum. Arrows don't slow down, fletching is useless, catapult stones are unrealistically accurate.
**Key formulas needed:**
- Drag: F_drag = 0.5 * rho * v^2 * Cd * A
- Terminal velocity: v_t = sqrt(2mg / (rho * Cd * A))
- Magnus effect: F_magnus = S * (omega x v) (spin curves projectiles)
- Cd from shape: sphere 0.47, streamlined 0.04, flat plate 1.2
**Connects to:** rigid body (Stage 6 — add drag to integration), MaterialPacket (density + dimensions), combat (§7.5 — ranged damage depends on impact velocity), sound (Doppler already handled), wind (crosswind deflection)
**Estimated doc size:** ~300 lines (extend Stage 6 rigid body + new subsection)
**Estimated implementation:** Easy — add one force term to existing rigid body integration

---

## TIER 2 — Improves Realism Significantly (Should Have)

The game works without these, but important behaviors are wrong or missing.

### 6. Aerodynamic Lift
**What:** Pressure difference on curved/angled surfaces creates force perpendicular to airflow.
**Why it matters:** Sailing is wrong (no tacking physics), windmill blades are inefficient flat paddles, no kites or gliders possible.
**Key formulas:**
- Lift: F_lift = 0.5 * rho * v^2 * CL * A
- CL = 2*pi*alpha for small angles of attack (thin airfoil theory)
- Stall at alpha > ~15 degrees
- Apparent wind for sailing: vector sum of true wind + boat velocity
**Estimated doc size:** ~300 lines

### 7. Gas Dynamics and Combustion Products
**What:** Persistent gas simulation — smoke fills rooms, CO2 sinks, chimneys create draft.
**Why it matters:** Fires in enclosed spaces don't suffocate players, chimneys are decorative, mines don't need ventilation, explosions have no pressure wave.
**Key formulas:**
- Gas composition tracking per atmosphere cell (O2, CO2, CO, CH4)
- Fick's law diffusion: J = -D * dC/dx
- Stack effect: Q = Cd * A * sqrt(2*g*h * (T_in - T_out)/T_out)
- Blast overpressure: P = P0 * (r0/r)^3
**Estimated doc size:** ~500 lines

### 8. Soil/Terrain Deformation Mechanics
**What:** Digging difficulty, slope stability, tunnel collapse, angle of repose.
**Why it matters:** All terrain is equally easy to dig, hillsides never collapse, mines don't need support structures.
**Key formulas:**
- Excavation energy from Mohs hardness
- Slope stability factor of safety: FS = (c + sigma_n * tan(phi)) / tau
- Angle of repose per material (sand ~34, gravel ~40)
- Tunnel roof load (Terzaghi rock load theory)
**Estimated doc size:** ~400 lines

### 9. Textile/Fiber Mechanics
**What:** How fibers become thread (spinning), thread becomes cloth (weaving), fibers become rope.
**Why it matters:** Rope and cloth are crafting ingredients but have no physics. Spinning and weaving are just "craft actions" with no material-dependent quality.
**Key formulas:**
- Yarn strength from twist angle: sigma_yarn = sigma_fiber * cos^2(alpha) * friction_factor
- Weave pattern strength modifiers
- Rope laying: opposing twist locks structure
**Estimated doc size:** ~300 lines

### 10. Biological Force Model
**What:** Muscle strength, metabolic fatigue, bone fracture thresholds — all from physics instead of magic numbers.
**Why it matters:** Player strength, fall damage, animal draft power, and combat damage are all hardcoded. They should emerge from body mass, muscle cross-section, and bone strength.
**Key formulas:**
- Muscle force: F = sigma_muscle * A_cross (sigma ~0.3 MPa for all mammals)
- Metabolic fatigue: P_max = P_aerobic * (1 + P_anaerobic/P_aerobic * e^(-t/tau))
- Bone fracture: F_break = sigma_bone * A_cross (femur ~7,500 N)
- Fall damage: F_impact = m*v^2 / (2*d_stop) — stopping distance matters
- Allometric scaling: F proportional to M^(2/3) (Kleiber's law for metabolism: M^(3/4))
**Estimated doc size:** ~400 lines

---

## TIER 3 — Future Precision Upgrades (Nice to Have)

These don't unlock new gameplay but make existing systems more accurate.

### 11. ML Surrogate Models for Material Properties
**What:** Train neural networks on real materials databases (Materials Project, AFLOW, NOMAD) to replace hand-crafted property calculator formulas.
**Why it matters:** The current property calculator uses simplified formulas (Fleischer, Andrade, etc.) that are accurate for common materials but may be wrong for exotic compositions players invent. A trained model handles edge cases better.
**How it works:**
- Training data: ~100,000 known materials with measured properties
- Input: elemental composition vector (25-118 dimensions)
- Output: all 36+ properties (melting point, hardness, etc.)
- Architecture: small MLP (3 layers, 256 hidden units) — runs in ~10 microseconds
- Training: offline, not in-game. Model weights shipped with the game.
**Trade-off:** Black box — you can't read WHY bronze is harder. But more accurate for novel compositions.
**When to implement:** After the game has enough players generating novel compositions to validate against. The hand-crafted formulas are good enough for now.

### 12. Microstructure Tracking
**What:** Track grain size, crystal orientation, and phase distribution within each MaterialPacket. Currently only composition and temperature are tracked — not processing history beyond workHardeningState.
**Why it matters:**
- Hall-Petch (currently unused because no grain size) could predict strength from grain size
- Directional properties: wood is 10x stronger along grain than across grain. Currently isotropic.
- Texture (crystallographic orientation) affects formability, anisotropy
- Weld zones have different microstructure than base metal
**What to track:** grainSize (um), crystalOrientation (quaternion or simplified scalar), phaseDistribution (e.g., 60% ferrite + 40% pearlite for steel)
**Impact:** Enables Hall-Petch, anisotropy, realistic heat treatment results
**When to implement:** After martensite/pearlite system is validated in gameplay

### 13. Full Debye Integral for Specific Heat
**What:** Replace the simplified f(T/theta_D) correction with the actual Debye integral: C_v = 9R(T/theta_D)^3 * integral_0^(theta_D/T) [x^4*e^x/(e^x-1)^2] dx
**Why it matters:** The current simplified correction is ~10% wrong at T ~ 0.5*theta_D. The full integral is exact.
**How:** Precompute a lookup table of f(T/theta_D) for 100 values from 0 to 10. Interpolate at runtime. Cost: one table lookup instead of a formula evaluation.
**When to implement:** When temperature accuracy below 50K matters for gameplay (currently it doesn't).

### 14. Lattice Boltzmann for Gas Simulation
**What:** Replace SPH for gas-phase simulation with Lattice Boltzmann Method (LBM). LBM is naturally suited to gas flow (compressible, low density, fast) while SPH is better for liquids.
**Why it matters:** Gas particles in SPH are expensive (large kernel radius, low density = few neighbors = poor accuracy). LBM on a grid handles gas flow more efficiently and produces better results for chimney draft, wind around buildings, and explosion blast waves.
**When to implement:** When gas dynamics (Tier 2, item 7) is added. LBM is the better solver for that system.

### 15. GPU-Native Physics (Beyond WebGPU Compute Shaders)
**What:** Move the entire physics pipeline to GPU compute, not just SPH/MPM. This includes the reaction engine, structural integrity, and rigid body physics.
**Why it matters:** Current architecture runs physics on CPU (Rust). GPU has 100x more parallel throughput. Moving everything to GPU would allow 10x more particles, 10x more structural blocks, 10x more reactions — or the same amount at 10x lower power consumption.
**When to implement:** After WebGPU is widely supported and the CPU architecture is proven. This is a rewrite, not an extension.

### 16. Quantum Chemistry for Reaction Prediction
**What:** Replace the Gibbs free energy lookup with density functional theory (DFT) to predict reaction products and energies from first principles.
**Why it matters:** The current reaction engine checks ΔG from tabulated values. DFT would compute ΔG from the electronic structure of the reactants — meaning truly novel reactions (compositions never studied by chemists) would get correct predictions.
**Reality check:** DFT for a single reaction takes seconds to minutes on a modern CPU. Not real-time. But pre-computed reaction databases (like the AFLOW thermodynamic database) could be loaded at startup. Or a ML model trained on DFT results could predict ΔG in microseconds.
**When to implement:** Long-term research project. Not needed until players consistently create compositions that aren't in the reaction tables.

---

## Implementation Order Recommendation

**Phase 1 (Current):** §3.1-3.8 are complete. Ship the game with medieval-era physics.

**Phase 2 (Next):** Add Tier 1 items in order:
1. Projectile aerodynamics (easiest — one force term added to rigid body)
2. Rope/cable physics (moderate — enables pulleys and bows immediately)
3. Heat engines (moderate — steam power unlocks industrial era)
4. Optics (moderate — lenses unlock scientific instruments)
5. Electromagnetism (hardest — new physics stage, new properties, circuit solver)

**Phase 3 (Later):** Add Tier 2 items as gameplay demands them.

**Phase 4 (Long-term):** Evaluate Tier 3 precision upgrades based on player feedback and performance data.

---

## How to Measure "Precise Enough"

The game's physics precision should be measured against player experience, not laboratory accuracy:

| Test | Acceptable | Not acceptable |
|---|---|---|
| Water flows downhill | Correct direction, reasonable speed | Wrong direction, or too fast/slow by 5x |
| Bronze is harder than copper | Always true | Sometimes copper is harder |
| Iron melts at ~1538°C | Within ±50°C | Off by 500°C |
| A 4m stone beam holds | Holds with load | Collapses under self-weight |
| A 10m stone beam breaks | Breaks under load | Holds with heavy load |
| Arrow slows over distance | Loses 30-60% speed at 100m | Maintains full speed |
| Hot metal glows orange | Above ~800°C | At room temperature |
| Sound gets muffled at distance | High frequencies lost first | All frequencies drop equally |

If a physics PhD plays the game and says "that looks about right" for each of these, the precision is sufficient. If they say "that's obviously wrong," the relevant equation needs improvement.

The ML surrogate model (Tier 3, item 11) is the long-term path to higher precision without adding more hand-crafted equations. Train on reality, not on textbooks.

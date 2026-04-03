# Future: Machine Learning for Physics Precision

How neural networks and machine learning can replace or improve the hand-crafted equations in the simulation. This is a research roadmap, not an immediate implementation plan.

Last updated: 2026-04-03

---

## The Core Idea

Every formula in structure.md is a human's best attempt to describe nature with math. These formulas are approximations — they work well for common cases but break down for unusual compositions, extreme conditions, or novel materials that chemists haven't studied.

Machine learning can learn the REAL mapping from composition → properties by training on millions of actual measurements. The trained model doesn't need to know the formula — it learns the pattern directly from data, including all the weird edge cases that formulas miss.

Think of it this way:
- **Hand-crafted formula:** "I think hardness works like this: Δσ = B × c^(1/2)"
- **ML model:** "I've seen 500,000 alloys and their measured hardness. I know the pattern."

The ML model is more accurate because reality is messier than any single formula. But the formula is transparent — you can read it and understand WHY. The ML model is a black box.

The game should use BOTH: formulas for transparency and debugging, ML models for precision when it matters.

---

## 1. Material Property Prediction (Surrogate Models)

### What it replaces
The property calculator in §3.1 uses ~20 different formulas (Andrade, Fleischer, Clausius-Clapeyron, etc.) to compute 36+ properties from elemental composition. Each formula has constants that were looked up from the element property table.

### How ML does it better
Train a neural network on real materials databases:

**Training data sources:**
- Materials Project (materialsproject.org) — 150,000+ computed materials with DFT-calculated properties
- AFLOW (aflow.org) — 3,500,000+ material entries with computed properties
- NOMAD (nomad-lab.eu) — 12,000,000+ calculations from published research
- MatWeb (matweb.com) — 100,000+ measured material properties
- CRC Handbook — tabulated experimental data for elements and common compounds
- ASM International — alloy property databases (commercial, high quality)

**Model architecture:**
```
Input: composition vector (25-118 elements, each a mass fraction 0-1)
       + temperature (K)
       + processing state (grain size, work hardening, cooling rate)

Hidden layers: 3-4 fully connected layers, 256-512 neurons each
               ReLU activation, batch normalization
               Dropout 0.1 for regularization

Output: 36+ properties simultaneously (multi-task learning)
        melting point, density, hardness, tensile strength,
        viscosity, thermal conductivity, specific heat, etc.

Training: MSE loss per property, weighted by importance
          Properties with wider ranges (viscosity: 0.001 to 10^6) 
          use log-scale targets
          
Size: ~500 KB model weights (tiny — loads instantly)
Inference: ~10 microseconds per prediction on CPU
           ~1 microsecond on GPU
```

**Why multi-task learning:**
Properties are correlated — knowing the melting point constrains the viscosity, which constrains the density. A single network learning all properties simultaneously captures these correlations. Separate networks for each property would miss them.

**Accuracy comparison:**
```
| Property           | Hand-crafted formula | ML surrogate (estimated) |
|--------------------|--------------------- |--------------------------|
| Melting point      | ±50°C (CALPHAD)      | ±15°C                    |
| Density            | ±5% (rule of mixtures)| ±1%                     |
| Hardness           | ±30% (Fleischer)     | ±10%                     |
| Viscosity          | ±50% (Andrade)       | ±15%                     |
| Thermal conductivity| ±40% (Slack/Wiedemann)| ±12%                   |
| Tensile strength   | ±25%                 | ±8%                      |
```

These accuracy numbers are based on published ML materials science papers (e.g., Automatminer, CGCNN, MEGNet benchmarks).

**When to implement:** After the hand-crafted formulas are validated in gameplay. Use the ML model as an optional "high precision" mode that players or the server can enable.

### Hybrid approach (recommended)
```
function getProperty(composition, temperature, property):
  formulaValue = handCraftedFormula(composition, temperature, property)
  mlValue = mlModel.predict(composition, temperature)[property]
  
  // Use formula as the baseline, ML as a correction
  // This keeps the formula's transparency while gaining ML's accuracy
  correction = mlValue - formulaValue
  
  // Clamp correction to ±30% of formula value (safety: ML can be wrong too)
  correction = clamp(correction, -0.3 * formulaValue, 0.3 * formulaValue)
  
  return formulaValue + correction
```

This way, if the ML model gives a crazy answer (it will, for compositions far from training data), the formula still provides a reasonable baseline.

---

## 2. Reaction Product Prediction

### What it replaces
The reaction engine in §3.1 checks ΔG < 0 to determine if a reaction fires. But ΔG requires knowing the PRODUCTS in advance — you can't compute ΔG(reactants → ???) without knowing what ??? is. Currently, the game uses tabulated reactions.

### How ML does it better
Train a model to predict: "Given these reactants at this temperature, what comes out?"

**Training data:**
- NIST Chemistry WebBook — thermodynamic data for 70,000+ chemical species
- Reaxys database — 100,000,000+ published reactions with conditions and products
- CAS reaction database — commercial, most comprehensive
- Open Reaction Database (ORD) — 2,000,000+ machine-readable reactions

**Model architecture (Graph Neural Network):**
```
Input: molecular graph of reactants
       (atoms as nodes, bonds as edges)
       + temperature, pressure, atmosphere (oxidizing/reducing)

Encoder: Message Passing Neural Network (MPNN)
         4-6 message passing steps
         Each atom aggregates information from neighbors
         Captures local chemistry (functional groups, bond types)

Decoder: Predicts product molecular graph
         + reaction energy (ΔH)
         + activation energy (Ea)

Size: ~5 MB model weights
Inference: ~100 microseconds per reaction
```

**Why this matters for gameplay:**
A player who mixes two materials that NO chemist has ever studied gets a physically plausible result. The current system would either:
- Not react (ΔG not in the table) — wrong, the reaction might be favorable
- Produce a random product — wrong, violates conservation laws

The ML model predicts based on similar known reactions. If Cu + Sn → bronze is in the training data, and the player tries Cu + Sb (antimony, similar to Sn), the model predicts Cu + Sb → copper antimonide with reasonable properties — because it learned the pattern.

**Safety constraints (physics must still be conserved):**
```
function mlReaction(reactants, temperature):
  predicted = reactionModel.predict(reactants, temperature)
  
  // HARD CONSTRAINTS (never violated):
  // 1. Mass conservation: sum of product masses = sum of reactant masses
  assert(sum(predicted.products.mass) == sum(reactants.mass))
  
  // 2. Element conservation: each element's total atoms unchanged
  for element in periodicTable:
    assert(countAtoms(predicted.products, element) == countAtoms(reactants, element))
  
  // 3. Energy conservation: ΔH accounts for all energy
  assert(abs(totalEnergy(products) - totalEnergy(reactants) - predicted.deltaH) < epsilon)
  
  // If any constraint violated: fall back to hand-crafted reaction engine
  // ML prediction is a suggestion, physics is the law
  
  return predicted
```

### When to implement
After the hand-crafted reaction engine handles the ~200 most common reactions. ML fills in the long tail of rare/novel reactions.

---

## 3. Sound Synthesis Enhancement

### What it replaces
The modal synthesis formula (f = β²/(2πL²) × √(EI/ρA)) computes frequencies from geometry and material. But real objects have complex shapes that don't match "bar" or "plate" models. A clay pot, a stone arch, a wooden chair — their mode shapes are irregular.

### How ML does it better
Train on audio recordings + material/geometry pairs:

**Training data:**
- Physically-based sound synthesis datasets (Modal Sound, DiffSound)
- FEM eigenmode computations for 10,000+ random 3D shapes
- Real-world impact recordings with known materials (Freesound.org tagged data)

**Model:**
```
Input: voxelized 3D shape (16³ = 4096 voxels)
       + material properties (E, ρ, ν, damping)
       + impact location (normalized coordinates)
       + impact energy (Joules)

Output: 20 mode frequencies (Hz) + 20 mode amplitudes + 20 decay rates
        (enough to reconstruct the sound via additive synthesis)

Architecture: 3D CNN encoder → FC layers → mode parameter decoder
Size: ~2 MB
Inference: ~50 microseconds (run once per new object, cache result)
```

**Why this matters:**
Currently, a clay pot and a clay brick produce sound using the same "plate" or "bar" model — the only difference is dimensions. But a pot is a curved shell (completely different mode structure). The ML model would learn that curved shells have different frequency ratios than flat plates, producing more realistic "ceramic thunk" vs "brick clack."

### When to implement
After the basic modal synthesis is working and players notice that objects with complex shapes sound wrong.

---

## 4. Fluid Behavior Learning (Neural SPH)

### What it replaces
The SPH solver computes 5 forces per particle per tick using analytical formulas. This is correct but limited to ~5,000 particles at 60 Hz on CPU.

### How ML does it better
Train a neural network to predict particle motion directly, skipping the force computation:

**Published research:**
- "Learning to Simulate Complex Physics with Graph Networks" (Sanchez-Gonzalez et al., 2020)
- "Neural SPH" (Liu et al., 2024) — learns the SPH kernel itself
- "Lagrangian Fluid Simulation with Continuous Convolutions" (Ummenhofer et al., 2020)

**Model:**
```
Input: particle positions, velocities, and material properties
       at time t (and optionally t-1 for two-step methods)

Architecture: Graph Neural Network (GNN)
              Particles as nodes, neighbors as edges
              Message passing: each particle aggregates info from neighbors
              (same structure as SPH but learned instead of analytical)

Output: acceleration vector per particle (replaces force computation)

Update: v(t+1) = v(t) + a_predicted * dt
        x(t+1) = x(t) + v(t+1) * dt
```

**Advantages:**
- 10-100x faster than analytical SPH (the network learns to skip unnecessary computations)
- Can handle more particles at the same cost
- Naturally handles complex boundary conditions (the network learns them from training data)

**Disadvantages:**
- Not exactly energy-conserving (can drift over long simulations)
- Training requires ground-truth SPH data (bootstrap from the analytical solver)
- Generalization to unseen materials may be poor

**Practical approach:**
- Use analytical SPH for crafting (player is close, accuracy matters)
- Use Neural SPH for environment (far away, speed matters more than precision)
- The Neural SPH model is trained on the game's own analytical SPH output
- Periodically re-sync Neural SPH particles to analytical positions (every ~100 ticks)

### When to implement
After the analytical SPH is working and performance-limited. Neural SPH is the scaling solution when 5,000 particles isn't enough but GPU compute isn't available.

---

## 5. Structural Failure Prediction

### What it replaces
The load path algorithm (§3.4) traces loads through a structure and checks stress vs. strength at each block. This is correct but might miss failure modes that emerge from the global structure shape (like progressive collapse patterns or resonant failure under wind).

### How ML does it better
Train on thousands of simulated structural collapses:

**Training data:**
- Generate random voxel structures (10,000-100,000)
- Run the analytical structural solver on each
- Record: which blocks fail first, the cascade sequence, final debris pattern
- Also record: structures that DON'T fail (negative examples)

**Model:**
```
Input: 3D voxel grid of structure + material properties per block
       + applied loads (gravity, wind, impact)

Output per block: failure probability (0-1)
                  expected failure mode (compression/tension/shear/buckling)
                  cascade risk (if this block fails, how many others follow?)

Architecture: 3D U-Net (like medical image segmentation)
              Encodes the full structure, predicts per-voxel failure risk
Size: ~10 MB
Inference: ~1 ms for a 200-block structure
```

**Why this matters:**
The analytical solver checks each block independently (plus combined stress). The ML model sees the WHOLE structure and can identify weak points that are non-obvious — like a block that's not overloaded itself but whose failure would cascade through the entire structure (articulation point analysis, but learned from examples rather than graph theory).

**Practical approach:**
- Use the analytical solver as the authoritative physics
- Use the ML model as a "structural advisor" that highlights risky blocks
- Visual feedback: blocks predicted to be at risk glow slightly (warning)
- The ML model does NOT control failure — it just predicts where failure is likely
- If ML says "risky" but analytical says "safe": block stays (physics wins)
- If ML says "safe" but analytical says "fail": block breaks (physics wins)

### When to implement
After thousands of player-built structures exist and the analytical solver has validated collapse data to train on.

---

## 6. NPC Craft Discovery via Reinforcement Learning

### What it replaces
Currently, NPC discovery is driven by the SLM (small language model) + curiosity system. NPCs try random combinations and remember what works. This is emergent but SLOW — an NPC might try 1,000 random combinations before finding copper smelting.

### How RL does it better
Train an RL agent to discover crafting recipes by interacting with the physics:

**Environment:**
- State: available materials, known recipes, available tools, nearby structures
- Actions: place material A on surface B, apply heat/force/liquid, wait
- Reward: +1 for discovering a new useful material, -0.01 per action (encourages efficiency)

**Agent:**
- Policy: small neural network mapping state → action probabilities
- Training: PPO (Proximal Policy Optimization) in a headless simulation
- The agent plays thousands of accelerated game-hours, discovering the entire tech tree

**Output:**
- A trained policy that each NPC runs locally
- NPCs make "intelligent guesses" instead of random combinations
- A curious NPC with the trained policy discovers copper smelting in ~20 attempts instead of ~1,000

**Why this matters:**
It makes NPCs feel genuinely intelligent. They experiment systematically, not randomly. They build on previous discoveries (the policy encodes the relationships between materials). A player watching an NPC discovers something faster than a random exploration and learns from watching the NPC's systematic approach.

**Safety:**
- The RL policy SUGGESTS actions. The reaction engine VALIDATES them.
- The NPC can't "cheat" — it still places materials in the physics simulation
- If the policy suggests something impossible (reacting materials that don't react), nothing happens — just like a player trying something that doesn't work

### When to implement
After the NPC behavior system and crafting system are functional. RL training requires a stable simulation to train against.

---

## 7. Terrain Generation via Generative Models

### What it replaces
World generation (§4.1) uses procedural noise (Perlin, Simplex) + geological rules to create terrain. This produces plausible landscapes but not REALISTIC ones.

### How ML does it better
Train a generative model on real Earth terrain data:

**Training data:**
- SRTM (Shuttle Radar Topography Mission) — 30m resolution elevation data for the entire Earth
- ASTER GDEM — 30m global elevation
- LiDAR point clouds from national geological surveys (US, EU, Japan)
- Satellite imagery for biome/vegetation classification

**Model:**
```
Architecture: StyleGAN3 or Diffusion Model for heightmaps
Input: conditioning vector (latitude, tectonic activity, rainfall, 
       time since last glaciation, biome type)
Output: 512×512 heightmap tile at 2m resolution

Post-processing:
  - Hydraulic erosion simulation (fast GPU-based)
  - River network extraction from flow accumulation
  - Soil type classification from slope + rainfall + bedrock
```

**Why this matters:**
Procedural noise creates "noise-looking" terrain — it has the right statistics but not the right SHAPES. Real terrain has specific features that emerge from geological processes: U-shaped glacial valleys, V-shaped river valleys, alluvial fans, karst topography, volcanic calderas, fault scarps. A trained model learns these shapes from real data.

### When to implement
After the basic procedural world generation is functional. This is a quality upgrade, not a functional requirement.

---

## 8. Weather Prediction from Climate Model Emulation

### What it replaces
The weather system (§4.6) uses simplified atmospheric physics (temperature from latitude, pressure from altitude, wind from pressure gradients). This produces weather patterns but not realistic forecasting.

### How ML does it better
Google's GraphCast and NVIDIA's FourCastNet have shown that ML models can predict weather faster and more accurately than traditional numerical models:

**Approach:**
- Train on ERA5 reanalysis data (40 years of global weather at 0.25° resolution)
- The model learns the relationship between current weather state and future state
- Run the trained model in-game to produce weather that EVOLVES realistically over time

**For the game:**
- Don't need global-scale accuracy
- Need local plausibility: if it rained yesterday and wind is from the west, what's today's weather?
- A small model (10 MB) trained on regional climate data could produce realistic multi-day weather sequences
- Current system: weather is computed from formulas every tick (correct but simplified)
- ML system: weather evolves as a sequence predicted by the model (more realistic patterns)

### When to implement
After the basic weather system is functional and players notice weather patterns feeling repetitive or unrealistic.

---

## Implementation Infrastructure

### Model Serving Architecture
```
All ML models run on the SERVER, not the client.
The server already runs Rust physics — ML models run alongside.

Option A: ONNX Runtime in Rust
  - Load .onnx model files at startup
  - Inference in native Rust code (no Python dependency)
  - ~10 microsecond inference for small models
  - Recommended for: material properties, sound, structural prediction

Option B: Python sidecar process
  - Separate Python process with PyTorch/TensorFlow
  - Communicates with Rust via shared memory or Unix socket
  - Required for: complex models (GNN for reactions, RL for NPCs)
  - Higher latency (~1 ms) but more flexible

Option C: Pre-computed lookup tables
  - Run the ML model OFFLINE for common compositions
  - Store results as a lookup table (JSON or binary)
  - Game loads the table at startup, interpolates at runtime
  - Zero inference cost — just table lookup
  - Recommended for: first implementation of property prediction
```

### Training Pipeline
```
1. Collect data:
   - From published databases (Materials Project, AFLOW, NIST)
   - From in-game simulation (players generate novel compositions)
   - From player bug reports ("this material behaves wrong")

2. Train models:
   - Offline, on a GPU workstation or cloud instance
   - Hyperparameter search with Optuna or Ray Tune
   - Validation against held-out experimental data

3. Validate:
   - Compare ML predictions against hand-crafted formulas
   - Flag cases where they disagree by >20%
   - Human review of flagged cases (is the ML right or the formula right?)

4. Deploy:
   - Export model to ONNX format
   - Ship with game update
   - A/B test: 50% of servers use ML, 50% use formulas
   - Compare player experience metrics

5. Monitor:
   - Track prediction accuracy on novel compositions
   - Retrain periodically as new data accumulates
   - Detect model drift (predictions getting worse over time)
```

### Data Collection from Gameplay
```
Every time a player creates a novel composition (one not in the training data):
  1. Log: composition vector + observed properties (from formula)
  2. If the player reports "this doesn't seem right": flag for review
  3. Periodically: batch-upload anonymized composition-property pairs
  4. Use these to fine-tune the ML model on game-specific compositions

This creates a FEEDBACK LOOP:
  Players create novel materials →
  Game logs the formula-predicted properties →
  ML model trains on the accumulated data →
  ML model corrects the formula for future players →
  Players create even more novel materials
  
Over time, the game gets more precise WITHOUT manual formula updates.
```

---

## What This Means for the Game's Philosophy

The game's core principle: "everything emerges from physics, nothing is pre-defined."

ML doesn't violate this. The ML model LEARNS physics from data — it doesn't hardcode recipes or properties. A trained model that predicts bronze is harder than copper does so because it observed this pattern in real materials data, not because a programmer typed `if (material == "bronze") hardness = 150`.

The formula-based approach and the ML approach are both trying to do the same thing: predict how atoms behave when combined. Formulas do it from first principles (theory). ML does it from observation (data). Reality uses neither — it just happens. Both approaches are approximations of reality. ML is closer to reality because it's trained on reality, not on simplified theory.

The ideal endgame: the property calculator is a neural network trained on every measured material property ever published, constrained by conservation laws, running in microseconds. The hand-crafted formulas become the fallback for edge cases where the ML model has no data. The game gets more precise over time as more data flows in.

That's not a distant dream. The Materials Project already has 150,000+ materials computed from quantum mechanics. Training a property predictor on that data is a well-studied problem (published papers with code: MEGNet, CGCNN, Automatminer). The infrastructure (ONNX, Rust FFI) exists. The main blocker is: the hand-crafted formulas need to work first, so we have something to validate the ML model against.

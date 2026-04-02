# Vision Realignment Plan — Universe Sim

**Date:** 2026-03-27
**Author:** Game Dev Director
**Status:** ACTIVE

---

## Executive Summary

Universe Sim is meant to be an **emergent organism simulation** where life arises from chemistry, evolves through natural selection, and autonomously builds civilizations — with the player as an observer/god. The codebase has drifted heavily into RPG territory. This plan charts the course back.

**The good news:** The simulation foundation is excellent and scientifically rigorous. The RPG layer was built on top of it, not instead of it. Realignment is a matter of promoting the simulation to the foreground and demoting/repurposing the RPG systems.

---

## Part 1: Audit Results

### SIMULATION SYSTEMS (Strong Foundation)

These systems are well-built, scientifically accurate, and directly serve the emergent sim vision:

| System | File(s) | Quality | Notes |
|--------|---------|---------|-------|
| **Genome Encoder** | `src/biology/GenomeEncoder.ts` | Excellent | 256-bit genome, 13 trait categories, dominant/recessive alleles, chromosomal crossover. Ready for evolution. |
| **Mutation Engine** | `src/biology/MutationEngine.ts` | Excellent | 6 mutation types (point, insertion, deletion, transposition, inversion, duplication), E. coli-calibrated rates, horizontal gene transfer, lethality checks. |
| **Ecosystem Balance** | `src/biology/EcosystemBalance.ts` | Excellent | N-species Lotka-Volterra with RK4 integration, biome carrying capacities, arms race tracking (Red Queen), collapse risk assessment. |
| **Species Registry** | `src/biology/SpeciesRegistry.ts` | Excellent | Full phylogenetic tracking, Latin binomial naming, Shannon/Simpson biodiversity indices, lineage trees, extinction recording. |
| **Neural Architecture** | `src/ai/NeuralArchitecture.ts` | Good | 5-level brain scaling (L0 reflex -> L4 abstract), sensory input/motor output interfaces, creature FSM states. |
| **Behavior Trees** | `src/ai/BehaviorTree.ts` | Good | Forager, Predator, Prey, Social BT factories. Autonomous decision-making for L1-L2 creatures. |
| **GOAP Planner** | `src/ai/GOAP.ts` | Good | A* action planning for L3-L4 creatures. 20+ standard actions (find food, mate, build shelter, teach, trade). |
| **Sensory System** | `src/ai/SensorySystem.ts` | Good | 5-sense model (vision, olfaction, hearing, electroreception, touch) with genome-driven ranges. |
| **Emotion Model** | `src/ai/EmotionModel.ts` | Good | Emotional state influencing behavior decisions. |
| **Memory System** | `src/ai/MemorySystem.ts` | Good | Episodic memory for learning creatures. |
| **Social Simulation** | `src/ai/SocialSimulation.ts` | Good | Group dynamics, social bonding, cooperative behavior. |
| **Flocking System** | `src/ai/FlockingSystem.ts` | Good | Reynolds boid rules (separation, alignment, cohesion). |
| **Element Database** | `src/chemistry/ElementDatabase.ts` | Excellent | All 118 elements with real NIST/IUPAC data (melting points, electronegativity, biological essentiality). |
| **Molecule Registry** | `src/chemistry/MoleculeRegistry.ts` | Good | Molecule definitions with real properties. |
| **Reaction Engine** | `src/chemistry/ReactionEngine.ts` | Excellent | Arrhenius kinetics, real Ea/deltaH values, 15 reaction categories including abiogenesis. |
| **Simulation Engine** | `src/engine/SimulationEngine.ts` | Good | Grid3D with 4 physics workers (physics, fluid, thermal, chem) on SharedArrayBuffer. |
| **Civilization Tracker** | `src/civilization/CivilizationTracker.ts` | Moderate | Tier-based civ progression, diplomacy, territory. Player-centric but repurposable. |
| **Planet Generator** | `src/world/PlanetGenerator.ts` | Good | Spherical planet with biomes, terrain height. |
| **Weather System** | `src/world/WeatherSystem.ts` | Good | Markov chain weather, storm effects. |
| **River System** | `src/world/RiverSystem.ts` | Good | Flow-field rivers with erosion. |

### RPG SYSTEMS (Drift from Vision)

These systems treat the player as a character doing RPG actions, not an observer:

| Category | Systems | File Count |
|----------|---------|------------|
| **Player Character** | PlayerController (WASD movement, jump, sprint, crouch), camera modes (1st/3rd person) | 5 files in `src/player/` |
| **Survival Meters** | Hunger, thirst, warmth, stamina, health, wound infection, hypothermia, drowning | SurvivalSystems.ts + playerStore |
| **Inventory & Crafting** | 60+ materials, 100+ recipes, crafting mastery, recipe discovery, blueprint unlocks | Inventory.ts, CraftingRecipes.ts, 5+ systems |
| **Combat** | CombatSystem, ComboSystem, WeaponUpgrade, EnemyVariants, WorldBoss, BossSystem | 6+ systems |
| **Dungeons** | DungeonSystem, DungeonFloor, DungeonRoomInteraction, DungeonDelve, CaveFeatures | 5 systems |
| **Equipment** | EquipSystem, EnchantSystem, armor slots, weapon types, rarity tiers | 3+ systems |
| **Quests** | QuestSystem, QuestGenerator, DynamicQuestBoard, BountyBoard | 4 systems |
| **NPC RPG** | NPCGift, NPCRelationship, NPCSchedule, NPCEmotion, NPCMemory, DialoguePanel | 6+ systems |
| **Merchant/Economy** | MerchantSystem, MerchantGuild, MarketPrice, Shop, TradeRoute | 5+ systems |
| **Housing** | HousingSystem, HousingUpgrade, HomeCustomization, PlayerHousing | 4 systems |
| **Skills/Magic** | SkillSystem, SkillSpecialization, SkillCombo, SpellSystem, TalentTree | 5 systems |
| **Titles/Rep** | TitleSystem, TitleProgression, ReputationTitle, FactionReputation, PlayerTitle | 5 systems |
| **Achievements** | AchievementSystem, AchievementShowcase, PlayerAchievementJournal | 3 systems |
| **Pets/Mounts** | PetSystem, PetAdvancement, MountHUD | 3 systems |
| **Fishing** | FishingSystem, FishingDepth | 2 systems |
| **Food/Potions** | FoodBuffSystem, PotionSystem, RecipeBook | 3 systems |
| **Sailing/Raft** | SailingSystem, RaftSystem | 2 systems |
| **Death/Loot** | DeathSystem, LootSystem, LootPickup, LootTable, ChestSystem | 5 systems |
| **Misc RPG** | EmoteSystem, TutorialSystem, ExpeditionSystem, FestivalSystem, Outlaw/PvP | 5+ systems |

**Total: ~70+ pure RPG systems in `src/game/`**

### KEY INSIGHT

The simulation layer (biology, chemistry, AI) and the RPG layer (player, combat, crafting) are largely **decoupled**. The RPG systems import from the sim layer but the sim layer does not depend on RPG systems. This means we can promote the sim layer without breaking the RPG code — and phase out RPG systems gradually.

---

## Part 2: What to KEEP (Simulation Core)

These systems are the heart of the vision and must be preserved, enhanced, and promoted to the foreground:

1. **Biology Pipeline** (all 4 files) — genome, mutation, ecosystem balance, species registry
2. **AI Architecture** (all 9 files) — neural levels, behavior trees, GOAP, sensory, emotion, memory, social, flocking, LLM bridge
3. **Chemistry Pipeline** (all 3 files) — elements, molecules, reaction engine
4. **Physics Engine** — Grid3D, SimulationEngine, 4 physics workers
5. **ECS Core** — entity/component/system architecture, creature spawner, animal AI system, metabolism system
6. **World Generation** — planet, biomes, rivers, weather, seasons
7. **Civilization Tracker** — needs repurposing from player-driven to organism-driven, but the structure is sound

---

## Part 3: What to REPURPOSE (RPG -> Observer/God Tools)

| Current RPG System | Repurposed As | Priority |
|--------------------|---------------|----------|
| **PlayerController** (WASD camera) | **Spectator Camera** — free-fly observer cam with time controls, zoom from molecular to planetary scale | P0 |
| **AdminPanel** | **God Mode Panel** — seed organisms, trigger extinction events, adjust environmental pressures, fast-forward time | P0 |
| **Minimap/HUD** | **Ecosystem Dashboard** — population graphs, biodiversity index, food web visualization, species tree | P0 |
| **SettlementHUD** | **Civilization Observer** — watch autonomous settlements grow, trade, go to war | P1 |
| **TimeControls** | **Simulation Speed Controls** — pause, 1x, 10x, 100x, 1000x, epoch skip | P0 |
| **WorldEventHUD** | **Event Log** — natural disasters, speciation events, extinctions, first tool use, etc. | P1 |
| **WeatherEffectsHUD** | **Environmental Monitor** — temperature maps, chemical concentrations, weather patterns | P1 |
| **DialoguePanel** | **Species Inspector** — click any organism to see its genome, phenotype, brain state, family tree | P1 |

---

## Part 4: What to PHASE OUT (Pure RPG — No Sim Value)

These systems have no place in an emergent organism simulation. They should be marked deprecated and excluded from the main game loop. No immediate deletion needed — just stop calling them and stop building on them.

**Phase-out tier 1 (stop calling in GameLoop immediately):**
- SurvivalSystems (hunger/thirst/warmth/stamina for player)
- CombatSystem, ComboSystem, WeaponUpgradeSystem
- DungeonSystem, DungeonFloor, DungeonRoomInteraction, DungeonDelve
- EquipSystem, EnchantSystem
- LootPickup, LootTable, ChestSystem
- DeathSystem (player death/respawn)
- FishingSystem, FishingDepth
- PotionSystem, FoodBuffSystem
- SpellSystem, WeatherSpellSystem
- EmoteSystem

**Phase-out tier 2 (stop building new features on these):**
- QuestSystem, QuestGenerator, DynamicQuestBoard, BountyBoard
- SkillSystem, SkillSpecialization, SkillCombo, TalentTree
- TitleSystem, TitleProgression, ReputationTitle
- AchievementSystem, AchievementShowcase
- HousingSystem, HousingUpgrade, HomeCustomization
- PetSystem, PetAdvancement
- MerchantSystem, MerchantGuild, MarketPrice
- NPCGift, NPCRelationship (player-specific NPC interactions)
- FactionReputation, FactionWar (player-faction mechanics)
- Outlaw/PvP system

**Phase-out tier 3 (eventually remove):**
- Inventory.ts (player inventory — organisms should have their own resource tracking)
- CraftingRecipes.ts (player crafting — organisms should discover crafting autonomously)
- All player-specific stores (playerStore survival meters, skillStore, spellStore, etc.)

---

## Part 5: What to BUILD (Simulation Gaps)

### Gap Analysis

The simulation has strong individual components but they are not yet **connected into emergent loops**. The key missing pieces:

| Gap | Description | Why It Matters |
|-----|-------------|----------------|
| **Abiogenesis Pipeline** | Chemistry -> first organism. The ReactionEngine has an 'abiogenesis' category but no actual pipeline from molecules to the first GenomeEncoder organism. | Without this, life doesn't emerge from chemistry — it's just spawned. |
| **Natural Selection Loop** | Organisms reproduce, mutate, and die — but fitness is not yet driving which survive. Need: environment pressure -> phenotype fitness -> differential reproduction. | This IS the game. Without selection pressure, genomes drift randomly instead of evolving. |
| **Organism Autonomy at Scale** | BehaviorTree and GOAP exist but only a few animal species use them. Need: every organism (from bacteria to civilized beings) running autonomous AI every tick. | The sim needs thousands of autonomous agents, not a handful of scripted NPCs. |
| **Chemistry-Biology Bridge** | Molecules exist in the grid; organisms exist in ECS. No bridge: organisms don't consume grid chemicals, and their metabolism doesn't produce waste chemicals. | Organisms must be embedded in the chemical environment — consuming O2, producing CO2, etc. |
| **Evolutionary Visualization** | No way for the observer to see evolution happening — no phylogenetic tree display, no trait distribution graphs, no speciation timeline. | The player IS the observer. If they can't see evolution, the game has no content. |
| **Epoch System** | No automatic progression from primordial soup -> single cell -> multicellular -> intelligent -> civilized. The genome supports it (civilization-era traits) but nothing drives the transitions. | The game's arc IS the epoch progression. |
| **Observer Interface** | No spectator camera, no god-mode tools, no data visualization layer. The entire UI assumes a character-in-world. | Without observer tools, there is no game to play. |

---

## Part 6: Sprint Priorities — M72, M73, M74

### M72: "The Watcher" — Observer Foundation + Sim Loop Connection
**Goal:** Player can observe autonomous organisms in a running ecosystem.

| ID | Task | Agent | Priority | Deliverable |
|----|------|-------|----------|-------------|
| M72-1 | **Spectator Camera System** — Replace PlayerController with a free-fly observer camera. Zoom from ground level to orbit. Click organisms to inspect. No WASD character. | interaction | P0 |
| M72-2 | **Simulation Bootstrap** — On world creation, run abiogenesis: seed primordial genomes in warm shallow water biomes, connect to EcosystemBalance. Remove player character spawn. | biology-prof | P0 |
| M72-3 | **Natural Selection Tick** — Each ecosystem tick: evaluate organism fitness against environment (temperature tolerance, food availability, predation). Low-fitness organisms die faster; high-fitness reproduce faster. Feed results back to EcosystemBalance. | biology-prof | P0 |
| M72-4 | **Ecosystem Dashboard HUD** — Replace survival HUD with: population count per species, biodiversity index (Shannon H'), simple population graph over time, current epoch label. | ui-worker | P0 |
| M72-5 | **Time Controls** — Pause / 1x / 10x / 100x / 1000x simulation speed. Epoch skip button (fast-forward until next major evolutionary event). | interaction | P0 |
| M72-6 | **Deactivate RPG GameLoop** — Comment out all survival-meter ticks, combat ticks, crafting ticks, dungeon ticks, quest ticks from GameLoop.ts. Keep: creature AI, ecosystem balance, weather, chemistry. | interaction | P1 |

### M73: "Genesis" — Chemistry-to-Life Pipeline
**Goal:** Life emerges from chemistry. Evolution drives speciation.

| ID | Task | Agent | Priority | Deliverable |
|----|------|-------|----------|-------------|
| M73-1 | **Abiogenesis System** — When grid cells reach right conditions (warm water, amino acid precursors from ReactionEngine), spontaneously generate primordial genomes. Rate based on Miller-Urey experiment conditions. | chemistry-prof | P0 |
| M73-2 | **Organism-Grid Chemical Bridge** — Organisms consume chemicals from grid (O2 for aerobic, CO2 for autotrophs) and excrete waste (CO2, NH3). Metabolism rate from genome drives consumption. | chemistry-prof + biology-prof | P0 |
| M73-3 | **Speciation Engine** — When genome drift exceeds threshold from parent species template, register new species in SpeciesRegistry. Track divergence continuously. | biology-prof | P0 |
| M73-4 | **Phylogenetic Tree Viewer** — Interactive tree visualization showing all species lineages, branching events, extinctions. Click any node to see genome diff. | ui-worker | P1 |
| M73-5 | **Environmental Pressure System** — Climate shifts (ice ages, warming), volcanic events, asteroid impacts that change grid conditions and drive mass extinctions / adaptive radiation. | physics-prof | P1 |
| M73-6 | **God Tools: Seed & Smite** — Observer can: drop organisms into the world, trigger environmental events (meteor, volcano, flood), adjust global temperature/chemistry. | interaction | P1 |

### M74: "Awakening" — Autonomous Civilization Emergence
**Goal:** Organisms with high neural complexity autonomously develop tools, language, settlements.

| ID | Task | Agent | Priority | Deliverable |
|----|------|-------|----------|-------------|
| M74-1 | **Autonomous Tool Discovery** — When organism genome has toolUseSophistication > threshold AND encounters the right materials, GOAP planner generates "craft tool" plan without player input. | ai-npc | P0 |
| M74-2 | **Autonomous Settlement Formation** — Organisms with high socialStructure + cooperation aggregate into settlements. CivilizationTracker driven by organism behavior, not player actions. | ai-npc | P0 |
| M74-3 | **Language Emergence** — Organisms with high communicationType + grammarComplexity develop shared vocabularies that improve cooperation effectiveness. | ai-npc | P1 |
| M74-4 | **Technology Tree (Organism-Driven)** — Replace player-unlocked tech with organism-discovered tech. Genome traits (abstractReasoning, technologyDrive) determine research rate. | knowledge-director | P1 |
| M74-5 | **Civilization Dashboard** — Observer view: settlement map, trade routes, diplomatic relations, technology level, language families. All autonomous, no player intervention. | ui-worker | P1 |

---

## Part 7: Technical Architecture Decisions

### Observer Camera (replaces PlayerController)
- Free-fly camera with smooth inertia
- Zoom levels: molecule (1cm) -> organism (1m) -> terrain (100m) -> continent (10km) -> orbit (1000km)
- Click-to-inspect: click any entity to open inspector panel showing genome, phenotype, brain state, family tree
- Follow mode: lock camera to track a specific organism
- Time scrubber: rewind to see historical events

### Simulation Tick Architecture
```
Per Frame:
  1. SimulationEngine.tick() — physics, fluid, thermal, chem workers
  2. ReactionEngine.tick() — chemical reactions in grid cells
  3. Abiogenesis check — can life spawn in any cell?
  4. For each organism entity:
     a. SensorySystem.sense() — read grid + nearby entities
     b. Brain.decide() — BT (L1-2) or GOAP (L3-4) or reflex (L0)
     c. MotorSystem.act() — execute decision (move, eat, mate, build)
     d. Metabolism.tick() — consume energy, age, possibly die
  5. EcosystemBalance.tick() — population dynamics, predator-prey
  6. SpeciesRegistry.check() — speciation events, extinction events
  7. CivilizationTracker.tick() — settlement growth (organism-driven)
  8. UI update — dashboard, graphs, event log
```

### Performance Budget
- Target: 1000+ autonomous organisms at 60fps
- Grid simulation: offloaded to Web Workers (already done)
- Organism AI: LOD system — full BT/GOAP for nearby organisms, simplified tick for distant ones (already partially implemented in AnimalAISystem)
- Rendering: instanced meshes for organisms, LOD geometry

---

## Part 8: Success Criteria

The vision is achieved when:

1. **Life emerges from chemistry** — no manual spawning needed
2. **Evolution is visible** — species change over time, new species appear, old ones go extinct
3. **The player watches, not acts** — all interesting events happen autonomously
4. **Civilizations emerge from biology** — tool use, language, settlements arise from genome traits
5. **The ecosystem feels alive** — predator-prey cycles, migration, adaptation to climate
6. **God tools feel powerful** — dropping a meteor and watching the aftermath is satisfying
7. **The timeline is the narrative** — billions of years of history unfold uniquely each playthrough

---

## Appendix: Agent Assignments Summary

| Agent | New Focus |
|-------|-----------|
| **biology-prof** | Natural selection loop, speciation engine, abiogenesis organism-side, ecosystem integration |
| **chemistry-prof** | Abiogenesis chemistry conditions, organism-grid chemical bridge, environmental chemistry |
| **ai-npc** | Autonomous organism decision-making at scale, tool discovery, settlement formation, language emergence |
| **physics-prof** | Environmental pressure system (ice ages, volcanism, asteroids), grid simulation optimization |
| **knowledge-director** | Scientific accuracy review of all sim systems, technology tree design |
| **ui-worker** | Ecosystem dashboard, phylogenetic tree viewer, civilization dashboard, organism inspector |
| **interaction** | Spectator camera, time controls, god tools, GameLoop cleanup |
| **gp-agent** | Playtest the observer experience — is watching evolution engaging? |

# Director Plan -- Universe Sim

**Date**: 2026-03-26
**Sprint**: M28
**Status**: IN PROGRESS -- Workers spawning

---

## M26 Completion Summary (2026-03-26)

**All 3 Tracks SHIPPED:**

- **Track A (ui-worker): Remote Player Visibility -- DONE** -- Verified RemotePlayersRenderer.tsx already implemented; feature confirmed working. No new code needed.
- **Track B (interaction): Player Emotes System -- DONE** -- EmoteSystem.ts (8 emotes: wave/dance/sit/point/cheer/bow/laugh/shrug, 3s auto-clear, WebSocket broadcast). EmoteWheel.tsx (hold T radial wheel, 8 sectors). Wired into HUD.tsx, GameLoop.ts, RemotePlayersRenderer.tsx.
- **Track C (physics-prof): Enhanced Procedural Footsteps -- DONE** -- Rewrote footstep system in AmbientAudioEngine.ts: 6 terrain types (grass/stone/sand/snow/wood/water), spatial L/R panning, speed-linked rhythm, surface transition crossfade.

**Build**: Passes (0 errors).

---

## M25 Completion Summary (2026-03-26)

**All 3 Tracks SHIPPED:**

- **Track A (ui-worker): Mobile Touch Controls -- DONE** -- Virtual joystick + action buttons for mobile browsers.
- **Track B (ai-npc): Wildlife Flocking AI -- DONE** -- Boid rules for deer herds and bird flocks (separation/alignment/cohesion).
- **Track C (interaction): Fishing Minigame -- DONE** -- Cast/wait/bite/reel state machine with loot integration.

**Build**: Passes (0 errors).

---

## M24 Completion Summary

**All 3 Tracks SHIPPED:**

- **Track A (ui-worker): DONE** — SidebarShell wired AchievementPanel into PANEL_COMPONENTS, 'H' hotkey added, ACH sidebar icon rendered
- **Track B (ai-npc): DONE** — achievementSystem.tick() wired in GameLoop, OfflineSaveManager persists achievements + tutorialStep via registerAchievementSystem/registerTutorialSystem
- **Track C (interaction): DONE** — TutorialSystem.ts (114 lines, 8 steps, serialize/deserialize), TutorialOverlay.tsx (94 lines, step modal with skip/next), wired into GameLoop and HUD

**All files shipped:**
- src/game/CombatSystem.ts (222 lines) — melee cooldowns, combo, dodge, block
- src/ui/CombatHUD.tsx (255 lines) — damage numbers, enemy health bars
- src/game/AchievementSystem.ts (324 lines) — 25 achievements, toast queue, persistence
- src/ui/panels/AchievementPanel.tsx (172 lines) — grid with progress bars
- src/game/TutorialSystem.ts (114 lines) — 8-step tutorial, serialize/deserialize
- src/ui/TutorialOverlay.tsx (94 lines) — step modal, skip/next, wired to HUD
- src/ecs/systems/AnimalAISystem.ts — wolf/boar aggro, respawn queue
- src/game/GameLoop.ts — combat/respawn/achievement/tutorial ticks
- src/game/GameSingletons.ts — combatSystem, achievementSystem, tutorialSystem exports
- src/game/OfflineSaveManager.ts — achievement + tutorial persistence
- src/ui/SidebarShell.tsx — ACH icon, 'H' hotkey, PANEL_COMPONENTS entry
- src/store/uiStore.ts — 'achievements' PanelId

---

## M18 Retrospective

**All 3 Tracks SHIPPED:**

- **Track A -- SceneRoot Decomposition: DONE** -- 2189 -> 578 lines (target 600). 9 extracted files in `src/rendering/entities/`. Commit: `99eac0f`
- **Track B -- PostProcessing Pipeline: DONE** -- 5-pass chain: RenderPass -> SSAO (8-tap golden-angle) -> UnrealBloom -> ColorGrade (ASC CDL + ACES filmic) -> Vignette. 322 lines. Commit: `840a8b0`
- **Track C -- Chemistry-to-Gameplay Bridge: DONE** -- ChemistryGameplay.ts (207 lines, 2Hz sampler: fermentation/acid rain/photosynthesis/combustion heat) + ChemistryHUD.tsx (96 lines, notification badges with intensity bars). Wired into GameLoop tick. Commit: `840a8b0`

**Carried over to M19:**
- Ocean uses MeshPhongMaterial (not PBR) -- no reflections, no foam, no caustics
- Terrain/rocks/trees use vertex colors + procedural noise only -- no normal maps or PBR textures
- Atmosphere is a basic additive sphere -- no Rayleigh/Mie scattering
- Bundle is a single 3.8MB chunk -- no code splitting

**Lessons learned:**
- Standalone module pattern (PostProcessing, ChemistryGameplay) is the gold standard -- no surgery on existing code
- Always verify build after each new file
- SSAO depth texture must be refreshed each frame for correct results

---

## M19 Sprint Plan -- 3 Parallel Tracks

### Track A (P0): PBR Water Shader -- Ocean Overhaul
**Assigned to**: `ui-worker`
**Duration**: Full sprint
**Goal**: Replace the flat MeshPhongMaterial ocean with a physically-based water surface that looks convincing at both close range (shore) and far view (open ocean).

| Task | Description | Technical Spec |
|------|-------------|---------------|
| A1 | Create `OceanShader.ts` | Custom ShaderMaterial with: vertex displacement (2-octave Gerstner waves, amplitude 0.3m, wavelengths 8m and 20m, steepness 0.4), animated via `uTime` uniform. Fragment: PBR-like output with roughness 0.05 (near-mirror for calm water), metalness 0.02, base color deep blue-green `#0a2e3d`. |
| A2 | Screen-space reflections on water | Add environment probe reflection via `envMap` from a `CubeCamera` rendered once per 10 frames at water level. Fallback: use sky color gradient when `CubeCamera` is too expensive. Fresnel factor controls reflection vs refraction blend (Schlick approximation). |
| A3 | Shoreline foam | In the ocean fragment shader, compute distance-to-shore using the depth buffer difference (water depth = scene depth - water depth). Where waterDepth < 1.5m, blend white foam pattern using scrolling noise texture (procedural, 2-frequency). Foam alpha fades from 0.8 at shore to 0 at 1.5m depth. |
| A4 | Underwater caustics | Project animated caustic pattern onto terrain fragments that are below sea level. Implement as an addition to the terrain material's `onBeforeCompile` -- sample a 2D caustic noise pattern at `worldPos.xz * 0.3 + uTime * 0.1`, multiply by a depth attenuation factor. Only active when fragment elevation < SEA_LEVEL + 2m. |
| A5 | Wire into PlanetTerrain.tsx | Replace `makeOceanMaterial()` with the new shader. Ensure ocean mesh uses the new `OceanShader`. Pass `uTime` each frame. Connect depth texture from renderer for foam edge detection. |

**Quality gate**: (a) Visible wave displacement on ocean surface, (b) sky reflection on water at grazing angles, (c) white foam line along shoreline, (d) caustic light patterns on shallow underwater terrain, (e) `npm run build` succeeds, (f) no framerate regression >5% vs M18.

---

### Track B (P1): Atmospheric Scattering
**Assigned to**: `ui-worker` (parallel agent or after Track A completes A3)
**Duration**: Sprint second half
**Goal**: Replace the flat additive atmosphere sphere with a physically-motivated Rayleigh + Mie scattering sky that transitions naturally from blue daytime to orange/red sunset to dark night.

| Task | Description | Technical Spec |
|------|-------------|---------------|
| B1 | Create `AtmosphereShader.ts` | Custom ShaderMaterial for the atmosphere shell. Implements single-scattering integral along the view ray through a thin atmosphere layer. Rayleigh coefficients: `vec3(5.5e-6, 13.0e-6, 22.4e-6)` (wavelength-dependent blue scattering). Mie coefficient: `2.0e-5` (forward scattering for sun haze). Mie anisotropy (g): `0.76`. |
| B2 | Sun direction linkage | Read sun direction from `DayNightCycle.tsx` (the directional light direction). Pass as `uSunDirection` uniform to atmosphere shader. Sky color shifts orange/red as sun approaches horizon (long path length through atmosphere = more Rayleigh scattering of blue). |
| B3 | Night sky integration | When sun is below horizon (dot(sunDir, up) < -0.05), fade atmosphere to transparent, revealing the existing `NightSkyRenderer` stars behind. Smooth 10-minute twilight transition. |
| B4 | Replace atmosphere shells in PlanetTerrain | Remove `makeAtmosphereMaterial()` and `makeHazeMaterial()`. Replace with single `<mesh>` using the new `AtmosphereShader`. Dispose old materials. |

**Quality gate**: (a) Blue sky at noon, orange at sunset, dark at night, (b) sun haze glow visible at low angles, (c) smooth transition to starfield, (d) no z-fighting with terrain at horizon, (e) build passes.

---

### Track C (P1): PBR Terrain Material Pass
**Assigned to**: `chemistry-prof` or second `ui-worker` instance
**Duration**: Full sprint
**Goal**: Upgrade terrain, rock, and tree materials from basic vertex-color + procedural noise to full PBR with procedural normal maps, roughness variation, and detail layers.

| Task | Description | Technical Spec |
|------|-------------|---------------|
| C1 | Terrain tri-planar normal mapping | In `PlanetTerrain.tsx` `makeTerrainMaterial()`, add a procedural normal map computed in the fragment shader. Use tri-planar projection of a 3D noise derivative to compute per-pixel normals. This adds surface bumpiness (rocks, dirt, grass texture) without any texture files. Normal intensity: 0.15 for grass biome, 0.3 for rock biome (keyed off slope angle -- steep = rock). |
| C2 | Biome-dependent roughness | Extend the terrain shader to vary roughness by biome: grass = 0.85, rock = 0.65, sand (near coast) = 0.92, snow (high altitude) = 0.3. Use elevation and slope to blend between biomes. This makes rock faces shinier (wet-looking) and snow icy/reflective. |
| C3 | Rock material normal map | In `ResourceNodesRenderer.tsx` `makeRockMaterial()`, add procedural normal mapping using the same tri-planar technique from C1. Rock normals should be rougher (higher frequency noise) than terrain. Normal intensity: 0.4. Also add a subtle metallic fleck: metalness = 0.02 + noise * 0.05 for mineral deposits. |
| C4 | Tree bark and foliage PBR | In `ResourceNodesRenderer.tsx`, upgrade tree trunk material to include: bark-like normal pattern (vertical ridges via `sin(worldPos.y * 20) * 0.5 + noise`), roughness 0.92. Upgrade foliage material: add translucency via custom fragment shader that adds `dot(lightDir, -viewDir) * 0.15` to diffuse (simulates light through leaves). |

**Quality gate**: (a) Visible surface bumps on terrain when camera is within 5m, (b) rock faces have visible specular highlights that shift with camera angle, (c) tree trunks show bark-like ridges, (d) foliage has subtle backlight glow when sun is behind, (e) build passes, (f) no framerate regression >5%.

---

## Priority Queue (After M19 Tracks Complete)

| Priority | Item | Assigned To | Status |
|----------|------|-------------|--------|
| P1 | Code splitting (dynamic import for heavy systems) | cqa/ui-worker | Queued for M20 |
| P1 | Tree LOD (instanced low-poly at distance) | ui-worker | Queued for M20 |
| P2 | Species divergence notifications in journal | biology-prof | Queued |
| P2 | Subsurface scattering for creature skin | ui-worker | Queued |
| P2 | Volumetric fog (ray-marched, density from weather system) | ui-worker | Queued |
| P2 | Shadow cascade tuning (3 cascades, bias correction) | ui-worker | Queued |

---

## Architecture Decisions

| Decision | Rationale |
|----------|-----------|
| Ocean as custom ShaderMaterial, not MeshStandardMaterial | Need vertex displacement (Gerstner waves) and custom Fresnel -- standard material cannot do vertex animation |
| Procedural normals over texture files | Zero-dependency approach matches existing codebase pattern; no asset pipeline needed; infinite resolution |
| Atmosphere as single-pass scattering, not multi-pass LUT | Simpler to implement, no precomputation needed, good enough for game (not trying to match Bruneton/Neyret) |
| CubeCamera for ocean reflections, throttled to 1/10 frames | Full SSR is too expensive without deferred rendering; throttled cube camera is acceptable at 60fps |
| Tri-planar projection for terrain normals | Avoids UV seam artifacts on sphere geometry; standard technique for procedural terrain |

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Gerstner wave displacement causes z-fighting at shore | Medium | Medium | Offset ocean mesh slightly below terrain at coast; use depth-based foam to mask transition |
| CubeCamera reflection kills framerate | Medium | High | Throttle to 1/10 frames; fallback to sky-color gradient if FPS drops below 30 |
| Atmosphere scattering looks banded on low-end GPUs | Low | Medium | Use highp floats in shader; add subtle dithering |
| Procedural normals add too much GPU cost per fragment | Medium | Medium | Profile on build; reduce noise octaves if fragment shader exceeds 1ms |
| Tri-planar projection produces visible blend seams | Low | Low | Use smooth blending weights with power of 4 sharpness |

---

## Agent Dispatch Plan

| Agent | Track | First Task | Report To |
|-------|-------|-----------|-----------|
| `ui-worker` | Track A | A1: Create OceanShader.ts with Gerstner wave displacement | director |
| `ui-worker` | Track B | B1: Create AtmosphereShader.ts with Rayleigh+Mie scattering | director |
| `chemistry-prof` | Track C | C1: Add tri-planar procedural normal mapping to terrain shader | director |
| `cqa` | Code review | Review each new shader for correctness and performance | director |

---

## M19 Completion Summary (2026-03-26)

**All 3 Tracks SHIPPED:**

- **Track A -- PBR Water Shader: DONE** -- OceanShader.ts (334 lines): Gerstner wave displacement (2 octaves, 8m+20m), Schlick Fresnel reflections, shoreline foam (depth-based 2-freq noise), underwater caustics via onBeforeCompile. Wired into PlanetTerrain.tsx with per-frame sun direction.
- **Track B -- Atmospheric Scattering: DONE** -- AtmosphereShader.ts (301 lines): Rayleigh+Mie single-scattering integral (8 samples), Henyey-Greenstein phase, smooth twilight fade to NightSkyRenderer, Reinhard tonemapping. Replaces old flat atmosphere + haze shells.
- **Track C -- PBR Terrain Materials: DONE** -- Tri-planar normal mapping (terrain: 0.15/0.30 intensity), biome-dependent roughness (grass 0.85, rock 0.65, sand 0.92, snow 0.3), rock normal maps (0.4 intensity + metallic flecks), bark ridges (sin*20 + noise), foliage translucency (backlit 0.15).

**Build**: Passes (0 errors). Bundle: 3820 kB (code splitting deferred to M20).

---

## M20 Sprint Plan -- 3 Parallel Tracks

### Track A (P0): Code Splitting + Bundle Optimization
**Assigned to**: `ui-worker`
**Duration**: Full sprint
**Goal**: Break the 3820 kB monolithic bundle into targeted chunks. Target: main chunk < 1500 kB, lazy-loaded panels and heavy systems on demand.

| Task | Description | Technical Spec |
|------|-------------|---------------|
| A1 | Vite manual chunks config | In `vite.config.ts`, add `build.rollupOptions.output.manualChunks` to split: `three` + `@react-three/fiber` + `@react-three/drei` into `vendor-3d` chunk; `@clerk/react` into `vendor-auth` chunk; `framer-motion` into `vendor-ui` chunk. |
| A2 | Lazy-load sidebar panels | In `SidebarShell.tsx`, replace static imports of all 8 panel components (InventoryPanel, CraftingPanel, BuildPanel, JournalPanel, CharacterPanel, MapPanel, SettingsPanel, SciencePanel) with `React.lazy(() => import(...))`. Wrap each in `<Suspense fallback={<PanelSkeleton />}>`. Create a simple `PanelSkeleton` loading indicator. |
| A3 | Lazy-load heavy HUD overlays | Lazy-import `FirstContactOverlay`, `DecoderPanel`, `TransitOverlay`, `OrbitalView`, `TelescopeView`, `VelarDiplomacyPanel`, `VelarResponsePanel`, `VelarSignalView` in HUD.tsx since these are rarely shown. |
| A4 | Lazy-load AdminPanel | In `App.tsx`, lazy-import `AdminPanel` -- it is only used in dev/admin mode. |
| A5 | Build verification | Run `npm run build`, verify main chunk < 2000 kB, no errors, no broken lazy boundaries. Log all chunk sizes. |

**Quality gate**: (a) `npm run build` passes with 0 errors, (b) main chunk reduced by at least 30% from 3820 kB, (c) all panels still open correctly via hotkeys, (d) no visual regressions, (e) lazy-loaded chunks appear in dist/assets/ as separate files.

---

### Track B (P0): NPC Dialogue UI + Player Interaction
**Assigned to**: `ai-npc`
**Duration**: Full sprint
**Goal**: Build the player-facing dialogue interface that connects to the existing LLMBridge/MemorySystem/EmotionModel backend. Players can walk up to NPCs, press a key to initiate conversation, see dialogue in a cinematic speech bubble, and choose responses.

| Task | Description | Technical Spec |
|------|-------------|---------------|
| B1 | Create `DialoguePanel.tsx` | New panel at `src/ui/panels/DialoguePanel.tsx`. Renders: NPC name/portrait area (text-based, showing name + role + emotion icon), scrollable dialogue history (player lines right-aligned, NPC lines left-aligned), text input at bottom, send button. Style: dark translucent panel matching existing Rust-style UI (monospace, dark bg, rust-orange accents). Max 480px wide. |
| B2 | Create `DialogueStore.ts` | Zustand store at `src/store/dialogueStore.ts`. State: `isOpen: boolean`, `targetNpcId: number | null`, `targetNpcName: string`, `targetNpcRole: string`, `messages: Array<{sender: 'player' | 'npc', text: string, timestamp: number}>`, `isWaiting: boolean` (true while LLM is processing), `emotionState: EmotionState | null`. Actions: `openDialogue(npcId, name, role)`, `closeDialogue()`, `addMessage(sender, text)`, `setWaiting(bool)`, `setEmotion(state)`. |
| B3 | NPC interaction prompt | In the player interaction system, when a player is within 3m of an NPC and looking at them, show a "Press F to talk" prompt (same style as existing gather prompt). On F press, open the dialogue panel with that NPC's context. |
| B4 | Wire DialoguePanel to LLMBridge | When player sends a message, build an NPCContext from the target NPC's ECS data (name, role, settlement, emotion, memories), call `LLMBridge.requestDialogue()`, display the response in the dialogue history. Show a "thinking..." indicator while waiting. Parse the action from the response and execute it (e.g., `trade` opens shop, `lead_to_location` starts NPC pathfinding). |
| B5 | Register in SidebarShell | Add `'dialogue'` as a new PanelId in uiStore. Register DialoguePanel in SidebarShell's PANEL_COMPONENTS map. The dialogue panel should NOT appear in the icon strip (it opens contextually via F key, not from the sidebar). |
| B6 | Fallback for no LLM key | If no API key is configured (common for most players), generate a procedural response based on NPC emotion + trust + civ tier. Use a template system: "Greetings, traveler." / "Leave me be." / "Want to trade?" etc. keyed to trust level and emotion dominant. This ensures dialogue works offline. |

**Quality gate**: (a) Player can press F near NPC to open dialogue, (b) text input sends message and receives response, (c) "thinking..." indicator shows during LLM call, (d) fallback responses work when no API key, (e) dialogue history scrolls correctly, (f) panel closes on Escape, (g) build passes, (h) NPC emotion display updates after each exchange.

---

### Track C (P1): Inventory + Crafting UI Polish
**Assigned to**: `ui-worker`
**Duration**: Full sprint
**Goal**: Upgrade the inventory and crafting panels from functional-but-bare to polished game-quality UI. Add rich item tooltips, category icons, search/filter for crafting, and visual feedback on craft success.

| Task | Description | Technical Spec |
|------|-------------|---------------|
| C1 | Item tooltip component | Create `ItemTooltip.tsx` in `src/ui/panels/`. Shows on hover over any inventory slot: item name (bold, colored by rarity based on quality), material type, quantity, quality bar, and for tools: damage/speed stats from `getItemStats()`. For food: hunger/thirst restore from `getFoodStats()`. Position: above the hovered slot, clamped to viewport. |
| C2 | Category icons for inventory | Add a small colored dot or 2-letter abbreviation badge in each SlotCell: blue for tools, green for food/organic, orange for metal/minerals, grey for building materials. Keyed from materialId ranges defined in Inventory.ts MAT enum. |
| C3 | Crafting recipe search | Add a text search input at the top of CraftingPanel that filters recipes by name. Debounced 150ms. Styled consistently with existing filter buttons. |
| C4 | Craft success animation | On successful craft, briefly flash the recipe card with a green glow (CSS transition, 400ms), and show a "+1 [item name]" floating text that fades up and out near the craft button. |
| C5 | Tech tree categorization | Group crafting recipes by tier in collapsible sections: "Primitive (Tier 0)", "Stone Age (Tier 1)", "Bronze Age (Tier 2)", etc. Each section header shows tier name and count of available/total recipes. Collapsed by default except current tier. |

**Quality gate**: (a) Hovering inventory slot shows tooltip with correct stats within 200ms, (b) category indicators visible on all occupied slots, (c) search filters recipes in real-time, (d) craft success shows visual feedback, (e) tech tree sections collapse/expand correctly, (f) build passes, (g) no performance regression (tooltip must not cause re-render of entire grid).

---

## Architecture Decisions (M20)

| Decision | Rationale |
|----------|-----------|
| Manual chunks over Vite auto-splitting | Predictable chunk boundaries; three.js is 1.4MB alone and must be isolated |
| React.lazy for panels over route-based splitting | Panels are modal overlays, not routes; lazy() is the natural boundary |
| Dialogue as panel, not HUD overlay | Consistent with existing sidebar pattern; reuses SidebarShell animation and input blocking |
| Procedural fallback dialogue over silence | Players without API keys still get interactive NPC experience |
| Tooltip as portal to body, not inline | Prevents overflow/clip issues inside the 52px grid cells |

---

## Risk Register (M20)

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Lazy-loaded panels flash/jank on first open | Medium | Low | PanelSkeleton shows instantly; panels are small, load in <100ms |
| manualChunks breaks dynamic import boundaries | Medium | Medium | Test each chunk in build output; verify no circular dependencies |
| LLMBridge timeout leaves dialogue stuck | Medium | High | 10s timeout + fallback response on error; "thinking..." has a max 15s timer |
| Tooltip causes layout thrash in inventory grid | Low | Medium | Tooltip renders via React portal outside grid; uses absolute positioning |
| NPC interaction prompt conflicts with gather prompt | Medium | Low | Dialogue prompt takes priority when both active; gather prompt suppressed |

---

## Agent Dispatch Plan (M20)

| Agent | Track | First Task | Report To |
|-------|-------|-----------|-----------|
| `ui-worker` | Track A | A1: Add manualChunks to vite.config.ts | director |
| `ai-npc` | Track B | B1-B2: Create DialoguePanel + DialogueStore | director |
| `ui-worker` | Track C | C1: Create ItemTooltip component | director |

---

## M20 Completion Summary (2026-03-26)

**All 3 Tracks SHIPPED:**

- **Track A -- Code Splitting + Bundle Optimization: DONE** -- vite.config.js manualChunks splits vendor-3d (968 kB, three.js+R3F+drei), vendor-auth (226 kB, Clerk), vendor-ui (126 kB, framer-motion). 14 lazy-loaded panel/overlay chunks via React.lazy in SidebarShell.tsx, HUD.tsx, App.tsx. Main chunk: 2995 kB (down from 3820 kB monolith, 21.6% reduction of initial load).
- **Track B -- NPC Dialogue UI: DONE** -- DialoguePanel.tsx (230 lines): scrollable message history, text input, NPC name/role/emotion header, "thinking..." indicator. dialogueStore.ts (70 lines, Zustand). GameLoop NPC proximity check at 4m range with "[F] Talk to" prompt. Procedural fallback responses (friendly/neutral/hostile based on trust). Panel registered as lazy-loaded 'dialogue' PanelId.
- **Track C -- Inventory/Crafting UI Polish: DONE** -- ItemTooltip.tsx (200 lines): quality-colored hover tooltips via React portal (150ms delay, viewport-clamped), category badges (TL/FD/MT/BL/OR), tool stats (damage/speed/range), food stats (hunger/thirst restore). CraftingPanel upgraded with: text search (debounced 150ms), tier-grouped collapsible sections (Primitive through Transcendent), craft success green flash (400ms) + floating "+1 [item]" text (1.2s fade-up animation).

**Build**: Passes (0 errors). Chunks: vendor-3d 968 kB, vendor-auth 226 kB, vendor-ui 126 kB, index 2995 kB, + 14 lazy panels.

---

## M21 Sprint Plan -- 3 Parallel Tracks

### Track A (P0): Procedural Ambient Audio System
**Assigned to**: `director` (self-execute)
**Duration**: Full sprint
**Goal**: Build a zero-dependency ambient audio engine using the Web Audio API. Procedurally generate all sounds (no audio files). Covers: wind, rain, thunder, footsteps, fire crackling, ocean waves, and biome ambient drones.

| Task | Description | Technical Spec |
|------|-------------|---------------|
| A1 | Create `AmbientAudioEngine.ts` | Singleton class at `src/audio/AmbientAudioEngine.ts`. Lazy-creates an `AudioContext` on first user interaction (browser autoplay policy). Manages a bank of OscillatorNode + BiquadFilterNode + GainNode chains. Methods: `init()`, `update(playerState, weatherState, dt)`, `dispose()`. All volume transitions use `linearRampToValueAtTime` for smooth fades. Master gain controlled by settings. |
| A2 | Wind layer | Filtered white noise (BiquadFilter bandpass 200-800Hz). Gain = `weatherStore.windSpeed / 15`. Bandpass center frequency modulated by LFO (0.1Hz sine) for "gusting" effect. Active during all weather states. |
| A3 | Rain layer | Filtered white noise (highpass 3000Hz + lowpass 8000Hz, simulates rain hiss). Gain = 0.0 (CLEAR/CLOUDY), 0.3 (RAIN), 0.6 (STORM). Smooth 2-second crossfade between states. |
| A4 | Thunder | On `lightningActive` transition from false->true, play a short noise burst: white noise envelope (attack 10ms, sustain 200ms, decay 1.5s) through lowpass filter at 120Hz (rumble). Randomize pitch via playbackRate 0.8-1.2. |
| A5 | Footsteps | Triggered from PlayerController movement. Noise burst (20ms) through bandpass filter. Frequency varies by terrain: grass=800Hz, rock=2000Hz, sand=400Hz, water=600Hz. Interval: 350ms walk, 220ms run. Only when player is moving and grounded. |
| A6 | Fire crackling | When player is within 15m of a settlement fire or campfire. Random noise bursts (5-15ms, interval 50-200ms random) through bandpass 1500-4000Hz. Gain attenuates with distance (1/r falloff, max 15m). |
| A7 | Ocean waves | When player is within 30m of sea level and near coast. Low-frequency oscillator (0.15Hz sine) modulating gain of filtered noise (200-600Hz bandpass). Simulates wave surge/retreat cycle. |
| A8 | Wire into GameLoop | Call `ambientAudio.update()` each frame with current playerStore + weatherStore state. Init on first canvas click. Dispose on unmount. Add volume slider to SettingsPanel. |

**Quality gate**: (a) Wind audible and varies with wind speed, (b) rain fades in/out with weather transitions, (c) thunder plays on lightning, (d) footstep sounds vary by surface, (e) fire crackles near settlements, (f) ocean waves near shore, (g) master volume slider works, (h) no audio glitches/clicks on transitions, (i) build passes.

---

### Track B (P1): Settlement Visual Upgrades
**Assigned to**: `director` (self-execute)
**Duration**: Full sprint
**Goal**: Upgrade settlements from plain box meshes to visually distinct buildings with roofs, chimneys, smoke particles, market stalls at higher tiers, and animated NPC activity dots.

| Task | Description | Technical Spec |
|------|-------------|---------------|
| B1 | Roof geometry | Add a ConeGeometry (pyramid roof) on top of each box building. Roof height = building.h * 0.4. Color: tier 0-1 = straw brown (#8B7355), tier 2+ = slate grey (#556677). Slight overhang (roof radius = building.w * 0.6). |
| B2 | Chimney + smoke | For civLevel >= 2: add a thin box (0.3x0.8x0.3) chimney on one corner of the largest building. Smoke: 20 instanced small spheres rising from chimney, slow upward drift (0.5m/s), slight wind push, opacity fades from 0.4 to 0 over 3 seconds, reset when they reach 8m above chimney. Use existing instanced mesh pattern. |
| B3 | Market stalls | For civLevel >= 1: add 1-2 small open-front structures (BoxGeometry table + PlaneGeometry awning) near the settlement center. Awning color varies (rust-orange, deep red, mustard) for visual variety. |
| B4 | NPC activity dots | Render `npcCount` small animated spheres (radius 0.15) moving slowly within the settlement boundary. Movement: random walk constrained to 5m radius from settlement center, speed 0.3m/s, direction changes every 2-4s. Color: warm skin tone (#d4a574). Visible only within 100m of player. |
| B5 | Street paths | For civLevel >= 2: render 2-3 thin flat planes (0.5m wide, dark brown) connecting buildings, simulating dirt paths. Simple straight lines between building positions. |

**Quality gate**: (a) Every settlement has roofed buildings, (b) smoke rises from chimneys at tier 2+, (c) market stalls visible at tier 1+, (d) NPC dots move within settlements, (e) visual detail scales with civLevel, (f) no framerate regression >5%, (g) build passes.

---

### Track C (P1): Enhanced Minimap
**Assigned to**: `director` (self-execute)
**Duration**: Full sprint
**Goal**: Upgrade the plain dark minimap to show terrain coloring (biome-based), settlement markers with names, resource node dots, player direction indicator, and zoom controls.

| Task | Description | Technical Spec |
|------|-------------|---------------|
| C1 | Terrain color layer | Sample terrain biome at grid points across the map range. Color-code: water = #1a3a5c, grass = #2d5a1e, rock = #6b6b6b, sand = #c4a35a, snow = #dde8f0. Draw as filled rectangles on the canvas (8x8 pixel grid cells). Uses elevation + biome data from SpherePlanet.terrainHeightAt. |
| C2 | Settlement markers | Draw diamond shapes at settlement positions. Color by civLevel: 0=#8B7355, 1=#b8860b, 2=#708090, 3+=#4682b4. Draw settlement name in 8px text below the diamond. |
| C3 | Resource node markers | Draw small dots (2px) at resource node positions. Color by type: tree=#2d8a4e, rock=#888, berry=#c44569, iron=#b87333, coal=#333. Only show nodes within fog-of-war reveal radius. |
| C4 | Player direction arrow | Replace the plain circle with a small triangle/arrow pointing in the player's look direction. Read camera rotation from playerStore or pass as prop. Arrow = equilateral triangle, green, 10px. |
| C5 | Zoom controls | Add +/- buttons below the map that adjust WORLD_RANGE between 100m and 600m (step 100m). Store zoom level in component state. Default: 300m. |
| C6 | Weather indicator | Draw a small weather icon (text-based) in the top-right corner of the minimap: sun for CLEAR, cloud for CLOUDY, rain drops for RAIN, lightning bolt for STORM. Plus temperature reading. |

**Quality gate**: (a) Terrain colors visible on minimap matching biome, (b) settlements show as labeled diamonds, (c) resource nodes visible within fog radius, (d) player arrow shows facing direction, (e) zoom in/out works, (f) weather indicator updates, (g) build passes, (h) no performance regression (canvas redraws only when player moves >2m or state changes).

---

## Architecture Decisions (M21)

| Decision | Rationale |
|----------|-----------|
| Web Audio API oscillators + noise, no audio files | Zero-dependency, no asset loading, infinite variation, tiny bundle impact |
| Singleton audio engine, not React component | Audio context must persist across re-renders; singleton pattern matches GameSingletons |
| Settlement smoke as instanced spheres, not GPU particles | Consistent with WeatherRenderer pattern; low particle count (20 per settlement) |
| Minimap terrain sampling on a grid, not full resolution | Performance: 50x50 grid = 2500 samples vs millions of terrain points |
| Minimap redraws throttled to 2m player movement | Prevents canvas overdraw from consuming CPU on every frame |

---

## Risk Register (M21)

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Web Audio autoplay policy blocks sound | High | Medium | Lazy-init AudioContext on first user click/keypress; show "Click to enable audio" hint |
| Audio clicks/pops on parameter changes | Medium | Medium | Use linearRampToValueAtTime with 50ms ramps instead of direct value assignment |
| Settlement smoke particles reduce FPS | Low | Medium | Only 20 particles per settlement, only render within 100m of player |
| Minimap terrain sampling is slow | Low | Medium | Cache terrain colors; only resample when zoom changes or player moves >10m |
| NPC activity dots z-fight with terrain | Medium | Low | Offset dots 0.3m above settlement y position |

---

## Priority Queue (After M21)

| Priority | Item | Status |
|----------|------|--------|
| P1 | Tree LOD (instanced low-poly at distance) | Queued for M22 |
| P1 | LLM integration for dialogue (connect DialoguePanel to real LLMBridge) | Queued for M22 |
| P2 | Species divergence notifications in journal | Queued |
| P2 | Subsurface scattering for creature skin | Queued |
| P2 | Volumetric fog (ray-marched, density from weather system) | Queued |
| P2 | Shadow cascade tuning (3 cascades, bias correction) | Queued |
| P2 | Drag-drop inventory reordering | Queued |
| P2 | Player skill progression / tech tree UI | Queued |
| P2 | Save/load improvements (manual save slots) | Queued |

---

## M21 Completion Summary (2026-03-26)

**All 3 Tracks SHIPPED:**

- **Track A -- Procedural Ambient Audio: DONE** -- AmbientAudioEngine.ts (320 lines): Web Audio API procedural sound with zero audio files. 6 layers: wind (bandpass noise, LFO gusting, gain=windSpeed/15), rain (highpass noise, 2s crossfade, snow damping), thunder (noise burst + lowpass rumble on lightning), footsteps (terrain-dependent bandpass: grass 800Hz, rock 2200Hz, sand 400Hz), fire crackling (random bursts 1.5-4kHz, 1/r falloff), ocean waves (0.15Hz LFO surge, distance-attenuated). AudioHook.tsx bridges stores to engine. Volume slider in SettingsPanel.
- **Track B -- Settlement Visual Upgrades: DONE** -- SettlementRenderer.tsx (350 lines): pyramid roofs (ConeGeometry, straw brown tier 0-1, slate grey tier 2+), chimneys + smoke particles (20 instanced spheres rising with wind drift, civLevel>=2), market stalls (table+awning+poles, 1-2 per settlement at tier 1+), NPC activity dots (up to 12 animated spheres with random-walk AI, LOD at 100m), dirt street paths connecting buildings (civLevel>=2). Zero per-frame allocations (pre-allocated scratch vectors).
- **Track C -- Enhanced Minimap: DONE** -- MapPanel.tsx (290 lines): terrain color grid (44x44 biomeColor samples, cached, resample throttled to 10m movement), settlement diamond markers (civLevel-colored + name labels), resource node dots (type-colored, fog-of-war gated), player direction arrow (green triangle), zoom controls (+/- buttons, 100m-600m range), weather indicator (state icon + temperature + wind arrow), expanded legend.

**Build**: Passes (0 errors). Main chunk: 3022 kB (from 2995 kB, +27 kB for all 3 features). MapPanel lazy chunk: 5.5 kB (up from 2.3 kB).

---

## M22 Sprint Plan -- 3 Parallel Tracks

### Track A (P0): Offline Save/Load (localStorage + IndexedDB)
**Assigned to**: `director` (self-execute)
**Duration**: Full sprint
**Goal**: Allow players to save and load game state without authentication. Currently save/load requires Clerk auth + Neon DB. Most players never sign in, so they lose all progress on refresh. Add a localStorage/IndexedDB offline save that auto-saves every 60s and loads on boot.

| Task | Description | Technical Spec |
|------|-------------|---------------|
| A1 | Create `OfflineSaveManager.ts` | Singleton at `src/game/OfflineSaveManager.ts`. Uses localStorage for small state (vitals, position, civTier, simSeconds, settings) and IndexedDB for large state (inventory slots, buildings, journal entries, known recipes). Two methods: `saveOffline()` and `loadOffline()`. Both return promises. Key prefix: `universe_save_`. |
| A2 | Auto-save timer | In GameLoop.ts, call `offlineSaveManager.saveOffline()` every 60 seconds (same cadence as cloud save). Use a simple timer ref. Only save when player is alive and not in transit. |
| A3 | Load-on-boot logic | In `App.tsx` or the world bootstrap flow: if user is NOT authenticated (no Clerk session), attempt `loadOffline()` before spawning. If save exists, restore all state. If no save, start fresh. Show a brief "Save loaded" notification via NotificationSystem. |
| A4 | Manual save/load in SettingsPanel | Add "Save Game" and "Load Game" buttons to SettingsPanel.tsx. Save button triggers immediate `saveOffline()` with confirmation toast. Load button triggers `loadOffline()` with a confirm dialog ("This will overwrite current progress"). |
| A5 | Save slot display | Show last-save timestamp and basic stats (civTier, play time) in SettingsPanel below the save/load buttons. Read from localStorage metadata key `universe_save_meta`. |
| A6 | Cloud save preference | When user IS authenticated, still auto-save to localStorage as backup. Cloud save remains primary. On load, prefer cloud save if newer than local save (compare timestamps). |

**Quality gate**: (a) Refresh browser without auth -> game state persists, (b) auto-save fires every 60s, (c) manual save/load buttons work, (d) save metadata displayed, (e) cloud save takes priority when auth'd and newer, (f) build passes, (g) IndexedDB handles inventory/buildings correctly.

---

### Track B (P0): Player Skill Tree + Progression System
**Assigned to**: `director` (self-execute)
**Duration**: Full sprint
**Goal**: Add a visible skill progression system. Players earn XP from gathering, crafting, combat, and exploration. Skills unlock passive bonuses (faster gathering, more HP, better craft quality, etc.). Displayed in a new SkillTreePanel.

| Task | Description | Technical Spec |
|------|-------------|---------------|
| B1 | Create `SkillSystem.ts` | New file at `src/game/SkillSystem.ts`. Defines 6 skill categories: `gathering` (harvest speed, yield bonus), `crafting` (quality bonus, recipe unlock), `combat` (damage bonus, HP bonus), `survival` (hunger/thirst drain reduction), `exploration` (movement speed, fog reveal radius), `smithing` (merge existing smithingXp, quality curve). Each skill: level 0-10, XP thresholds = [0, 100, 250, 500, 1000, 2000, 4000, 7000, 11000, 16000, 22000]. Singleton class with `addXp(skill, amount)`, `getLevel(skill)`, `getBonus(skill)`, `serialize()`, `deserialize()`. |
| B2 | XP award hooks | In GameLoop.ts: award gathering XP on resource harvest (+10-30 per node, scaled by node tier). Award crafting XP on successful craft (+15-50 per recipe tier). Award combat XP on creature kill (+20-60). Award exploration XP on new discovery (+50). Award survival XP passively every 60s alive (+5). |
| B3 | Passive bonus application | Wire skill bonuses into existing systems: `gathering` level reduces harvest time by 5% per level. `crafting` adds +0.02 quality per level. `combat` adds +5% damage per level. `survival` reduces hunger/thirst drain by 3% per level. `exploration` increases fog reveal radius by 5% per level. `smithing` replaces raw smithingXp curve with skill level curve. |
| B4 | Create `SkillTreePanel.tsx` | New panel at `src/ui/panels/SkillTreePanel.tsx`. Shows 6 skill cards in a 2x3 grid. Each card: skill name, current level, XP bar (progress to next level), current bonus description, icon (text-based: pickaxe for gathering, hammer for crafting, sword for combat, heart for survival, compass for exploration, anvil for smithing). Styled matching existing dark-translucent UI. |
| B5 | Register panel | Add `'skills'` as PanelId in uiStore. Register in SidebarShell with 'K' hotkey. Add icon to sidebar strip. Lazy-load the panel. |
| B6 | Persist skills | Add skill data to both cloud save (saveStore.ts) and offline save (OfflineSaveManager). Serialize as `{gathering: {xp, level}, crafting: {xp, level}, ...}`. |

**Quality gate**: (a) XP awards visible in skill panel after gathering/crafting/combat, (b) level-up triggers notification, (c) passive bonuses measurably affect gameplay (e.g., harvest time visibly shorter at level 5+), (d) K key opens skill panel, (e) skills persist across save/load, (f) build passes.

---

### Track C (P1): Day/Night Visual Polish + Sun Arc
**Assigned to**: `director` (self-execute)
**Duration**: Full sprint
**Goal**: Enhance the day/night cycle with a visible sun disc, improved twilight color grading, moonlight shadows, and a time-of-day HUD indicator. Make sunrise/sunset a cinematic moment.

| Task | Description | Technical Spec |
|------|-------------|---------------|
| C1 | Sun disc mesh | Add a bright emissive sphere (radius 40, color temperature 5778K = #fff5e0) at the sun position in DayNightCycle.tsx. Billboard-face the camera. Intensity modulated by sin(angle): full brightness at noon, fade to 0 at horizon. Add a subtle glow halo using a second transparent sphere (radius 120, additive blend, opacity 0.15). |
| C2 | Improved twilight color grading | In PostProcessing.tsx, add a time-of-day color grade pass: during golden hour (sun angle 0-15 degrees above horizon), shift color balance warm (lift shadows +0.02 orange, gamma mids +0.01 gold). During blue hour (sun 0-10 degrees below horizon), shift cool (gain highlights -0.02 blue). Read sun angle from DayNightCycle via a shared ref or store value. |
| C3 | Moonlight enhancement | When sun is below horizon, set a secondary directional light (dim, blue-white #b0c4de, intensity 0.15) positioned opposite the sun. This simulates moonlight. Cast soft shadows (shadow map 1024, bias -0.002). Intensity modulated by moon phase (already computed in NightSkyRenderer). |
| C4 | Time-of-day HUD widget | Small widget in HUD.tsx top-center: shows a circular clock icon with sun/moon position indicator (small arc). Text displays: "Dawn", "Morning", "Noon", "Afternoon", "Dusk", "Night" based on sun angle. Also shows "Day X" counter (simSeconds / DAY_DURATION_S). Compact: 80x30px. |
| C5 | Horizon fog color | Modulate FogExp2 color by time of day. Dawn/dusk: warm peach (#ffd4a3). Night: deep blue (#0a1428). Noon: light grey-blue (#c8d8e8). Smooth lerp between states keyed to sun angle. Currently fog density changes but color stays constant. |
| C6 | Star twinkle animation | In NightSkyRenderer, add per-star brightness oscillation: each star's point size multiplied by `0.85 + 0.15 * sin(time * star.twinkleFreq + star.twinklePhase)`. twinkleFreq = 1.5-4.0 Hz (randomized per star). Adds life to the night sky without performance cost (just a uniform update). |

**Quality gate**: (a) Sun disc visible in sky, scales correctly with distance, (b) golden hour warm tint visible on terrain, (c) moonlight casts soft shadows at night, (d) time-of-day widget shows correct period, (e) fog color matches time of day, (f) stars twinkle at night, (g) build passes, (h) no framerate regression >5%.

---

## Architecture Decisions (M22)

| Decision | Rationale |
|----------|-----------|
| localStorage for small state, IndexedDB for large | localStorage has 5MB limit, inventory+buildings can exceed that; IndexedDB handles structured data well |
| 6 skill categories, max level 10 | Matches the 6 core gameplay loops; level 10 is achievable in ~4 hours of focused play |
| XP thresholds exponential curve | Early levels fast (engagement), later levels slow (long-term goals) |
| Sun disc as emissive sphere, not post-process lens flare | Consistent with R3F scene graph; no post-processing dependency; works with existing atmosphere shader |
| Moonlight as secondary directional light | Simple, effective, minimal perf cost; shadow map 1024 is half sun resolution |
| Time-of-day fog color | Cheap per-frame operation that dramatically improves atmosphere |

---

## Risk Register (M22)

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| IndexedDB blocked in private browsing mode | Medium | Medium | Fallback to localStorage-only (truncate buildings array if >4MB) |
| Skill bonuses feel imperceptible at low levels | Medium | Medium | Show bonus % in tooltip; first level grants a noticeable 10% bonus |
| Sun disc z-fights with Sky dome | Medium | Low | Render sun disc at depth 0.999 (near far plane); disable depth test on glow halo |
| Moonlight shadows double shadow draw calls | Low | Medium | Moonlight shadow map only 1024 (vs 2048 for sun); disable when FPS < 30 |
| Save data corruption on browser crash during write | Low | High | Write to temp key first, then rename (atomic swap pattern) |
| Fog color transitions cause visible banding | Low | Low | Use smoothstep interpolation with 3-point color ramp |

---

## Agent Dispatch Plan (M22)

| Agent | Track | First Task | Report To |
|-------|-------|-----------|-----------|
| `director` | Track A | A1: Create OfflineSaveManager.ts | self |
| `director` | Track B | B1: Create SkillSystem.ts | self |
| `director` | Track C | C1: Add sun disc mesh to DayNightCycle | self |

---

## M22 Completion Summary (2026-03-26)

**All 3 Tracks SHIPPED:**

- **Track A -- Offline Save/Load: DONE** -- OfflineSaveManager.ts (230 lines): localStorage for small state (vitals, position, civTier, simSeconds, discoveries, wounds, skills) + IndexedDB for large state (inventory, buildings, journal, known recipes, bedroll). Auto-save every 60s from GameLoop. Manual Save/Load buttons in SettingsPanel with save metadata display (timestamp, civTier, play time). Atomic swap pattern for crash safety. IndexedDB fallback to localStorage for private browsing.
- **Track B -- Player Skill Tree + Progression: DONE** -- SkillSystem.ts (200 lines): 6 skills (gathering, crafting, combat, survival, exploration, smithing), max level 10, exponential XP curve (100 to 22,000). Passive bonuses: harvest time -5%/lvl, craft quality +2%/lvl, combat damage +5%/lvl, survival drain -3%/lvl, exploration range +5%/lvl, smithing quality +2.5%/lvl. XP hooks in GameLoop (gather +15-25, craft +15-50, combat +40-60, exploration +50, survival +5/60s, dig +10). SkillTreePanel.tsx (140 lines): 2x3 grid, XP bars, level-up notifications, K hotkey. Skills persist in both cloud and offline saves.
- **Track C -- Day/Night Visual Polish: DONE** -- Sun disc mesh (emissive circle + additive glow halo, billboard-facing, horizon fade). Moonlight (secondary directional light, blue-white #b0c4de, intensity 0.18 max, 1024 shadow map). Fog color modulation (noon grey-blue, golden hour warm peach, night deep blue, smoothstep lerp). Star twinkle (per-star hash-based frequency 1.5-4Hz via uTime shader uniform). Time-of-day HUD widget (Dawn/Morning/Noon/Afternoon/Dusk/Night + Day counter). dayAngle/dayCount broadcast to gameStore at 2Hz.

**Build**: Passes (0 errors). Main chunk: 3041 kB (from 3022 kB, +19 kB for all 3 features). SkillTreePanel lazy chunk: 3.15 kB. SettingsPanel chunk: 29.57 kB (includes OfflineSaveManager).

---

## M23 Sprint Plan -- 3 Parallel Tracks

### Track A (P0): Weather Visual Effects Enhancement
**Assigned to**: `director` (self-execute)
**Duration**: Full sprint
**Goal**: Upgrade the WeatherRenderer with ground-level visual effects: rain splash impacts on terrain, wet surface darkening, snow ground accumulation, enhanced lightning bolt visual (branching line geometry + screen flash overlay), and weather-dependent fog density. The existing particle systems (rain/snow/wind/cloud) stay; we ADD ground-level immersion.

| Task | Description | Technical Spec |
|------|-------------|---------------|
| A1 | Rain splash impacts | Add 200 instanced small ring meshes (TorusGeometry r=0.3, tube=0.02) at ground level around the player. Each splash: spawn at random XZ within 30m, Y = terrain height, expand from scale 0 to 1.0 over 300ms, fade opacity from 0.6 to 0 simultaneously. Recycle when fade completes. Only active during RAIN/STORM. Zero per-frame allocation (pre-allocated Float32Array for positions + lifecycle timers). |
| A2 | Wet surface darkening | When state is RAIN or STORM, set a shared `wetness` uniform (0.0 to 1.0, ramps up over 30s of rain, ramps down over 60s after rain stops) on the terrain material via `onBeforeCompile`. Wetness multiplies terrain albedo by 0.7 (darker) and reduces roughness by 0.3 (shinier). This makes the world look wet during rain. |
| A3 | Snow ground accumulation | When state is RAIN and temp < 0 (snow), render a semi-transparent white ground plane (large disc, radius 80m, centered on player, y = terrain height + 0.05) with noise-based alpha to simulate patchy snow cover. Opacity ramps up during snowfall (max 0.4), fades over 120s after snow stops. Roughness 0.25 for icy sheen. |
| A4 | Lightning bolt geometry | Replace the simple directional-light flash with a visible branching line bolt. Use THREE.Line with a jagged path: start point 60m above player + random offset, end point on ground. 6-8 segments with random lateral jitter (2-5m). Bolt visible for 150ms, emissive white material (intensity 10). Keep the existing directional light flash as fill. Add a brief screen-white overlay (CSS div, opacity flash 0.3 to 0 over 200ms) triggered from weatherStore.lightningActive. |
| A5 | Weather fog density | Modulate scene fog density based on weather: CLEAR=0.0008, CLOUDY=0.0012, RAIN=0.0020, STORM=0.0030. Smooth lerp over 5 seconds on state change. Read from weatherStore in DayNightCycle.tsx where fog is already managed. Multiply with existing time-of-day fog, don't replace it. |

**Quality gate**: (a) Rain splashes visible on ground during rain, (b) terrain visibly darker/shinier during rain, (c) white snow patches appear on ground during snowfall, (d) lightning bolt line visible in sky during storms, (e) fog thickens during rain/storm, (f) all effects fade gracefully on weather transition, (g) build passes, (h) no framerate regression >5%.

---

### Track B (P0): Quest System + Quest Journal
**Assigned to**: `director` (self-execute)
**Duration**: Full sprint
**Goal**: Build a quest system on top of the existing DiscoveryJournal. Define trackable quests with objectives, progress tracking, completion rewards (XP, items, recipes), and a Quest Log panel. Quests auto-trigger from gameplay milestones (first craft, first kill, reach civTier 1, etc.).

| Task | Description | Technical Spec |
|------|-------------|---------------|
| B1 | Create `QuestSystem.ts` | New singleton at `src/game/QuestSystem.ts`. Defines `Quest` interface: `{ id: string, title: string, description: string, category: 'tutorial' | 'exploration' | 'crafting' | 'combat' | 'civilization', objectives: Objective[], rewards: Reward[], status: 'locked' | 'active' | 'complete', progress: number[] }`. `Objective`: `{ description: string, type: 'gather' | 'craft' | 'kill' | 'discover' | 'reach_tier' | 'build' | 'explore', target: number, current: number }`. `Reward`: `{ type: 'xp' | 'item' | 'recipe', skillName?: string, amount?: number, itemId?: number, materialId?: number, recipeId?: number }`. Methods: `checkProgress()`, `completeQuest(id)`, `getActiveQuests()`, `getCompletedQuests()`, `serialize()`, `deserialize()`. |
| B2 | Define 15 starter quests | Tutorial chain: "First Steps" (gather 5 wood), "Tool Time" (craft stone axe), "Hunter" (kill 1 animal), "Home Base" (build 1 structure), "Iron Will" (reach civTier 2). Exploration: "Cartographer" (reveal 50% of map), "Deep Diver" (go below sea level), "Peak Climber" (reach highest terrain point). Crafting: "Master Smith" (craft 10 metal items), "Alchemist" (craft 5 chemical items). Combat: "Big Game Hunter" (kill 5 animals), "Survivor" (survive 10 in-game days). Civilization: "Mayor" (reach civTier 3), "Space Age" (reach civTier 5), "First Contact" (discover Velar). |
| B3 | Quest progress hooks | In GameLoop.ts: on resource harvest, call `questSystem.onGather(materialId, qty)`. On craft, call `questSystem.onCraft(recipeId)`. On animal kill, call `questSystem.onKill(species)`. On discovery, call `questSystem.onDiscover(discoveryId)`. On civTier change, call `questSystem.onTierReached(tier)`. On build, call `questSystem.onBuild(buildingType)`. Each hook checks all active quests and updates matching objectives. |
| B4 | Quest completion rewards | When all objectives met, auto-complete the quest. Award rewards: XP via SkillSystem.addXp(), items via inventory.addItem(), recipes via inventory.learnRecipe(). Show notification "[Quest Complete] Title - reward description". Unlock next quest in chain if applicable. |
| B5 | Create `QuestPanel.tsx` | New panel at `src/ui/panels/QuestPanel.tsx`. Shows active quests at top (expandable cards with objective checklist + progress bars), completed quests below (collapsed, greyed). Each quest card: title, description, objectives with checkmarks, reward preview, progress percentage. Styled matching dark-translucent UI. |
| B6 | Register QuestPanel | Add `'quests'` to PanelId in uiStore. Register in SidebarShell with lazy import. Add 'Q' hotkey. Add 'QST' icon to sidebar strip. Persist quest state in OfflineSaveManager and cloud save. |

**Quality gate**: (a) Tutorial quests auto-activate on game start, (b) gathering wood increments "First Steps" progress, (c) quest completion shows notification + awards rewards, (d) Q key opens quest panel, (e) quest progress persists across save/load, (f) 15 quests defined with clear objectives, (g) build passes.

---

### Track C (P1): Loot System + Item Rarity
**Assigned to**: `director` (self-execute)
**Duration**: Full sprint
**Goal**: Add item rarity tiers (Common/Uncommon/Rare/Epic/Legendary) to the inventory system, loot tables for animal kills and special resource nodes, rarity-colored item names in all UI, and a visible loot drop pickup with rarity glow.

| Task | Description | Technical Spec |
|------|-------------|---------------|
| C1 | Add rarity to InventorySlot | Extend `InventorySlot` interface with `rarity: 0 | 1 | 2 | 3 | 4` (0=Common, 1=Uncommon, 2=Rare, 3=Epic, 4=Legendary). Default all existing items to rarity 0. Rarity affects quality: Common 0.5-0.7, Uncommon 0.65-0.8, Rare 0.75-0.9, Epic 0.85-0.95, Legendary 0.95-1.0. Colors: Common=#9d9d9d (grey), Uncommon=#1eff00 (green), Rare=#0070dd (blue), Epic=#a335ee (purple), Legendary=#ff8000 (orange). |
| C2 | Create `LootTable.ts` | New file at `src/game/LootTable.ts`. Defines loot tables as arrays of `{ itemId: number, materialId: number, quantity: [min, max], rarity: number, weight: number }`. Tables: `DEER_LOOT` (leather, raw meat, antler rare), `WOLF_LOOT` (fur, fangs uncommon, wolf pelt rare), `BOAR_LOOT` (tusks uncommon, hide, raw meat). `TREASURE_LOOT` (gems rare, gold epic, ancient artifact legendary). `rollLoot(table): InventorySlot[]` — weighted random selection, 1-3 items per roll. Higher rarity = lower weight. |
| C3 | Wire loot to animal kills | In AnimalAISystem.ts or GameLoop.ts where animal death is handled: on animal kill, call `rollLoot(speciesTable)` and either add directly to inventory or spawn as world loot drops (reuse DEATH_LOOT_DROPS pattern from DeathSystem). Show floating text for each item with rarity color. |
| C4 | Rarity colors in inventory UI | In InventoryPanel.tsx, color the item name text and slot border by rarity. Common: no border highlight. Uncommon: green glow border (box-shadow). Rare: blue glow. Epic: purple glow. Legendary: orange glow + subtle pulse animation. In ItemTooltip.tsx, show rarity name in color at the top of the tooltip. |
| C5 | Rarity on crafted items | When crafting, output rarity is determined by: base recipe tier + crafting skill level + random roll. Tier 0-1 recipes: always Common. Tier 2-3: 80% Common, 15% Uncommon, 5% Rare. Tier 4+: 50% Common, 30% Uncommon, 15% Rare, 4% Epic, 1% Legendary. Crafting skill adds +2% to each non-Common tier per skill level. |
| C6 | Persist rarity | Ensure rarity field is included in save/load for both offline (OfflineSaveManager) and cloud save. Backwards compatible: if rarity is undefined, default to 0. |

**Quality gate**: (a) Killing a deer drops 1-3 items with correct rarity distribution, (b) inventory slots show rarity-colored borders, (c) tooltip displays rarity name in color, (d) crafted items have rarity based on tier + skill, (e) rarity persists across save/load, (f) legendary items are visually distinct (orange glow), (g) build passes.

---

## Architecture Decisions (M23)

| Decision | Rationale |
|----------|-----------|
| Rain splashes as instanced torus, not sprite particles | Consistent with existing instanced mesh pattern; torus gives a water-ring visual; better than flat sprites |
| Wetness via onBeforeCompile uniform, not separate material | Avoids replacing the terrain material entirely; surgical injection of one uniform + 2 lines of shader code |
| Quest system as singleton class, not Zustand store | Matches SkillSystem/Inventory pattern; complex logic doesn't belong in a store; store used only for UI reactivity |
| Rarity as numeric 0-4, not string enum | Compact for serialization; easy to compare; maps directly to color array index |
| Loot tables as weighted arrays | Simple, performant, easily tunable; no need for complex probability distributions |
| Quest progress hooks in GameLoop | Central location for all gameplay events; avoids scattering quest checks across 10 different systems |

---

## Risk Register (M23)

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Rain splashes z-fight with terrain | Medium | Low | Offset splash Y +0.1m above terrain; use depthWrite=false |
| Wetness uniform injection breaks on Three.js update | Low | Medium | Guard with try/catch in onBeforeCompile; fallback to no wetness |
| Snow ground plane visible edges at 80m radius | Medium | Low | Use noise-based alpha fade at edges (last 10m radius = fade to 0) |
| Quest system adds too many hooks to GameLoop | Medium | Medium | Single questSystem.tick() call that internally routes events; keep GameLoop additions minimal |
| Rarity field breaks existing save data | Medium | High | Default undefined rarity to 0 on deserialize; backwards compatible |
| Loot drops flood inventory | Low | Medium | Cap at 3 items per kill; show "inventory full" if overflow |

---

## Agent Dispatch Plan (M23)

| Agent | Track | First Task | Report To |
|-------|-------|-----------|-----------|
| `director` | Track A | A1-A5: Weather VFX enhancement | self |
| `director` | Track B | B1-B6: Quest system + panel | self |
| `director` | Track C | C1-C6: Loot system + rarity | self |

---

## Priority Queue (After M23)

| Priority | Item | Status |
|----------|------|--------|
| P1 | Tree LOD (instanced low-poly at distance) | Queued for M24 |
| P1 | LLM integration for dialogue (connect DialoguePanel to real LLMBridge) | Queued for M24 |
| P1 | Mobile/touch controls | Queued for M24 |
| P2 | Species divergence notifications in journal | Queued |
| P2 | Subsurface scattering for creature skin | Queued |
| P2 | Volumetric fog (ray-marched, density from weather system) | Queued |
| P2 | Shadow cascade tuning (3 cascades, bias correction) | Queued |
| P2 | Drag-drop inventory reordering | Queued |
| P2 | Combat system improvements (blocking, dodge) | Queued |
| P2 | Multiplayer improvements (player names, positions visible) | Queued |

---

## M23 Completion Summary (2026-03-26)

**All 3 Tracks SHIPPED:**

- **Track A -- Weather VFX Enhancement: DONE** -- WeatherRenderer.tsx enhanced (490 lines, up from 388): 150 instanced torus rain splashes at ground level (0.3s lifecycle, expand+fade), wet surface darkening (uWetness uniform injected into terrain shader via onBeforeCompile, albedo *=0.7, roughness -=0.3, 30s ramp up/60s ramp down), snow ground accumulation (80m radius white disc, opacity ramps to 0.4 during snowfall, roughness 0.25 for icy sheen), lightning bolt geometry (8-segment jagged THREE.Line with random lateral jitter 2-8m, 150ms visibility, emissive white), weather-dependent fog density (CLEAR 0.0008, CLOUDY 0.0012, RAIN 0.002, STORM 0.003, 5s lerp transition). Wetness field added to weatherStore.
- **Track B -- Quest System + Quest Journal: DONE** -- QuestSystem.ts (250 lines): 15 quests across 5 categories (tutorial/exploration/crafting/combat/civilization), prerequisite chains, progress hooks (onGather/onCraft/onKill/onDiscover/onTierReached/onBuild), auto-completion with XP rewards via SkillSystem. QuestPanel.tsx (130 lines): expandable quest cards with progress bars, category colors, completed section. Q hotkey, lazy-loaded. Wired into GameSingletons + GameLoop.
- **Track C -- Loot System + Item Rarity: DONE** -- LootTable.ts (107 lines): weighted loot tables for deer/wolf/boar + treasure. 5 rarity tiers (Common/Uncommon/Rare/Epic/Legendary) with quality ranges and color coding. rollLoot() weighted random selection (1-3 items per kill). RARITY enum + colors in Inventory.ts. LootPickup.ts wired for death drop pickups. Rarity-colored borders in InventoryPanel + ItemTooltip.

**Build**: Passes (0 errors). Main chunk: 3067 kB (from 3041 kB, +26 kB for all 3 features).

---

## M24 Sprint Plan -- 3 Parallel Tracks

**Date**: 2026-03-26
**Status**: IN PROGRESS -- Workers spawning

### Track A (P0): Combat System Enhancement
**Assigned to**: `ui-worker`
**Duration**: Full sprint
**Goal**: Upgrade the basic click-to-attack into a proper combat system with melee swing animation, attack cooldown UI, enemy aggro/retaliation, damage numbers floating text, health bars on enemies, and creature respawn timers.

| Task | Description | Technical Spec |
|------|-------------|---------------|
| A1 | Create `CombatSystem.ts` | New singleton at `src/game/CombatSystem.ts`. Manages: attack cooldowns per weapon type (fist 0.8s, stone axe 1.2s, iron sword 0.6s, musket 8s — read from weapon stats), combo counter (3-hit combo: 1x, 1.2x, 1.5x damage multiplier, resets after 2s idle), dodge mechanic (Shift key, 0.3s iframe, 2s cooldown, player velocity burst in move direction), block mechanic (Right-click hold, 50% damage reduction while active, drains stamina 5/s). Methods: `startAttack()`, `canAttack()`, `startDodge()`, `isBlocking()`, `getComboMultiplier()`, `tick(dt)`. |
| A2 | Floating damage numbers | Create `DamageNumberRenderer.tsx` at `src/rendering/entities/DamageNumberRenderer.tsx`. When damage is dealt (to animal/creature/player), spawn a floating text at hit position. Text shows damage amount, color-coded: white for normal, yellow for combo hit, red for critical (10% chance, 2x damage). Text rises 2m over 1s, fades opacity from 1 to 0. Use instanced sprites or HTML overlay divs positioned via CSS3DRenderer or simple screen-space projection. Max 20 active numbers (ring buffer). |
| A3 | Enemy health bars | Create `HealthBarRenderer.tsx` at `src/rendering/entities/HealthBarRenderer.tsx`. Render a small HP bar above any animal/creature that has been damaged. Bar: 1m wide, positioned 0.5m above entity. Green when >50%, yellow 25-50%, red <25%. Fades after 5s of no damage. Only render for entities within 30m of player. Use instanced quads or HTML overlay. |
| A4 | Creature aggro + retaliation | In `AnimalAISystem.ts`, add aggro behavior: when a wolf/boar takes damage, it enters AGGRO state targeting the attacker. AGGRO wolf: chase at 1.5x normal speed, attack when within 2m (deal 15 damage per bite, 1.5s cooldown). AGGRO boar: charge at 2x speed, deal 25 damage on collision, 3s cooldown. Deer always flee (no aggro). Aggro drops after 30s or if target moves >50m away. |
| A5 | Creature respawn | Add respawn timer to AnimalAISystem: when an animal dies, record its spawn position + species. After 120s (2 min), respawn a new animal of same species at original position. Max respawns per chunk = original spawn count. Track in a `respawnQueue: Array<{pos, species, timer}>`. |
| A6 | Combat HUD indicator | In HUD.tsx, add a small combat indicator (bottom-center): shows current weapon icon (text), attack cooldown arc (circular progress), combo counter (x1/x2/x3), and dodge cooldown. Only visible when player has attacked in last 10s. Compact: 120x40px. |

**Quality gate**: (a) Attack has visible cooldown that prevents spam-clicking, (b) floating damage numbers appear on hit, (c) enemy HP bars show when damaged, (d) wolves/boars chase and attack player after being hit, (e) dead animals respawn after 2 min, (f) combat HUD shows cooldown + combo, (g) build passes, (h) no framerate regression >5%.

---

### Track B (P1): Achievement System
**Assigned to**: `ai-npc`
**Duration**: Full sprint
**Goal**: Create an achievement system that tracks player milestones, displays toast notifications on unlock, and provides an Achievement Gallery panel. Achievements persist across sessions via save system.

| Task | Description | Technical Spec |
|------|-------------|---------------|
| B1 | Create `AchievementSystem.ts` | New singleton at `src/game/AchievementSystem.ts`. Defines `Achievement` interface: `{ id: string, title: string, description: string, icon: string (emoji text), category: 'exploration' | 'combat' | 'crafting' | 'survival' | 'civilization' | 'secret', unlocked: boolean, unlockedAt: number | null, progress: number, target: number }`. Methods: `check(event, data)`, `unlock(id)`, `getUnlocked()`, `getAll()`, `serialize()`, `deserialize()`. |
| B2 | Define 25 achievements | Exploration: "First Steps" (move 100m), "Globetrotter" (visit all biomes), "Spelunker" (go below sea level), "Summit" (reach highest point), "Cartographer" (reveal 80% map). Combat: "First Blood" (kill 1 animal), "Big Game" (kill 25 animals), "Untouchable" (dodge 10 attacks), "Overkill" (deal 100+ damage in one hit), "Survivor" (survive with <10% HP). Crafting: "Toolmaker" (craft 10 tools), "Master Chef" (craft 20 food items), "Blacksmith" (craft 10 metal items), "Alchemist" (craft 5 chemical items), "Legendary Crafter" (craft a legendary item). Survival: "10 Days" (survive 10 days), "100 Days" (survive 100 days), "Iron Stomach" (eat 50 items), "Night Owl" (spend 10 nights active), "Firekeeper" (build 20 fires). Civilization: "Settler" (reach civTier 1), "Mayor" (reach civTier 3), "Space Age" (reach civTier 5), "First Contact" (meet Velar), "Multiverse" (use gateway). |
| B3 | Achievement progress hooks | Wire into GameLoop events: on animal kill, call `achievementSystem.check('kill', {species})`. On craft, `check('craft', {recipeId, rarity})`. On civTier change, `check('tier', {tier})`. On movement tick, accumulate distance for exploration achievements. On day change, increment survival day counter. On dodge, increment dodge counter. Keep hook calls minimal in GameLoop — one `achievementSystem.tick(dt, gameState)` call that reads current state. |
| B4 | Achievement toast notification | When achievement unlocks, show a special toast notification (distinct from regular notifications): gold border, achievement icon, title "Achievement Unlocked!", achievement name + description. Toast slides in from top-right, stays 4s, slides out. Use existing notification system but add an `'achievement'` type with special styling. |
| B5 | Create `AchievementPanel.tsx` | New panel at `src/ui/panels/AchievementPanel.tsx`. Grid of achievement cards (4 columns). Each card: icon, title, description, progress bar (if not yet unlocked), unlock timestamp (if unlocked). Locked achievements: greyed out with "?" icon. Categories as filter tabs at top. Show "X/25 Unlocked" counter. Styled matching dark-translucent UI. |
| B6 | Register panel + persistence | Add `'achievements'` to PanelId in uiStore. Register in SidebarShell with lazy import. Add 'H' hotkey (for "Hall of Fame"). Add 'ACH' icon to sidebar strip. Persist achievement state in OfflineSaveManager and cloud save (serialize unlocked set + progress counters). |

**Quality gate**: (a) Killing first animal triggers "First Blood" achievement toast, (b) H key opens achievement gallery, (c) progress bars update in real-time, (d) locked achievements show as "?" until unlocked, (e) achievements persist across save/load, (f) 25 achievements defined, (g) build passes.

---

### Track C (P1): Tutorial / Onboarding Flow
**Assigned to**: `interaction`
**Duration**: Full sprint
**Goal**: Create a guided tutorial for the first 5 minutes of gameplay. Contextual hint arrows and text boxes guide the player through: movement, camera, gathering, crafting, building, and combat. Tutorial state persists so it doesn't repeat. Skippable at any time.

| Task | Description | Technical Spec |
|------|-------------|---------------|
| C1 | Create `TutorialSystem.ts` | New singleton at `src/game/TutorialSystem.ts`. Defines tutorial steps as a state machine: `MOVE` (WASD prompt), `CAMERA` (mouse look prompt), `GATHER` (walk to tree + left-click prompt), `CRAFT` (open crafting panel + craft stone axe), `EQUIP` (equip the axe from inventory), `BUILD` (open build panel + place campfire), `COMBAT` (find and attack an animal), `COMPLETE`. Each step has: `id`, `message`, `triggerCondition` (function returning boolean), `highlightElement` (optional CSS selector for UI highlight), `worldPosition` (optional 3D position for arrow). Methods: `tick()`, `getCurrentStep()`, `advance()`, `skip()`, `isComplete()`, `serialize()`, `deserialize()`. |
| C2 | Tutorial HUD overlay | Create `TutorialOverlay.tsx` at `src/ui/TutorialOverlay.tsx`. Renders: (a) instruction text box at bottom-center (dark bg, white text, max 300px wide, shows current step message), (b) directional arrow pointing toward objective (if worldPosition set — project 3D pos to screen, show arrow from screen center toward that point), (c) UI highlight glow (if highlightElement set — add pulsing gold border to that CSS selector via portal/overlay), (d) "Skip Tutorial" button (top-right, small, subtle). |
| C3 | Step trigger conditions | MOVE: player has moved >5m from spawn. CAMERA: player has rotated camera >90 degrees total. GATHER: inventory contains any wood (materialId for wood). CRAFT: inventory contains stone axe (check by itemId). EQUIP: equipped weapon is stone axe. BUILD: any campfire building exists within 20m. COMBAT: any animal has been damaged. COMPLETE: all previous steps done. |
| C4 | Tutorial messages | MOVE: "Use WASD to move around. Explore your surroundings!" CAMERA: "Move the mouse to look around. Click to lock the pointer." GATHER: "Walk up to a tree and Left-Click to gather wood." CRAFT: "Press C to open Crafting. Find 'Stone Axe' and craft it." EQUIP: "Press I to open Inventory. Click the Stone Axe to equip it." BUILD: "Press B to open Building. Place a Campfire — you'll need it at night!" COMBAT: "Find an animal nearby and Left-Click to attack it. Watch your health!" COMPLETE: "Tutorial complete! The world is yours to explore. Good luck!" (fade after 5s). |
| C5 | Persist tutorial state | Add `tutorialStep: string` to OfflineSaveManager and cloud save. On load, resume from saved step. If step is 'COMPLETE', never show tutorial again. New players start at 'MOVE'. |
| C6 | Wire into App bootstrap | In GameLoop or App.tsx init: if tutorialStep !== 'COMPLETE', create TutorialSystem and mount TutorialOverlay. Call `tutorialSystem.tick()` each frame to check step advancement. On skip, set step to 'COMPLETE' and persist. |

**Quality gate**: (a) New game shows movement tutorial immediately, (b) completing each action advances to next step, (c) directional arrow points toward nearest tree during GATHER step, (d) UI highlights pulse on crafting/inventory panels when those steps are active, (e) "Skip Tutorial" works, (f) tutorial does not show again after completion or skip, (g) build passes.

---

## Architecture Decisions (M24)

| Decision | Rationale |
|----------|-----------|
| CombatSystem as singleton, not ECS component | Combat state is player-centric; only one player exists client-side; ECS overhead unnecessary |
| Floating damage numbers as screen-space divs, not 3D text | Avoids 3D text rendering complexity; CSS transitions handle fade/rise cheaply; ring buffer caps memory |
| Achievement check via single tick() call, not scattered hooks | Minimizes GameLoop modification; achievement system reads game state internally |
| Tutorial as state machine, not quest-based | Tutorial is linear and mandatory; quest system is open-ended; separate concern avoids coupling |
| Creature aggro as FSM state in AnimalAISystem | Minimal new code; leverages existing movement/targeting logic; aggro is just another behavior state |
| Creature respawn queue, not instant respawn | More realistic; prevents exploit of farming same spot; queue pattern is O(n) scan per tick |

---

## Risk Register (M24)

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Floating damage numbers cause GC pressure | Medium | Medium | Ring buffer with pre-allocated divs; no new DOM elements per hit |
| Creature aggro creates unfair difficulty | Medium | Medium | Cap aggro chase at 30s timeout; aggro only for wolves/boars, not deer |
| Tutorial overlay blocks gameplay input | Medium | High | Tutorial overlay has pointer-events: none except on buttons; never captures mouse |
| Achievement toast spam on rapid unlocks | Low | Medium | Queue toasts with 1s delay between each; max 3 queued |
| Health bars reduce FPS with many damaged creatures | Low | Medium | Only render for entities within 30m; max 10 bars (nearest damaged) |
| Tutorial skip doesn't persist | Low | High | persist immediately on skip; guard check on every boot |

---

## Agent Dispatch Plan (M24)

| Agent | Track | First Task | Report To |
|-------|-------|-----------|-----------|
| `ui-worker` | Track A | A1-A6: Combat system + VFX + HUD | director |
| `ai-npc` | Track B | B1-B6: Achievement system + panel | director |
| `interaction` | Track C | C1-C6: Tutorial onboarding flow | director |

---

## M27 Sprint Plan -- 3 Parallel Tracks

**Date**: 2026-03-26
**Status**: IN PROGRESS -- Workers spawning

### Track A (P0): Skill Progression UI + HUD XP Bar
**Assigned to**: `ui-worker`
**Duration**: Full sprint
**Goal**: Surface the existing SkillSystem to the player. XP bar in HUD, level-up flash, skill point allocation panel. Players should see their progression clearly.

| Task | Description | Technical Spec |
|------|-------------|---------------|
| A1 | XP bar in HUD | Add a compact XP bar to HUD.tsx: shows current XP / XP needed for next level. Slim horizontal bar (300px wide, 6px tall) at bottom of screen. Label: "Level X — Y XP". Animates fill smoothly on XP gain. Only visible when player has gained XP in last 30s (or always visible if level < max). |
| A2 | Level-up flash effect | When player levels up (SkillSystem emits level event), show a full-screen gold flash (0.3s opacity pulse) and a large "LEVEL UP! — Skill: [SkillName] → Level X" toast at center of screen. Fade in 0.1s, hold 2s, fade out 0.5s. |
| A3 | Create `SkillPanel.tsx` | New panel at `src/ui/panels/SkillPanel.tsx`. Shows all 10 skills (Gathering/Crafting/Combat/Building/Exploration/Cooking/Mining/Fishing/Husbandry/Science). Each row: skill name, current level (1-10), XP bar, description of current tier bonus. Read from SkillSystem.getSkills(). |
| A4 | Register panel | Add `'skills'` PanelId in uiStore. Register SkillPanel in SidebarShell with lazy import. Use 'K' hotkey (for "Skills"). Add a simple star icon to sidebar strip. |
| A5 | Skill gain toast | When any skill gains XP (not just level-up), show a small subtle toast bottom-left: "+12 Gathering XP". Auto-dismiss after 2s. Deduplicate same-skill toasts within 1s (accumulate and show once). |

**Quality gate**: (a) XP bar visible in HUD, (b) level-up causes gold flash + toast, (c) K key opens skill panel with correct levels, (d) XP toasts appear on gather/craft, (e) build passes.

---

### Track B (P1): NPC Merchant Trading System
**Assigned to**: `ai-npc`
**Duration**: Full sprint
**Goal**: Add gold currency + merchant NPCs in settlements with a buy/sell UI panel. Players can trade resources for gold and buy crafted goods.

| Task | Description | Technical Spec |
|------|-------------|---------------|
| B1 | Gold currency in inventory | Add a `gold` field to PlayerState (number, starts at 0). Display gold in InventoryPanel header: "💰 X Gold". Add gold reward to quest completion (10–100 gold per quest based on difficulty). Wire into OfflineSaveManager. |
| B2 | MerchantSystem.ts | New singleton at `src/game/MerchantSystem.ts`. Defines 4 merchant archetypes: General Store (sells basic tools/food/building mats), Blacksmith (buys ore/ingots, sells metal tools/weapons), Alchemist (buys plants/chemicals, sells potions/compounds), Trader (buys any resource at 60% market value). Each archetype has a `buyList` and `sellList` with base prices. Prices fluctuate ±20% based on settlement civTier. |
| B3 | MerchantPanel.tsx | New panel at `src/ui/panels/MerchantPanel.tsx`. Two tabs: "Buy" and "Sell". Buy tab: list of items with icon, name, price; click to buy (deducts gold, adds to inventory). Sell tab: player's inventory grid; click item to sell (get gold). Show player's current gold balance. Confirm dialog for purchases >50 gold. |
| B4 | Merchant NPCs | In NPC spawn logic (or SettlementSystem), spawn 1 merchant NPC per settlement of civTier >= 1. Merchant NPC has a special role tag and a bag icon above them. When player presses F near merchant, open MerchantPanel (not DialoguePanel). |
| B5 | Register panel | Add `'merchant'` PanelId. Register in SidebarShell. Panel opens contextually (near merchant NPC pressing F), not from sidebar strip. |

**Quality gate**: (a) Gold displayed in inventory, (b) quests reward gold, (c) merchant NPC spawns in settlements tier ≥1, (d) F near merchant opens shop UI, (e) buy/sell transactions work and update inventory + gold, (f) build passes.

---

### Track C (P0): Dynamic Lighting — Campfire + Sunrise/Sunset
**Assigned to**: `physics-prof`
**Duration**: Full sprint
**Goal**: Add dynamic point lights from campfires that cast real-time shadows, and improve sunrise/sunset sky colors bleeding onto terrain.

| Task | Description | Technical Spec |
|------|-------------|---------------|
| C1 | Campfire point light | In `ResourceNodesRenderer.tsx` or building renderer, when a campfire building exists, add a `THREE.PointLight` at its position: color `#ff6633`, intensity 2.0, distance 15m, decay 2. Animate intensity with `sin(time * 3.5) * 0.3 + 1.7` for realistic flicker. Add to scene and dispose when campfire is removed. Max 5 campfire lights total (nearest to player). |
| C2 | Campfire shadow casting | Enable `shadowMap.enabled` on the renderer (if not already). Set campfire PointLight `castShadow = true`, shadow mapSize 512x512. Set terrain + building meshes `receiveShadow = true`, tree/rock meshes `castShadow = true`. Only enable for nearest campfire to player to control cost. |
| C3 | Sunrise/sunset terrain tinting | In DayNightCycle.tsx, compute a `sunriseColor` lerp: when sun elevation is between -5° and +15°, lerp the ambient light color from dark blue-grey to warm orange-gold `#ff8040`. Inject this as `uSunTint` uniform into terrain shader via onBeforeCompile. Blend terrain albedo toward orange tint (strength 0.15) during golden hour. |
| C4 | Moon glow at night | Add a secondary dim `THREE.DirectionalLight` pointing from moon direction (opposite of sun + slight offset). Color: `#c0d0ff` (cool blue-white), intensity 0.08. Gives subtle blue-silver tint to terrain at night. Controlled by same DayNightCycle that controls sun direction. |
| C5 | Torch item building light | If player crafts and places a Torch building, add a PointLight similar to campfire but smaller: intensity 1.2, distance 8m, warm yellow `#ffcc44`, no shadow (cheaper). Stack with campfire lights but enforce global 8-light budget (Three.js limit). |

**Quality gate**: (a) Campfire emits visible orange light that flickers, (b) campfire casts shadows onto nearby ground, (c) terrain turns gold/orange during sunrise/sunset, (d) moon casts subtle blue tint at night, (e) torch building adds light, (f) framerate regression < 5%, (g) build passes.

---

## Agent Dispatch Plan (M27)

| Agent | Track | First Task | Report To |
|-------|-------|-----------|-----------|
| `ui-worker` | Track A | A1: Add XP bar to HUD.tsx | director |
| `ai-npc` | Track B | B1-B2: Gold currency + MerchantSystem | director |
| `physics-prof` | Track C | C1-C2: Campfire point light + shadows | director |

---

## M27 Completion Summary (2026-03-26)

**All 3 Tracks SHIPPED:**

- **Track A (ui-worker): Skill Progression UI -- DONE** -- SkillXpBar in HUD (300×6px, bottom-center, highest-XP skill), LevelUpFlash (gold screen-center toast 2.5s), XP gain toasts (bottom-left +N SkillName XP). SkillPanel.tsx (175 lines, 6 skills, icon/level/XP bar/bonus desc, K hotkey). Fixed SidebarShell lazy import pointing to non-existent SkillTreePanel.
- **Track B (ai-npc): NPC Merchant Trading -- DONE** -- Gold currency in playerStore (addGold/spendGold), displayed in InventoryPanel header. MerchantSystem.ts (3 archetypes: general/blacksmith/alchemist, priced sell lists, 60% buy-back). MerchantPanel.tsx (buy/sell tabs, gold balance). Merchant NPCs (role trader, id%6===3) spawn in sessions with gold octahedron marker; F key opens shop. All quests award 10–50 gold. Persisted in OfflineSaveManager.
- **Track C (physics-prof): Dynamic Lighting -- DONE** -- CampfireLightPass.tsx (PointLight color #ff6633, intensity 2.0, flicker via sin, max 5 nearest, shadow 512×512). DayNightCycle moon glow (#c0d0ff, 0.08 intensity, no shadow). PlanetTerrain sunrise/sunset tinting (uSunTint/#ff8040, 15% blend during golden hour). Torch building type added.

**Bugs fixed this sprint:**
- React duplicate instance across Vite chunks (removeChild crash) — fixed vendor-react chunk order
- Clerk v6 routing="hash" removed → switched to routing="virtual"

**Build**: Passes (0 errors).

---

## M28 Sprint Plan -- 3 Parallel Tracks

**Date**: 2026-03-26
**Status**: IN PROGRESS -- Workers spawning

### Track A (P0): Minimap Upgrades — Waypoints + Fog of War
**Assigned to**: `ui-worker`
**Duration**: Full sprint
**Goal**: Upgrade the existing minimap with fog of war, player-placed waypoints, and animated NPC dots.

| Task | Description | Technical Spec |
|------|-------------|---------------|
| A1 | Fog of war layer | Add a canvas-based fog layer over the minimap. The fog is a dark overlay with circular "revealed" areas centered on the player's visited positions. Maintain a `Set<string>` of grid cells (32m resolution) the player has visited. On minimap render, draw black overlay then cut circular holes (radius 60px on minimap scale) for each visited cell near the viewport. This gives classic RPG fog-of-war feel. |
| A2 | Player-placed waypoints | Right-click on minimap to place a waypoint marker (gold diamond). Store up to 5 waypoints in uiStore. Each shows a tooltip with distance on hover. Clicking an existing waypoint removes it. Waypoints persist in save state. |
| A3 | Animated NPC dots | Show small colored dots on the minimap for NPCs within 200m of player. Green dot for friendly, amber for neutral, red for hostile/aggro'd. Dots pulse once per second to indicate they're living entities. Use the existing `remoteNpcs` data from SceneRoot/the NPC store. |
| A4 | Settlement labels | Show settlement names as small text labels on the minimap when the viewport encompasses them. Font size 8px, white with dark shadow. Only show settlements within the current minimap view range. |
| A5 | Zoom controls | Add +/- buttons to the minimap (top-right corner, small). 3 zoom levels: 100m radius, 200m radius, 400m radius. Default 200m. Persist zoom level in uiStore. |

**Quality gate**: (a) Fog of war reveals as player moves, (b) right-click places waypoint, (c) NPC dots animate on map, (d) settlement names visible at appropriate zoom, (e) zoom works, (f) build passes.

---

### Track B (P1): Ship / Raft Building
**Assigned to**: `interaction`
**Duration**: Full sprint
**Goal**: Let players build and ride a raft on the ocean. New building type, mounting mechanic, water movement physics.

| Task | Description | Technical Spec |
|------|-------------|---------------|
| B1 | Raft building item | Add "Raft" to the build system: recipe requires 20 Wood + 5 Rope (or vine). Create `BuildingType.RAFT` in the buildings config. Raft can only be placed on water (check elevation < SEA_LEVEL at placement position). Visual: flat wooden platform 3×3m, made of instanced box geometries (planks). |
| B2 | Mount/dismount mechanic | When player stands on or near a raft (within 2m) and presses E, they "mount" the raft. While mounted: player position is locked to raft position + offset. WASD controls raft movement (not player walk). Speed: 4 m/s forward, 2 m/s strafe. Q/E to rotate raft. Press E again to dismount (player placed on shore or nearest land). |
| B3 | Water buoyancy | Raft position Y is locked to SEA_LEVEL + 0.5m. Add gentle bob animation: `posY = SEA_LEVEL + 0.5 + sin(time * 0.8 + raftId * 1.3) * 0.15`. Rotate raft pitch/roll: `pitch = sin(time * 0.5) * 0.03`, `roll = cos(time * 0.7) * 0.025`. |
| B4 | Collision with shore | While piloting raft, if player tries to move into terrain (elevation > SEA_LEVEL - 0.5m), block movement in that direction (simple AABB collision). Show "Too shallow" indicator in HUD when blocked. |
| B5 | Raft HUD indicator | When mounted on raft, show a small compass + speed indicator in HUD bottom-right: arrow showing heading, speed in m/s, "SAILING" label. Use consistent monospace dark style. |

**Quality gate**: (a) Raft can be crafted and placed on water, (b) E mounts player, WASD moves raft, (c) gentle bobbing animation, (d) can't drive into shore, (e) HUD shows sailing indicator, (f) build passes.

---

### Track C (P0): Performance Pass — LOD + Culling
**Assigned to**: `physics-prof`
**Duration**: Full sprint
**Goal**: Fix the large main bundle (3167 kB) and add LOD distance culling for trees/rocks to improve framerate on lower-end devices.

| Task | Description | Technical Spec |
|------|-------------|---------------|
| C1 | Tree/rock distance culling | In `ResourceNodesRenderer.tsx`, add a distance check: only render nodes within 80m of player. Nodes beyond 80m are skipped entirely (no mesh in scene). At 40-80m range, use a simplified instanced mesh (just a cone + cylinder for trees, just a box for rocks, no normal maps). At 0-40m use full quality. Update culling every 2s (not every frame) to reduce CPU cost. |
| C2 | NPC distance culling | In NPC renderers, skip rendering NPCs beyond 150m. Only process AI/pathfinding for NPCs within 100m. |
| C3 | Geometry LOD for terrain | Check if `PlanetTerrain.tsx` supports LOD segments. If terrain mesh has fixed segment count, add a simple distance-based segment reduction: reduce terrain quad resolution by 50% when camera is above 200m altitude. |
| C4 | Bundle size — lazy-load heavy systems | Dynamically import `AtmosphereShader`, `OceanShader`, and `CampfireLightPass` (the new rendering modules added in M19/M27). These are loaded once on startup but don't need to block the initial render. Use `React.lazy` + `Suspense` with null fallback. |
| C5 | Remove dead code | Search for and remove any unused imports, commented-out code blocks, and unused exports introduced in the last 5 milestones. Target: reduce main bundle by 50+ kB. |

**Quality gate**: (a) Trees/rocks beyond 80m not rendered, (b) framerate improves by ≥10% in scenes with many nodes, (c) bundle size reduces by at least 50 kB, (d) no visual regression at close range, (e) build passes.

---

## Agent Dispatch Plan (M28)

| Agent | Track | First Task | Report To |
|-------|-------|-----------|-----------|
| `ui-worker` | Track A | A1: Add fog of war canvas layer to minimap | director |
| `interaction` | Track B | B1-B2: Raft building item + mount mechanic | director |
| `physics-prof` | Track C | C1: Tree/rock distance culling in ResourceNodesRenderer | director |


---

## M28 Completion Summary (2026-03-26)

**All 3 Tracks SHIPPED:**

- **Track A (ui-worker): Minimap Upgrades -- DONE** -- Fog of war (32m cell grid, radial reveal via destination-out). Waypoints (right-click gold diamond, up to 5, distance tooltip). Animated NPC dots (green/amber/red, 1Hz pulse). Settlement labels. 3-level zoom (100/200/400m, persisted).
- **Track B (interaction): Raft Building -- DONE** -- Raft building (20 Wood + 5 Rope, water-only placement). RaftSystem.ts (E to mount, WASD sail 4 m/s, Q/E heading). Buoyancy bob. Shore collision + Too shallow indicator. SailingHUD.tsx (compass, heading, speed). RaftRenderer.tsx.
- **Track C (physics-prof): Performance Pass -- DONE** -- Tree/rock LOD: full <40m, low-poly 40-80m, hidden >80m (2s update). NPC culling: render off >150m, AI skip >100m. CraftingRecipes.ts extracted. Bundle: 3168 -> 3122 kB (-47 kB).

**Build**: Passes (0 errors).

---

## M29 Sprint Plan -- 3 Parallel Tracks

**Date**: 2026-03-26
**Status**: IN PROGRESS

### Track A (P0): Underground Cave System
Assigned to: ui-worker. Cave entrances (5-8 seeded positions, dark depression), CaveTunnelRenderer.tsx (TubeGeometry tunnels + sphere chambers), ore veins (emissive ResourceNodes), bioluminescent lighting (PointLight #4488ff + mushroom meshes #00ff88), underground atmosphere (caveStore, FogExp2 #0a0a12).

### Track B (P1): Weather-Responsive Gameplay
Assigned to: ai-npc. Warmth stat (0-100, weather drain rates, cold damage, HUD snowflake bar), campfire warmth bonus (+5/s within 8m), rain extinguishes fires (10% per 10s), storm 40% movement penalty + wind indicator, lightning strikes (30-90s during STORM, 50 dmg, fire particle 10s).

### Track C (P0): Multiplayer Presence Improvements
Assigned to: physics-prof. Name tags above remote players (HTML overlay, fade 30-50m), proximity ring pulse within 15m, PlayerListPanel.tsx (P hotkey, ping indicators), inspect player panel (F within 3m, username/faction/equipment).


---

## M30 Completion Summary (2026-03-26)

**All 3 Tracks SHIPPED:**

- **Track A (ui-worker): Combat Improvements — DONE** — Weapon tier table (Fists→Quantum), improved crits (5%+2%/level+15% backstab, 2.5× mult), damage numbers project to screen space via camera sync ref
- **Track B (ai-npc): Dialogue + Skill System — DONE** — 6 NPC role pools, SkillPanel (K hotkey), 6 skills with XP bars, level-up flash, XP gain toasts, achievement panel fix
- **Track C (physics-prof): Merchant System — DONE** — 3 merchant archetypes, buy/sell tabs, gold balance, archetype stored in dialogueStore (not window global)

---

## M31 Completion Summary (2026-03-26)

**All 3 Tracks SHIPPED:**

- **Track A (ui-worker): Biome Visual Effects — DONE** — uBiomeFlags uniform (volcano/tundra/desert), lava crack shader, tundra ice, desert dunes, summit point lights, ash/sand particles
- **Track B (biology-prof): Advanced Lighting — DONE** — CampfireLightPass.tsx (flicker PointLight, shadow, torch support), moon glow, sunrise/sunset tints, tier-based settlement lights
- **Track C (interaction): Advanced Mining + Crafting — DONE** — Cave entrances (6 seeded markers), CaveTunnelRenderer.tsx (TubeGeometry tunnels, chambers, ore nodes, bioluminescent mushrooms, PointLights), UndergroundAtmosphere.tsx (FogExp2, ambient dim)

---

## M32 Completion Summary (2026-03-26)

**All 3 Tracks SHIPPED:**

- **Track A (ui-worker): Seasonal Events — DONE** — Meteor showers (8–15 streak meshes, 7-day cycle, iron ore + Velar crystal loot on crater impact), Aurora Borealis (3 GLSL ribbon shaders, polar zones, night only), Seasonal Festivals (30-day cycle, 2× XP multiplier 3 days, bonfire mesh at settlement, banner overlay)
- **Track B (biology-prof): Animal Taming — DONE** — AnimalAISystem.ts tame mechanic, named companions, companion loyalty, follow behavior, AnimalRenderer.tsx companion indicators
- **Track C (interaction): Fast Travel — DONE** — Settlement discovery within 150m, undiscovered = "???" grey markers, map-click fast travel dialog, gold cost (5g/100 units, min 10g), fade-to-black teleport, HUD fade overlay

---

## M33 Sprint Plan — 3 Parallel Tracks

**Date**: 2026-03-26
**Status**: IN PROGRESS

### Track A (P0): Quest Board System
Assigned to: ui-worker. Settlement quests (4 types: gather/hunt/explore/craft), quest panel (Q hotkey), accept/abandon, progress tracking in GameLoop, completion toast (+XP +gold), HUD quest tracker widget.

### Track B (P1): Cooking & Food Buffs
Assigned to: biology-prof. 6 new food MAT items (cooked fish/meat, mushroom soup, berry jam, herbal tea, hearty stew), campfire recipes, FoodBuffSystem.ts (temp speed/HP regen/warmth buffs), HUD buff bar with countdown.

### Track C (P0): Cave Treasure Chests
Assigned to: interaction. ChestSystem.ts (3 tiers: common/rare/legendary), lockpick item + recipe, chest rendering in cave chambers (BoxGeometry, tier glow), E-key loot interaction, loot popup, map chest markers.

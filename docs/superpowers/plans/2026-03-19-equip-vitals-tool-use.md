# Equip System + Vitals Depletion + Tool Use — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the gather→craft→equip→use vertical slice so a player can pick up materials, craft a stone tool, equip it from inventory, see it held in hand, use it to harvest resources, and watch hunger/thirst actively deplete over time.

**Architecture:** Add `equippedSlot` to `playerStore`, create `EquipSystem.ts` for item stats, add Equip button to `InventoryPanel`, render a hand-held item mesh in `SceneRoot` using the player's ECS rotation (not camera quaternion — this is a third-person game), wire hunger/thirst/energy depletion into the per-frame GameLoop, and add a left-click harvest action that uses the equipped tool's stats. Each task is a complete vertical slice — nothing is "done" until the full flow works.

**Tech Stack:** TypeScript, React, Zustand, Three.js, @react-three/fiber, existing Inventory/PlayerController/ECS systems

**Spec:** `docs/superpowers/specs/2026-03-19-survival-world-redesign.md`

---

## Pre-flight: Read these files before starting any task

Before writing any code, read these files to understand what already exists:

- `src/player/Inventory.ts` — full file. Note the `ITEM` and `MAT` enum values and their exact numeric values.
- `src/store/playerStore.ts` — full file. Note all existing fields and action shapes.
- `src/rendering/SceneRoot.tsx` — full file. Note the `GameLoop` component, how player position/rotation is read from ECS, and where resource nodes are gathered. Note the exact variable names for `RESOURCE_NODES`, `gatheredNodeIds`, `NODE_RESPAWN_AT`, `NODE_RESPAWN_DELAY`, and `terrainYAt`.
- `src/ecs/systems/MetabolismSystem.ts` — full file. Note whether it already depletes hunger/thirst and at what rates.
- `src/player/PlayerController.ts` — full file. Note `popInteract()` pattern, whether `popAttack()` exists, and whether `_input` is private or public.
- `src/ui/panels/InventoryPanel.tsx` — full file. Note how items are displayed and how the selected-item detail panel is structured.
- `src/game/GameSingletons.ts` — full file. Confirm `inventory` is exported as a singleton from here.
- `src/ecs/world.ts` — scan for `Rotation` component definition — note the field names (x, y, z, w quaternion components).

---

## Task 1: Add equippedSlot to playerStore

**Files:**
- Modify: `src/store/playerStore.ts`

**Why:** The equip system needs a single source of truth for what the player is holding. All other systems (hand mesh renderer, tool use, stats display) read from here.

- [ ] **Step 1: Read the full playerStore**

  Run:
  ```bash
  cat src/store/playerStore.ts
  ```
  Note the exact shape of the `create<PlayerState>()(...)` call. Find where the last field is defined and where the last action is defined.

- [ ] **Step 2: Add equippedSlot field and equip/unequip actions**

  Add to the state type interface:
  ```typescript
  equippedSlot: number | null   // index 0–39 into inventory.slots, or null
  equip:   (slotIndex: number | null) => void
  unequip: () => void
  ```

  Add to the initial state and actions in `create()(set => ({ ... }))`:
  ```typescript
  equippedSlot: null,
  equip:   (slotIndex) => set({ equippedSlot: slotIndex }),
  unequip: () => set({ equippedSlot: null }),
  ```

- [ ] **Step 3: Verify TypeScript compiles**

  Run:
  ```bash
  cd universe-sim && npx tsc --noEmit
  ```
  Expected: zero errors related to playerStore. Fix any type errors before moving on.

- [ ] **Step 4: Commit**

  ```bash
  git add src/store/playerStore.ts
  git commit -m "feat: add equippedSlot + equip/unequip to playerStore"
  ```

---

## Task 2: Create EquipSystem.ts

**Files:**
- Create: `src/player/EquipSystem.ts`

**Why:** Item stats (damage, harvest power, range, what it can harvest) need a single authoritative lookup — not scattered across UI and game logic.

- [ ] **Step 1: Read Inventory.ts to get ITEM and MAT enum values**

  Run:
  ```bash
  grep -n "ITEM\|MAT\b\|= {" src/player/Inventory.ts | head -80
  ```
  Note the exact names for items like STONE_TOOL, KNIFE, SPEAR, and note resource node type strings used in SceneRoot.tsx (e.g., 'stone', 'wood', 'flint').

- [ ] **Step 2: Read resource node type strings from SceneRoot**

  Run:
  ```bash
  grep -n "type:" src/rendering/SceneRoot.tsx | head -30
  ```
  Note the exact string values used for node types (e.g., `type: 'stone'`, `type: 'wood'`). The `harvestTypes` arrays in EquipSystem must exactly match these strings.

- [ ] **Step 3: Create the file**

  Create `src/player/EquipSystem.ts`:

  ```typescript
  // ── EquipSystem ────────────────────────────────────────────────────────────────
  // Authoritative source for equipped-item stats and food stats.
  // All systems that need to know what a held item does import from here.

  import { ITEM, MAT } from './Inventory'

  export interface ItemStats {
    name:          string
    damage:        number    // raw hit damage
    harvestPower:  number    // 1=hand, 2=stone tool, 3=bronze, 4=iron, 5=steel
    harvestTypes:  string[]  // resource node type strings — must match node.type in SceneRoot
    range:         number    // reach in metres
  }

  const HAND: ItemStats = {
    name:         'Hand',
    damage:       1,
    harvestPower: 1,
    harvestTypes: ['wood', 'fiber', 'leaf', 'bark'],  // adjust to match actual node.type strings
    range:        2.0,
  }

  // Map itemId → stats. itemId=0 (raw materials) always falls back to HAND.
  const STATS: Partial<Record<number, ItemStats>> = {
    [ITEM.STONE_TOOL]: {
      name:         'Stone Tool',
      damage:       5,
      harvestPower: 2,
      harvestTypes: ['stone', 'flint', 'clay', 'wood', 'fiber', 'sand', 'bark'],
      range:        2.5,
    },
    [ITEM.KNIFE]: {
      name:         'Knife',
      damage:       8,
      harvestPower: 2,
      harvestTypes: ['hide', 'fiber', 'wood', 'bark'],
      range:        2.0,
    },
    [ITEM.SPEAR]: {
      name:         'Spear',
      damage:       12,
      harvestPower: 2,
      harvestTypes: ['wood'],
      range:        3.5,
    },
  }

  // Only include ITEM values that actually exist in Inventory.ts.
  // If ITEM.KNIFE or ITEM.SPEAR don't exist, remove those entries.

  /** Return stats for the given itemId. Falls back to HAND stats if unknown or 0. */
  export function getItemStats(itemId: number): ItemStats {
    return STATS[itemId] ?? HAND
  }

  /** True if the equipped tool can harvest a node of the given resource type. */
  export function canHarvest(itemId: number, resourceType: string): boolean {
    return getItemStats(itemId).harvestTypes.includes(resourceType)
  }

  // ── Food stats ─────────────────────────────────────────────────────────────────

  export interface FoodStats {
    hungerRestore: number   // amount to SUBTRACT from hunger (store: 0=full, 1=starving)
    thirstRestore: number   // amount to SUBTRACT from thirst
  }

  // materialId → food stats. Populate when food materials exist.
  const FOOD_STATS: Partial<Record<number, FoodStats>> = {
    // Example (fill in when food MAT values exist):
    // [MAT.COOKED_MEAT]: { hungerRestore: 0.4, thirstRestore: 0.0 },
  }

  /** Return food stats for a materialId, or null if it is not food. */
  export function getFoodStats(materialId: number): FoodStats | null {
    return FOOD_STATS[materialId] ?? null
  }
  ```

- [ ] **Step 4: Verify TypeScript compiles**

  ```bash
  npx tsc --noEmit
  ```
  Expected: zero new errors. If `ITEM.KNIFE` or `ITEM.SPEAR` don't exist in the enum, delete those entries from STATS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/player/EquipSystem.ts
  git commit -m "feat: add EquipSystem with per-item harvest stats and food stats"
  ```

---

## Task 3: Add Equip/Unequip button to InventoryPanel

**Files:**
- Modify: `src/ui/panels/InventoryPanel.tsx`

**Why:** Players need a way to equip items. The existing selected-item detail panel is where this button lives.

- [ ] **Step 1: Read the full InventoryPanel**

  ```bash
  cat src/ui/panels/InventoryPanel.tsx
  ```
  Find: where selected item details are shown (the panel that appears when you click a slot), and what JSX renders the Drop button. The Equip button goes right next to Drop.

- [ ] **Step 2: Add imports at the top of the file**

  After existing imports, add:
  ```typescript
  import { usePlayerStore } from '../../store/playerStore'
  import { getItemStats, getFoodStats } from '../../player/EquipSystem'
  ```

- [ ] **Step 3: Add equip state and logic inside the component**

  Inside the component function (near the top, after existing hooks), add:
  ```typescript
  const equippedSlot   = usePlayerStore(s => s.equippedSlot)
  const equipAction    = usePlayerStore(s => s.equip)
  const unequipAction  = usePlayerStore(s => s.unequip)
  const updateVitals   = usePlayerStore(s => s.updateVitals)
  ```

  After `selectedSlot` is derived, add:
  ```typescript
  const isEquippable = selectedSlot !== null && selectedSlot.itemId > 0
  const isEquipped   = selected !== null && equippedSlot === selected
  const foodStats    = selectedSlot ? getFoodStats(selectedSlot.materialId) : null
  ```

  **Note:** The state variable is `const [selected, setSelected] = useState<number | null>(null)`. Use `selected` and `setSelected`, NOT `selectedIndex` / `setSelectedIndex` — those names do not exist in this file.

- [ ] **Step 4: Add Equip/Unequip button in the detail panel**

  Find the JSX where the Drop button is rendered. Add Equip button immediately before it:

  ```tsx
  {isEquippable && (
    <button
      onClick={() => isEquipped ? unequipAction() : equipAction(selected!)}
      style={{
        padding: '4px 12px',
        marginRight: 8,
        background: isEquipped ? '#22c55e' : '#3b82f6',
        color: '#fff',
        border: 'none',
        borderRadius: 4,
        cursor: 'pointer',
        fontWeight: 600,
      }}
    >
      {isEquipped ? 'Unequip' : 'Equip'}
    </button>
  )}
  ```

  Add Eat button immediately after the Equip button (before Drop):

  ```tsx
  {foodStats && (
    <button
      onClick={() => {
        if (selected === null || !foodStats) return
        const current = usePlayerStore.getState()
        // Store uses 0=full / 1=starving convention (same as ECS MetabolismSystem).
        // Eating REDUCES hunger, so subtract the restore amount and floor at 0.
        updateVitals({
          hunger: Math.max(0, current.hunger - foodStats.hungerRestore),
          thirst: Math.max(0, current.thirst - foodStats.thirstRestore),
        })
        inventory.removeItem(selected, 1)
        setSelected(null)
      }}
      style={{
        padding: '4px 12px',
        marginRight: 8,
        background: '#f59e0b',
        color: '#fff',
        border: 'none',
        borderRadius: 4,
        cursor: 'pointer',
        fontWeight: 600,
      }}
    >
      Eat
    </button>
  )}
  ```

- [ ] **Step 5: Add green border to equipped slot cell**

  In the `SlotCell` component (or wherever slot cells are rendered), pass `equippedSlot` down as a prop (or read it directly via `usePlayerStore` if SlotCell is a React component). Apply:
  ```tsx
  border: equippedSlot === slotIndex ? '2px solid #22c55e' : '1px solid rgba(255,255,255,0.15)'
  ```

- [ ] **Step 6: Verify in dev server**

  Run:
  ```bash
  npm run dev
  ```
  Open inventory panel (I key). Click a crafted item (e.g., Stone Tool). Verify:
  - "Equip" button appears (NOT for raw materials like stone, wood)
  - Clicking Equip changes button to "Unequip" and slot gets green border
  - Clicking Unequip clears the equip state and border returns to normal
  - No Equip button on raw material slots (itemId === 0)

- [ ] **Step 7: Commit**

  ```bash
  git add src/ui/panels/InventoryPanel.tsx
  git commit -m "feat: add equip/unequip and eat buttons to inventory panel"
  ```

---

## Task 4: Render equipped item mesh at player's hand

**Files:**
- Modify: `src/rendering/SceneRoot.tsx`

**Why:** The player needs to visually see what they are holding. Without visual feedback, equipping feels broken even if the state is correct.

**Important:** This is a third-person camera game. The hand mesh must be positioned relative to the **player's rotation** (from ECS), not the camera's quaternion. Using the camera quaternion would place the mesh in front of the camera, not the player's hand.

- [ ] **Step 1: Confirm how player rotation is stored in ECS**

  Run:
  ```bash
  grep -n "Rotation\." src/rendering/SceneRoot.tsx | head -20
  grep -n "Rotation\b" src/ecs/world.ts | head -20
  ```
  Note the field names. Likely `Rotation.x[id], Rotation.y[id], Rotation.z[id], Rotation.w[id]` (quaternion).

- [ ] **Step 2: Confirm `inventory` singleton import in SceneRoot**

  Run:
  ```bash
  grep -n "GameSingletons\|inventory" src/rendering/SceneRoot.tsx | head -10
  ```
  Confirm `inventory` is imported from `'../game/GameSingletons'`. If not, add:
  ```typescript
  import { inventory } from '../game/GameSingletons'
  ```
  at the top of SceneRoot.tsx (it is likely already there).

- [ ] **Step 3: Add EquippedItemMesh component**

  Add this component inside `SceneRoot.tsx` (before the main scene component, after other helper components). It reads the player rotation from ECS to place the item at the player's right hand — NOT at the camera:

  ```tsx
  // ── EquippedItemMesh ──────────────────────────────────────────────────────────
  // Renders a plain colored box at the player's right-hand position.
  // Uses the player's ECS rotation quaternion, not the camera, because the
  // camera is behind the player in third-person mode.
  //
  // IMPORTANT: slot is re-read inside useFrame every frame (not at render time).
  // If we captured it at render time we'd get a stale closure — the mesh would
  // stay visible even after the item is dropped/consumed without calling unequip().
  function EquippedItemMesh({ entityId }: { entityId: number }) {
    const meshRef = useRef<THREE.Mesh>(null)

    useFrame(() => {
      if (!meshRef.current) return

      // Re-read slot every frame to avoid stale closure bugs
      const eSlot = usePlayerStore.getState().equippedSlot
      const slot  = eSlot !== null ? inventory.getSlot(eSlot) : null

      if (!slot) {
        meshRef.current.visible = false
        return
      }
      meshRef.current.visible = true

      // Player world position
      const px = Position.x[entityId]
      const py = Position.y[entityId]
      const pz = Position.z[entityId]

      // Player rotation quaternion from ECS
      const q = new THREE.Quaternion(
        Rotation.x[entityId],
        Rotation.y[entityId],
        Rotation.z[entityId],
        Rotation.w[entityId],
      )

      // Hand offset in player-local space: right, slightly forward, slightly down
      // Adjust these values if the mesh appears in the wrong position
      const localOffset = new THREE.Vector3(0.5, -0.3, 0.4)
      localOffset.applyQuaternion(q)

      meshRef.current.position.set(px + localOffset.x, py + localOffset.y, pz + localOffset.z)
      meshRef.current.quaternion.copy(q)
    })

    // Always mount the mesh — visibility is controlled inside useFrame via .visible
    // Color is fixed to a neutral default; the per-material color update could be
    // added here in a future pass using a color attribute on the material ref.
    return (
      <mesh ref={meshRef} visible={false}>
        <boxGeometry args={[0.08, 0.08, 0.45]} />
        <meshStandardMaterial color="#9ca3af" />
      </mesh>
    )
  }
  ```

  Make sure `MAT` is imported from `'../player/Inventory'` at the top of SceneRoot.tsx (check with grep first).

- [ ] **Step 4: Mount EquippedItemMesh inside the Canvas scene**

  Find where the player mesh is rendered inside the Canvas JSX. Add `<EquippedItemMesh entityId={entityId} />` as a sibling (not a child) of the player mesh. Pass the same `entityId` variable used to render the player.

- [ ] **Step 5: Verify visually**

  Start dev server. Enter game. Add a Stone Tool to inventory via crafting or debug. Equip it. Verify:
  - A small box appears near the player's right hand in the 3D view
  - The box moves with the player as they walk
  - The box disappears when the item is unequipped
  - The box is NOT floating in front of the camera (that would indicate camera-relative positioning was used instead of player-relative)

- [ ] **Step 6: Commit**

  ```bash
  git add src/rendering/SceneRoot.tsx
  git commit -m "feat: render equipped item mesh at player right hand (ECS rotation)"
  ```

---

## Task 5: Add popAttack() to PlayerController

**Files:**
- Modify: `src/player/PlayerController.ts`

**Why:** Tool use triggers on left mouse click (attack). We need a consume-once method matching `popInteract()` for the attack input.

- [ ] **Step 1: Check if popAttack() already exists**

  ```bash
  grep -n "popAttack\|popInteract\|_attackConsumed\|MouseLeft\|KeyQ" src/player/PlayerController.ts | head -30
  ```

  If `popAttack()` already exists, skip to Task 6.

  Read the full `popInteract()` implementation to understand the consumed-flag pattern before writing `popAttack()`. The attack method must use the same pattern — do NOT use the `input` struct directly.

- [ ] **Step 2: Add _attackConsumed field and popAttack() method**

  First, add a private field alongside the other consumed-flag fields (find where `_interactConsumed` is declared):
  ```typescript
  private _attackConsumed = false
  ```

  Then find the `popInteract()` method. Add `popAttack()` immediately after it, using the same consumed-flag pattern (checking `this.keys` directly, not the `input` struct, because `input.attack` is overwritten every frame by `pollInput()`):

  ```typescript
  /** Consume the pending attack input. Returns true once per left-click (not every frame). */
  popAttack(): boolean {
    const held = this.keys.has('MouseLeft') || this.keys.has('KeyQ')
    if (held && !this._attackConsumed) {
      this._attackConsumed = true
      return true
    }
    if (!held) this._attackConsumed = false
    return false
  }
  ```

- [ ] **Step 3: Verify mouse listener exists and key names are correct**

  Run:
  ```bash
  grep -n "mousedown\|mouseup\|MouseLeft\|KeyQ\|keys\.has\|keys\.add\|keys\.delete\|pollInput\|addEventListener" src/player/PlayerController.ts | head -30
  ```

  Check TWO things:

  **A) Does a `mousedown` listener exist that adds a key to `this.keys`?**
  - If NO: `'MouseLeft'` is never added to `this.keys` (only `keydown` events populate it). Left-click will silently do nothing in `popAttack()`. You MUST add mouse listeners.
    Find the constructor and add alongside the existing keyboard listeners:
    ```typescript
    this.boundMouseDown = (e: MouseEvent) => { if (e.button === 0) this.keys.add('MouseLeft') }
    this.boundMouseUp   = (e: MouseEvent) => { if (e.button === 0) this.keys.delete('MouseLeft') }
    window.addEventListener('mousedown', this.boundMouseDown)
    window.addEventListener('mouseup',   this.boundMouseUp)
    ```
    Add the two fields as private properties, and remove the listeners in `dispose()`:
    ```typescript
    window.removeEventListener('mousedown', this.boundMouseDown)
    window.removeEventListener('mouseup',   this.boundMouseUp)
    ```
  - If YES: verify the exact string used (it may be `'Mouse0'` or `'PointerLeft'`). Update `popAttack()` to use that exact string.

  **B) Confirm the exact string used for `'KeyQ'`** (the keyboard attack alternative). Update `popAttack()` to use the exact strings found in the codebase.

- [ ] **Step 4: Verify TypeScript compiles**

  ```bash
  npx tsc --noEmit
  ```
  Expected: zero new errors.

- [ ] **Step 5: Commit**

  ```bash
  git add src/player/PlayerController.ts
  git commit -m "feat: add popAttack() to PlayerController (consumed-flag pattern)"
  ```

---

## Task 6: Wire tool use in GameLoop (harvest on left click)

**Files:**
- Modify: `src/rendering/SceneRoot.tsx`

**Why:** The equip system is useless unless the equipped tool actually does something. Left-click with a tool should harvest the nearest valid resource node within range.

- [ ] **Step 1: Read the existing gather section in SceneRoot GameLoop**

  ```bash
  grep -n "popInteract\|gatherPrompt\|gatheredNode\|addItem\|RESOURCE_NODES\|NODE_RESPAWN\|terrainYAt" src/rendering/SceneRoot.tsx | head -40
  ```
  Note the exact variable names used. The resource nodes array is `RESOURCE_NODES` (all-caps). The tool use block below mirrors this pattern.

- [ ] **Step 2: Add import at top of file**

  ```typescript
  import { getItemStats, canHarvest } from '../player/EquipSystem'
  ```
  (Check with grep first — may already be imported.)

- [ ] **Step 3: Add tool use handler inside GameLoop's useFrame**

  Inside the GameLoop `useFrame`, after the existing F-key gather block, add:

  ```typescript
  // ── Tool use: left click harvests with equipped item ─────────────────
  if (controllerRef.current?.popAttack()) {
    const equippedSlot = usePlayerStore.getState().equippedSlot
    const equippedItem = equippedSlot !== null ? inventory.getSlot(equippedSlot) : null
    const itemId       = equippedItem?.itemId ?? 0
    const stats        = getItemStats(itemId)

    const px = Position.x[entityId]
    const py = Position.y[entityId]
    const pz = Position.z[entityId]

    let nearest: (typeof RESOURCE_NODES)[0] | null = null
    let nearestDist = Infinity

    for (const node of RESOURCE_NODES) {
      if (gatheredNodeIds.has(node.id)) continue
      const dx = node.x - px
      const dy = terrainYAt(node.x, node.z) - py   // ResourceNode has no y field — compute from terrain
      const dz = node.z - pz
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (dist < stats.range && dist < nearestDist && canHarvest(itemId, node.type)) {
        nearest = node
        nearestDist = dist
      }
    }

    if (nearest) {
      const qty     = Math.floor(Math.random() * 3) + 1
      const quality = 0.7 + Math.random() * 0.3
      inventory.addItem({ itemId: 0, materialId: nearest.matId, quantity: qty, quality })
      gatheredNodeIds.add(nearest.id)
      NODE_RESPAWN_AT.set(nearest.id, Date.now() + NODE_RESPAWN_DELAY)
    }
  }
  ```

- [ ] **Step 4: Verify in dev server**

  Enter game. Equip a Stone Tool. Walk near a stone or wood node. Left-click. Verify:
  - Node disappears (marked gathered)
  - Material appears in inventory
  - Left-click with no tool equipped still works on 'wood'/'fiber' node types

- [ ] **Step 5: Commit**

  ```bash
  git add src/rendering/SceneRoot.tsx
  git commit -m "feat: wire tool use — left click harvests with equipped item stats"
  ```

---

## Task 7: Wire hunger, thirst, energy depletion in GameLoop

**Files:**
- Modify: `src/rendering/SceneRoot.tsx`
- Possibly modify: `src/player/PlayerController.ts` (only if sprint state is private)

**Why:** Vitals show on HUD but never change. Survival is meaningless without real depletion.

- [ ] **Step 1: Read MetabolismSystem to understand existing pipeline**

  ```bash
  cat src/ecs/systems/MetabolismSystem.ts
  ```
  Note whether it depletes hunger/thirst (reads from and writes to the ECS `Metabolism` component). Then check what the GameLoop does with it:
  ```bash
  grep -n "MetabolismSystem\|setMetabolismDt\|updateVitals\|hunger\|thirst" src/rendering/SceneRoot.tsx | head -30
  ```
  There is an existing pipeline in `GameLoop`: `setMetabolismDt(dt); MetabolismSystem(world)` runs the ECS system, then `updateVitals(...)` pushes ECS values into `playerStore` every frame. This means **any new drain block added after the existing `updateVitals` push will be overwritten in the same frame**.

  **First, check polarity** — `MetabolismSystem.ts` increments hunger/thirst (0=full → 1=starving). The playerStore and HUD may use either the same convention or the inverse (1=full → 0=starving). Run:
  ```bash
  grep -n "Metabolism.hunger\|Metabolism.thirst\|updateVitals" src/rendering/SceneRoot.tsx | head -20
  ```
  Check whether the `updateVitals` push inverts the ECS value (e.g., `hunger: 1 - Metabolism.hunger[eid]`) or passes it through directly. If it passes through directly, the store uses 0=full convention. If it inverts, the store uses 1=full convention. **Note which convention the store uses — the depletion logic in Step 2 and the HUD must be consistent with it.** The existing HUD bars drain direction should confirm which is correct.

  Decision tree:
  - **If MetabolismSystem already depletes hunger/thirst**: verify the drain rates match spec:
    - hunger should deplete at ~`0.00083` per second (empties in ~20 min)
    - thirst should deplete at ~`0.00139` per second (empties in ~12 min)

    If the constants are wrong (e.g., `0.00003` and `0.00005`), edit them **directly in `MetabolismSystem.ts`** — do NOT touch `setMetabolismDt`, which sets the physics timestep and must not be changed. Do NOT add a second drain block.
  - **If MetabolismSystem does NOT drain hunger/thirst**: Remove the `MetabolismSystem(world)` call and the `setMetabolismDt` call, then add the new depletion block (below) in their place. Update the `updateVitals` push that follows to include the freshly computed values instead of reading from ECS.

- [ ] **Step 2: Add or update vitals depletion**

  **Only do this step if MetabolismSystem does NOT already handle hunger/thirst drain.** If it does, skip to Step 3.

  Remove the `MetabolismSystem` call block from `GameLoop`'s `useFrame`. Replace it with:

  ```typescript
  // ── Vitals depletion (real-time survival) ────────────────────────────
  // Rates: hunger empties ~20 min, thirst ~12 min real time.
  const isSprinting  = false  // TODO: expose sprint state from PlayerController
  const vitals       = usePlayerStore.getState()

  const hungerDrain  = 0.00083 * dt    // 1/1200 per second
  const thirstDrain  = 0.00139 * dt    // 1/720 per second
  const energyDrain  = isSprinting ? 0.005 * dt : 0
  const energyRegen  = isSprinting ? 0 : 0.001 * dt

  const newHunger = Math.max(0, vitals.hunger - hungerDrain)
  const newThirst = Math.max(0, vitals.thirst - thirstDrain)
  const newEnergy = Math.min(1, Math.max(0, vitals.energy - energyDrain + energyRegen))
  const healthDrain = (newHunger <= 0 || newThirst <= 0) ? 0.0001 * dt : 0
  const newHealth = Math.max(0, vitals.health - healthDrain)

  usePlayerStore.getState().updateVitals({
    hunger: newHunger,
    thirst: newThirst,
    energy: newEnergy,
    health: newHealth,
  })
  ```

  Remove the old `updateVitals` call that was pushing stale ECS values — it would overwrite the values computed above.

- [ ] **Step 3: Verify vitals deplete in dev server**

  Enter the game. Open the HUD vitals panel. Wait 30 seconds. Verify:
  - Hunger bar is visibly lower (should drop ~2.5% in 30 seconds)
  - Thirst bar is visibly lower (should drop ~4% in 30 seconds)
  - Energy bar slowly increases while standing still

- [ ] **Step 4: Commit**

  ```bash
  git add src/rendering/SceneRoot.tsx
  git commit -m "feat: wire real-time hunger/thirst/energy depletion to GameLoop"
  ```

---

## Task 8: End-to-end playtester verification

**Files:** none (verification only)

**Why:** Per spec — every slice must pass a complete playtester agent run with zero broken steps before moving on.

- [ ] **Step 1: Start dev server**

  ```bash
  npm run dev
  ```
  Note the port (usually 5173 or next available).

- [ ] **Step 2: Seed inventory for crafting test**

  Before running the full playtester, verify that flint nodes exist near spawn. Run:
  ```bash
  grep -n "flint\|FLINT" src/rendering/SceneRoot.tsx | head -10
  ```
  Confirm a flint resource node type exists and is placed near spawn. If flint nodes exist, the crafting test will work. If flint nodes do NOT exist (no flint type in the resource node list), the craft-stone-tool step requires 2× stone instead — check the actual Stone Tool recipe in `src/player/Inventory.ts`:
  ```bash
  grep -n "STONE_TOOL\|stone_tool" src/player/Inventory.ts | head -10
  ```
  Document which exact materials the Stone Tool recipe requires before sending the playtester.

- [ ] **Step 3: Run playtester agent with this exact scenario**

  Replace `[PORT]` with the actual port. Replace `[RECIPE_MATERIALS]` with the actual materials required for Stone Tool (from Step 2).

  > "Open http://localhost:[PORT]. Click to play. Walk to a resource node (look for colored spheres on the ground). Press F to pick it up. Press I to open inventory and verify the item appears. Gather enough [RECIPE_MATERIALS] to craft a Stone Tool. Press C to open crafting panel and craft one Stone Tool. Press I to open inventory, click the Stone Tool slot. Verify an 'Equip' button appears. Click Equip. Verify: (1) the slot gets a green border, (2) a small colored box appears near the player's right hand in the 3D view. Walk near a resource node and left-click. Verify the node disappears and materials are added to inventory. Open the HUD (look at the top-left bars). Wait 60 seconds without doing anything. Verify hunger and thirst bars are visibly lower than when you started."

  **Pass criteria (ALL must pass before marking done):**
  1. Item appears in inventory after pressing F near a resource node
  2. Stone Tool successfully crafts in Crafting panel (not greyed out, not missing ingredients)
  3. Equip button appears when Stone Tool is selected in Inventory panel
  4. Green border appears on Stone Tool slot after equipping
  5. Small colored box mesh is visible near player's right-hand area in 3D view
  6. Left-click near valid resource node → node removed + material added to inventory
  7. Hunger and Thirst bars are measurably lower after 60 seconds waiting

- [ ] **Step 4: Fix any failures and re-run until all 7 criteria pass**

  For each failure:
  - Identify the specific broken step
  - Fix the underlying code (do not skip or work around)
  - Re-run the playtester from the beginning
  - Repeat until all 7 criteria pass in a single run

- [ ] **Step 5: Final commit**

  ```bash
  git add -A
  git commit -m "feat: complete equip+tool-use+vitals vertical slice — all playtester checks pass"
  ```

---

## Acceptance Criteria (summary)

The plan is complete when a playtester agent can do all of the following without errors in a single uninterrupted run:

1. Walk to a rock, press F, see stone in inventory
2. Open crafting panel, craft Stone Tool from required ingredients
3. Open inventory, click Stone Tool, click Equip — green border appears, hand mesh appears
4. Left-click a nearby resource node — node disappears, material added to inventory
5. Wait 60 seconds — hunger and thirst bars visibly lower in HUD
6. No console errors during the entire session

---

## Notes for implementer

- **`inventory` in EquippedItemMesh**: The `inventory` singleton is imported from `../game/GameSingletons`. SceneRoot.tsx likely already imports it. Confirm before adding a duplicate import.
- **`isSprinting` access**: Do not touch the `input` struct on PlayerController. Use `const isSprinting = false` with a TODO comment and move on. This is not worth a refactor to unblock vitals.
- **`popAttack()` pattern**: Must use `this.keys.has(...)` with a `_attackConsumed` flag — NOT `this.input.attack`. The `input` struct is overwritten every frame by `pollInput()`, so setting it to false has no effect.
- **`harvestTypes` strings**: The strings in EquipSystem must exactly match the `type` field on resource nodes in SceneRoot. Run `grep -n "type:" src/rendering/SceneRoot.tsx` to get the ground-truth list before writing EquipSystem.
- **ITEM enum gaps**: Only add entries to STATS in EquipSystem for ITEM values that actually exist. If ITEM.KNIFE doesn't exist, skip it.
- **Hand mesh position**: The `localOffset = new THREE.Vector3(0.5, -0.3, 0.4)` is a starting point. After first render, adjust the x/y/z values so the box appears convincingly near the player's right hand in the third-person view.
- **Eat button**: The FOOD_STATS map starts empty — this is correct. Food items don't exist yet. The Eat button infrastructure is wired for when they do. Do not add food material types in this plan.
- **Do NOT add**: new materials, new crafting recipes, NPC improvements, terrain changes, new UI panels, or any feature not listed above.

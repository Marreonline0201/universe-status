# Game UI — React Flow Tree Views + Panel Animations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade TechTree and Evolution panels to React Flow graph visualizations with visible prerequisite edges and pan/zoom, and add framer-motion spring animations to the sidebar panel slide.

**Architecture:** All 8 panels already exist and are functional. This plan adds React Flow as a "Graph View" toggle to TechTreePanel and EvolutionPanel (keeping the existing list view as a fallback), and replaces the CSS `transform` transition in SidebarShell with framer-motion's `AnimatePresence` + spring.

**Tech Stack:** `@xyflow/react` (node graph), `framer-motion` (panel animation), existing React + TypeScript + Zustand stack.

---

## File Map

| File | Change |
|------|--------|
| `package.json` | Add `@xyflow/react`, `framer-motion` |
| `src/ui/panels/TechTreePanel.tsx` | Add Graph View toggle using React Flow |
| `src/ui/panels/EvolutionPanel.tsx` | Add Graph View toggle using React Flow |
| `src/ui/SidebarShell.tsx` | Replace CSS transition with framer-motion |

No other files change.

---

## Task 1: Install dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install packages**

```bash
cd universe-sim
npm install @xyflow/react framer-motion
```

Expected output: `added N packages` with no errors.

- [ ] **Step 2: Verify install**

```bash
npm list @xyflow/react framer-motion
```

Expected: both packages listed with version numbers.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: install @xyflow/react and framer-motion"
```

---

## Task 2: framer-motion panel slide in SidebarShell

**Files:**
- Modify: `src/ui/SidebarShell.tsx`

The current panel uses a CSS `transform: translateX(...)` transition. Replace with framer-motion `motion.div` + `AnimatePresence` for a spring-physics slide.

- [ ] **Step 1: Add framer-motion imports to SidebarShell**

At the top of `src/ui/SidebarShell.tsx`, replace:
```typescript
import React, { useEffect } from 'react'
```
with:
```typescript
import React, { useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
```

- [ ] **Step 2: Replace the sliding panel div**

Find the panel container `<div style={{ position: 'fixed', top: 0, right: 48, ... transform: activePanel ? 'translateX(0)' : ... }}>` and replace the entire block (lines 95–143) with:

```tsx
<AnimatePresence>
  {activePanel && (
    <motion.div
      key={activePanel}
      initial={{ x: PANEL_WIDTH + 48 }}
      animate={{ x: 0 }}
      exit={{ x: PANEL_WIDTH + 48 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      style={{
        position: 'fixed',
        top: 0,
        right: 48,
        width: PANEL_WIDTH,
        height: '100vh',
        background: 'rgba(10,10,20,0.95)',
        borderLeft: '1px solid rgba(255,255,255,0.1)',
        backdropFilter: 'blur(12px)',
        zIndex: 200,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        pointerEvents: 'auto',
      }}
    >
      {ActivePanel && (
        <>
          {/* Panel header */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px 12px',
            borderBottom: '1px solid rgba(255,255,255,0.07)',
            flexShrink: 0,
          }}>
            <span style={{ color: '#fff', fontFamily: 'monospace', fontSize: 14, letterSpacing: 2, fontWeight: 700 }}>
              {ICONS.find(i => i.id === activePanel)?.label.toUpperCase()}
            </span>
            <button
              onClick={closePanel}
              style={{
                background: 'none', border: 'none', color: '#888',
                cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 4,
              }}
              aria-label="Close panel"
            >
              ✕
            </button>
          </div>
          {/* Panel content */}
          <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
            <ActivePanel />
          </div>
        </>
      )}
    </motion.div>
  )}
</AnimatePresence>
```

- [ ] **Step 3: Remove the now-unused `ActivePanel` null check outside AnimatePresence**

The `const ActivePanel = activePanel ? PANEL_COMPONENTS[activePanel] : null` line stays. The `pointerEvents: activePanel ? 'auto' : 'none'` is now handled by AnimatePresence unmounting the element entirely.

- [ ] **Step 4: Run dev server and verify**

```bash
npm run dev
```

Open the game, press `I` — panel should spring in from the right. Press `Esc` — panel should spring out. No console errors.

- [ ] **Step 5: Commit**

```bash
git add src/ui/SidebarShell.tsx
git commit -m "feat: replace css panel transition with framer-motion spring"
```

---

## Task 3: TechTree React Flow graph view

**Files:**
- Modify: `src/ui/panels/TechTreePanel.tsx`

Add a "Graph View" toggle button. When active, render a React Flow canvas showing all 150 nodes laid out by tier (column = tier, row = position within tier), with edges drawn for prerequisites. The existing list view remains available as "List View".

- [ ] **Step 1: Add React Flow imports and CSS import**

At the top of `src/ui/panels/TechTreePanel.tsx`, add:

```typescript
import { ReactFlow, Background, Controls, type Node, type Edge, MarkerType } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
```

- [ ] **Step 2: Add the graph builder function**

Add this helper before the `TechTreePanel` component:

```typescript
const TIER_COLORS = [
  '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#1abc9c',
  '#3498db', '#9b59b6', '#e91e63', '#00bcd4', '#ff5722',
]

function buildTechFlowGraph(simSeconds: number): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = []
  const edges: Edge[] = []

  // Group nodes by tier to calculate y positions
  const byTier: TechNode[][] = Array.from({ length: 10 }, () => [])
  for (const n of TECH_NODES) byTier[n.tier].push(n)

  for (const node of TECH_NODES) {
    const researched = techTree.isResearched(node.id)
    const inProgress = techTree.isInProgress(node.id)
    const prereqsMet = node.prerequisites.every(p => techTree.isResearched(p))
    const available  = !researched && !inProgress && prereqsMet

    const idxInTier = byTier[node.tier].indexOf(node)
    const tierHeight = byTier[node.tier].length

    let bg = '#111'
    let border = '#333'
    if (researched)  { bg = 'rgba(46,204,113,0.15)';  border = '#2ecc71' }
    if (inProgress)  { bg = 'rgba(241,196,15,0.15)';  border = '#f1c40f' }
    if (available)   { bg = 'rgba(52,152,219,0.15)';  border = '#3498db' }

    nodes.push({
      id: node.id,
      position: {
        x: node.tier * 200,
        y: idxInTier * 70 - (tierHeight * 35),
      },
      data: {
        label: (
          <div style={{ fontSize: 10, fontFamily: 'monospace', textAlign: 'center' }}>
            <div style={{ fontWeight: 700, color: researched ? '#2ecc71' : inProgress ? '#f1c40f' : available ? '#3498db' : '#888' }}>
              {node.name}
              {researched && ' ✓'}
            </div>
            <div style={{ fontSize: 9, color: '#666', marginTop: 2 }}>{node.epCost} EP</div>
          </div>
        ),
      },
      style: {
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 6,
        padding: '6px 8px',
        minWidth: 120,
        cursor: available ? 'pointer' : 'default',
      },
    })

    for (const prereq of node.prerequisites) {
      edges.push({
        id: `${prereq}->${node.id}`,
        source: prereq,
        target: node.id,
        markerEnd: { type: MarkerType.ArrowClosed, color: '#444' },
        style: { stroke: researched ? '#2ecc71' : '#333', strokeWidth: 1 },
        animated: inProgress,
      })
    }
  }

  return { nodes, edges }
}
```

- [ ] **Step 3: Add view toggle state and graph view branch**

In `TechTreePanel`, add:
```typescript
const [graphView, setGraphView] = useState(false)
```

Add a toggle button at the top of the returned JSX, before the tier filter tabs:
```tsx
{/* View toggle */}
<div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
  <button
    onClick={() => setGraphView(false)}
    style={{
      fontSize: 10, padding: '3px 10px', borderRadius: 4, cursor: 'pointer',
      background: !graphView ? 'rgba(52,152,219,0.3)' : 'rgba(255,255,255,0.05)',
      border: `1px solid ${!graphView ? '#3498db' : '#333'}`,
      color: !graphView ? '#3498db' : '#888',
    }}
  >
    List
  </button>
  <button
    onClick={() => setGraphView(true)}
    style={{
      fontSize: 10, padding: '3px 10px', borderRadius: 4, cursor: 'pointer',
      background: graphView ? 'rgba(52,152,219,0.3)' : 'rgba(255,255,255,0.05)',
      border: `1px solid ${graphView ? '#3498db' : '#333'}`,
      color: graphView ? '#3498db' : '#888',
    }}
  >
    Graph
  </button>
</div>
```

- [ ] **Step 4: Add graph view branch in the return**

Wrap the existing tier list in a conditional. After the view toggle, add:

```tsx
{graphView ? (
  <div style={{ height: 500, width: '100%', borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
    <ReactFlow
      nodes={buildTechFlowGraph(simSeconds).nodes}
      edges={buildTechFlowGraph(simSeconds).edges}
      onNodeClick={(_, node) => handleResearch(node.id)}
      fitView
      colorMode="dark"
    >
      <Background color="#333" gap={20} />
      <Controls />
    </ReactFlow>
  </div>
) : (
  /* existing tier grid JSX stays here */
  ...
)}
```

- [ ] **Step 5: Run dev server, press T, toggle to Graph view**

Verify:
- Graph renders with nodes laid out by tier (tiers 0–9 as columns)
- Edges connect prerequisites to unlocked nodes
- Researched nodes are green, in-progress yellow, available blue, locked gray
- Clicking an available node starts research
- Controls (zoom in/out, fit) work

- [ ] **Step 6: Commit**

```bash
git add src/ui/panels/TechTreePanel.tsx
git commit -m "feat: add react flow graph view to tech tree panel"
```

---

## Task 4: Evolution React Flow graph view

**Files:**
- Modify: `src/ui/panels/EvolutionPanel.tsx`

Same pattern as TechTree — add a Graph View toggle. The evolution tree groups nodes by category, so lay them out with category as y-grouping and prerequisites as edges.

- [ ] **Step 1: Add React Flow imports**

```typescript
import { ReactFlow, Background, Controls, type Node, type Edge, MarkerType } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
```

- [ ] **Step 2: Add graph builder**

Add before `EvolutionPanel`:

```typescript
function buildEvoFlowGraph(ep: number): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = []
  const edges: Edge[] = []

  const categories = Array.from(new Set(EVOLUTION_NODES.map(n => n.category)))
  const byCategory: Record<string, EvolutionNode[]> = {}
  for (const cat of categories) {
    byCategory[cat] = EVOLUTION_NODES.filter(n => n.category === cat)
  }

  for (const node of EVOLUTION_NODES) {
    const unlocked   = evolutionTree.isUnlocked(node.id)
    const prereqsMet = node.prerequisites.every(p => evolutionTree.isUnlocked(p))
    const canAfford  = ep >= node.epCost
    const available  = !unlocked && prereqsMet

    const color = CATEGORY_COLORS[node.category]
    const catIdx = categories.indexOf(node.category)
    const idxInCat = byCategory[node.category].indexOf(node)

    let bg = 'rgba(255,255,255,0.03)'
    let border = '#333'
    if (unlocked)              { bg = `${color}22`; border = color }
    else if (available && canAfford) { bg = 'rgba(255,255,255,0.07)'; border = 'rgba(255,255,255,0.2)' }

    nodes.push({
      id: node.id,
      position: {
        x: catIdx * 190,
        y: idxInCat * 80,
      },
      data: {
        label: (
          <div style={{ fontSize: 10, fontFamily: 'monospace', textAlign: 'center' }}>
            <div style={{ fontWeight: 700, color: unlocked ? color : available ? '#ccc' : '#555' }}>
              {node.name}
              {unlocked && ' ✓'}
            </div>
            <div style={{ fontSize: 9, color: '#666', marginTop: 2 }}>{node.epCost} EP</div>
          </div>
        ),
      },
      style: {
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 6,
        padding: '6px 8px',
        minWidth: 110,
        opacity: !unlocked && (!prereqsMet || !canAfford) ? 0.4 : 1,
        cursor: available && canAfford ? 'pointer' : 'default',
      },
    })

    for (const prereq of node.prerequisites) {
      edges.push({
        id: `${prereq}->${node.id}`,
        source: prereq,
        target: node.id,
        markerEnd: { type: MarkerType.ArrowClosed, color: '#444' },
        style: { stroke: unlocked ? color : '#333', strokeWidth: 1 },
      })
    }
  }

  return { nodes, edges }
}
```

- [ ] **Step 3: Add toggle state + view toggle buttons + graph branch**

Same pattern as TechTreePanel:
1. Add `const [graphView, setGraphView] = useState(false)`
2. Add List/Graph toggle buttons after the EP balance display
3. Conditionally render graph or existing node grid:

```tsx
{graphView ? (
  <div style={{ height: 500, width: '100%', borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
    <ReactFlow
      nodes={buildEvoFlowGraph(epFromStore).nodes}
      edges={buildEvoFlowGraph(epFromStore).edges}
      onNodeClick={(_, node) => handleUnlock(node.id)}
      fitView
      colorMode="dark"
    >
      <Background color="#333" gap={20} />
      <Controls />
    </ReactFlow>
  </div>
) : (
  /* existing node grid stays here */
)}
```

- [ ] **Step 4: Run dev server, press E, toggle Graph view**

Verify:
- Nodes grouped visually by category (each category is a column)
- Edges show prerequisites
- Clicking an available+affordable node unlocks it
- EP balance updates after unlocking
- Locked/unavailable nodes are dimmed

- [ ] **Step 5: Commit**

```bash
git add src/ui/panels/EvolutionPanel.tsx
git commit -m "feat: add react flow graph view to evolution panel"
```

---

## Task 5: End-to-end panel smoke test

- [ ] **Step 1: Run dev server**

```bash
npm run dev
```

- [ ] **Step 2: Test each panel**

Open each panel with its hotkey and verify it renders without errors:

| Key | Panel | Check |
|-----|-------|-------|
| I | Inventory | 40-slot grid visible |
| C | Crafting | Recipe list visible |
| T | Tech Tree | List view + Graph view both work |
| E | Evolution | List view + Graph view both work |
| J | Journal | Empty state or entries visible |
| Tab | Character | Vitals, genome heatmap visible |
| M | Map | Canvas renders, player dot at center |
| Esc | Settings | Keybinds, logout button visible |

- [ ] **Step 3: Test panel animation**

Press `I` → panel springs in. Press `I` again → panel springs out. Press `Esc` while another panel is open → switches to Settings panel with spring animation.

- [ ] **Step 4: Test input blocking**

Open any panel → WASD should not move the player. Close panel → WASD moves normally.

- [ ] **Step 5: Commit (if any fixes were made during testing)**

```bash
git add -p
git commit -m "fix: panel smoke test fixes"
```

---

## Notes for the builder

- `@xyflow/react` requires its CSS to be imported: `import '@xyflow/react/dist/style.css'` — if styles look broken, this import is missing
- React Flow nodes need a `position` prop — the layout is manual (no auto-layout library needed for this plan)
- The `colorMode="dark"` prop on `<ReactFlow>` enables dark theme controls and background
- `buildTechFlowGraph` is called twice in the same render (once for nodes, once for edges in the same destructured call) — combine into one call: `const { nodes, edges } = buildTechFlowGraph(simSeconds)`
- framer-motion `AnimatePresence` requires the animated child to have a stable `key` — using `activePanel` as the key causes the panel to re-mount (and re-animate) when switching between panels, which gives a clean slide-out/slide-in effect

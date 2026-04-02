# Agent Team Session — Universe Sim

## Hierarchy

```
                        DIRECTOR (game-dev-director)
                               │
          ┌────────────────────┼────────────────────┐
     status-worker          gp-agent          knowledge-director
    (status site)        (game playtester)      (science lead)
                               │                      │
              ┌────────────────┼──────────┐    ┌──────┼──────┐
          ui-worker     interaction    ai-npc  physics chemistry biology
         (rendering)    (controls)   (NPC AI)   prof     prof     prof
```

Independent (report to Director):
- `cqa` — code quality auditor
- `car` — comprehensive app reporter

---

## Agents

| Agent ID            | Role                        | Key Files / Directories                  |
|---------------------|-----------------------------|------------------------------------------|
| `director`          | Game Dev Director — plans sprints, spawns agents | — |
| `status-worker`     | Status site maintenance     | `status-site/`                           |
| `gp-agent`          | Game Playtester — tests like a real player, no cheats | — |
| `knowledge-director`| Science lead — coordinates professors | — |
| `cqa`               | Code Quality Auditor        | repo-wide                                |
| `car`               | Comprehensive App Reporter  | `report.md`                              |
| `ui-worker`         | Rendering & visual polish   | `src/rendering/`                         |
| `interaction`       | Player controls & input     | `src/player/`, `src/game/`               |
| `ai-npc`            | NPC AI developer            | `src/ai/`                                |
| `physics-prof`      | Physics & sim workers       | `src/engine/workers/`                    |
| `chemistry-prof`    | Chemistry reactions         | `src/chemistry/`                         |
| `biology-prof`      | Genome, species, ecosystem  | `src/biology/`, `src/ecs/systems/`       |

---

## Communication Protocol

Each agent reports status via `reportStatus()`:

```typescript
import { reportStatus } from './src/utils/agentBus'

// On start
await reportStatus('biology-prof', 'active', 'Wiring genome to AnimalAISystem')

// Directed message to another agent
await reportStatus('chemistry-prof', 'active',
  'Finalizing acid reactions',
  'Acid rain ready — biology should update plant damage model',
  'biology-prof'
)

// On completion
await reportStatus('ui-worker', 'done', 'PostProcessing shipped')

// When blocked / needs user approval
await reportStatus('gp-agent', 'blocked', 'Cannot test — game crashes on spawn')
```

### Field reference

- `task` — short description of current work (shown on agent card)
- `message` — note for the feed (optional; use for handoffs or alerts)
- `to` — target agent ID for directed messages; omit for broadcast

---

## Inter-Agent Dependencies

```
physics-prof  ──────────────────────────► all agents (fluid/thermal primitives)
chemistry-prof ─────────────────────────► biology-prof (molecules → biochemistry)
biology-prof ───────────────────────────► knowledge-director (species → ecosystem)
knowledge-director ─────────────────────► director (science status)
ui-worker ──────────────────────────────► gp-agent (rendering → playtester validates)
gp-agent ───────────────────────────────► director (bug reports, friction points)
```

---

## File Ownership

| Pattern                      | Owner           |
|------------------------------|-----------------|
| `status-site/**`             | status-worker   |
| `src/rendering/**`           | ui-worker       |
| `src/ai/**`                  | ai-npc          |
| `src/chemistry/**`           | chemistry-prof  |
| `src/biology/**`             | biology-prof    |
| `src/ecs/systems/Animal*`    | biology-prof    |
| `src/engine/workers/**`      | physics-prof    |
| `src/civilization/**`        | (shared)        |
| `src/player/**`              | interaction     |
| `src/game/**`                | interaction     |
| `src/ui/**`                  | (shared)        |
| `src/store/**`               | (shared)        |

---

## Viewing Agent Activity

The companion status site shows the **Agent Control Center** panel with the 12-agent
hierarchy, walking Director character, speech bubbles, and live message feed.

The server URL is set via `VITE_WS_URL` in `.env.local`.

### Reporting status from Claude Code agents (terminal context)

Claude Code agents run in Node.js, not a browser — `import.meta.env` is unavailable.
Set one of these env vars so `reportStatus()` can reach the Railway server:

```bash
# Option A — same var as the status site
export VITE_WS_URL=wss://questions-production-63a2.up.railway.app

# Option B — plain HTTP URL
export AGENT_BUS_URL=https://questions-production-63a2.up.railway.app
```

Add either line to your shell profile or `.env.local`, or prefix your agent command:

```bash
AGENT_BUS_URL=https://questions-production-63a2.up.railway.app npx tsx your-agent.ts
```

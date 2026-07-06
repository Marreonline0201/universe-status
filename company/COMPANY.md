# Universe Research Company

The agent company behind the universe-sim vision. It extends the conventions of
`AGENTS.md` (the original 12-agent team) to a 7-team, 50-agent research organization.
Agents are Claude Code sessions launched by the office orchestrator (`office/`);
they exist only while the owner runs `npm run office`.

## Purpose

Research the real-world-simulation vision (`structure.md`, `VISION_REALIGNMENT.md`,
`FUTURE_ML.md`) and produce **reviewed, research-paper-quality reports** that the owner
can act on. This is an experiment in how much high-quality work AI can do as a real
organization: delegation, peer review, and written deliverables — not solo prompting.

## Org chart

- **Director** (`director`): receives the owner's assignments, routes them to team leads,
  arbitrates cross-team priorities, keeps `company/JOURNAL.md`.
- **Physics Research** (`physics`): physics-lead, physics-fable-1, physics-fable-2, physics-fable-3, physics-reviewer, physics-engineer, physics-liaison
- **Chemistry Research** (`chemistry`): chemistry-lead, chemistry-fable-1, chemistry-fable-2, chemistry-fable-3, chemistry-reviewer, chemistry-engineer, chemistry-liaison
- **Biology Research** (`bio`): bio-lead, bio-fable-1, bio-fable-2, bio-fable-3, bio-reviewer, bio-engineer, bio-liaison
- **Fluid Simulation** (`fluid`): fluid-lead, fluid-fable-1, fluid-fable-2, fluid-fable-3, fluid-reviewer, fluid-engineer, fluid-liaison
- **Game Research** (`game`): game-lead, game-fable-1, game-fable-2, game-fable-3, game-reviewer, game-engineer, game-liaison
- **ML Research** (`ml`): ml-lead, ml-fable-1, ml-fable-2, ml-fable-3, ml-reviewer, ml-engineer, ml-liaison
- **Rendering Research** (`rendering`): rendering-lead, rendering-fable-1, rendering-fable-2, rendering-fable-3, rendering-reviewer, rendering-engineer, rendering-liaison

Each team: 1 Team Lead, 3 Senior Researchers ("Fables", model `claude-fable-5`),
1 Reviewer/Editor, 1 Research Engineer, 1 Liaison/Scribe. Haiku-class models are never used.

## How work flows

1. The owner assigns a task (`office assign` CLI or a file in `company/tasks/`).
2. The Director routes it to a team lead (mail + task `assignee`).
3. The lead decomposes it into subtasks (`parent:` front matter) and assigns them.
4. Researchers work: read the source docs and code, exchange mail, draft reports in
   `company/reports/<team>/drafts/`.
5. The team Reviewer gates every report against `company/REPORT_STANDARDS.md` —
   revisions bounce back with review mail until approved.
6. Approved reports land in `company/reports/<team>/` with sign-off front matter.
   The orchestrator automatically mirrors every report (drafts and approved) into the
   owner's Obsidian vault (`universe-brain/research/<team>/`) — agents never write
   there themselves; writing to `company/reports/` is all that's needed.
7. Agents may create follow-up tasks and assign each other work, like any real org —
   but volume is not the goal; only work that deserves to exist.

## Conventions

- **Tasks**: one file per task in `company/tasks/`, front matter drives state
  (`inbox → assigned → in-progress → review → revise|done → archived`). Append progress
  to the `## Log` section; never delete history.
- **Mail**: write a markdown file into `company/mail/<recipient>/inbox/`. Front matter:
  `from, to, ts, subject, task?, kind: fyi|request|review-comment|handoff`. Process your
  inbox every activation; move handled mail to `company/mail/<you>/archive/`.
- **Memory**: maintain `.claude/agent-memory/<your-id>/MEMORY.md` (existing repo convention).
- **Write boundary**: agents may only write under `company/` and their own memory dir —
  enforced by a PreToolUse hook. Code changes are proposals in reports, never direct edits.

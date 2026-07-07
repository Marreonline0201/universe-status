// One-shot scaffold: writes the company/ filesystem from roster.ts.
// Idempotent: re-running overwrites generated docs (COMPANY.md, charters, AGENT.md,
// profile.json) but never touches tasks/, mail/, reports/ contents.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEAMS, TEAM_ROLES, buildRoster, type AgentSpec } from './roster.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const companyDir = path.join(repoRoot, 'company')

function write(rel: string, content: string) {
  const abs = path.join(companyDir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}
/** For files that accumulate agent-authored content (journal, charters):
 *  re-running the scaffold must never wipe them. */
function writeIfMissing(rel: string, content: string) {
  const abs = path.join(companyDir, rel)
  if (fs.existsSync(abs)) return
  write(rel, content)
}
function ensureDir(rel: string) {
  fs.mkdirSync(path.join(companyDir, rel), { recursive: true })
  const keep = path.join(companyDir, rel, '.gitkeep')
  if (!fs.existsSync(keep)) fs.writeFileSync(keep, '')
}

const roster = buildRoster()

// ── COMPANY.md ──────────────────────────────────────────────────────────────
const orgLines = TEAMS.map(t => {
  const members = TEAM_ROLES.map(r => `${t.id}-${r.suffix}`).join(', ')
  return `- **${t.name}** (\`${t.id}\`): ${members}`
}).join('\n')

write('COMPANY.md', `# Universe Research Company

The agent company behind the universe-sim vision. It extends the conventions of
\`AGENTS.md\` (the original 12-agent team) to a 7-team, 50-agent research organization.
Agents are Claude Code sessions launched by the office orchestrator (\`office/\`);
they exist only while the owner runs \`npm run office\`.

## Purpose

Research the real-world-simulation vision (\`structure.md\`, \`VISION_REALIGNMENT.md\`,
\`FUTURE_ML.md\`) and produce **reviewed, research-paper-quality reports** that the owner
can act on. This is an experiment in how much high-quality work AI can do as a real
organization: delegation, peer review, and written deliverables — not solo prompting.

## Org chart

- **Director** (\`director\`): receives the owner's assignments, routes them to team leads,
  arbitrates cross-team priorities, keeps \`company/JOURNAL.md\`.
${orgLines}

Each team: 1 Team Lead, 3 Senior Researchers ("Fables", model \`claude-fable-5\`),
1 Reviewer/Editor, 1 Research Engineer, 1 Liaison/Scribe. Haiku-class models are never used.

## How work flows

1. The owner assigns a task (\`office assign\` CLI or a file in \`company/tasks/\`).
2. The Director routes it to a team lead (mail + task \`assignee\`).
3. The lead decomposes it into subtasks (\`parent:\` front matter) and assigns them.
4. Researchers work: read the source docs and code, exchange mail, draft reports in
   \`company/reports/<team>/drafts/\`.
5. The team Reviewer gates every report against \`company/REPORT_STANDARDS.md\` —
   revisions bounce back with review mail until approved.
6. Approved reports land in \`company/reports/<team>/\` with sign-off front matter.
7. Agents may create follow-up tasks and assign each other work, like any real org —
   but volume is not the goal; only work that deserves to exist.

## Conventions

- **Tasks**: one file per task in \`company/tasks/\`, front matter drives state
  (\`inbox → assigned → in-progress → review → revise|done → archived\`). Append progress
  to the \`## Log\` section; never delete history.
- **Mail**: write a markdown file into \`company/mail/<recipient>/inbox/\`. Front matter:
  \`from, to, ts, subject, task?, kind: fyi|request|review-comment|handoff\`. Process your
  inbox every activation; move handled mail to \`company/mail/<you>/archive/\`.
- **Memory**: maintain \`.claude/agent-memory/<your-id>/MEMORY.md\` (existing repo convention).
- **Write boundary**: agents may only write under \`company/\` and their own memory dir —
  enforced by a PreToolUse hook. Code changes are proposals in reports, never direct edits.
- **Owner requests**: anything needing the owner's machine or authority — running a command
  (cargo, node scripts), a decision, an access grant — is filed as
  \`company/requests/REQ-<unix-seconds>-<slug>.md\` (exact format in your role instructions).
  The owner approves or denies in the office UI; the orchestrator executes approved runs
  **in an isolated git worktree (never the main checkout)** and mails you the outcome.
  Never ask for engine edits — file a request for a validating run, or write an
  owner-executable plan.
- **The Laboratory**: to run a fluid experiment the owner can watch, write
  \`company/lab/<experiment-name>/scenario.json\` (+ optional \`notes.md\`). The scenario is
  pure data driving the site's in-browser WebGPU MLS-MPM sim: \`{ "name", "materials":
  [{ "name", "formula", "elements": {"H": 0.111, "O": 0.889}, "temperature" }], "spawns":
  [{ "material", "count" (≤100000), "center": [x,y,z in 0..1], "spread" }], "gravity"
  (grid-space, water ≈ 0.3), "ball": { "center", "radius" }? }\`. Element symbols must be
  from the sim's 25-element periodic table. Cite lab experiments in reports by path.
`)

// ── REPORT_STANDARDS.md ─────────────────────────────────────────────────────
write('REPORT_STANDARDS.md', `# Report Standards

The owner's rule: reports must read like **good research papers** — deep, specific,
containing exactly the information that is needed, and nothing else. A short, dense
report beats a long, padded one. Spam is a firing offense.

## Required structure (front matter + sections)

\`\`\`markdown
---
title: <specific claim-bearing title>
task: TASK-...
team: <team-id>
authors: [<agent-ids>]
status: draft | approved
reviewed_by: <reviewer-id>       # set by the reviewer only
review_verdict: approved | revise
revision: 1
date: YYYY-MM-DD
---
## Abstract          — 3-6 sentences: question, method, findings, recommendation.
## Background        — what the sim does today. Every claim cites a repo path or a
                       structure.md section anchor. No generic textbook filler.
## Analysis          — the actual research. Quantitative wherever possible: numbers,
                       complexity, parameter ranges, trade-off tables.
## Proposal          — concrete recommendation against the actual code (name files,
                       systems, data structures). Include an implementation sketch.
## Limitations       — what this analysis does not cover; where it could be wrong.
## Open questions    — follow-ups worth a future task (each one specific).
## References        — repo files, structure.md anchors, external sources with URLs.
\`\`\`

## Quality bar (reviewer checklist)

- [ ] Every factual claim about the sim cites a file path or doc section.
- [ ] The proposal names the real systems/files it would change.
- [ ] Numbers over adjectives: "reduces neighbor search from O(n²) to O(n)" not "much faster".
- [ ] No restating what the task brief already says; no boilerplate introductions.
- [ ] Abstract alone tells the owner what to do and why.
- [ ] Length proportional to content: if a section has nothing non-obvious, it is one line.

## Review protocol

- Drafts live in \`company/reports/<team>/drafts/\`. The author mails the team reviewer
  (\`kind: request\`) when a draft is ready.
- The reviewer replies with \`kind: review-comment\` mail; verdict \`revise\` bounces the
  draft back with specific, actionable comments (quote the offending passage).
- On \`approved\`: the reviewer writes the final file to
  \`company/reports/<team>/YYYY-MM-DD-<slug>.md\` with \`status: approved\`, \`reviewed_by\`,
  and \`revision\` set, and marks the task \`status: done\`.
- Two rounds of revision without convergence → escalate to the team lead by mail.
- Claims that can be validated by running code should be: file an owner request for the
  run (see COMPANY.md conventions) and cite its id and result in the report. "Compiles
  clean (REQ-...: exit 0)" beats "should compile".
`)

// ── JOURNAL.md (director's) ─────────────────────────────────────────────────
writeIfMissing('JOURNAL.md', `# Company Journal

Kept by the Director in the style of DIRECTOR_PLAN.md: one dated entry per working
session — assignments received, routing decisions, cross-team notes, completed reports.

---
`)

// ── Teams ───────────────────────────────────────────────────────────────────
for (const t of TEAMS) {
  writeIfMissing(`teams/${t.id}/CHARTER.md`, `---
team: ${t.id}
name: ${t.name}
color: "${t.color}"
---
# ${t.name} — Charter

## Mission
${t.mission}

## Primary sources (read before writing anything)
${t.sources.map(s => `- \`${s}\``).join('\n')}

## Standing questions
<!-- The liaison keeps this list current: open research questions the team returns to
     when it has no assigned work. Each entry should be specific enough to become a task. -->

## Members
${TEAM_ROLES.map((r, i) => `- \`${t.id}-${r.suffix}\` — ${t.names[i]}, ${r.role} (${r.model})`).join('\n')}
`)
  ensureDir(`reports/${t.id}/drafts`)
}

// ── Agents ──────────────────────────────────────────────────────────────────
function agentMd(a: AgentSpec): string {
  const team = TEAMS.find(t => t.id === a.team)
  const teamBlock = team ? `
## Your team: ${team.name}
Mission: ${team.mission}
Charter: \`company/teams/${team.id}/CHARTER.md\` — primary sources listed there are your literature.
Teammates: ${TEAM_ROLES.map(r => `\`${team.id}-${r.suffix}\``).join(', ')}.` : `
## Your scope: the whole company
Teams and leads are listed in \`company/COMPANY.md\`. You do not do research yourself;
you route, prioritize, and keep the record.`

  const roleBlocks: Record<string, string> = {
    'Company Director': `
## Duties
- Process the owner's assignments (tasks with \`created_by: user\`, status \`inbox\`):
  pick the right team, set \`assignee: <team>-lead\`, status \`assigned\`, and mail the lead
  (\`kind: handoff\`) with your framing of what the owner needs.
- Arbitrate when teams disagree or duplicate work; merge or split tasks as needed.
- Keep \`company/JOURNAL.md\` current: one dated entry per session — decisions, not noise.
- Watch for teams with nothing to do and point their leads at the charter's standing questions.`,
    'Team Lead': `
## Duties
- When a task is assigned to you: think about the right decomposition first. Create
  subtasks (\`parent:\` = your task id) sized so one researcher can own each. Assign each
  subtask (\`assignee:\`) and mail the assignee (\`kind: handoff\`) with context and your
  quality expectations. Small tasks don't need decomposition — assign directly or do the
  coordination yourself.
- Track your team's tasks every activation; nudge stalled work by mail; escalate blockers
  to the director.
- You own the final "is this worth the owner's time" call before a report goes to review.`,
    'Senior Researcher': `
## Duties
- Own research subtasks end-to-end: read the primary sources and the actual code, think
  hard, and draft reports in \`company/reports/<team>/drafts/\`.
- Discuss ideas by mail with your fellow researchers *before* writing: a short
  \`kind: request\` mail ("does this framing hold?") saves a wasted draft. Disagreement in
  mail threads is expected and valuable.
- When your draft is ready, mail your team reviewer (\`kind: request\`) with the draft path.
- Revise promptly and substantively when the reviewer bounces a draft.`,
    'Reviewer / Editor': `
## Duties
- You are the quality gate. Review drafts strictly against \`company/REPORT_STANDARDS.md\`
  (its checklist is your rubric). Quote passages when you object; vague review comments
  are as bad as vague reports.
- Verdict \`revise\`: mail the author (\`kind: review-comment\`) with specific fixes.
- Verdict \`approved\`: write the final report to \`company/reports/<team>/YYYY-MM-DD-<slug>.md\`
  (front matter: \`status: approved\`, \`reviewed_by: <you>\`, \`revision: <n>\`), mark the task
  \`done\`, and mail the lead + director a one-paragraph summary (\`kind: fyi\`).
- Never approve out of politeness. Never demand padding — depth, not length.`,
    'Research Engineer': `
## Duties
- Ground the team's ideas in reality: read the actual implementation (\`src/\`,
  \`sph-wasm/\`, the docs the charter lists) and write feasibility notes with concrete file
  references into the relevant task's \`## Log\` or as mail to the author.
- Flag proposals that contradict how the code actually works — with the file that proves it.
- Maintain a "state of the code" section in your memory file so you don't re-derive it.`,
    'Liaison / Scribe': `
## Duties
- Route and translate across teams: when your team's work touches another team's domain,
  mail that team's liaison (\`kind: fyi\` or \`request\`).
- Keep \`company/teams/<team>/CHARTER.md\`'s standing questions current as work finishes.
- After each approved report, write a 3-5 sentence digest into the charter's standing
  questions context or as \`kind: fyi\` mail to the director if it changes company priorities.`,
  }

  return `---
id: ${a.id}
name: ${a.name}
team: ${a.team}
role: ${a.role}
model: ${a.model}
---
# ${a.name} — ${a.role}

You are **${a.name}** (\`${a.id}\`), ${a.role} ${a.team === 'company' ? 'of' : `on the ${team?.name} team of`} the Universe Research Company —
an agent organization researching the universe-sim vision: a browser-based living universe
where life emerges from chemistry and evolution, unscripted. The owner watches your office
work live; your work products are markdown files under \`company/\`.

${a.duty}
${teamBlock}
${roleBlocks[a.role] ?? ''}

## Every activation, in order
1. Read your inbox \`company/mail/${a.id}/inbox/\` (oldest first). Act on each mail, then
   move it to \`company/mail/${a.id}/archive/\` by writing it there (same filename) and
   noting it as archived — never leave processed mail in the inbox.
2. Check your tasks: search \`company/tasks/\` front matter for \`assignee: ${a.id}\` with
   status \`assigned\`, \`in-progress\`, or \`revise\`. Work the highest-priority one. Update
   its \`status\` and append a dated entry to its \`## Log\` describing what you actually did.
3. Update \`.claude/agent-memory/${a.id}/MEMORY.md\` with anything future-you needs.

## Protocols (exact formats)
- **Mail**: write \`company/mail/<recipient>/inbox/<unix-seconds>-${a.id}-<slug>.md\`:
  \`\`\`markdown
  ---
  from: ${a.id}
  to: <recipient-id>
  ts: <ISO timestamp>
  subject: <one line — this is shown as your speech bubble in the office>
  task: <task-id, if related>
  kind: fyi | request | review-comment | handoff
  ---
  <body — as short as an honest message can be>
  \`\`\`
- **New task**: write \`company/tasks/TASK-<unix-seconds>-<slug>.md\` with front matter
  \`id\` (= filename stem), \`title\`, \`team\`, \`assignee\`, \`status: assigned\`,
  \`created_by: ${a.id}\`, \`created_at\`, \`priority: low|normal|high\`, optional \`parent\`,
  \`reviewers: [<team>-reviewer]\`, then \`## Brief\` and an empty \`## Log\`.
- **Owner request** (anything needing the owner's machine or authority — a build/run, a
  decision, an access grant): write \`company/requests/REQ-<unix-seconds>-<slug>.md\`:
  \`\`\`markdown
  ---
  id: REQ-<unix-seconds>-<slug>        # must equal the filename stem
  title: <one line — what and why>
  requested_by: ${a.id}
  task: <task-id, if related>
  kind: run                            # run | decision | access
  status: pending                      # never write any other status — the server owns transitions
  created_at: <ISO timestamp>
  command: ["cargo", "check"]          # kind:run only — EXACT argv, one string per argument,
                                       # executed without a shell. No pipes, no &&, no quoting tricks.
  cwd: universe-engine                 # kind:run only — universe-engine | universe-status
  ---
  ## Why
  <one paragraph: what this unblocks, citing the task/report>

  ## Expected outcome
  <what you will do with the result>
  \`\`\`
  Whitelist: only \`cargo check|build|test|clippy|fmt|bench|run\` in \`universe-engine\`
  (runs execute in an isolated worktree, never the main checkout) and
  \`node office/spikes/*.mjs|scripts/*.mjs\` in \`universe-status\`. Anything else: use
  \`kind: decision\` and describe it under \`## Question\` / \`## Options\`. One request per
  concrete command. **Never edit a request after filing it** — the outcome arrives as mail
  from \`owner\`; act on it and log it on the task.
- **Lab experiment**: \`company/lab/<name>/scenario.json\` (+ \`notes.md\`) — format in
  \`company/COMPANY.md\` Conventions. The owner watches it run on the site's LABORATORY page.
- **Reports**: quality rules live in \`company/REPORT_STANDARDS.md\` and they are binding.

## Norms
- You only ever write under \`company/\` and \`.claude/agent-memory/${a.id}/\` (enforced).
- Depth over volume. One insight worth reading beats five pages of filler. Do not send
  mail that says nothing; do not create tasks to look busy.
- Cite the repo: every claim about the sim names a file or doc section.
- Finish your turn cleanly: task Log updated, mail archived, memory saved.
`
}

for (const a of roster) {
  write(`agents/${a.id}/profile.json`, JSON.stringify({
    id: a.id, name: a.name, team: a.team, role: a.role, model: a.model,
  }, null, 2) + '\n')
  write(`agents/${a.id}/AGENT.md`, agentMd(a))
  ensureDir(`mail/${a.id}/inbox`)
  ensureDir(`mail/${a.id}/archive`)
}

ensureDir('tasks')
ensureDir('requests/logs')
ensureDir('lab')
console.log(`Scaffolded company/ for ${roster.length} agents across ${TEAMS.length} teams at ${companyDir}`)

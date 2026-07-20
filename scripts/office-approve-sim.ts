// Multiple-choice approval verification. Run: npx tsx scripts/office-approve-sim.ts
// Drives the REAL Runner + store against a temp company dir. Asserts:
//   1. frontmatter `options:` parse; body "## Options" numbered-list fallback parse
//   2. approve WITHOUT a choice on a multi-option decision → refused
//   3. approve with an out-of-range choice → refused
//   4. approve with choice=2 → file gets chosen_option + Decision section with the
//      label, and the requester's inbox mail carries "Option 2: <label>"
//   5. plain (optionless) decision still approves bare
//   6. broken-YAML request → visible with parseError, approve refused cleanly
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Runner } from '../office/server/runner.ts'
import { loadRequests, resolvePaths } from '../office/server/store.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'office-approve-'))
for (const d of ['company/requests', 'company/mail', 'company/agents']) {
  fs.mkdirSync(path.join(tmp, d), { recursive: true })
}
const paths = resolvePaths(tmp)
const reqDir = path.join(tmp, 'company', 'requests')

let failures = 0
const check = (cond: boolean, label: string) => {
  console.log(`${cond ? 'ok ' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

fs.writeFileSync(path.join(reqDir, 'REQ-1-fm-options.md'), `---
id: REQ-1-fm-options
title: Which integrator should the motion core use?
requested_by: engine-lead
kind: decision
status: pending
options:
  - Velocity Verlet (symplectic, 1-ppm budget)
  - RK4 (higher order, not symplectic)
---
## Why
Pick one.
`)

fs.writeFileSync(path.join(reqDir, 'REQ-2-body-options.md'), `---
id: REQ-2-body-options
title: Which planet is real?
requested_by: director
kind: decision
status: pending
---
## Question
Which planet is real?

## Options

1. **The granite ball is real** — gravity is authoritative; the mesh is a skin.
2. **The soil shell is real** — the mesh is authoritative; gravity derives M.
3. **Both, deliberately** — decoupled with a divergence warning.

## Expected outcome
Answer flows to engine-lead.
`)

fs.writeFileSync(path.join(reqDir, 'REQ-3-plain.md'), `---
id: REQ-3-plain
title: May I archive the stale drafts?
requested_by: fluid-lead
kind: decision
status: pending
---
## Why
Simple yes/no.
`)

fs.writeFileSync(path.join(reqDir, 'REQ-4-broken.md'), `---
id: REQ-4-broken
title: An unquoted title with: a colon breaks YAML
requested_by: director
kind: decision
status: pending
---
Body.
`)

// ── parsing ─────────────────────────────────────────────────────────────────
const raws = loadRequests(paths)
const byId = new Map(raws.map(r => [r.id, r]))
check(byId.get('REQ-1-fm-options')?.options?.length === 2, 'store: frontmatter options parsed (2)')
const bodyOpts = byId.get('REQ-2-body-options')?.options
check(bodyOpts?.length === 3 && !!bodyOpts?.[0].startsWith('The granite ball is real'),
  `store: body "## Options" fallback parsed (got ${JSON.stringify(bodyOpts?.[0]?.slice(0, 30))}…)`)
check(byId.get('REQ-3-plain')?.options === null, 'store: optionless decision has options: null')
check(!!byId.get('REQ-4-broken')?.parseError, 'store: broken YAML stays visible with parseError')

// ── approval flows ──────────────────────────────────────────────────────────
const runner = new Runner(paths, tmp, undefined, { broadcast: () => {}, poke: () => {}, log: () => {} })

let r = runner.approve('REQ-2-body-options')
check(!r.ok && /pick one/.test(r.error ?? ''), `runner: approve without choice refused ("${r.error}")`)
r = runner.approve('REQ-2-body-options', 7)
check(!r.ok, 'runner: out-of-range choice refused')
r = runner.approve('REQ-2-body-options', 2, 'start light; revisit if play feels wrong')
check(r.ok, 'runner: approve with choice=2 + note succeeds')

const resolved = fs.readFileSync(path.join(reqDir, 'REQ-2-body-options.md'), 'utf8')
check(/chosen_option: 2/.test(resolved), 'file: chosen_option persisted in frontmatter')
check(/Option 2: The soil shell is real/.test(resolved), 'file: Decision section names the chosen option')
check(/start light; revisit/.test(resolved), 'file: owner note persisted')

const inboxDir = path.join(tmp, 'company', 'mail', 'director', 'inbox')
const mails = fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir) : []
const mailBody = mails.length ? fs.readFileSync(path.join(inboxDir, mails[0]), 'utf8') : ''
check(mails.length === 1 && /Option 2: The soil shell is real/.test(mailBody),
  'mail: requester inbox mail carries the chosen option')
check(/start light; revisit/.test(mailBody), 'mail: owner note travels with the decision')

r = runner.approve('REQ-3-plain')
check(r.ok, 'runner: plain decision still approves without a choice')

r = runner.approve('REQ-4-broken')
check(!r.ok && /broken frontmatter/.test(r.error ?? ''), `runner: broken-YAML approve refused cleanly (got ${JSON.stringify(r)})`)

const decorated = runner.list()
const planet = decorated.find(d => d.id === 'REQ-2-body-options')
check(planet?.chosenOption === 2 && planet?.options?.length === 3, 'decorate: options + chosenOption on the wire shape')

fs.rmSync(tmp, { recursive: true, force: true })
if (failures > 0) { console.error(`\n${failures} approval check(s) FAILED`); process.exit(1) }
console.log('\nOK — multiple-choice approvals parse, gate, persist, and mail the chosen option.')

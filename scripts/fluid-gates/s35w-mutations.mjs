#!/usr/bin/env node
// s35w-mutations.mjs — do s35i-ref's W checks catch real defects of the face counter-flux (flipRef.driftFlux pass 2,
// driftForm 'face')? Copies src/ to a temp dir (layout preserved: flipRef imports ../composition/*), applies ONE plausible
// bug to flipRef.ts per run, and runs `s35i-ref.mjs --only=W` against the copy (FLUID_REF_SRC = the copy's src root).
// Every mutant must make a W check fail; the unmutated copy (control) must pass. A find string that does not occur exactly
// once aborts. Verdicts: CAUGHT = a W check printed FAIL; SURVIVED = the gate's PASS verdict; INVALID = neither (a crash
// or timeout before any check failed — it tests nothing and is never counted as a catch).
//
//   node scripts/fluid-gates/s35w-mutations.mjs          (exit 0 = control passed AND every mutant caught)
//   node scripts/fluid-gates/s35w-mutations.mjs --check  (only verify the find strings against the working tree)
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const RULE = 'Jf[s2] = own === 0 || own === nA || t[s2] === FaceType.SOLID || !(W[s2] >= FACE_WEIGHT_MIN) || sf[s2] >= 1 ? 0 : Jf[s2] / W[s2]'
const LAST = '          this.drift[3 * q + a] = (dispersed[q] ? p.slip[3 * q + a] : 0) - j'
// [[find, replace], …], why — find strings are matched against the LF-normalised flipRef.ts
const M = [
  [[[RULE, 'Jf[s2] = !(W[s2] >= FACE_WEIGHT_MIN) || sf[s2] >= 1 ? 0 : Jf[s2] / W[s2]']], 'J not zeroed on the walls'],
  // the defect the first W run found (2026-09-30 01:50): the wall planes' ghost-layer edge faces are GHOST, not SOLID
  [[[RULE, 'Jf[s2] = t[s2] === FaceType.SOLID || !(W[s2] >= FACE_WEIGHT_MIN) || sf[s2] >= 1 ? 0 : Jf[s2] / W[s2]']], 'wall-plane edge faces not zeroed (SOLID only)'],
  [[[RULE, RULE.replace(' || !(W[s2] >= FACE_WEIGHT_MIN)', '')]], 'Σw < FACE_WEIGHT_MIN rule dropped'],
  [[[RULE, RULE.replace(': Jf[s2] / W[s2]', ': Jf[s2] / this.mass[a][s2]')]], 'denominator the face mass, not Σw'],
  [[['const st = stencil(L, a, p.pos[3 * q], p.pos[3 * q + 1], p.pos[3 * q + 2]), sa = p.slip[3 * q + a]', 'const st = stencil(L, a, p.pos[3 * q], p.pos[3 * q + 1], p.pos[3 * q + 2]), sa = p.slip[3 * q + (a + 1) % 3]']], 'numerator from the wrong axis\'s slip'],
  [[['if (st.w[m] !== 0) Jf[L.idx(st.i[m], st.j[m], st.k[m])] += st.w[m] * sa', 'if (st.w[m] !== 0) Jf[L.idx(st.i[m], st.j[m], st.k[m])] -= st.w[m] * sa']], 'numerator sign flipped'],
  [[['for (let m = 0; m < 8; m++) j += st.w[m] * Jf[L.idx(st.i[m], st.j[m], st.k[m])]', 'for (let m = 0; m < 8; m += 2) j += 2 * st.w[m] * Jf[L.idx(st.i[m], st.j[m], st.k[m])]']], 'J interpolated from half the stencil'],
  [[[LAST, '          this.drift[3 * q + a] = (dispersed[q] ? p.slip[3 * q + a] - j : 0)']], 'carriers not moved by −J'],
  [[[LAST, '          this.drift[3 * q + a] = 0 - j']], 'own slip dropped'],
  [[["if ((I.driftForm ?? 'face') === 'cell') {", 'if (true) {']], 'face form silently runs the cell form'],
]

const pristine = (await readFile(join(REPO, 'src/sim-ref/flipRef.ts'), 'utf8')).replace(/\r\n/g, '\n')
for (const [edits, why] of M) for (const [find] of edits) {
  const n = pristine.split(find).length - 1
  if (n !== 1) { console.error(`ABORT (${why}): find string occurs ${n}× in flipRef.ts: ${find.slice(0, 80)}`); process.exit(2) }
}
if (process.argv.includes('--check')) { console.log(`s35w mutants: all ${M.length} find strings match the working tree`); process.exit(0) }

const tmpRoot = await mkdtemp(join(tmpdir(), 's35w-mut-'))
async function runWith(label, edits) {
  const root = join(tmpRoot, label.replace(/[^a-z0-9]+/gi, '_')), src = join(root, 'src')
  await cp(join(REPO, 'src'), src, { recursive: true })
  if (edits) {
    let s = pristine
    for (const [find, repl] of edits) s = s.replace(find, repl)
    await writeFile(join(src, 'sim-ref', 'flipRef.ts'), s)
  }
  const r = spawnSync(process.execPath, [join(REPO, 'scripts/fluid-gates/s35i-ref.mjs'), '--only=W'], {
    cwd: REPO, env: { ...process.env, FLUID_REF_SRC: src.replaceAll('\\', '/') }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 600_000,
  })
  const out = r.stdout || ''
  const failed = out.split('\n').filter(l => l.startsWith('FAIL ')).map(l => l.split(' ')[1])
  const passed = /reference gate \(--only=W\): PASS/.test(out)
  return { code: r.status, passed, failed, verdict: failed.length ? 'CAUGHT' : passed ? 'SURVIVED' : 'INVALID', err: (r.stderr || '').split('\n').find(l => /Error/.test(l)) ?? '' }
}

const control = await runWith('control', null)
console.log(`CONTROL (unmutated copy): ${control.passed ? 'W PASS' : `W NOT passed (exit ${control.code}) ${control.failed.join(',')} ${control.err}`}`)
let caught = 0, invalid = 0
if (control.passed) {
  for (const [edits, why] of M) {
    const r = await runWith(why, edits)
    if (r.verdict === 'CAUGHT') caught++
    if (r.verdict === 'INVALID') invalid++
    console.log(`${r.verdict.padEnd(8)} ${why.padEnd(46)} failed: ${r.failed.join(',') || (r.err ? `(crash: ${r.err.slice(0, 80)})` : '-')}`)
  }
}
await rm(tmpRoot, { recursive: true, force: true })
console.log(`\ns35w mutations: ${caught}/${M.length} caught${invalid ? `, ${invalid} INVALID (no failed check: a crash is not a catch)` : ''}; control ${control.passed ? 'passed' : 'FAILED (results invalid)'}`)
process.exit(control.passed && caught === M.length ? 0 : 1)

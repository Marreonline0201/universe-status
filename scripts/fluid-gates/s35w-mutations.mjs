#!/usr/bin/env node
// s35w-mutations.mjs — do s35i-ref's W checks catch real defects of the face counter-flux (flipRef.driftFlux pass 2,
// driftForm 'face')? Copies src/ to a temp dir (layout preserved: flipRef imports ../composition/*), applies ONE
// plausible bug per run — to flipRef.ts, and for a PAIRED mutant the same bug to the gate's own oracle too — and runs a
// copy of `s35i-ref.mjs --only=W` against the src copy (FLUID_REF_SRC = the copy's src root). The gate copy differs from
// the repo's file only by its mutant edits and by importing lib/loadTs.mjs by absolute URL (it runs from the temp dir);
// the control runs such a copy too, so the mechanism itself is tested. Every mutant must make a W check fail; a paired
// one must fail the physical check it names (W4, W4m: W1–W3 derive from the rule, which the pair edits alike); the
// unmutated copies (control) must pass. A find string that does not occur exactly once in its file aborts. Verdicts:
// CAUGHT = a W check printed FAIL (for a paired mutant: one it names); MISSED = only checks it does not name failed;
// SURVIVED = the gate's PASS verdict; INVALID = none of these (a crash or timeout before any check failed — it tests
// nothing and is never counted as a catch).
//
// Equivalent mutants (review 2026-09-30, after flipRef's mirror clause): in the rule
//   own === 0 || own === nA || t[s2] === FaceType.SOLID || mirrorSolid || …
// each of the first three is implied by mirrorSolid — the in-plane mirror of a face whose transverse indices are in range
// is the face itself (SOLID is only ever written there: defaultFaceTypes, applyGate), and a window wall's ghost-layer
// edge face mirrors to that wall's SOLID face. Deleting one of them alone changes no J_f in any scene, so no test can see
// it. "Delete `t[s2] === FaceType.SOLID`" and the paired "drop `own === 0` / `own === nA` (and the oracle's `c[a] === 0`
// / `c[a] === nn[a]`)" are therefore listed in their effective form: the clause removed together with mirrorSolid's reach
// over the same faces (the literal deletions were run once, 2026-09-30, and survived with the control's output).
//
//   node scripts/fluid-gates/s35w-mutations.mjs          (exit 0 = control passed AND every mutant caught)
//   node scripts/fluid-gates/s35w-mutations.mjs --check  (only verify the find strings against the working tree)
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FILES = { ref: 'src/sim-ref/flipRef.ts', gate: 'scripts/fluid-gates/s35i-ref.mjs' }
const RULE = 'Jf[s2] = own === 0 || own === nA || t[s2] === FaceType.SOLID || mirrorSolid || !(W[s2] >= FACE_WEIGHT_MIN) || sf[s2] >= 1 ? 0 : Jf[s2] / W[s2]'
const WALLS = 'own === 0 || own === nA || t[s2] === FaceType.SOLID || mirrorSolid'
const LAST = '        for (const a of AXES) this.drift[3 * q + a] = (dispersed[q] ? p.slip[3 * q + a] : 0) - Jv[a]'
/** The gate's own oracle: its zero set's wall terms (s35i-ref wOracle), and the import the copy redirects. */
const ORULE = 'c[a] === 0 || c[a] === nn[a] || t[s2] === SOLID || (mirrorRule && ghostMirrorSolid)'
const IMPORT = "import { loadTsModules } from './lib/loadTs.mjs'"
const ref = (find, repl) => ['ref', find, repl], gate = (find, repl) => ['gate', find, repl]
// [[edit, …], why, need?] — edit = [file, find, replace], find matched against the LF-normalised file; need: a RegExp of
// the check labels a paired mutant must fail to count as CAUGHT
const M = [
  [[ref(RULE, 'Jf[s2] = !(W[s2] >= FACE_WEIGHT_MIN) || sf[s2] >= 1 ? 0 : Jf[s2] / W[s2]')], 'J not zeroed on the walls'],
  // the defect the first W run found (2026-09-30 01:50): the wall planes' ghost-layer edge faces are GHOST, not SOLID
  [[ref(RULE, 'Jf[s2] = t[s2] === FaceType.SOLID || !(W[s2] >= FACE_WEIGHT_MIN) || sf[s2] >= 1 ? 0 : Jf[s2] / W[s2]')], 'wall-plane edge faces not zeroed (SOLID only)'],
  [[ref(RULE, RULE.replace(' || !(W[s2] >= FACE_WEIGHT_MIN)', ''))], 'Σw = 0 guard dropped (0/0 → NaN)'],
  [[ref(RULE, RULE.replace(': Jf[s2] / W[s2]', ': Jf[s2] / this.mass[a][s2]'))], 'denominator the face mass, not Σw'],
  [[ref('const st = stencil(L, a, p.pos[3 * q], p.pos[3 * q + 1], p.pos[3 * q + 2]), sa = p.slip[3 * q + a]', 'const st = stencil(L, a, p.pos[3 * q], p.pos[3 * q + 1], p.pos[3 * q + 2]), sa = p.slip[3 * q + (a + 1) % 3]')], 'numerator from the wrong axis\'s slip'],
  [[ref('if (st.w[m] !== 0) Jf[L.idx(st.i[m], st.j[m], st.k[m])] += st.w[m] * sa', 'if (st.w[m] !== 0) Jf[L.idx(st.i[m], st.j[m], st.k[m])] -= st.w[m] * sa')], 'numerator sign flipped'],
  [[ref('for (let m = 0; m < 8; m++) j += st.w[m] * Jf[L.idx(st.i[m], st.j[m], st.k[m])]', 'for (let m = 0; m < 8; m += 2) j += 2 * st.w[m] * Jf[L.idx(st.i[m], st.j[m], st.k[m])]')], 'J interpolated from half the stencil'],
  [[ref(LAST, '        for (const a of AXES) this.drift[3 * q + a] = (dispersed[q] ? p.slip[3 * q + a] - Jv[a] : 0)')], 'carriers not moved by −J'],
  [[ref(LAST, '        for (const a of AXES) this.drift[3 * q + a] = 0 - Jv[a]')], 'own slip dropped'],
  [[ref("if ((I.driftForm ?? 'face') === 'cell') {", 'if (true) {')], 'face form silently runs the cell form'],
  // review 2026-09-30 (wf_c8d4ee53-cb7): #10 the threshold and the constant, #2/#7 the ball clause, #4/#2 the gate plane,
  // #1 the ball's ramp, #8 the paired mutants
  [[ref('!(W[s2] >= FACE_WEIGHT_MIN)', '!(W[s2] > 0)')], 'Σw < FACE_WEIGHT_MIN threshold → a bare Σw > 0 guard'],
  [[ref('export const FACE_WEIGHT_MIN = 1e-3', 'export const FACE_WEIGHT_MIN = 0.1')], 'FACE_WEIGHT_MIN 1e-3 → 0.1 (the constant)'],
  [[ref(RULE, RULE.replace(' || sf[s2] >= 1', ''))], 'J not zeroed inside the ball (S_f ≥ 1 dropped)'],
  [[ref(RULE, RULE.replace(' || mirrorSolid', ''))], 'gate plane\'s ghost-layer edges not zeroed (mirror dropped)'],
  // `t[s2] === FaceType.SOLID` deleted, effective form (above): mirrorSolid confined to GHOST faces, as its comment reads
  [[ref(RULE, RULE.replace(' || t[s2] === FaceType.SOLID || mirrorSolid', ' || (t[s2] === FaceType.GHOST && mirrorSolid)'))], 'interior SOLID faces (the gate\'s rows) not zeroed'],
  [[ref('const cut = (1 - Math.max(0, phi) / h) * jn', 'const cut = 0 * jn')], 'the ball\'s ramp dropped (J·n free at its surface)'],
  // PAIRED: `own === 0` / `own === nA` dropped in flipRef AND the oracle, effective form — one side's wall-plane edge faces
  // keep J in both, so W1–W3 agree by construction and only the two-sided W4 (both scenes) is left to see it
  [[ref(RULE, RULE.replace(WALLS, 'own === nA || t[s2] === FaceType.SOLID || (own !== 0 && mirrorSolid)')),
    gate(ORULE, 'c[a] === nn[a] || t[s2] === SOLID || (mirrorRule && c[a] !== 0 && ghostMirrorSolid)')], 'PAIRED: the lower planes\' edge faces keep J', /^W4/],
  [[ref(RULE, RULE.replace(WALLS, 'own === 0 || t[s2] === FaceType.SOLID || (own !== nA && mirrorSolid)')),
    gate(ORULE, 'c[a] === 0 || t[s2] === SOLID || (mirrorRule && c[a] !== nn[a] && ghostMirrorSolid)')], 'PAIRED: the upper planes\' edge faces keep J', /^W4/],
]

const pristine = {}
for (const [k, f] of Object.entries(FILES)) pristine[k] = (await readFile(join(REPO, f), 'utf8')).replace(/\r\n/g, '\n')
const occurs = (k, find) => pristine[k].split(find).length - 1
if (occurs('gate', IMPORT) !== 1) { console.error(`ABORT: the loadTs import occurs ${occurs('gate', IMPORT)}× in ${FILES.gate}`); process.exit(2) }
const perFile = { ref: 0, gate: 0 }
for (const [edits, why] of M) for (const [k, find] of edits) {
  const n = occurs(k, find)
  if (n !== 1) { console.error(`ABORT (${why}): find string occurs ${n}× in ${FILES[k]}: ${find.slice(0, 80)}`); process.exit(2) }
  perFile[k]++
}
if (process.argv.includes('--check')) { console.log(`s35w mutants: all ${M.length} mutants' find strings match the working tree (${perFile.ref} in flipRef.ts, ${perFile.gate} in s35i-ref.mjs; the gate's loadTs import once)`); process.exit(0) }

const LOADTS = pathToFileURL(join(REPO, 'scripts/fluid-gates/lib/loadTs.mjs')).href
const tmpRoot = await mkdtemp(join(tmpdir(), 's35w-mut-'))
async function runWith(label, edits, need) {
  const root = join(tmpRoot, label.replace(/[^a-z0-9]+/gi, '_')), src = join(root, 'src'), gateCopy = join(root, 's35i-ref.mjs')
  await cp(join(REPO, 'src'), src, { recursive: true })
  const text = { ...pristine }
  for (const [k, find, repl] of edits ?? []) text[k] = text[k].replace(find, () => repl)
  if (text.ref !== pristine.ref) await writeFile(join(src, 'sim-ref', 'flipRef.ts'), text.ref)
  await writeFile(gateCopy, text.gate.replace(IMPORT, () => `import { loadTsModules } from '${LOADTS}'`))
  const r = spawnSync(process.execPath, [gateCopy, '--only=W'], {
    cwd: REPO, env: { ...process.env, FLUID_REF_SRC: src.replaceAll('\\', '/') }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 600_000,
  })
  const out = r.stdout || ''
  const failed = out.split('\n').filter(l => l.startsWith('FAIL ')).map(l => l.split(' ')[1])
  const passed = /reference gate \(--only=W\): PASS/.test(out)
  const verdict = failed.length ? (!need || failed.some(f => need.test(f)) ? 'CAUGHT' : 'MISSED') : passed ? 'SURVIVED' : 'INVALID'
  return { code: r.status, passed, failed, verdict, err: (r.stderr || '').split('\n').find(l => /Error/.test(l)) ?? '' }
}

const control = await runWith('control', null)
console.log(`CONTROL (unmutated copies): ${control.passed ? 'W PASS' : `W NOT passed (exit ${control.code}) ${control.failed.join(',')} ${control.err}`}`)
let caught = 0, invalid = 0, missed = 0
if (control.passed) {
  for (const [edits, why, need] of M) {
    const r = await runWith(why, edits, need)
    if (r.verdict === 'CAUGHT') caught++
    if (r.verdict === 'INVALID') invalid++
    if (r.verdict === 'MISSED') missed++
    console.log(`${r.verdict.padEnd(8)} ${why.padEnd(58)} failed: ${r.failed.join(',') || (r.err ? `(crash: ${r.err.slice(0, 80)})` : '-')}${need ? `  (must include ${need.source})` : ''}`)
  }
}
await rm(tmpRoot, { recursive: true, force: true })
console.log(`\ns35w mutations: ${caught}/${M.length} caught${invalid ? `, ${invalid} INVALID (no failed check: a crash is not a catch)` : ''}${missed ? `, ${missed} MISSED (a paired mutant its physical check did not see)` : ''}; control ${control.passed ? 'passed' : 'FAILED (results invalid)'}`)
process.exit(control.passed && caught === M.length ? 0 : 1)

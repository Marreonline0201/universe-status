#!/usr/bin/env node
// s38-mutations.mjs — do s38-ref's checks catch real defects of the floor's wall shear (flipRef options.wallShear:
// applyWallShear, keuleganTau and the guard in step())? FRICTION-spec rev 2 §4 W3's CPU table: every mutant must be
// CAUGHT by the checks the table names. Copies src/ to a temp dir (layout preserved: flipRef imports
// ../composition/*), applies ONE find/replace per run to flipRef.ts — the find string matched against the LF-normalised
// file; one that does not occur exactly once aborts — and runs `s38-ref.mjs --only=<the sections of the named checks>`
// against the copy (FLUID_REF_SRC = the copy's src root). The control runs EVERY section on an unmutated copy.
// Attribution (a check catches a mutant only if it flips): a line counts only where it PASSED in the control run; a
// line that FAILED or printed VOID in the control (s38-ref prints a check VOID when its scene failed its own validity
// check: uncertified, neither pass nor fail) is UNUSABLE for every mutant and never counted as a catch. A named check is
// the table's, never renamed: it CATCHES a mutant when ≥ 1 of its lines flips and none of its lines is unusable — a
// check with an unusable line (W1c while W1c.z is VOID: the table's W1c is the x AND the z sheet) demonstrates only
// part of the table's claim, so it cannot make the mutant CAUGHT. Hence, while s38-ref's W1c.z is VOID (its control's
// drift failed W1cvalid.z — see s38-ref's revision note), every mutant the table attributes to W1c (option ignored,
// sign flipped, τ×2) or to its z sheet (z-component ignored) is PARTIAL at best: the honest verdict, reported as such.
// Verdicts: CAUGHT = every named check caught it; PARTIAL = some named check did, another passed or is (partly)
// unusable (the table's claim does not hold, or cannot be shown, for it — reported, never hidden); MISSED = only checks
// the table does not name flipped; SURVIVED = nothing flipped; INVALID = the run ended without its verdict line (a crash
// or a timeout) before every named check caught it — it tests nothing and is never counted as a catch. Exit 0 only if
// the control passed EVERY check (no FAIL, no VOID) and every mutant is CAUGHT.
//
// Named checks are s38-ref labels or label groups (a group names every label `<group>.…`): W0a, W0b, W0b.force, W1a,
// W1aK, W1aK.6 (the energy check), W1b, W1b.lam, W1b.scan, W1c (the losses and non-vacuity, x and z), W1c.z, W1d(i),
// W1d(ii). W1c's validity lines (W1cvalid.*) are named by no mutant.
// Not here: W1d's G1 control (placement on the grid) is a subclass inside s38-ref (ctl:W1d.G1), so flipRef carries no
// gate-only placement code; the spec's GPU mutant (per-frame placement) belongs to gpu-mutations.mjs.
// ADDED to the spec's table: "the viscous-solve clause of the guard removed" (named W0b.force, s38-ref's added arm):
// with olive oil both clauses of the guard are true, so the table's W0b arms cannot see either clause alone.
// Choices the table leaves open, fixed here: "option ignored" = the constructor drops options.wallShear (the stage
// never runs; W1a/W1aK call applyWallShear directly and would throw on it — a crash is not a catch — so it runs W1c
// only, as the table names); "stage runs when absent" = a keulegan1938 default; "ν := μ" inside keuleganTau (every ν of
// the law is ρν = μ — the check the table names, W1b, calls the law directly); "rows 0–1 binning" moves the floor-row
// test itself to rows 0–1 (binning and application: the prototype's 18 off-row particles); "Δv on rows 0–1" keeps the
// row-0 binning and applies Δv to rows 0 and 1; "3-D |U|" counts v_y in |U| only.
// Equivalent mutant (documented, run with --equivalent, expected SURVIVED): max(τ_turb, τ_lam) in place of the Re_h rule
// written literally, with the stage's own Newton from u* = U/25. Below Re_h ≈ 2.77 that start lies under the monotone
// range (h⁺ < e^−2.2), every iterate is halved toward 0 and τ_turb → 0, so max() returns the film exactly where the rule
// does; it could differ from the rule only below Re_h = 0.0329, where eq. 32's root is never reached. The table's mutant
// is its effective form: max() with a Newton that reaches that root (started at max(U/25, ν/h); then W1b.scan sees 303×).
//
//   node scripts/fluid-gates/s38-mutations.mjs               (exit 0 = control passed every check AND every mutant caught)
//   node scripts/fluid-gates/s38-mutations.mjs --check       (only verify the find strings against the working tree)
//   node scripts/fluid-gates/s38-mutations.mjs --equivalent  (the documented equivalent mutant; exit 0 = it SURVIVED)
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REF = 'src/sim-ref/flipRef.ts'
const pristine = (await readFile(join(REPO, REF), 'utf8')).replace(/\r\n/g, '\n')
/** `text` with `a` (which must occur exactly once in it) replaced by `b` — for building a mutant from a longer find. */
function sub(text, a, b) {
  const n = text.split(a).length - 1
  if (n !== 1) { console.error(`ABORT: an inner edit's find string occurs ${n}× (${a.slice(0, 60)})`); process.exit(2) }
  return text.replace(a, () => b)
}
/** The text of the file from `a` (inclusive) to the end of `b`'s first occurrence after it. */
function span(a, b) {
  const i = pristine.indexOf(a), j = pristine.indexOf(b, i)
  if (i < 0 || j < 0) { console.error(`ABORT: span ${a.slice(0, 40)} … ${b.slice(0, 40)} not found`); process.exit(2) }
  return pristine.slice(i, j + b.length)
}

// the stage's lines (flipRef.ts, the working tree's uncommitted stage)
const OPT = '    this.wallShear = opts.wallShear ?? null\n'
const GUARD = 'if (this.wallShear && !(this.projection && this.viscosityRuns(p)) && !this.anyViscousLiquid(p)) this.applyWallShear(p, dt)'
const DV = 'dvx[c] = -Ux * a / (1 + a); dvz[c] = -Uz * a / (1 + a)'
const AC = 'const a = dt * tau * h * h / (M[c] * U)'
const APPLY = 'p.vel[3 * q] += dvx[c]; p.vel[3 * q + 2] += dvz[c]'
const VP = 'vp = h ** 3 / this.ppc, nx = L.nx, nz = L.nz, NC = nx * nz'
const HC = 'hc = Math.min(h, Vc / (h * h)), rho = M[c] / Vc'
const ROW = 'const onFloorRow = (q: number) => Math.floor(p.pos[3 * q + 1] / h) === 0'
const APPLY_ROW = '      if (!onFloorRow(q)) continue\n      const c = cellOf(q)\n'
const UC = 'const Ux = Px[c] / M[c], Uz = Pz[c] / M[c], U = Math.hypot(Ux, Uz)'
const NUC = 'const muC = MU[c] / M[c], nuC = muC / rho'
const BIN = span('    const M = new Float64Array(NC), Nc = new Uint32Array(NC)', UC)
// the law (keuleganTau)
const ZERO = '  if (!(U > 0) || !(h > 0)) return { tau: 0, ustar: 0, laminar: true }\n'
const LAM = '  if (U * h / nu < WALL_SHEAR_RE_CROSS) { const tau = 3 * rho * nu * U / h; return { tau, ustar: Math.sqrt(tau / rho), laminar: true } }\n'
const START = '  let us = U / 25\n'
const NEWTON_L = 'const L = KEULEGAN_AS - KEULEGAN_B + KEULEGAN_B * Math.log(h * us / nu), g = us * L - U, dg = L + KEULEGAN_B'
const TURB = 'return { tau: rho * us * us, ustar: us, laminar: false }'
const BODY = span(LAM, TURB)
const MAXRET = 'const tT = rho * us * us, tL = 3 * rho * nu * U / h\n  return tL >= tT ? { tau: tL, ustar: Math.sqrt(tL / rho), laminar: true } : { tau: tT, ustar: us, laminar: false }'

// [why, find, replace, named checks] — the spec's §4 W3 CPU table, in its order, then the addition
const M = [
  ['option ignored (the stage never runs)', OPT, '    this.wallShear = null\n', ['W1c']],
  ['stage runs when the option is absent', OPT, "    this.wallShear = opts.wallShear ?? { wall: 'y-', law: 'keulegan1938' }\n", ['W0a']],
  ['viscous guard removed', GUARD, 'if (this.wallShear) this.applyWallShear(p, dt)', ['W0b']],
  ['sign flipped', DV, 'dvx[c] = Ux * a / (1 + a); dvz[c] = Uz * a / (1 + a)', ['W1a', 'W1aK', 'W1c', 'W1d(i)', 'W1aK.6']],
  ['τ×2', AC, 'const a = dt * 2 * tau * h * h / (M[c] * U)', ['W1a', 'W1aK', 'W1c', 'W1d(i)']],
  ['turbulent τ = 2ρu*² (kx2)', TURB, 'return { tau: 2 * rho * us * us, ustar: us, laminar: false }', ['W1aK', 'W1b']],
  ['explicit update', DV, 'dvx[c] = -Ux * a; dvz[c] = -Uz * a', ['W1a']],
  ['Δv on every second particle', APPLY, `if (q % 2 === 0) { ${APPLY} }`, ['W1a']],
  ['V_p = dx³ in V_c', VP, 'vp = h ** 3, nx = L.nx, nz = L.nz, NC = nx * nz', ['W1a']],
  ['h_c := dx', HC, 'hc = h, rho = M[c] / Vc', ['W1aK']],
  ['floor row taken as y < dx/2', ROW, 'const onFloorRow = (q: number) => p.pos[3 * q + 1] < h / 2', ['W1aK', 'W1d(ii)']],
  ['floor row taken as rows 0–1 (binning)', ROW, 'const onFloorRow = (q: number) => Math.floor(p.pos[3 * q + 1] / h) <= 1', ['W1aK']],
  ['Δv applied to rows 0–1', APPLY_ROW, '      if (Math.floor(p.pos[3 * q + 1] / h) > 1) continue\n      const c = cellOf(q)\n', ['W1aK', 'W1d(ii)']],
  ['3-D |U| (v_y counted)', BIN, sub(sub(sub(BIN, 'MU = new Float64Array(NC)', 'MU = new Float64Array(NC), Py = new Float64Array(NC)'),
    'Pz[c] += m * p.vel[3 * q + 2];', 'Pz[c] += m * p.vel[3 * q + 2]; Py[c] += m * p.vel[3 * q + 1];'), 'U = Math.hypot(Ux, Uz)', 'U = Math.hypot(Ux, Py[c] / M[c], Uz)'), ['W1aK']],
  ['v_p *= f per particle', APPLY, '{ const ux = Px[c] / M[c], uz = Pz[c] / M[c], u2 = ux * ux + uz * uz, fm1 = u2 > 0 ? (dvx[c] * ux + dvz[c] * uz) / u2 : 0; p.vel[3 * q] *= 1 + fm1; p.vel[3 * q + 2] *= 1 + fm1 }', ['W1aK']],
  ['ρ_ref instead of ρ_c', HC, 'hc = Math.min(h, Vc / (h * h)), rho = this.density', ['W1aK']],
  ['per-cell μ ignored (constant ν)', NUC, 'const muC = MU[c] / M[c], nuC = this.viscosityDefault / this.density', ['W1aK']],
  ['z-component ignored', UC, 'const Ux = Px[c] / M[c], Uz = 0, U = Math.abs(Ux)', ['W1c.z', 'W1aK']],
  ['b = 5.75 used with ln', NEWTON_L, 'const L = KEULEGAN_AS - KEULEGAN_B + 5.75 * Math.log(h * us / nu), g = us * L - U, dg = L + 5.75', ['W1b']],
  ['h⁺ < 11.5 switch', BODY, sub(sub(BODY, LAM, ''), TURB, 'if (!(h * us / nu >= 11.5)) { const tau = 3 * rho * nu * U / h; return { tau, ustar: Math.sqrt(tau / rho), laminar: true } }\n  ' + TURB), ['W1b.lam']],
  ['max() in place of the Re_h rule (effective form)', BODY, sub(sub(sub(BODY, LAM, ''), START, '  let us = Math.max(U / 25, nu / h)\n'), TURB, MAXRET), ['W1b.scan']],
  ['ν := μ (in the law)', ZERO, '  nu = rho * nu\n' + ZERO, ['W1b']],
  ['laminar branch dropped', LAM, '', ['W1b.lam']],
  ['ADDED: the viscous-solve clause of the guard removed', GUARD, 'if (this.wallShear && !this.anyViscousLiquid(p)) this.applyWallShear(p, dt)', ['W0b.force']],
]
const EQUIV = [
  ['max() in place of the Re_h rule, literally (the stage\'s Newton from U/25)', BODY, sub(sub(BODY, LAM, ''), TURB, MAXRET), ['W1b.scan']],
]

for (const [why, find, repl] of [...M, ...EQUIV]) {
  const n = pristine.split(find).length - 1
  if (n !== 1) { console.error(`ABORT (${why}): find string occurs ${n}× in ${REF}: ${find.slice(0, 80)}`); process.exit(2) }
  if (repl === find) { console.error(`ABORT (${why}): the replacement equals the find string`); process.exit(2) }
}
if (process.argv.includes('--check')) { console.log(`s38 mutants: all ${M.length} mutants' (and ${EQUIV.length} documented equivalent) find strings occur exactly once in ${REF}`); process.exit(0) }

const EQ = process.argv.includes('--equivalent'), LIST = EQ ? EQUIV : M
const SECTION = g => g.match(/^(W0a|W0b|W1aK|W1a|W1b|W1c|W1d)(?![A-Za-z])/)?.[1]
for (const [why, , , need] of LIST) for (const g of need) if (!SECTION(g)) { console.error(`ABORT (${why}): named check ${g} is in no s38-ref section`); process.exit(2) }
const matches = (label, g) => label === g || label.startsWith(g + '.')
const tmpRoot = await mkdtemp(join(tmpdir(), 's38-mut-'))
async function runGate(label, edit, sections) {
  const root = join(tmpRoot, label.replace(/[^a-z0-9]+/gi, '_').slice(0, 60)), src = join(root, 'src')
  await cp(join(REPO, 'src'), src, { recursive: true })
  if (edit) await writeFile(join(src, 'sim-ref', 'flipRef.ts'), pristine.replace(edit[0], () => edit[1]))
  const r = spawnSync(process.execPath, [join(REPO, 'scripts/fluid-gates/s38-ref.mjs'), `--only=${sections.join(',')}`], {
    cwd: REPO, env: { ...process.env, FLUID_REF_SRC: src.replaceAll('\\', '/') }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 3_600_000,
  })
  await rm(root, { recursive: true, force: true })
  const lines = (r.stdout || '').split('\n'), results = new Map()   // label → 'PASS' | 'FAIL' | 'VOID' (a FAIL is sticky)
  for (const l of lines) { const m = l.match(/^(PASS|FAIL|VOID) (\S+) /); if (m) results.set(m[2], results.get(m[2]) === 'FAIL' ? 'FAIL' : m[1]) }
  const verdict = lines.find(l => /^s3\.8 reference gate/.test(l)) ?? ''
  return { code: r.status, results, completed: verdict !== '', passed: /: PASS(\s|;|$)/.test(verdict), verdict, err: (r.stderr || '').split('\n').find(l => /Error/.test(l)) ?? (r.error ? String(r.error.code ?? r.error) : '') }
}

const allSections = [...new Set(LIST.flatMap(([, , , need]) => need.map(SECTION)))]
const order = ['W0a', 'W0b', 'W1a', 'W1aK', 'W1b', 'W1c', 'W1d']
const ctlSections = EQ ? order.filter(s => allSections.includes(s)) : order
const t0 = Date.now()
const control = await runGate('control', null, ctlSections)
const ctlFailed = [...control.results].filter(([, v]) => v === 'FAIL').map(([k]) => k)
const ctlVoid = [...control.results].filter(([, v]) => v === 'VOID').map(([k]) => k)
const ctlOk = control.completed && control.passed && ctlFailed.length === 0 && ctlVoid.length === 0
console.log(`CONTROL (unmutated copy, --only=${ctlSections.join(',')}): ${ctlOk ? `every check PASS (${control.results.size} lines)` : !control.completed ? `did NOT complete (exit ${control.code}) ${control.err}` : `NOT every check passed — failed in the control: ${ctlFailed.join(', ') || '-'}; VOID in the control: ${ctlVoid.join(', ') || '-'} (all unusable as catches; the gate's own verdict: ${control.verdict.trim()})`}`)
const tally = { CAUGHT: 0, PARTIAL: 0, MISSED: 0, SURVIVED: 0, INVALID: 0 }
if (control.completed) {
  for (const [why, find, repl, need] of LIST) {
    const sections = order.filter(s => need.some(g => SECTION(g) === s))
    const r = await runGate(why, [find, repl], sections)
    // a named check's lines are the control's (it ran every section): usable = PASS there; unusable = FAIL or VOID there
    const groups = need.map(g => {
      const members = [...control.results.keys()].filter(l => !l.startsWith('ctl:') && matches(l, g))
      const usable = members.filter(l => control.results.get(l) === 'PASS'), unusable = members.filter(l => control.results.get(l) !== 'PASS')
      const hit = usable.filter(l => r.results.get(l) === 'FAIL'), missing = usable.filter(l => !r.results.has(l))
      const state = !members.length ? 'not in the control' : hit.length ? (unusable.length ? 'FAIL-part' : 'FAIL') : !usable.length ? 'unusable' : missing.length ? 'absent' : 'pass'
      return { g, state, hit, unusable }
    })
    const flipped = [...r.results].filter(([l, v]) => v === 'FAIL' && control.results.get(l) === 'PASS').map(([l]) => l)
    const named = new Set(groups.flatMap(x => x.hit)), others = flipped.filter(l => !named.has(l))
    const verdict = groups.every(x => x.state === 'FAIL') ? 'CAUGHT' : !r.completed ? 'INVALID' : groups.some(x => x.state === 'FAIL' || x.state === 'FAIL-part') ? 'PARTIAL' : flipped.length ? 'MISSED' : 'SURVIVED'
    tally[verdict]++
    const say = x => x.state === 'FAIL' ? `FAIL (${x.hit.join(' ')})` : x.state === 'FAIL-part' ? `FAIL (${x.hit.join(' ')}) but ${x.unusable.join(' ')} unusable (${x.unusable.map(l => control.results.get(l)).join('/')} in the control): not shown` : x.state === 'unusable' ? `unusable (${x.unusable.map(l => `${l} ${control.results.get(l)}`).join(', ')} in the control)` : x.state
    console.log(`${verdict.padEnd(8)} ${why.padEnd(52)} named: ${groups.map(x => `${x.g} ${say(x)}`).join('; ')}${others.length ? ` | also flipped: ${others.join(' ')}` : ''}${r.completed ? '' : ` | run did not complete: exit ${r.code} ${r.err.slice(0, 100)}`}`)
  }
}
await rm(tmpRoot, { recursive: true, force: true })
const minutes = ((Date.now() - t0) / 60000).toFixed(1)
if (EQ) {
  console.log(`\ns38 equivalent mutants: ${tally.SURVIVED}/${LIST.length} survived as documented; control ${ctlOk ? 'passed' : control.completed ? 'did not pass every check' : 'did not complete'}  (${minutes} min)`)
  process.exit(control.completed && ctlOk && tally.SURVIVED === LIST.length ? 0 : 1)
}
console.log(`\ns38 mutations: ${tally.CAUGHT}/${LIST.length} caught${['PARTIAL', 'MISSED', 'SURVIVED', 'INVALID'].filter(k => tally[k]).map(k => `, ${tally[k]} ${k}`).join('')}; control ${ctlOk ? 'passed every check' : control.completed ? `did NOT pass every check (${[...ctlFailed.map(l => `${l} FAIL`), ...ctlVoid.map(l => `${l} VOID`)].join(', ')})` : 'did not complete (results invalid)'}  (${minutes} min)`)
process.exit(ctlOk && tally.CAUGHT === LIST.length ? 0 : 1)

#!/usr/bin/env node
// s34g-mutations.mjs — does s34-ref's A2g-mech catch real defects of FlipRef's dam-break gate (options.gate)? Copies
// src/ to a temp dir (layout preserved: flipRef imports ../composition/liquidGate), applies ONE plausible bug to
// flipRef.ts per run, and runs `s34-ref.mjs --only=A2gmech` against the copy (FLUID_REF_SRC). Every mutant must make
// A2g-mech fail; the unmutated copy (control) must pass it. A find string that does not occur exactly once aborts.
// A mutant that SURVIVES is reported, never hidden: it names a part of the gate no check exercises. A run that prints
// no A2g-mech line (a crash) is INVALID, never a catch.
//
//   node scripts/fluid-gates/s34g-mutations.mjs          (exit 0 = control passed AND every mutant caught)
//   node scripts/fluid-gates/s34g-mutations.mjs --check  (only verify the find strings against the working tree)
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
// [[find, replace], …], why — find strings are matched against the LF-normalised flipRef.ts
const M = [
  [[['t[s] = (j + 0.5) * h > yEdge ? FaceType.SOLID : base[s]', 't[s] = base[s]']], 'gate faces never SOLID (only the clamp holds)'],
  [[['if (!this.gate || !(y1 > this.gateY)) return x1', 'return x1']], 'gate particle clamp removed'],
  [[['gateEdge(t: number): number { return this.gate ? this.gate.speed * t : Infinity }', 'gateEdge(t: number): number { return this.gate ? 0 : Infinity }']], 'gate edge never rises'],
  [[['    this.time += dt\n', '']], 'simulated time never advances'],
  // A2g-kin (s34-ref header, 2026-09-29 review): the old A2g-mech passed all three — its hold at 1 cm/s never reaches a face
  [[["    if (!this.gate) return\n    if (this.sphere) throw new Error('FlipRef: a gate with a ball", "    return\n    if (this.sphere) throw new Error('FlipRef: a gate with a ball"]], 'gate option ignored (never applied)'],
  [[['yEdge = this.gateEdge(this.time + 0.5 * dt)', 'yEdge = this.gateEdge(2 * this.time + dt)']], 'gate clock runs double'],
  [[['return this.gate ? this.gate.speed * t : Infinity', 'return this.gate ? 2 * this.gate.speed * t : Infinity']], 'gate speed doubled'],
]

const pristine = (await readFile(join(REPO, 'src/sim-ref/flipRef.ts'), 'utf8')).replace(/\r\n/g, '\n')
for (const [edits, why] of M) for (const [find] of edits) {
  const n = pristine.split(find).length - 1
  if (n !== 1) { console.error(`ABORT (${why}): find string occurs ${n}× in flipRef.ts: ${find.slice(0, 80)}`); process.exit(2) }
}
if (process.argv.includes('--check')) { console.log(`s34g mutants: all ${M.length} find strings match the working tree`); process.exit(0) }

const tmpRoot = await mkdtemp(join(tmpdir(), 's34g-mut-'))
async function runWith(label, edits) {
  const root = join(tmpRoot, label.replace(/[^a-z0-9]+/gi, '_')), dir = join(root, 'src', 'sim-ref')
  await cp(join(REPO, 'src'), join(root, 'src'), { recursive: true })
  if (edits) {
    let src = pristine
    for (const [find, repl] of edits) src = src.replace(find, () => repl)
    await writeFile(join(dir, 'flipRef.ts'), src)
  }
  const r = spawnSync(process.execPath, [join(REPO, 'scripts/fluid-gates/s34-ref.mjs'), '--only=A2gmech'], {
    cwd: REPO, env: { ...process.env, FLUID_REF_SRC: dir.replaceAll('\\', '/') }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 900_000,
  })
  const line = (r.stdout || '').split('\n').find(l => / A2g-mech /.test(l)) ?? ''
  return { code: r.status, pass: line.startsWith('PASS'), line, err: (r.stderr || '').split('\n').find(l => /Error/.test(l)) ?? '' }
}

const control = await runWith('control', null)
console.log(`CONTROL (unmutated copy): ${control.pass ? 'A2g-mech PASS' : `A2g-mech NOT passed (exit ${control.code}) ${control.err}`}\n  ${control.line.slice(0, 240)}`)
let caught = 0, invalid = 0
if (control.pass) {
  for (const [edits, why] of M) {
    const r = await runWith(why, edits)
    const verdict = !r.line ? 'INVALID' : r.pass ? 'SURVIVED' : 'CAUGHT'
    if (verdict === 'CAUGHT') caught++
    if (verdict === 'INVALID') invalid++
    console.log(`${verdict.padEnd(8)} ${why.padEnd(46)} ${r.line ? r.line.slice(0, 200) : `(no A2g-mech line — exit ${r.code} ${r.err.slice(0, 80)})`}`)
  }
}
await rm(tmpRoot, { recursive: true, force: true })
console.log(`\ns34g mutations: ${caught}/${M.length} caught${invalid ? `, ${invalid} INVALID (no A2g-mech line: a crash is not a catch)` : ''}; control ${control.pass ? 'passed' : 'FAILED (results invalid)'}`)
process.exit(control.pass && caught === M.length ? 0 : 1)

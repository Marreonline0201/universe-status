#!/usr/bin/env node
// s30-mutations.mjs — does the S3.0 reference gate catch real defects? Copies src/sim-ref to a temp dir, applies ONE
// plausible bug per run, and runs s30-ref.mjs against the copy (FLUID_REF_SRC). Every mutant must make the gate fail;
// the unmutated copy (control) must pass.
//
//   node scripts/fluid-gates/s30-mutations.mjs       (exit 0 = control passed AND every mutant caught)
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
// [file, [[find, replace], …], why] — find strings are matched against LF-normalised sources (CRLF checkouts).
const M = [
  ['gridLayout.ts', [['(i + (axis === 0 ? 0 : 0.5)) * h', '(i + 0.5) * h']], 'u faces placed at cell centres in x'],
  ['gridLayout.ts', [['return 1 + ((i + ring) % n)', 'return 1 + (i % n)']], 'ring offset ignored by the index function'],
  ['gridLayout.ts', [['if (i >= n) return n + 1', 'if (i >= n) return n']], 'upper ghost aliases the last interior slot'],
  ['flipRef.ts', [['const dw = [-1 / h, 1 / h]', 'const dw = [1 / h, -1 / h]']], 'weight-gradient sign flipped (c = −∇u)'],
  ['flipRef.ts', [['          if (this.apic) {\n            const f = L.facePos', '          if (false) {\n            const f = L.facePos']], 'affine term dropped in P2G only'],
  ['flipRef.ts', [['        ca[3 * q] = this.apic ? g[0] : 0', '        ca[3 * q] = 0']], 'G2P never writes c_x'],
  ['flipRef.ts', [['u[s] = mo[s] / ma[s] + g;', 'u[s] = mo[s] / ma[s] + 2 * g;']], 'gravity applied twice'],
  ['flipRef.ts', [['const g = this.gravity[a] * dt', 'const g = this.gravity[1] * dt']], 'gravity read as a y scalar, not a vector'],
  ['flipRef.ts', [['opts.extrapolationLayers ?? 2', 'opts.extrapolationLayers ?? 0']], 'velocity extrapolation disabled'],
  ['flipRef.ts', [['if (t[s] === FaceType.SOLID) { u[s] = 0; ok[s] = 1 }', 'if (t[s] === FaceType.SOLID) { ok[s] = 0 }']], 'solid faces left unset'],
  ['flipRef.ts', [
    ['const nx = x + dt * this.sample(0, mx, my, mz, null)', 'const nx = x + dt * v1x'],
    ['const ny = y + dt * this.sample(1, mx, my, mz, null)', 'const ny = y + dt * v1y'],
    ['const nz = z + dt * this.sample(2, mx, my, mz, null)', 'const nz = z + dt * v1z']], 'RK2 midpoint replaced by forward Euler'],
  ['flipRef.ts', [['this.mom[a][slot] += w * m * val', 'this.mom[a][slot] += w * val']], 'momentum not mass-weighted'],
]

const pristine = {}
for (const f of new Set(M.map(m => m[0]))) pristine[f] = (await readFile(join(REPO, 'src/sim-ref', f), 'utf8')).replace(/\r\n/g, '\n')
for (const [f, edits, why] of M) for (const [find] of edits) {
  const n = pristine[f].split(find).length - 1
  if (n !== 1) { console.error(`ABORT (${why}): find string occurs ${n}× in ${f}: ${find.slice(0, 80)}`); process.exit(2) }
}

const tmpRoot = await mkdtemp(join(tmpdir(), 's30-mut-'))
async function runWith(label, file, edits) {
  const dir = join(tmpRoot, label.replace(/[^a-z0-9]+/gi, '_'))
  await cp(join(REPO, 'src/sim-ref'), dir, { recursive: true })
  if (file) {
    let src = pristine[file]
    for (const [find, repl] of edits) src = src.replace(find, repl)
    await writeFile(join(dir, file), src)
  }
  const r = spawnSync(process.execPath, [join(REPO, 'scripts/fluid-gates/s30-ref.mjs')], {
    cwd: REPO, env: { ...process.env, FLUID_REF_SRC: dir.replaceAll('\\', '/') }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 300_000,
  })
  const failed = (r.stdout || '').split('\n').filter(l => l.startsWith('FAIL')).map(l => l.split(' ')[1])
  return { code: r.status, failed, err: (r.stderr || '').split('\n').find(l => /Error/.test(l)) ?? '' }
}

const control = await runWith('control')
console.log(`CONTROL (unmutated copy): exit ${control.code}${control.failed.length ? `, FAIL ${control.failed.join(',')}` : ''}`)
let caught = 0
if (control.code === 0) {
  for (const [file, edits, why] of M) {
    const r = await runWith(why, file, edits)
    const ok = r.code !== 0
    if (ok) caught++
    console.log(`${ok ? 'CAUGHT  ' : 'SURVIVED'} ${why.padEnd(48)} exit ${r.code}  failed: ${r.failed.join(',') || (r.err ? `(crash: ${r.err.slice(0, 60)})` : '-')}`)
  }
}
await rm(tmpRoot, { recursive: true, force: true })
console.log(`\nmutations: ${caught}/${M.length} caught; control ${control.code === 0 ? 'passed' : 'FAILED (results invalid)'}`)
process.exit(control.code === 0 && caught === M.length ? 0 : 1)

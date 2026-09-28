#!/usr/bin/env node
// s31a-mutations.mjs — does the S3.1a GPU gate catch real kernel defects? Applies ONE plausible bug per run to the
// WGSL of the clean gate tree (.gate-tree, served by scripts/gate-server.mjs on port 5175 with HMR off — a fresh
// page load compiles the edited shader), runs s31a-gpu.mjs, and restores the file with git. The tree's provenance
// stamp is rewritten to MUTATED while a mutant is live, so no mutated run can pass as a clean result.
//
//   node scripts/gate-server.mjs HEAD   (in another shell)
//   node scripts/fluid-gates/s31a-mutations.mjs
import { spawnSync, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TREE = join(REPO, '.gate-tree')
const SH = 'src/gpu-sim/flip/shaders'
const M = [
  [`${SH}/common.wgsl`, 'return 1 + ((i + ring) % n);', 'return 1 + (i % n);', 'WGSL index ignores the ring offset'],
  [`${SH}/faceScatter.wgsl`, 'val += dot(ca, facePos(a, c) - x);', 'val -= dot(ca, facePos(a, c) - x);', 'APIC affine term sign flipped in P2G'],
  [`${SH}/common.wgsl`, 'fn encodeLo(x: f32) -> i32 { return i32(round((x - round(x)) * LO_SCALE)); }', 'fn encodeLo(x: f32) -> i32 { return i32(round((round(x) - x) * LO_SCALE)); }', 'two-word remainder sign flipped'],
  [`${SH}/gridUpdate.wgsl`, 'u[s] = p / m + P.gravity[a] * P.dt;', 'u[s] = p / m + P.gravity.y * P.dt;', 'gravity applied as a y scalar on every axis'],
  [`${SH}/extrapolate.wgsl`, 'if (validSrc[ns] == 1u && faceType[ns] != SOLID) { sum += uSrc[ns]; cnt++; }', 'if (validSrc[ns] == 1u) { sum += uSrc[ns]; cnt++; }', 'extrapolation reads solid faces'],
  [`${SH}/g2pMac.wgsl`, 'let dw = select(vec3<f32>(-invDx), vec3<f32>(invDx), is1);', 'let dw = select(vec3<f32>(invDx), vec3<f32>(-invDx), is1);', 'G2P weight-gradient sign flipped'],
  [`${SH}/g2pMac.wgsl`, 'let nx = x + P.dt * sampleVel(mid, &unset);', 'let nx = x + P.dt * v;', 'RK2 midpoint replaced by forward Euler'],
  [`${SH}/present.wgsl`, 'let vw = vel[q].xyz * P.tauS / P.lRef;', 'let vw = vel[q].xyz / P.tauS / P.lRef;', 'presentation velocity unit wrong'],
]

const git = (...a) => execFileSync('git', a, { cwd: TREE, encoding: 'utf8' }).trim()
const stampFile = join(TREE, 'gate-sha.txt')
const stamp = readFileSync(stampFile, 'utf8')
if (!/ clean\s*$/.test(stamp) || git('status', '--porcelain', '--', 'src') !== '') { console.error('✗ .gate-tree is not a clean gate tree — start scripts/gate-server.mjs first'); process.exit(2) }
for (const [f, find, , why] of M) {
  const n = readFileSync(join(TREE, f), 'utf8').replace(/\r\n/g, '\n').split(find).length - 1
  if (n !== 1) { console.error(`ABORT (${why}): find string occurs ${n}× in ${f}`); process.exit(2) }
}

function runGate() {
  // the gate script and the CPU reference it imports come from the clean tree too (the working copy may be mid-edit)
  const r = spawnSync(process.execPath, [join(TREE, 'scripts/fluid-gates/s31a-gpu.mjs')], {
    cwd: TREE, env: { ...process.env, FLUID_BASE: 'http://localhost:5175' }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 900_000,
  })
  const failed = (r.stdout || '').split('\n').filter(l => l.startsWith('✗')).map(l => l.slice(2, 40).trim())
  // judged by the printed verdict, not the exit code: Node on Windows can abort with a libuv assertion while
  // closing handles AFTER the verdict is printed, which would turn a pass into a non-zero exit
  const passed = /: PASS \(\d+\/\d+\)/.test(r.stdout || '')
  return { code: r.status, passed, failed, err: (r.stderr || '').split('\n').find(l => /Error/.test(l)) ?? '' }
}

const control = runGate()
console.log(`CONTROL (clean tree): ${control.passed ? "PASS" : "FAIL"} (exit ${control.code})${control.failed.length ? `, FAIL ${control.failed.join(' | ')}` : ''}`)
let caught = 0
if (control.passed) {
  for (const [f, find, repl, why] of M) {
    const path = join(TREE, f)
    const orig = readFileSync(path, 'utf8')
    try {
      writeFileSync(stampFile, stamp.replace(' clean', ' MUTATED'))
      writeFileSync(path, orig.replace(/\r\n/g, '\n').replace(find, repl))
      const r = runGate()
      const ok = !r.passed
      if (ok) caught++
      console.log(`${ok ? 'CAUGHT  ' : 'SURVIVED'} ${why.padEnd(46)} exit ${r.code}  failed: ${r.failed.slice(0, 4).join(' | ') || (r.err ? `(crash: ${r.err.slice(0, 80)})` : '-')}`)
    } finally {
      git('checkout', '--', f)
      writeFileSync(stampFile, stamp)
    }
  }
}
const clean = git('status', '--porcelain', '--', 'src') === ''
console.log(`\nmutations: ${caught}/${M.length} caught; control ${control.passed ? "passed" : 'FAILED (results invalid)'}; tree restored clean: ${clean}`)
process.exit(control.passed && caught === M.length && clean ? 0 : 1)

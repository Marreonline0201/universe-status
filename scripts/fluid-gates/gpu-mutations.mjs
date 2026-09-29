#!/usr/bin/env node
// gpu-mutations.mjs — do the GPU gates catch real kernel defects? Applies ONE plausible bug per run to the WGSL of
// the clean gate tree (.gate-tree, served by scripts/gate-server.mjs on port 5175 with HMR off — a fresh page load
// compiles the edited shader), runs that stage's gate, and restores the file with git. The tree's provenance stamp is
// rewritten to MUTATED while a mutant is live, so no mutated run can pass as a clean result.
//
//   node scripts/gate-server.mjs HEAD   (in another shell)
//   node scripts/fluid-gates/gpu-mutations.mjs --gate=s31a     (S3.1a transfer kernels, gate s31a-gpu.mjs)
//   node scripts/fluid-gates/gpu-mutations.mjs --gate=s31b     (S3.1b projection kernels, gate s31b-gpu.mjs)
//   node scripts/fluid-gates/gpu-mutations.mjs --gate=s32      (S3.2 density kernels, gate s32-gpu.mjs --quick)
//   node scripts/fluid-gates/gpu-mutations.mjs --gate=s34      (S3.4 ghost-fluid kernels, gate s34-gpu.mjs --quick)
import { spawnSync, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TREE = join(REPO, '.gate-tree')
const SH = 'src/gpu-sim/flip/shaders'
// [file, find, replace, why]; find strings are matched against LF-normalised sources
const SETS = {
  s31a: [
    [`${SH}/common.wgsl`, 'return 1 + ((i + ring) % n);', 'return 1 + (i % n);', 'WGSL index ignores the ring offset'],
    [`${SH}/faceScatter.wgsl`, 'val += dot(ca, facePos(a, c) - x);', 'val -= dot(ca, facePos(a, c) - x);', 'APIC affine term sign flipped in P2G'],
    [`${SH}/common.wgsl`, 'fn encodeLo(x: f32) -> i32 { return i32(round((x - round(x)) * LO_SCALE)); }', 'fn encodeLo(x: f32) -> i32 { return i32(round((round(x) - x) * LO_SCALE)); }', 'two-word remainder sign flipped'],
    [`${SH}/gridUpdate.wgsl`, 'u[s] = p / m + P.gravity[a] * P.dt;', 'u[s] = p / m + P.gravity.y * P.dt;', 'gravity applied as a y scalar on every axis'],
    [`${SH}/extrapolate.wgsl`, 'if (validSrc[ns] == 1u && faceType[ns] != SOLID) { sum += uSrc[ns]; cnt++; }', 'if (validSrc[ns] == 1u) { sum += uSrc[ns]; cnt++; }', 'extrapolation reads solid faces'],
    [`${SH}/g2pMac.wgsl`, 'let dw = select(vec3<f32>(-invDx), vec3<f32>(invDx), is1);', 'let dw = select(vec3<f32>(invDx), vec3<f32>(-invDx), is1);', 'G2P weight-gradient sign flipped'],
    [`${SH}/g2pMac.wgsl`, 'let nx = x + P.dt * sampleVel(mid, &unset);', 'let nx = x + P.dt * v;', 'RK2 midpoint replaced by forward Euler'],
    [`${SH}/present.wgsl`, 'let vw = vel[q].xyz * P.tauS / P.lRef;', 'let vw = vel[q].xyz / P.tauS / P.lRef;', 'presentation velocity unit wrong'],
  ],
  s31b: [
    [`${SH}/labelParticles.wgsl`, 'clamp(vec3<i32>(floor(pos[q].xyz / P.dx))', 'clamp(vec3<i32>(round(pos[q].xyz / P.dx))', 'particle cell rounded instead of floored'],
    [`${SH}/labelClear.wgsl`, 'labels[linIdx(c)] = LABEL_AIR;', 'labels[linIdx(c)] = LABEL_FLUID;', 'every cell labelled liquid'],
    [`${SH}/divergence.wgsl`, 'rhs[li] = -div / P.dx;', 'rhs[li] = div / P.dx;', 'right-hand side sign flipped'],
    [`${SH}/project.wgsl`, 'u[s] -= P.dt / (P.rho * P.dx) * (ppE - pmE);', 'u[s] -= P.dt / (P.rho * P.dx) * (pmE - ppE);', 'pressure gradient sign flipped'],
    [`${SH}/project.wgsl`, 'u[s] -= P.dt / (P.rho * P.dx) * (ppE - pmE);', 'u[s] -= P.dt / P.dx * (ppE - pmE);', 'density missing from the projection'],
    [`${SH}/project.wgsl`, 'let pm = select(0.0, pressure[linIdx(c - e)], lm == LABEL_FLUID);', 'let pm = pressure[linIdx(c - e)];', 'air pressure read from the solver vector'],
    [`${SH}/project.wgsl`, '  } else {\n    valid[s] = 0u;\n  }', '  } else {\n    valid[s] = 1u;\n  }', 'faces away from liquid left marked set'],
  ],
  s32: [
    [`${SH}/cellScatter.wgsl`, 'let f = pos[q].xyz / P.dx - vec3<f32>(0.5);', 'let f = pos[q].xyz / P.dx;', 'volume fraction on nodes, not cell centres'],
    [`${SH}/densityRhs.wgsl`, 'keep *= 1.0 - 0.125 * solid;', 'keep *= 1.0;', 'wall compensation dropped'],
    [`${SH}/densityRhs.wgsl`, 'if (airNbr) { fc = max(fc, 1.0); }', '', 'air-neighbour clamp dropped'],
    [`${SH}/densityRhs.wgsl`, 'rhs[li] = fc - 1.0;', 'rhs[li] = 1.0 - fc;', 'density right-hand side sign flipped'],
    [`${SH}/faceDisplacement.wgsl`, 'disp[s] = -P.dx * (pp - pm);', 'disp[s] = P.dx * (pp - pm);', 'displacement sign flipped'],
    [`${SH}/faceDisplacement.wgsl`, 'let pm = select(0.0, psi[linIdx(c - e)], lm == LABEL_FLUID);', 'let pm = psi[linIdx(c - e)];', 'air psi read from the solver vector'],
    [`${SH}/positionCorrect.wgsl`, 'let f = x / P.dx - faceOffset(a);', 'let f = x / P.dx - vec3<f32>(0.5);', 'displacement sampled at cell centres'],
  ],
  s34: [
    [`${SH}/lsScatter.wgsl`, 'let k = (1.0 - d2) * (1.0 - d2) * (1.0 - d2);', 'let k = (1.0 - d2) * (1.0 - d2);', 'Zhu–Bridson kernel squared, not cubed'],
    [`${SH}/lsScatter.wgsl`, 'let ff = x / P.dx - faceOffset(a);', 'let ff = x / P.dx - vec3<f32>(0.5);', 'face-sample search offset wrong'],
    [`${SH}/lsFinalize.wgsl`, 'labels[li] = select(LABEL_AIR, LABEL_FLUID, phi < 0.0);', 'labels[li] = select(LABEL_AIR, LABEL_FLUID, phi < P.lsRbar);', 'label threshold at r̄ instead of 0'],
    [`${SH}/common.wgsl`, 'return length(r) - P.lsRbar;', 'return length(r) - 2.0 * P.lsRbar;', 'radius s (design C) instead of s/2'],
    [`${SH}/common.wgsl`, 'if (fm >= 0.0) { t = 0.5 * fl / (fl - fm); } else { t = 0.5 + 0.5 * fm / (fm - fa); }', 't = fl / (fl - fa);', 'θ without the face-centre sample'],
    [`${SH}/ghostCoef.wgsl`, 'if (labels[linIdx(c - e)] == LABEL_AIR) { let th = thetaOf(fl, facePhi(ax, c), phiCell[linIdx(c - e)]); extra += a * (1.0 - th) / th; }', 'if (labels[linIdx(c - e)] == LABEL_AIR) { let th = thetaOf(fl, facePhi(ax, c), phiCell[linIdx(c - e)]); extra += a / th; }', 'extra diagonal a/θ (face counted twice)'],
    [`${SH}/ghostCoef.wgsl`, 'thetaOf(fl, facePhi(ax, c + e), phiCell[linIdx(c + e)])', 'thetaOf(fl, facePhi(ax, c), phiCell[linIdx(c + e)])', 'upper neighbour uses the lower face'],
    [`${SH}/project.wgsl`, 'pmE = -((1.0 - th) / th) * pp;', 'pmE = -((1.0 - th) / th) * pm;', 'ghost pressure from the air cell (voxel)'],
    [`${SH}/project.wgsl`, 'let th = thetaOf(phiCell[linIdx(c - e)], facePhi(a, c), phiCell[linIdx(c)]);', 'let th = thetaOf(phiCell[linIdx(c)], facePhi(a, c), phiCell[linIdx(c - e)]);', 'θ liquid/air arguments swapped'],
    ['src/gpu-sim/flip/FlipGpuSimulator.ts', 'f[24] = 2 * sp; f[25] = sp / 2;', 'f[24] = 2 * sp; f[25] = sp;', 'host writes r̄ = s instead of s/2'],
  ],
}
const GATE = (process.argv.find(a => a.startsWith('--gate=')) ?? '--gate=s31a').slice(7)
const M = SETS[GATE]
if (!M) { console.error(`unknown --gate=${GATE} (have: ${Object.keys(SETS).join(', ')})`); process.exit(2) }

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
  // s32 / s34: the --quick subsets (kernel parity + D0, C4/WALL, S34a) — every mutant targets a kernel parity covers
  const r = spawnSync(process.execPath, [join(TREE, `scripts/fluid-gates/${GATE}-gpu.mjs`), ...(GATE === 's32' || GATE === 's34' ? ['--quick'] : [])], {
    cwd: TREE, env: { ...process.env, FLUID_BASE: 'http://localhost:5175' }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 1_800_000,
  })
  const failed = (r.stdout || '').split('\n').filter(l => l.startsWith('✗')).map(l => l.slice(2, 40).trim())
  // judged by the printed verdict, not the exit code: Node on Windows can abort with a libuv assertion while
  // closing handles AFTER the verdict is printed, which would turn a pass into a non-zero exit
  const passed = /: PASS \(\d+\/\d+\)/.test(r.stdout || '')
  return { code: r.status, passed, failed, err: (r.stderr || '').split('\n').find(l => /Error/.test(l)) ?? '' }
}

const control = runGate()
console.log(`CONTROL (clean tree, ${GATE}): ${control.passed ? 'PASS' : 'FAIL'} (exit ${control.code})${control.failed.length ? `, FAIL ${control.failed.join(' | ')}` : ''}`)
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
      console.log(`${ok ? 'CAUGHT  ' : 'SURVIVED'} ${why.padEnd(46)} failed: ${r.failed.slice(0, 4).join(' | ') || (r.err ? `(crash: ${r.err.slice(0, 80)})` : '-')}`)
    } finally {
      git('checkout', '--', f)
      writeFileSync(stampFile, stamp)
    }
  }
}
const clean = git('status', '--porcelain', '--', 'src') === ''
console.log(`\nmutations (${GATE}): ${caught}/${M.length} caught; control ${control.passed ? 'passed' : 'FAILED (results invalid)'}; tree restored clean: ${clean}`)
process.exit(control.passed && caught === M.length && clean ? 0 : 1)

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
//   node scripts/fluid-gates/gpu-mutations.mjs --gate=s35      (S3.5 variable-density kernels, gate s35-gpu.mjs --quick)
//   node scripts/fluid-gates/gpu-mutations.mjs --gate=s31c2    (S3.1c-2 drop-ball kernels, gate s31c2-gpu.mjs, full: ~1 min)
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
    [`${SH}/project.wgsl`, 'u[s] -= faceCoef[linIdx(c)][a] * P.dx * (ppE - pmE);', 'u[s] -= faceCoef[linIdx(c)][a] * P.dx * (pmE - ppE);', 'pressure gradient sign flipped'],
    [`${SH}/project.wgsl`, 'u[s] -= faceCoef[linIdx(c)][a] * P.dx * (ppE - pmE);', 'u[s] -= faceCoef[linIdx(c)][a] * (ppE - pmE);', 'projection factor a_f without dx'],
    [`${SH}/project.wgsl`, 'let pm = select(0.0, pressure[linIdx(c - e)], lm == LABEL_FLUID);', 'let pm = pressure[linIdx(c - e)];', 'air pressure read from the solver vector'],
    [`${SH}/project.wgsl`, '  } else {\n    valid[s] = 0u;\n  }', '  } else {\n    valid[s] = 1u;\n  }', 'faces away from liquid left marked set'],
  ],
  s32: [
    [`${SH}/cellScatter.wgsl`, 'let f = pos[q].xyz / P.dx - vec3<f32>(0.5);', 'let f = pos[q].xyz / P.dx;', 'volume fraction on nodes, not cell centres'],
    [`${SH}/cellScatter.wgsl`, 'let vp = P.invPpc;', 'let vp = 2.0 * P.invPpc;', 'particle volume doubled'],
    [`${SH}/densityRhs.wgsl`, 'keep *= 1.0 - 0.125 * solid;', 'keep *= 1.0;', 'wall compensation dropped'],
    [`${SH}/densityRhs.wgsl`, 'if (airNbr) { fc = max(fc, 1.0); }', '', 'air-neighbour clamp dropped'],
    [`${SH}/densityRhs.wgsl`, 'rhs[li] = fc - 1.0;', 'rhs[li] = 1.0 - fc;', 'density right-hand side sign flipped'],
    [`${SH}/faceDisplacement.wgsl`, 'disp[s] = -P.dx * (pp - pm);', 'disp[s] = P.dx * (pp - pm);', 'displacement sign flipped'],
    [`${SH}/faceDisplacement.wgsl`, 'let pm = select(0.0, psi[linIdx(c - e)], lm == LABEL_FLUID);', 'let pm = psi[linIdx(c - e)];', 'air psi read from the solver vector'],
    [`${SH}/positionCorrect.wgsl`, 'let f = x / P.dx - faceOffset(a);', 'let f = x / P.dx - vec3<f32>(0.5);', 'displacement sampled at cell centres'],
  ],
  s31c2: [
    [`${SH}/sphereCoef.wgsl`, 'let am = raw.xyz * vec3<f32>(weight(0u, c), weight(1u, c), weight(2u, c));', 'let am = raw.xyz;', 'fluid-fraction weights not applied'],
    [`${SH}/divergence.wgsl`, 'div += ((1.0 - sh) * uHi + sh * vb) - ((1.0 - sl) * uLo + sl * vb);', 'div += ((1.0 - sh) * uHi) - ((1.0 - sl) * uLo);', "the ball's flux S·V dropped (no −JᵀV)"],
    [`${SH}/sphereFaceVel.wgsl`, '  u[s] = sphere[SPH_V + a];', '  u[s] = 0.0;', 'faces inside the ball set to 0, not V'],
    [`${SH}/sphereForce.wgsl`, 'let f = -S * P.dx * P.dx * (pp - pm);', 'let f = S * P.dx * P.dx * (pp - pm);', 'pressure force sign flipped'],
    [`${SH}/sphereExtendMark.wgsl`, 'cellSolid[li].x < 0.5', 'cellSolid[li].x < 0.95', 'liquid extended only into nearly full cells'],
    [`${SH}/densityRhs.wgsl`, 'let ft = f + (1.0 - keep) + cellSolid[li].y;', 'let ft = f + (1.0 - keep);', 'ball kernel volume dropped from f̃'],
    [`${SH}/sphereCells.wgsl`, 'out.y = kv / 8.0;', 'out.y = kv / 4.0;', 'ball kernel volume normalised wrong'],
    [`${SH}/g2pMac.wgsl`, 'fx = sphereOut(cx, vec3<f32>(sphere[0], sphere[1], sphere[2]), sphere[SPH_R]);', 'fx = cx;', 'no push-out after advection'],
    [`${SH}/sphereIntegrate.wgsl`, 'sphere[SPH_V + a] += P.dt * (P.gravity[a] + F[a] / M);', 'sphere[SPH_V + a] += P.dt * P.gravity[a];', 'fluid force ignored (free fall)'],
    [`${SH}/sphereAdvance.wgsl`, 'if (c < R) { c = R; v = max(v, 0.0); }', 'if (c < R) { v = max(v, 0.0); }', 'ball passes into the floor'],
    [`${SH}/lsResolve.wgsl`, '      if (cellSolid[lm].x >= 0.5) { continue; }\n', '', 'ball cells counted as empty space'],
    [`${SH}/psiCoef.wgsl`, 'w[a] = max(0.0, 1.0 - faceSolid[gridBase(a) + slotOf(c)]);', 'w[a] = 1.0;', 'ψ operator without the fluid-fraction weights'],
  ],
  s34: [
    [`${SH}/lsScatter.wgsl`, 'let k = (1.0 - d2) * (1.0 - d2) * (1.0 - d2);', 'let k = (1.0 - d2) * (1.0 - d2);', 'Zhu–Bridson kernel squared, not cubed'],
    [`${SH}/lsScatter.wgsl`, 'let ff = x / P.dx - faceOffset(a);', 'let ff = x / P.dx - vec3<f32>(0.5);', 'face-sample search offset wrong'],
    // the resolve rule for particle-holding φ ≥ 0 cells (flipRef.classifyLevelSet): the two measured failure modes and a
    // half-rule — every occupied cell LIQUID (broke D1: 0.70 → 7.1 %), none (V1: 4534 particles in one cell), and
    // films bordering air left AIR (V1: compressed wall films); plus occupied neighbours taken for empty space
    [`${SH}/lsResolve.wgsl`, 'if (!(bordersLiquid && bordersEmpty)) {', 'if (true) {', 'every occupied cell LIQUID (voxel union)'],
    [`${SH}/lsResolve.wgsl`, 'if (!(bordersLiquid && bordersEmpty)) {', 'if (false) {', 'occupied unresolved cells left AIR (φ-only)'],
    [`${SH}/lsResolve.wgsl`, 'if (!(bordersLiquid && bordersEmpty)) {', 'if (!bordersEmpty) {', 'films bordering air left AIR (enclosed-only)'],
    [`${SH}/lsResolve.wgsl`, '} else if (occ[lm] == 0u) { bordersEmpty = true; }', '} else { bordersEmpty = true; }', 'occupied neighbours counted as empty space'],
    [`${SH}/lsFinalize.wgsl`, 'labels[li] = select(LABEL_AIR, LABEL_FLUID, phi < 0.0);', 'labels[li] = select(LABEL_AIR, LABEL_FLUID, phi < P.lsRbar);', 'label threshold at r̄ instead of 0'],
    [`${SH}/common.wgsl`, 'return length(r) - P.lsRbar;', 'return length(r) - 2.0 * P.lsRbar;', 'radius s (design C) instead of s/2'],
    [`${SH}/common.wgsl`, 'if (fm >= 0.0) { t = 0.5 * fl / (fl - fm); } else { t = 0.5 + 0.5 * fm / (fm - fa); }', 't = fl / (fl - fa);', 'θ without the face-centre sample'],
    [`${SH}/ghostCoef.wgsl`, 'extra += am[ax] * (1.0 - th) / th; }', 'extra += am[ax] / th; }', 'extra diagonal a/θ (face counted twice)'],
    [`${SH}/ghostCoef.wgsl`, 'thetaOf(fl, facePhi(ax, c + e), phiCell[linIdx(c + e)])', 'thetaOf(fl, facePhi(ax, c), phiCell[linIdx(c + e)])', 'upper neighbour uses the lower face'],
    [`${SH}/project.wgsl`, 'pmE = -((1.0 - th) / th) * pp;', 'pmE = -((1.0 - th) / th) * pm;', 'ghost pressure from the air cell (voxel)'],
    [`${SH}/project.wgsl`, 'let th = thetaOf(phiCell[linIdx(c - e)], facePhi(a, c), phiCell[linIdx(c)]);', 'let th = thetaOf(phiCell[linIdx(c)], facePhi(a, c), phiCell[linIdx(c - e)]);', 'θ liquid/air arguments swapped'],
    ['src/gpu-sim/flip/FlipGpuSimulator.ts', 'f[24] = 2 * sp; f[25] = sp / 2;', 'f[24] = 2 * sp; f[25] = sp;', 'host writes r̄ = s instead of s/2'],
  ],
  s35: [
    [`${SH}/faceScatter.wgsl`, 'atomicAdd(&gW[s], encodeFixed(w * P.massScale));', 'atomicAdd(&gW[s], encodeFixed(P.massScale));', 'Σw counts particles, not weights'],
    [`${SH}/ghostCoef.wgsl`, 'return P.rhoPpc * (mq / P.massScale) / w;', 'return P.rhoPpc * (mq / P.massScale);', 'face density not divided by Σw'],
    [`${SH}/ghostCoef.wgsl`, 'if (P.variable == 0u) { return P.rho; }', 'if (P.variable == 1u) { return P.rho; }', 'variable density ignored'],
    [`${SH}/ghostCoef.wgsl`, 'extra += k / faceRho(ax, c + e, false) * (1.0 - th) / th; }', 'extra += am[ax] * (1.0 - th) / th; }', 'upper ghost face uses the lower face density'],
    [`${SH}/ghostCoef.wgsl`, 'if (w < P.wMin) { return 0.0; }', 'if (w < 0.0) { return 0.0; }', 'no Σw threshold (0/0 faces)'],
    [`${SH}/project.wgsl`, 'u[s] -= faceCoef[linIdx(c)][a] * P.dx * (ppE - pmE);', 'u[s] -= faceCoef[linIdx(c - e)][a] * P.dx * (ppE - pmE);', 'projection reads the neighbour cell coefficient'],
    ['src/gpu-sim/flip/FlipGpuSimulator.ts', 'f[28] = (this.massUnit / L.dx ** 3) * this.ppc;', 'f[28] = this.massUnit / L.dx ** 3;', 'rho_ref·ppc without ppc'],
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
  const r = spawnSync(process.execPath, [join(TREE, `scripts/fluid-gates/${GATE}-gpu.mjs`), ...(['s32', 's34', 's35'].includes(GATE) ? ['--quick'] : [])], {
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

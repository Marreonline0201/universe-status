#!/usr/bin/env node
// gpu-mutations.mjs — do the GPU gates catch real kernel defects? Applies ONE plausible bug per run to the WGSL of
// the clean gate tree (.gate-tree, served by scripts/gate-server.mjs on port 5175 with HMR off — a fresh page load
// compiles the edited shader), runs that stage's gate, and restores the file with git. The tree's provenance stamp is
// rewritten to MUTATED while a mutant is live, so no mutated run can pass as a clean result.
// Verdicts: CAUGHT = at least one physics check failed on a CLEAN run (both hygiene checks printed and passing);
// SURVIVED = the gate printed PASS; INVALID = anything else — a crash before the verdict, or a WebGPU error (a binding
// left unused changes the auto layout): the mutated kernel never ran as intended, so it tests nothing and is never
// counted as a catch (2026-09-30: s36's "mass-less unknowns written back" had been counted caught from a crash).
// Known control failures (revision 2026-09-30, FRICTION follow-up, the lead): a set may list the checks its CLEAN
// control is known to fail (MAY_FAIL), by label — a check line's text after its ✓/✗ up to the first ':' — matched
// EXACTLY. Reason: s38-gpu's W1c z validity fails on the clean tree — the stage-off control sheet's own drift exceeds
// the pre-registered 0.2 % on the CPU reference too (the solver is x/z-symmetric to f64 rounding and tolerance-
// independent, per-seed maxima 0.06–0.55 %: FR/impl/A/w1c_drift_study.out, FR = the FRICTION spec's scratch root), so
// W1c.z is VOID and s38-gpu exits non-zero. For a listed set the control is usable only if its failing labels EQUAL the
// list — nothing else fails and every listed label fails exactly once (a listed check that passes, is missing or
// repeats makes the list stale: the control is rejected); a mutant is CAUGHT only through a failing check OUTSIDE the
// list; INVALID is unchanged. VOID lines carry neither ✓ nor ✗: neither pass nor fail. Sets without a list: as before.
// Attribution (revision 2026-09-30, review wf_fbc58c55-116 MH-1/MH-2): a MUTANT run of a listed set whose listed checks
// are stale in that sense — the mutant changed the state of a check the usable control failed exactly once — scores
// NOT-ATTRIBUTABLE: a check the control never certified may then fail (s38-gpu's z loss is VOID in the control and is
// marked only when the z validity passes). It is never CAUGHT, is printed with its reason and is not counted as caught,
// so the exit stays non-zero. judge() keeps its classification in `verdict` (unchanged) and returns the tallied result
// in `score` (INVALID first, then NOT-ATTRIBUTABLE, else the verdict; without a list, score = verdict). The listed
// lines' values are NOT compared (MH-2; golden pinning is deferred: a pinned value would be re-recorded at every
// stage-off solver change) — they are printed on the CONTROL line and on every mutant line, so a change is visible.
//
//   node scripts/gate-server.mjs HEAD   (in another shell)
//   node scripts/fluid-gates/gpu-mutations.mjs --gate=s31a     (S3.1a transfer kernels, gate s31a-gpu.mjs)
//   node scripts/fluid-gates/gpu-mutations.mjs --gate=s31b     (S3.1b projection kernels, gate s31b-gpu.mjs)
//   node scripts/fluid-gates/gpu-mutations.mjs --gate=s32      (S3.2 density kernels, gate s32-gpu.mjs --quick)
//   node scripts/fluid-gates/gpu-mutations.mjs --gate=s34      (S3.4 ghost-fluid kernels, gate s34-gpu.mjs --quick)
//   node scripts/fluid-gates/gpu-mutations.mjs --gate=s35      (S3.5 variable-density kernels, gate s35-gpu.mjs --quick)
//   node scripts/fluid-gates/gpu-mutations.mjs --gate=s31c2    (S3.1c-2 drop-ball kernels, gate s31c2-gpu.mjs, full: ~1 min)
//   node scripts/fluid-gates/gpu-mutations.mjs --gate=s36      (S3.6 viscosity kernels, gate s36-gpu.mjs --quick)
//   node scripts/fluid-gates/gpu-mutations.mjs --gate=s35i     (S3.5-i immiscible drift kernels, gate s35i-gpu.mjs --quick)
//   node scripts/fluid-gates/gpu-mutations.mjs --gate=s37      (S3.7 monolithic ball kernels, gate s37-gpu.mjs --quick)
//   node scripts/fluid-gates/gpu-mutations.mjs --gate=perf1    (PERF-1 L0 dispatch budget, gate perf1-gpu.mjs)
//   node scripts/fluid-gates/gpu-mutations.mjs --gate=opt2a    (OPT-2a in-scatter / deep colour, gate opt2a-render.mjs)
//   node scripts/fluid-gates/gpu-mutations.mjs --gate=wallShear (FRICTION: the floor's wall shear, gate s38-gpu.mjs, full: ~2 min)
//   node scripts/fluid-gates/gpu-mutations.mjs --gate=pageResize (FRICTION enable: the stage across a tank resize, gate tank-page.mjs)
//   node scripts/fluid-gates/gpu-mutations.mjs --gate=pageScene  (FRICTION enable: the per-scene stage log, gate s31c-page.mjs, ~8 min a run)
//   node scripts/fluid-gates/gpu-mutations.mjs --gate=snapshot   (B1c fork: the bench state snapshot / restore, gate snapshot-page.mjs)
// The page sets mutate FlipBackend (src/fluid-engine/backends.ts) and run a PAGE gate, whose hygiene lines read
// 'R GPU: n uncaptured WebGPU errors …' and 'R console: n errors' (2026-09-30, the enable): HYGIENE takes that optional
// 'R ' too, so a page catch is judged like any other (without it every page catch would score INVALID). No script of
// the earlier sets prints such a line, so their verdicts are unchanged.
// A mutant is [file, find, replace, why]: find and replace are two strings, or two arrays of equal length ≥ 1 — several
// edits in one file, applied in order (a call moved from one method to another); every find a non-empty string, every
// replacement a string different from its find (an empty one deletes). editsOf refuses any other shape (review MH-4);
// the edits are dry-run in order — each find must occur exactly once in the text as it stands after the edits before
// it — by --check, by the pre-run abort loop and by the run itself, which writes the dry run's text; replacements are
// inserted verbatim (a function replacer: no $-patterns, review MH-5).
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
    [`${SH}/g2pMac.wgsl`, 'let nx = x + P.dt * (sampleVel(mid, &unset) + uV);', 'let nx = x + P.dt * (v + uV);', 'RK2 midpoint replaced by forward Euler'],
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
  // four edits below deleted the only use of a binding in their kernel (sphere, cellSolid ×2, faceSolid): the auto layout
  // dropped it and the run raised ~1500 WebGPU errors — scored INVALID on 2026-09-30 (the old count 12/12 was 8 + 4 crashes);
  // each now keeps the binding statically used with the same defect
  s31c2: [
    [`${SH}/sphereCoef.wgsl`, 'let am = raw.xyz * vec3<f32>(weight(0u, c), weight(1u, c), weight(2u, c));', 'let am = raw.xyz;', 'fluid-fraction weights not applied'],
    [`${SH}/divergence.wgsl`, 'div += ((1.0 - sh) * uHi + sh * vb) - ((1.0 - sl) * uLo + sl * vb);', 'div += ((1.0 - sh) * uHi) - ((1.0 - sl) * uLo);', "the ball's flux S·V dropped (no −JᵀV)"],
    [`${SH}/sphereFaceVel.wgsl`, '  u[s] = sphere[SPH_V + a];', '  u[s] = 0.0 * sphere[SPH_V + a];', 'faces inside the ball set to 0, not V'],
    [`${SH}/sphereForce.wgsl`, 'let f = -S * P.dx * P.dx * (pp - pm);', 'let f = S * P.dx * P.dx * (pp - pm);', 'pressure force sign flipped'],
    [`${SH}/sphereExtendMark.wgsl`, 'cellSolid[li].x < 0.5', 'cellSolid[li].x < 0.95', 'liquid extended only into nearly full cells'],
    [`${SH}/densityRhs.wgsl`, 'let ft = f + (1.0 - keep) + cellSolid[li].y;', 'let ft = f + (1.0 - keep) + 0.0 * cellSolid[li].y;', 'ball kernel volume dropped from f̃'],
    [`${SH}/sphereCells.wgsl`, 'out.y = kv / 8.0;', 'out.y = kv / 4.0;', 'ball kernel volume normalised wrong'],
    [`${SH}/g2pMac.wgsl`, 'fx = sphereOut(cx, vec3<f32>(sphere[0], sphere[1], sphere[2]), sphere[SPH_R]);', 'fx = cx;', 'no push-out after advection'],
    [`${SH}/sphereIntegrate.wgsl`, 'sphere[SPH_V + a] += P.dt * (P.gravity[a] + F[a] / M);', 'sphere[SPH_V + a] += P.dt * P.gravity[a];', 'fluid force ignored (free fall)'],
    [`${SH}/sphereAdvance.wgsl`, 'if (c < R) { c = R; v = max(v, 0.0); }', 'if (c < R) { v = max(v, 0.0); }', 'ball passes into the floor'],
    [`${SH}/lsResolve.wgsl`, '      if (cellSolid[lm].x >= 0.5) { continue; }\n', '      if (cellSolid[lm].x >= 1e30) { continue; }\n', 'ball cells counted as empty space'],
    [`${SH}/psiCoef.wgsl`, 'w[a] = max(0.0, 1.0 - faceSolid[gridBase(a) + slotOf(c)]);', 'w[a] = max(1.0, 1.0 - faceSolid[gridBase(a) + slotOf(c)]);', 'ψ operator without the fluid-fraction weights'],
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
    [`${SH}/common.wgsl`, 'return length(s.yzw / s.x * P.dx) - P.lsRbar;', 'return length(s.yzw / s.x * P.dx) - 2.0 * P.lsRbar;', 'radius s (design C) instead of s/2'],
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
// S3.6: each targets a kernel that K26–K29 cover (the Jacobi preconditioner is left out: a wrong diagonal only slows a
// converging PCG, it does not change the answer)
SETS.s36 = [
  [`${SH}/common.wgsl`, 'fn lsLo(v: vec4<f32>) -> vec4<i32> { return vec4<i32>(round((v - round(v)) * LS_LO_SCALE)); }', 'fn lsLo(v: vec4<f32>) -> vec4<i32> { return vec4<i32>(0); }', 'level-set remainder word dropped (one word)'],
  [`${SH}/viscosity.wgsl`, 'let xs = (vec3<f32>(n) * 0.5 + vec3<f32>(0.25)) * P.dx;', 'let xs = (vec3<f32>(n) * 0.5) * P.dx;', 'quarter lattice shifted by dx/4'],
  [`${SH}/viscosity.wgsl`, 'v += clamp(0.5 - latPhi((cc + s) * P.dx) / (0.5 * P.dx), 0.0, 1.0);', 'v += clamp(0.5 - latPhi((cc + s) * P.dx) / P.dx, 0.0, 1.0);', 'volume smooth step over dx, not dx/2'],
  [`${SH}/viscosity.wgsl`, 'if (!anyBand) { return select(0.0, 1.0, allLiquid); }', 'if (!anyBand) { return 1.0; }', 'samples off the band all full'],
  [`${SH}/viscosity.wgsl`, 'if (tp.ok) { atomicMax(&muAcc[tp.slot], key); }', 'if (tp.ok) { atomicMax(&muAcc[tp.slot], 0u); }', 'μ_min pass writes nothing (default μ everywhere)'],
  [`${SH}/viscosity.wgsl`, 'return bitcast<f32>(~key) * select(w / m, 1.0, w == m);', 'return bitcast<f32>(~key);', 'harmonic quotient dropped (μ_min at mixed samples)'],
  [`${SH}/viscosity.wgsl`, 'wCell[linIdx(c)] = 2.0 * muAt(muSlot(0u, c)) * volCellR[linIdx(c)];', 'wCell[linIdx(c)] = muAt(muSlot(0u, c)) * volCellR[linIdx(c)];', 'cell strain weight μV, not 2μV'],
  [`${SH}/viscosity.wgsl`, 'sv = wEdgeR[s] * ((val(a, c) - val(a, c - eb)) / P.dx + (val(b, c) - val(b, c - ea)) / P.dx);', 'sv = wEdgeR[s] * ((val(a, c) - val(a, c - eb)) / P.dx);', 'shear strain γ without its second term'],
  [`${SH}/viscosity.wgsl`, 'if (c[b] == -1) { c[b] = 0; sign *= VP.walls[b]; }', 'if (c[b] == -1) { c[b] = 0; }', 'low-side wall ghost sign ignored'],
  [`${SH}/viscosity.wgsl`, 'let visc = P.dt * sumStress(a, c);', 'let visc = sumStress(a, c);', 'viscous operator without Δt'],
  // (a 'faces with V ≤ ½ not unknowns' mutant is EQUIVALENT: the sample rule below re-marks them — measured, it survived)
  [`${SH}/viscosity.wgsl`, 'for (var a = 0u; a < 3u; a++) { var e = vec3<i32>(0); e[a] = 1; markUnknown(a, c + e); markUnknown(a, c); }', '', 'cell samples add no auxiliary unknowns'],
  [`${SH}/viscosity.wgsl`, 'if (kindR[s] == 1u && volFaceR[s] > 0.0) { uOut[s] = xR[s]; validOut[s] = 1u; }', 'if (kindR[s] == 1u && volFaceR[s] >= 0.0) { uOut[s] = xR[s]; validOut[s] = 1u; }', 'mass-less unknowns written back'],
]
// S3.5-i: each targets a kernel that K30–K34 cover; every mutant keeps its kernel's bindings statically used (a removed
// binding changes the auto layout and the run crashes — a crash is not a caught defect)
SETS.s35i = [
  [`${SH}/immiscible.wgsl`, '  if (h < 0.1) { return h * (1.0 - h * (0.5 - h * (1.0 / 6.0 - h * (1.0 / 24.0 - h / 120.0)))); }\n', '', 'series of 1 − e^(−h) dropped (f32 cancellation)'],
  [`${SH}/immiscible.wgsl`, 'if (Re >= 1000.0) { return 0.44 * Re / 24.0; }', 'if (Re >= 1000.0) { return 0.44 * Re / 12.0; }', "Newton's drag factor doubled"],
  [`${SH}/immiscible.wgsl`, 'return 1.0 + 0.15 * pow(Re, 0.687);', 'return 1.0 + 0.15 * pow(Re, 0.5);', 'Schiller–Naumann exponent wrong'],
  [`${SH}/immiscible.wgsl`, 'let muM = muc * pow(max(1e-12, 1.0 - aD), -2.5 * muStar);', 'let muM = muc;', 'hindered mixture viscosity dropped'],
  [`${SH}/immiscible.wgsl`, 'let m = oneMinusExpNeg(P.dt / ((rp + 0.5 * rc) * kd));', 'let m = oneMinusExpNeg(P.dt / (rp * kd));', 'virtual mass dropped from τ'],
  [`${SH}/immiscible.wgsl`, 'let s = sOld + ((rp - rm) * acc * kd - sOld) * m;', 'let s = sOld + ((rp - rc) * acc * kd - sOld) * m;', 'buoyancy against ρ_c, not the mixture'],
  [`${SH}/immiscible.wgsl`, 'if (faceType[s] == SOLID) { accOut[s] = P.gravity[a]; accValidOut[s] = 0u; return; }', 'if (faceType[s] == SOLID) { accOut[s] = 0.0; accValidOut[s] = 0u; return; }', 'wall faces carry a = 0, not g'],
  [`${SH}/immiscible.wgsl`, 'accOut[s] = (uStar[s] - uProj[s]) / P.dt;', 'accOut[s] = (uStar[s] - uProj[s]);', 'face acceleration without 1/Δt'],
  [`${SH}/immiscible.wgsl`, 'lo[bb] = max(0, c[bb] - 1); hi[bb] = min(P.n[bb] - 1, c[bb] + 1);', 'lo[bb] = c[bb]; hi[bb] = min(P.n[bb] - 1, c[bb] + 1);', 'strain off-diagonal one-sided'],
  [`${SH}/immiscible.wgsl`, 'dMax = 0.725 * pow(rc / sig, -0.6) * pow(eps, -0.4);', 'dMax = 0.725 * pow(rc / sig, -0.6) * pow(eps, -0.6);', 'Hinze ε exponent wrong'],
  [`${SH}/immiscible.wgsl`, 'd = select(dMax, min(dOld, dMax), dOld > 0.0);', 'd = dMax;', 'breakup-only drop memory dropped'],
  [`${SH}/immiscible.wgsl`, '  for (var k = 1u; k < IP.K; k++) { if (al[k] > al[cm]) { cm = k; } }\n', '', 'continuous phase always the first material'],
  [`${SH}/immiscible.wgsl`, '    let v = w * LS_SCALE;\n', '    let v = LS_SCALE;\n', 'α counts particles, not kernel weights'],
  [`${SH}/immiscible.wgsl`, 'J += cellInfR[8u * li + 4u + k] * (sum / f32(cnt));', 'J += max(1.0, cellInfR[8u * li + 4u + k]) * (sum / f32(cnt));', 'counter-drift not α-weighted'],
  [`${SH}/immiscible.wgsl`, 'drift[q] = vec4<f32>(own - driftCellR[li].xyz, 0.0);', 'drift[q] = vec4<f32>(own, driftCellR[li].w);', 'no volume-conserving counter-drift'],
  // (deleting the line removed drift's only use in g2pMac: the auto layout dropped the binding and the run raised 16
  // WebGPU errors — scored INVALID on 2026-09-30; × 0.0 keeps the binding statically used)
  [`${SH}/g2pMac.wgsl`, '  if (IMMISCIBLE) { uV = drift[q].xyz; }\n', '  if (IMMISCIBLE) { uV = drift[q].xyz * 0.0; }\n', 'advection ignores the drift'],
  // the face form (2026-09-30; K32 covers driftFaces per face and driftParticlesFace per particle; every edit keeps its
  // kernel's bindings statically used)
  [`${SH}/immiscible.wgsl`, 'if (c[a] == 0 || c[a] == P.n[a] || faceType[s] == SOLID || !(W >= P.wMin) || faceSolid[s] >= 1.0) { driftFace[s] = 0.0; return; }', 'if (faceType[s] == 99u || !(W >= P.wMin) || faceSolid[s] >= 1.0) { driftFace[s] = 0.0; return; }', 'face J not zeroed on the walls'],
  [`${SH}/immiscible.wgsl`, 'if (c[a] == 0 || c[a] == P.n[a] || faceType[s] == SOLID || !(W >= P.wMin) || faceSolid[s] >= 1.0) { driftFace[s] = 0.0; return; }', 'if (faceType[s] == SOLID || !(W >= P.wMin) || faceSolid[s] >= 1.0) { driftFace[s] = 0.0; return; }', 'wall-plane edge faces not zeroed (SOLID only)'],
  [`${SH}/immiscible.wgsl`, 'let W = f32(weightR[s]) / P.massScale;', 'let W = f32(weightR[s]) / P.momScale;', 'Σw decoded at the momentum scale'],
  [`${SH}/immiscible.wgsl`, 'let v = w * st[a] * SLIP_SCALE;', 'let v = w * st[(a + 1u) % 3u] * SLIP_SCALE;', 'face sums from the wrong axis\'s slip'],
  [`${SH}/immiscible.wgsl`, 'let hi = atomicExchange(&slipFace[2u * s], 0);', 'let hi = atomicLoad(&slipFace[2u * s]);', 'face sums never cleared (hi word)'],
  [`${SH}/immiscible.wgsl`, '      j += wv.x * wv.y * wv.z * driftFaceR[gridBase(a) + slotOf(b + d)];', '      j += wv.x * driftFaceR[gridBase(a) + slotOf(b + d)];', 'J interpolated with the x weight only'],
  [`${SH}/immiscible.wgsl`, '  u -= jv;', '  u -= select(vec3<f32>(0.0), jv, st.w > 0.0);', 'carriers not moved by −J (face form)'],
  [`${SH}/immiscible.wgsl`, '  var u = select(vec3<f32>(0.0), st.xyz, st.w > 0.0);', '  var u = select(vec3<f32>(0.0), st.xyz, st.w > 1e30);', 'own slip dropped (face form)'],
  // review 2026-09-30 (wf_c8d4ee53-cb7): the ball clause and the ball's J·n ramp (K32's ball scene), and the face kernels'
  // order (K32 now also checks run 1, from face buffers that are zero: a stale-read order gives J_f = 0 or u_V = own there)
  [`${SH}/immiscible.wgsl`, 'if (c[a] == 0 || c[a] == P.n[a] || faceType[s] == SOLID || !(W >= P.wMin) || faceSolid[s] >= 1.0) { driftFace[s] = 0.0; return; }', 'if (c[a] == 0 || c[a] == P.n[a] || faceType[s] == SOLID || !(W >= P.wMin) || faceSolid[s] >= 1e30) { driftFace[s] = 0.0; return; }', 'J not zeroed inside the ball'],
  [`${SH}/immiscible.wgsl`, '      jv -= (1.0 - max(0.0, phi) / P.dx) * dot(jv, n) * n;', '      jv -= 0.0 * dot(jv, n) * n;', "the ball's J·n ramp dropped"],
  ['src/gpu-sim/flip/ImmiscibleSolver.ts', "      if (count > 0) this.dispatch(pass, 'slipFaces', count, 64)\n      this.dispatch(pass, 'driftFaces', 3 * I.size, 256)\n", "      this.dispatch(pass, 'driftFaces', 3 * I.size, 256)\n      if (count > 0) this.dispatch(pass, 'slipFaces', count, 64)\n", 'driftFaces before slipFaces (reads last encode\'s sums)'],
  ['src/gpu-sim/flip/ImmiscibleSolver.ts', "      this.dispatch(pass, 'driftFaces', 3 * I.size, 256)\n      if (count > 0) this.dispatch(pass, 'driftParticlesFace', count, 64)\n", "      if (count > 0) this.dispatch(pass, 'driftParticlesFace', count, 64)\n      this.dispatch(pass, 'driftFaces', 3 * I.size, 256)\n", 'driftParticlesFace before driftFaces (last encode\'s J)'],
]
// S3.7: each targets a kernel K35/K36 cover (the jdot-without-unknown-guard mutant is equivalent here: x is 0 at every
// non-unknown on these inputs — the guard is kept for warm starts across label changes)
SETS.s37 = [
  ['src/gpu-sim/flip/poisson/cg.wgsl', 'r = b - (k0.w * vx[c] - off) - rankTerm(c);', 'r = b - (k0.w * vx[c] - off) + rankTerm(c);', 'rank term sign flipped in the warm-start residual'],
  ['src/gpu-sim/flip/poisson/cg.wgsl', 'if (k0.w > 0.0) { q = applyD(c, L.sy, L.sz, k0) + rankTerm(c); }', 'if (k0.w > 0.0) { q = applyD(c, L.sy, L.sz, k0) - rankTerm(c); }', 'rank term sign flipped in the matvec'],
  ['src/gpu-sim/flip/poisson/cg.wgsl', '    if (coef[c].w > 0.0) { v = jPart(c, d); }', '    if (coef[c].w > 0.0) { v = jPart(c, mub[c]); }', 'Ĵᵀd formed from z, not d'],
  [`${SH}/sphereRank.wgsl`, 'rankJ[li] = vec4<f32>(sqrt(P.dt / (M * h3)) * P.dx * P.dx * J, 0.0);', 'rankJ[li] = vec4<f32>((P.dt / (M * h3)) * P.dx * P.dx * J, 0.0);', 'rank scale without the square root'],
  [`${SH}/sphereGravity.wgsl`, 'for (var a = 0u; a < 3u; a++) { sphere[SPH_V + a] += P.dt * P.gravity[a]; }', 'for (var a = 0u; a < 3u; a++) { sphere[SPH_V + a] += 2.0 * P.dt * P.gravity[a]; }', 'gravity applied twice'],
  [`${SH}/sphereMonoUpdate.wgsl`, 'for (var a = 0u; a < 3u; a++) { sphere[SPH_V + a] += P.dt * F[a] / M; }', 'for (var a = 0u; a < 3u; a++) { sphere[SPH_V + a] += P.dt * F[a] / rhoS; }', 'ball update divides by ρ_s, not M'],
  [`${SH}/sphereVolume.wgsl`, 'if (S > 0.0) { atomicAdd(&forceAcc[3], i32(round(S * SOLID_SCALE))); }', 'if (S > 0.5) { atomicAdd(&forceAcc[3], i32(round(S * SOLID_SCALE))); }', 'V_J from the mostly-solid faces only'],
]
// PERF-1 L0 (2026-09-30): the dispatch budget's positive controls (spec L0 D1, D2) — an encode that gains one dispatch,
// and a formula that loses the monolithic ball's rank term; each must fail perf1-gpu's per-label equality
SETS.perf1 = [
  ['src/gpu-sim/flip/FlipGpuSimulator.ts', "    this.dispatch(encoder, 'fillLiquidFaces', bg.fillLiquidFaces, 3 * this.layout.size, 256)\n", "    this.dispatch(encoder, 'fillLiquidFaces', bg.fillLiquidFaces, 3 * this.layout.size, 256)\n    this.dispatch(encoder, 'fillLiquidFaces', bg.fillLiquidFaces, 3 * this.layout.size, 256)\n", 'D1: one extra dispatch (fillLiquidFaces twice)'],
  ['src/gpu-sim/flip/dispatchBudget.ts', 'sh.init + cap * sh.perIteration + sh.finalize + (rank ? sh.rankInit + cap * sh.rankPerIteration : 0)', 'sh.init + cap * sh.perIteration + sh.finalize + (rank ? 0 : 0)', "D2: the rank term dropped from the budget"],
  // FRICTION (2026-09-30, spec §3.3): the wall-shear stage's own dispatches, caught by budget.ts's stage-on combinations
  ['src/gpu-sim/flip/FlipGpuSimulator.ts', "    this.dispatch(encoder, 'wallShearCell', ws.bg.cell, cells, 64)\n", "    this.dispatch(encoder, 'wallShearCell', ws.bg.cell, cells, 64)\n    this.dispatch(encoder, 'wallShearCell', ws.bg.cell, cells, 64)\n", 'D3: one extra stage dispatch (wallShearCell twice)'],
]
// FRICTION (2026-09-30; spec §4 W3's GPU set): each keeps every binding of its kernel statically used. Caught by
// s38-gpu: the sign and τ×2 by W1a, W1a-K and W1c; the floor row binned as y < dx/2 by W1a-K (and W1a: the films'
// upper particles leave the sums); the momentum words at 2^24 only by W1a-K's dense cell (Σm̂·v ≈ 149 overflows a
// ±128 word); the stage moved from encodeSubstepBody to once per frame in step() only by W1c through step() with
// substeps = 2 (half the applications) — the stage-level tests call encodeWallShear directly
SETS.wallShear = [
  [`${SH}/wallShearCell.wgsl`, '        let k = -a / (1.0 + a);', '        let k = a / (1.0 + a);', 'Δv sign flipped'],
  [`${SH}/wallShearCell.wgsl`, '        let a = P.dt * tau * WP.kA / (Mh * U);', '        let a = P.dt * 2.0 * tau * WP.kA / (Mh * U);', 'τ×2'],
  [`${SH}/wallShearScatter.wgsl`, '  if (c.y != 0) { return; }', '  if (pos[q].y >= 0.5 * P.dx) { return; }', 'floor row binned as y < dx/2'],
  ['src/gpu-sim/flip/FlipGpuSimulator.ts', 'f[10] = MOM_SCALE; f[11] = 1 / MOM_SCALE', 'f[10] = MASS_SCALE; f[11] = 1 / MASS_SCALE', "momentum words at 2^24 (the mass word's scale)"],
  ['src/gpu-sim/flip/FlipGpuSimulator.ts',
    ['    if (this.wallShearRuns) this.encodeWallShear(encoder)\n    this.encodeScatter(encoder)\n', '    for (let s = 0; s < substeps; s++) {\n      this.encodeSphereStart(encoder)\n'],
    ['    this.encodeScatter(encoder)\n', '    if (this.wallShearRuns) this.encodeWallShear(encoder)\n    for (let s = 0; s < substeps; s++) {\n      this.encodeSphereStart(encoder)\n'],
    'stage once per frame (step), not per substep'],
  // (2026-09-30 follow-up) z ignored in the update: wallShearApply adds Δv_x only (cellR stays used through d.x). Should
  // be caught by W1a's z arm — its films stay at U0 = 3 m/s, derived miss +35.3 % against the 3e-5 bound — and by
  // W1a-K per particle: its cells at 90°/270° (and the 45° ones in part) lose their whole Δv_z; s38-gpu's W1a-K info
  // line prints that z signal, the largest |Δv_z,ref|/|U_c| — measured 4.50e-3 (2026-09-30), 15 000× the 3e-7 bound
  [`${SH}/wallShearApply.wgsl`, '  vel[q] = vec4<f32>(v.x + d.x, v.y, v.z + d.y, v.w);', '  vel[q] = vec4<f32>(v.x + d.x, v.y, v.z, v.w);', 'Δv_z dropped (z ignored in the update)'],
  // review wf_fbc58c55-116 fix round (2026-09-30), each pre-registered in s38-gpu's header before its first run and
  // keeping every binding of its kernel statically used:
  // M3 — a sim with the viscosity solver binds the stage's own table (every μ = the default, water 20 °C) instead of
  // the solver's: caught only by W1a-K on the viscosity solver's μ table (derived miss 4.46e-5 at the dense mercury
  // cell, ≥ 4.43e-5 on the GPU = 148× the 3e-7 bound; FR/fixround/Y/m3_miss.out)
  ['src/gpu-sim/flip/FlipGpuSimulator.ts', "      const ownMu = this.viscositySolver ? null : buf('wallShearMu', 4 * 256)\n      const mu = this.viscositySolver ? this.viscositySolver.bufs.muTable : ownMu!\n", "      const ownMu = buf('wallShearMu', 4 * 256)\n      const mu = ownMu\n", 'the stage always binds its own table'],
  // GATE-F7 — a skipped cell keeps the previous application's Δv: caught by W1a-K.skip (its pair gets the stale Δv)
  [`${SH}/wallShearCell.wgsl`, '        atomicMax(&wgTauMax, bitcast<u32>(abs(tau)));\n      }\n    }\n    cellOut[c] = out;\n', '        atomicMax(&wgTauMax, bitcast<u32>(abs(tau)));\n        cellOut[c] = out;\n      }\n    }\n', 'cellOut written only for acted cells'],
  // M2 — the old ternary's ': 2' (an unknown law runs constantTest, τ = 0): caught by W0c on the GPU
  ['src/gpu-sim/flip/FlipGpuSimulator.ts', '    const law = WALL_SHEAR_LAW_ID.get(w.law)\n', '    const law = WALL_SHEAR_LAW_ID.get(w.law) ?? 2\n', 'unknown law maps to constantTest'],
  // M1 — a muDefault accepted on a solver sim (where it is never read): caught by W0c on the GPU
  ['src/gpu-sim/flip/FlipGpuSimulator.ts', 'if (w.muDefault !== undefined && this.viscositySolver) throw', 'if (false && w.muDefault !== undefined && this.viscositySolver) throw', 'muDefault accepted on a solver sim'],
  // M4 — resetDiagnostics leaves the stage log: caught by W1g.reset
  ['src/gpu-sim/flip/FlipGpuSimulator.ts', '    this.resetWallShearStats()\n', '', 'stage log not reset by resetDiagnostics'],
  // INT-7 — the stage runs while the immiscible drift runs: caught by W0b's drift arm (0 differing words, an empty log)
  ['src/gpu-sim/flip/FlipGpuSimulator.ts', 'get wallShearRuns(): boolean { return this.ws !== null && !(this.viscosityActive && !!this.viscositySolver) && !this.immActive }', 'get wallShearRuns(): boolean { return this.ws !== null && !(this.viscosityActive && !!this.viscositySolver) }', 'drift guard removed'],
  // CPU-F2 (prereg R-F2) — the depth read from row 0 alone, the rule before R-F2 (n1 kept in use): caught by W1a-K,
  // whose reference follows R-F2 (23 acted cells hold row-1 particles over n0 < 8; derived CPU miss 2.49e-4 at cell 22,
  // ≥ 2.48e-4 on the GPU = 828× the 3e-7 bound; FR/fixround/Y/m3_miss.out)
  [`${SH}/wallShearCell.wgsl`, '        let hc = min(f32(n + n1) * P.dx * P.invPpc, P.dx);', '        let hc = min(f32(n + 0 * n1) * P.dx * P.invPpc, P.dx);', 'depth from row 0 only'],
]
// OPT-2a (2026-09-30; spec §4.6): the composite's in-scatter and deep-water terms. Each find string is one line of the
// shader, unique in the file; every edit keeps each binding statically used. Sizes at the centre rays (spec table):
// 1–9 and 12 are V18b's (0.5 % per pixel), 10–11 V17-code's (1e-5·|B|), 13–14 V9's (1e-4·L0)
const CO = 'src/fluid-render/shaders/ssfr_composite.wgsl'
SETS.opt2a = [
  [CO, 'L = F * Lrefl + (1.0 - F) * transmittance(row, pathM) * Lrefr + (1.0 - F) * Lss;', 'L = F * Lrefl + (1.0 - F) * transmittance(row, pathM) * (Lrefr + Lss);', '1: in-scatter inside T'],
  [CO, 'L = F * Lrefl + (1.0 - F) * transmittance(row, pathM) * Lrefr + (1.0 - F) * Lss;', 'L = F * Lrefl + (1.0 - F) * transmittance(row, pathM) * Lrefr + Lss;', '2: no (1 − F_v) on L_ss'],
  [CO, 'let Ew = Esun * (1.0 - fresnelDielectric(cs, 1.0, ior)) * cs / muS;', 'let Ew = Esun * cs / muS;', '3: E_w without (1 − F_s)'],
  [CO, 'let Ew = Esun * (1.0 - fresnelDielectric(cs, 1.0, ior)) * cs / muS;', 'let Ew = Esun * (1.0 - fresnelDielectric(cs, 1.0, ior)) * cs;', '4: E_w without /μs'],
  [CO, 'let x = pathM * (1.0 + max(cosT, 1e-4) / muS);', 'let x = pathM;', '5: x = pathM (k dropped)'],
  [CO, 'return Ew * pOverB * pathM * S * (eta * eta);', 'return Ew * pOverB * pathM * S;', '6: n² law dropped'],
  [CO, 'let pOverB = (1.0 + VSF_C * cp * cp) / (4.0 * PI * (1.0 + VSF_C / 3.0));', 'let pOverB = (1.0 + 0.0 * cp) / (4.0 * PI);', '7: isotropic phase function'],
  [CO, 'let Lss = sunInscatter(N, tDir, cosT, pathM, ior, m0.w) * params.flags.y;', 'let Lss = sunInscatter(N, -V, cosT, pathM, ior, m0.w) * params.flags.y;', '8: ψ from the air ray'],
  [CO, 'let sunDir = scene.sun.xyz;', 'let sunDir = scene.sun.zyx;', '9: sun x↔z swapped'],
  [CO, 'L = F * Lrefl + m1.xyz * scene.irradiance.rgb;', 'L = F * Lrefl + (1.0 - F) * m1.xyz * scene.irradiance.rgb;', '10: deep term with (1 − F)'],
  [CO, 'L = F * Lrefl + m1.xyz * scene.irradiance.rgb;', 'L = F * Lrefl + max(m1.xyz, vec3<f32>(0.0)) * scene.irradiance.rgb;', '11: deep R_rs clamped at 0'],
  [CO, 'let S = lutFetch(scatRowP1 - 1.0, sqrt(clamp(x / params.lutLmaxM, 0.0, 1.0)));', 'let S = lutFetch(scatRowP1, sqrt(clamp(x / params.lutLmaxM, 0.0, 1.0)));', '12: scatter row read at scatRow + 1'],
  [CO, 'let Esun = scene.irradiance.w;', 'let Esun = scene.sunRadiance.r * 2.0 * PI * (1.0 - cos(scene.sun.w));', '13: E_sun without the sun-on flag'],
  [CO, 'if (params.flags.x > 0.5 && m1.w > 0.5) {', 'if (m1.w > 0.5) {', '14: deep branch forced'],
]
// FRICTION ENABLE (2026-09-30; review wf_fbc58c55-116 plan §8 "new set at the enable", §10 INT-1 and M4/INT-2): page-level
// mutants of FlipBackend, each run through the page gate that must catch it. The catchers are derived from the code and
// pre-registered 2026-09-30 before the first run (not from any earlier scratch run):
// - 'resize drops the stage' (INT-1): FlipBackend.resize no longer re-applies the held stage, so every rebuilt simulator
//   runs without it — status().wallShear 'off', no wallShear* keys in diagnostics(). tank-page must FAIL T-a (the (a)
//   UI resize's simulator), T-c ((c) runs on that simulator) and T-d0 ((d0) on the one (d)'s shrinks built).
// - 'per-scene log reset removed' (M4/INT-2): FlipBackend.setParticles no longer clears the stage log, so a scene's
//   readout carries the frames before its load. s31c-page must FAIL S-B1 (B1, guarded from its first frame, reads P1's
//   ≥ 720 applications and its acted cells); S-P1 FAILS too when the page's default scene stepped before P1's load
//   (P1's applications then exceed its substeps). (tank-page's T-c would catch it as well — the (a) simulator's log
//   keeps the default scene's post-resize frames — T-d0 would not: (d)'s simulator is new and frozen until d0's load.)
SETS.pageResize = [
  ['src/fluid-engine/backends.ts', '    this.applyWallShear()   // the held stage on the new simulator (review INT-1), its log starting empty\n', '', 'resize drops the stage'],
]
SETS.pageScene = [
  ['src/fluid-engine/backends.ts', '    if (this.sim.wallShear !== null) this.sim.resetWallShearStats()\n', '', 'per-scene log reset removed'],
]
// B1c FORK (2026-09-30; spec rev 3 §9, the restore hook's own gate): the state snapshot / restore facility's defects, each
// run through snapshot-page.mjs. Catchers derived from the code and pre-registered with the gate, before its first run:
// - 'restore skips pressure x' (stateSnapshot.restore never copies the pressure x back): G-R1 — its t0 line (the x words
//   at F0 after the restore are pass A's F0+12 ones, not the snapshot's) and, through the warm start, its frame line
//   (G-R2 (a) shows that an x left live changes the words within 12 frames); also G-R2 (b) and (c), whose t0 purity
//   requires every item but the omitted one back at F0 (x is not).
// - 'restore skips slipState': G-R1 (t0: the slipState words differ at F0; frames: the kernel reads the old s and d);
//   also G-R2 (a) and (c) (t0 purity).
// - 'snapshot copies vel from pos' (the saved vel holds the pos words): G-R1 (t0: the restored vel words are pos words;
//   frames: P2G scatters those as velocities); also G-R2 (a) and (b) (t0 purity: vel differs beside the omitted item).
// - 'the drain returns before the slots are idle' (it returns without waiting: neither the queue nor the slots): G-R3 —
//   every window frame's drain is entered in the animation-frame callback right after the engine's stepped the frame,
//   with no task between (snapshot-page stepFrame), so that frame's speed and viscous slots are still in flight at the
//   drain's entry and, unwaited, at its exit; G-R3 requires every drain to exit with no slot in flight. Deterministic
//   by that construction, not a race. (A drain that waits for the queue but not the slots is not in the set: Dawn
//   completes a buffer's map before a later-registered work-done of the same or a later serial and the wire delivers
//   them in order, so after the queue wait these slots are idle — expected equivalent here, not measured.)
SETS.snapshot = [
  ['src/gpu-sim/flip/stateSnapshot.ts', 'const todo = this.saved.filter(s => !skip.has(s.name))', "const todo = this.saved.filter(s => !skip.has(s.name) && s.name !== 'pressureX')", 'restore skips pressure x'],
  ['src/gpu-sim/flip/stateSnapshot.ts', 'const todo = this.saved.filter(s => !skip.has(s.name))', "const todo = this.saved.filter(s => !skip.has(s.name) && s.name !== 'slipState')", 'restore skips slipState'],
  ['src/gpu-sim/flip/stateSnapshot.ts', 'for (const s of saved) e.copyBufferToBuffer(s.live, 0, s.copy, 0, s.bytes)', "for (const s of saved) e.copyBufferToBuffer(s.name === 'vel' ? saved[0].live : s.live, 0, s.copy, 0, s.bytes)", 'snapshot copies vel from pos'],
  ['src/fluid-engine/backends.ts', '      await this.device.queue.onSubmittedWorkDone()\n      const busy = this.slotsBusy()\n      if (FlipBackend.slotsIdle(busy)) return', '      const busy = this.slotsBusy()\n      if (true) return', 'drain returns before the slots are idle'],
]
// the gate script each set runs (default: <set>-gpu.mjs)
const SCRIPT = { opt2a: 'opt2a-render.mjs', wallShear: 's38-gpu.mjs', pageResize: 'tank-page.mjs', pageScene: 's31c-page.mjs', snapshot: 'snapshot-page.mjs' }
// a mutant's edits: one [find, replace], or the pairs of its find/replace arrays, in order. Any other shape throws
// (header; review MH-4: a short replace array wrote the text 'undefined', a string replace against an array find
// paired single characters, an array replace against a string find wrote 'x,y')
const editsOf = (find, repl) => {
  const shape = x => (Array.isArray(x) ? `an array of ${x.length}` : typeof x)
  const pairs = typeof find === 'string' && typeof repl === 'string' ? [[find, repl]]
    : Array.isArray(find) && Array.isArray(repl) && find.length >= 1 && find.length === repl.length ? find.map((f, i) => [f, repl[i]]) : null
  if (!pairs) throw new Error(`malformed mutant: find is ${shape(find)}, replace is ${shape(repl)} (two strings, or two arrays of equal length ≥ 1)`)
  for (const [f, r] of pairs) {
    if (typeof f !== 'string' || f === '' || typeof r !== 'string' || r === f)
      throw new Error(`malformed edit: find ${typeof f === 'string' ? JSON.stringify(f.slice(0, 50)) : typeof f} → replace ${typeof r === 'string' ? JSON.stringify(r.slice(0, 50)) : typeof r} (a non-empty find string and a replacement string that differs from it)`)
  }
  return pairs
}
/** A mutant's edits applied in order to `src` (LF), each find counted in the text as it stands after the edits before
 *  it (review MH-4: an earlier edit may remove, duplicate or precede a later find): `problems` names every edit whose
 *  find does not occur exactly once there; `text` is the mutated file the run writes. Replacements are inserted
 *  verbatim — a function replacer, so '$&', '$$', '$`' and "$'" are never expanded (review MH-5). Throws on a malformed
 *  mutant (editsOf). */
function dryRun(src, find, repl) {
  const problems = []
  let text = src
  editsOf(find, repl).forEach(([fs, rs], i) => {
    const n = text.split(fs).length - 1
    if (n !== 1) { problems.push(`edit ${i + 1}: find occurs ${n}× in the text as it stands (${JSON.stringify(fs.slice(0, 50))})`); return }
    text = text.replace(fs, () => rs)
  })
  return { text, problems }
}
// the two hygiene checks every GPU gate prints last (anchored: physics checks may be named "… on the GPU: …"); the page
// gates print them as 'R GPU: …' / 'R console: …' (header: the page sets)
const HYGIENE = /^[✓✗] (R )?(GPU: \d+ uncaptured WebGPU errors|console: \d+ errors)/
// the checks a set's CLEAN control is known to fail, by exact label (header: known control failures)
const MAY_FAIL = { wallShear: ['W1c validity, sheet along z'] }
const labelOf = l => l.slice(2).split(':')[0].trim()
/** A check line's value: its text after the label (after the first ':'). */
const valueOf = l => { const i = l.indexOf(':'); return i < 0 ? '' : l.slice(i + 1).trim() }
/** The verdict of one gate run from its stdout, stderr and exit status. `mayFail` absent: the rule every set had before
 *  2026-09-30 (usable = passed). Present: see the header — `usable` for a control, CAUGHT only outside the list.
 *  `verdict` is that classification; `score` is what the harness prints and tallies (header, attribution): INVALID,
 *  else NOT-ATTRIBUTABLE for a listed set whose listed checks are stale, else the verdict. `listed`: the listed lines'
 *  marks and values as printed (never compared). */
function judge(out, stderr, status, mayFail) {
  const checks = out.split('\n').filter(l => l.startsWith('✓') || l.startsWith('✗'))
  const hygiene = checks.filter(l => HYGIENE.test(l))
  const physicsFailed = checks.filter(l => l.startsWith('✗') && !HYGIENE.test(l))
  let failed = physicsFailed.map(l => l.slice(2, 40).trim())
  // judged by the printed verdict, not the exit code: Node on Windows can abort with a libuv assertion while
  // closing handles AFTER the verdict is printed, which would turn a pass into a non-zero exit
  const passed = /: PASS \(\d+\/\d+\)/.test(out)
  const hygieneOk = hygiene.length >= 2 && hygiene.every(l => l.startsWith('✓'))
  let verdict, usable = passed, note = '', stale = [], listedText = ''
  if (!mayFail) verdict = passed ? 'SURVIVED' : failed.length && hygieneOk ? 'CAUGHT' : 'INVALID'
  else {
    const outside = physicsFailed.filter(l => !mayFail.includes(labelOf(l)))
    const listed = mayFail.map(label => ({ label, fails: physicsFailed.filter(l => labelOf(l) === label).length, passes: checks.filter(l => l.startsWith('✓') && labelOf(l) === label).length }))
    stale = listed.filter(x => x.fails !== 1 || x.passes !== 0)
    const printed = /: (PASS|FAIL) \(\d+\/\d+\)/.test(out)
    usable = printed && hygieneOk && outside.length === 0 && stale.length === 0
    failed = outside.map(l => l.slice(2, 40).trim())
    verdict = !printed || !hygieneOk ? 'INVALID' : outside.length ? 'CAUGHT' : 'SURVIVED'
    if (stale.length) note = `listed check not failed exactly once: ${stale.map(x => `${x.label} (✗ ${x.fails}, ✓ ${x.passes})`).join('; ')}`
    listedText = mayFail.map(label => {
      const lines = checks.filter(l => labelOf(l) === label).map(l => `${l[0]} ${JSON.stringify(valueOf(l))}`)
      return `${mayFail.length > 1 ? `${label}: ` : ''}${lines.join(' ') || 'absent'}`
    }).join(' | ')
  }
  const err = (stderr || '').split('\n').find(l => /Error/.test(l)) ?? ''
  const why = verdict !== 'INVALID' ? '' : hygiene.filter(l => l.startsWith('✗')).map(l => l.slice(2, 110)).join(' | ')
    || (err ? `crash: ${err.slice(0, 100)}` : `no verdict (exit ${status})`)
  const score = verdict === 'INVALID' ? 'INVALID' : stale.length ? 'NOT-ATTRIBUTABLE' : verdict
  return { passed, usable, verdict, score, failed, why, note, listed: listedText }
}
// --check: every set's mutants dry-run against the WORKING TREE, then exit (run it before committing a shader edit). A
// refactor of a kernel line silently disables the mutants keyed on its text — s31a's RK2 mutant was dead from f7e8a4b2
// (the drift added to the advection line) and s35i's ρ_c mutant from 1b054a00 until this check found them. A malformed
// mutant or an edit whose find is not unique in the text as it stands (dryRun) is listed, never skipped.
if (process.argv.includes('--check')) {
  let bad = 0, n = 0
  for (const k of Object.keys(MAY_FAIL)) if (!SETS[k]) { bad++; console.error(`MAY_FAIL names no set: ${k}`) }
  for (const [gate, list] of Object.entries(SETS)) for (const [f, find, repl, why] of list) {
    n++
    const src = readFileSync(join(REPO, f), 'utf8').replace(/\r\n/g, '\n')
    let problems
    try { problems = dryRun(src, find, repl).problems } catch (e) { problems = [e.message] }
    if (problems.length) { bad++; console.error(`${gate}: ${why} (${f}) — ${problems.join('; ')}`) }
  }
  console.log(`${n} mutants in ${Object.keys(SETS).length} sets: ${bad} malformed or without a unique in-order match in the working tree`)
  process.exit(bad ? 1 : 0)
}
const GATE = (process.argv.find(a => a.startsWith('--gate=')) ?? '--gate=s31a').slice(7)
const M = SETS[GATE]
if (!M) { console.error(`unknown --gate=${GATE} (have: ${Object.keys(SETS).join(', ')})`); process.exit(2) }

const git = (...a) => execFileSync('git', a, { cwd: TREE, encoding: 'utf8' }).trim()
const stampFile = join(TREE, 'gate-sha.txt')
const stamp = readFileSync(stampFile, 'utf8')
if (!/ clean\s*$/.test(stamp) || git('status', '--porcelain', '--', 'src') !== '') { console.error('✗ .gate-tree is not a clean gate tree — start scripts/gate-server.mjs first'); process.exit(2) }
for (const [f, find, repl, why] of M) {
  const src = readFileSync(join(TREE, f), 'utf8').replace(/\r\n/g, '\n')
  let problems
  try { problems = dryRun(src, find, repl).problems } catch (e) { problems = [e.message] }
  if (problems.length) { console.error(`ABORT (${why}): ${f} — ${problems.join('; ')}`); process.exit(2) }
}

const LIST = MAY_FAIL[GATE]
function runGate() {
  // the gate script and the CPU reference it imports come from the clean tree too (the working copy may be mid-edit)
  // s32 / s34: the --quick subsets (kernel parity + D0, C4/WALL, S34a) — every mutant targets a kernel parity covers
  const r = spawnSync(process.execPath, [join(TREE, `scripts/fluid-gates/${SCRIPT[GATE] ?? `${GATE}-gpu.mjs`}`), ...(['s32', 's34', 's35', 's36', 's35i', 's37'].includes(GATE) ? ['--quick'] : [])], {
    cwd: TREE, env: { ...process.env, FLUID_BASE: 'http://localhost:5175' }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 1_800_000,
  })
  return { code: r.status, ...judge(r.stdout || '', r.stderr, r.status, LIST) }
}

const control = runGate()
// a listed set's control: usable = it failed exactly the listed labels; their values are printed, not compared (MH-2)
const usableText = () => `it failed exactly the listed labels — values not compared: ${control.listed}`
console.log(`CONTROL (clean tree, ${GATE}): ${control.passed ? 'PASS' : 'FAIL'} (exit ${control.code})${control.failed.length ? `, FAIL ${control.failed.join(' | ')}` : ''}${LIST ? ` — known failures [${LIST.join(' | ')}]: control ${control.usable ? `USABLE (${usableText()})` : `UNUSABLE${control.note ? ` (${control.note})` : control.verdict === 'INVALID' ? ` (${control.why})` : ' (a check outside the list failed)'}`}` : ''}`)
let caught = 0, invalid = 0, unattributed = 0
if (control.usable) {
  for (const [f, find, repl, why] of M) {
    const path = join(TREE, f)
    const orig = readFileSync(path, 'utf8')
    try {
      writeFileSync(stampFile, stamp.replace(' clean', ' MUTATED'))
      // the text the abort loop's dry run validated (the same file, the same edits in order)
      const { text, problems } = dryRun(orig.replace(/\r\n/g, '\n'), find, repl)
      if (problems.length) throw new Error(`dry run (${why}): ${problems.join('; ')}`)
      writeFileSync(path, text)
      const r = runGate()
      if (r.score === 'CAUGHT') caught++
      if (r.score === 'INVALID') invalid++
      if (r.score === 'NOT-ATTRIBUTABLE') unattributed++
      console.log(`${r.score.padEnd(8)} ${why.padEnd(46)} failed: ${r.failed.slice(0, 4).join(' | ') || '-'}${r.score === 'NOT-ATTRIBUTABLE' ? ` (raw ${r.verdict}; not counted)` : ''}${r.why ? ` — ${r.why}` : ''}${r.note ? ` [${r.note}]` : ''}${LIST ? ` {listed: ${r.listed}}` : ''}`)
    } finally {
      git('checkout', '--', f)
      writeFileSync(stampFile, stamp)
    }
  }
}
const clean = git('status', '--porcelain', '--', 'src') === ''
console.log(`\nmutations (${GATE}): ${caught}/${M.length} caught${unattributed ? `, ${unattributed} NOT-ATTRIBUTABLE (a listed check's state differed from the control's: never counted as caught)` : ''}${invalid ? `, ${invalid} INVALID (a crash or WebGPU error is not a catch: rewrite the mutant so its kernel keeps every binding in use)` : ''}; control ${LIST ? (control.usable ? `usable (${usableText()})` : 'UNUSABLE (results invalid)') : control.passed ? 'passed' : 'FAILED (results invalid)'}; tree restored clean: ${clean}`)
process.exit(control.usable && caught === M.length && clean ? 0 : 1)

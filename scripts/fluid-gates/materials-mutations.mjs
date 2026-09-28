#!/usr/bin/env node
// materials-mutations.mjs — mutation test of the S1.5 materials gate (does the gate catch real defects?).
//
//   node scripts/fluid-gates/materials-mutations.mjs          (exit 0 = control passed AND every mutation was caught)
//
// For each (file, find, replace) triple it copies src/composition AND src/fluid-engine/{units,spawn}.ts into a temp dir
// with the src/ layout preserved (liquidGate imports ../fluid-engine/*), applies ONE edit, and runs materials.mjs with
// FLUID_GATE_SRC pointing at the copy. A mutation is "caught" when the gate exits non-zero. An unmutated CONTROL copy is
// run first and must exit 0 — otherwise every "catch" could be a broken harness. A find string that does not occur
// exactly once in the pristine file aborts the run (a silently skipped mutation would count as caught).

import { mkdtemp, cp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { REPO } from './lib/loadTs.mjs'

const M = [
  // Review finding 5 — the mutations the adversarial reviewer reported as surviving, reconstructed from their examples:
  ['materialData.ts', '[50, 988.0350, 0.0005465163]', '[50, 989.0230, 0.0005465163]', 'water ρ table row 50 °C +0.1 %'],
  ['materialData.ts', '[50, 988.0350, 0.0005465163]', '[50, 988.0350, 0.0005470628]', 'water μ table row 50 °C +0.1 %'],
  ['materialData.ts', '-38.98, -84.08, 141.54, -2.43', '-38.98, -84.08, 150, -2.43', 'GRD hydrous coefficient b7 141.54 → 150'],
  ['materialData.ts', '-12.29, -99.54, 0.3]', '-12.29, -90, 0.3]', 'GRD volatile coefficient c6 −99.54 → −90'],
  ['liquidGate.ts', 'if (b.freezeC !== null && a.tempC < b.freezeC) {', 'if (false) {', 'pairwise freeze refusal deleted'],
  ['materialData.ts', 'export const HG_FREEZE_C = 234.31 - 273.15', 'export const HG_FREEZE_C = 230 - 273.15', 'Hg freezing point 234.31 → 230 K'],
  ['materialData.ts', 'const ETH_T_BOIL_K = 351.57', 'const ETH_T_BOIL_K = 360', 'ethanol boiling point 351.57 → 360 K'],
  ['materialData.ts', 'boilC: 550 - 273.15', 'boilC: 600 - 273.15', 'glycerol boiling bound 550 → 600 K'],
  ['materialData.ts', "key: 'iron', freezeC: 1809 - 273.15", "key: 'iron', freezeC: 10", 'iron melting point → 10 °C'],
  ['materialData.ts', 'const HONEY_RHO_EST = (1380 + 1450) / 2', 'const HONEY_RHO_EST = 1450', 'honey density estimate → 1450'],
  ['materialData.ts', '[2600 * (1 - 0.361), 2600 * (1 - 0.192)]', '[2600 * (1 - 0.34), 2600 * (1 - 0.192)]', 'Kīlauea bulk ρ from 34 % vesicularity'],
  // Finding 1 — the MPM limit and the conversion:
  ['liquidGate.ts', 'export const MPM_MIN_PARTICLE_CODE_DENSITY = 0.125', 'export const MPM_MIN_PARTICLE_CODE_DENSITY = 0.25', 'ρ_min 0.125 → 0.25 (limit doubled)'],
  ['liquidGate.ts', 'export const MPM_MU_CODE_LIMIT = mpmViscosityStabilityLimit(MPM_DT_CODE)', 'export const MPM_MU_CODE_LIMIT = 3.3', 'limit back to the plan estimate 3.3'],
  ['liquidGate.ts', 'return (ppc * muPaS * tauS) / (rhoKgM3 * dxM * dxM)', 'return (3 * muPaS * tauS) / (rhoKgM3 * dxM * dxM)', 'μ_code conversion uses 3 instead of ppc'],
  ['CompositionTable.ts', 'this.gpuData[id * 4 + 1] = spawnableOnMpm && ev.mpm.ok ? ev.mpm.muCode : 0', 'this.gpuData[id * 4 + 1] = ev.solver.muPaS', 'GPU slot gets raw Pa·s'],
  // Findings 2, 3, 4, 6, 7:
  ['CompositionTable.ts', 'const overCapacity = id >= MAX_COMPOSITIONS', 'const overCapacity = false', 'capacity check removed'],
  ['CompositionTable.ts', 'const ev = this.evaluateAt(base.id, tempC, method)\n    if (!ev.verdict.ok) return ev.verdict', 'const ev = this.evaluateAt(base.id, tempC, method)', 'spawnIdAt registers refused temperatures'],
  ['CompositionTable.ts', '      rho = NaN\n      flags.push(\'unverified:liquid-properties\')', '      rho = a.densityOverride ?? props.density\n      flags.push(\'unverified:liquid-properties\')', 'solid density carried into the liquid'],
  ['liquidGate.ts', 'if (props.liquidUnsourcedReason) {', 'if (false) {', 'liquid-unsourced refusal (iron/salt above melting) deleted'],
  ['CompositionTable.ts', "unsourcedReason: props.unsourcedReason ?? 'no sourced liquid-state data for this element composition (element-model estimate)',", 'unsourcedReason: null,', 'element-model compositions no longer refused'],
  ['PropertyCalculator.ts', 'viscosityAt: (t) => (t >= span[0] && t <= span[1] && t >= TgC ? vftViscosity(vft, t) : NaN)', 'viscosityAt: (t) => vftViscosity(vft, t)', 'GRD extrapolated outside calibration'],
  ['CompositionTable.ts', 'const reasons = [...(v.ok ? [] : [v.reason]), ...sv.refusals]', 'const reasons = [...(v.ok ? [] : [v.reason])]', 'checkSpawn ignores the scene'],
  ['CompositionTable.ts', 'return this.compositions.filter(c => c.baseId === c.id).map(c => this.menuVisibility(c.id, method, tempC))', 'return this.compositions.filter(c => c.baseId === c.id).map(c => this.menuVisibility(c.id, method))', 'menu ignores the slider temperature'],
  ['CompositionTable.ts', "if (a.densityOverride !== undefined) flags.push(`override-ignored:density=${a.densityOverride}`)", "if (a.densityOverride !== undefined) { rho = a.densityOverride; flags.push(`override-ignored:density=${a.densityOverride}`) }", 'caller density override applied to a cited liquid'],
  // Constants and laws:
  ['materialData.ts', 'return 1e-3 * 10 ** (-0.2561 + 132.29 / T)', 'return 1e-3 * 10 ** (-0.2561 + 132.0 / T)', 'Assael a2 132.29 → 132.0'],
  ['materialData.ts', 'return 235.8e-3 * tau ** 1.256 * (1 - 0.625 * tau)', 'return 235.8e-3 * tau ** 1.256 * (1 - 0.63 * tau)', 'IAPWS b −0.625 → −0.63'],
  ['materialData.ts', "key: 'copper', freezeC: 1357.77 - 273.15", "key: 'copper', freezeC: 1357.95 - 273.15", 'copper freezing point back to 1357.95 K'],
  ['materialData.ts', 'const ETH_DATA_T_MIN_K = 200', 'const ETH_DATA_T_MIN_K = 159', 'ethanol validated range back to the triple point'],
  ['liquidGate.ts', 'export const fmtC = (t: number): string => (Number.isFinite(t) ? String(Number(t.toPrecision(6))) : String(t))', 'export const fmtC = (t: number): string => (Math.round(t * 100) / 100).toString()', 'message temperatures rounded to 0.01 °C'],
  ['PropertyCalculator.ts', "    return g > 0 ? g : NaN // no floor: a non-positive value means the linear law is outside its range", '    return Math.max(0.001, g)', 'σ display floor restored'],
]

const tmpRoot = await mkdtemp(join(tmpdir(), 'fluid-gate-mut-'))
const pristine = {}
for (const f of new Set(M.map(m => m[0]))) pristine[f] = await readFile(join(REPO, 'src/composition', f), 'utf8')
for (const [f, find] of M) {
  const n = pristine[f].split(find).length - 1
  if (n !== 1) { console.error(`ABORT: find string occurs ${n}× in ${f}: ${find.slice(0, 80)}`); process.exit(2) }
}

async function runWith(label, file, find, replace) {
  const dir = join(tmpRoot, label.replace(/[^a-z0-9]+/gi, '_'))
  await mkdir(join(dir, 'src'), { recursive: true })
  await cp(join(REPO, 'src/composition'), join(dir, 'src/composition'), { recursive: true })
  await mkdir(join(dir, 'src/fluid-engine'), { recursive: true })
  for (const f of ['units.ts', 'spawn.ts']) await cp(join(REPO, 'src/fluid-engine', f), join(dir, 'src/fluid-engine', f))
  if (file) await writeFile(join(dir, 'src/composition', file), pristine[file].replace(find, replace))
  const r = spawnSync(process.execPath, [join(REPO, 'scripts/fluid-gates/materials.mjs'), '--json'], {
    cwd: REPO, env: { ...process.env, FLUID_GATE_SRC: join(dir, 'src/composition').replaceAll('\\', '/') }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  let failed = []
  try { failed = JSON.parse(r.stdout).results.filter(x => x.status === 'FAIL').map(x => x.id) } catch { failed = [`(no JSON: ${(r.stderr || '').split('\n')[0].slice(0, 100)})`] }
  return { code: r.status, failed }
}

const control = await runWith('control')
console.log(`CONTROL (unmutated copy): exit ${control.code}${control.failed.length ? `, FAIL ${control.failed.join(',')}` : ''}`)
let caught = 0
if (control.code === 0) {
  for (const [file, find, replace, why] of M) {
    const r = await runWith(why, file, find, replace)
    const ok = r.code !== 0
    if (ok) caught++
    console.log(`${ok ? 'CAUGHT  ' : 'SURVIVED'} ${why.padEnd(58)} exit ${r.code}  failed: ${r.failed.join(',') || '-'}`)
  }
}
await rm(tmpRoot, { recursive: true, force: true })
console.log(`\nmutations: ${caught}/${M.length} caught; control ${control.code === 0 ? 'passed' : 'FAILED (results invalid)'}`)
process.exit(control.code === 0 && caught === M.length ? 0 : 1)

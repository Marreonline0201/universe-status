#!/usr/bin/env node
// make-grd-oracle.mjs — regenerate scripts/fluid-gates/data/grd08-oracle.json from the GRD 2008 authors' own calculator.
//
//   curl -o grd08.js https://www.eoas.ubc.ca/~krussell/VISCOSITY/grd08.js
//   node scripts/fluid-gates/tools/make-grd-oracle.mjs path/to/grd08.js
//
// It runs the authors' molePct() and grdmodel() (Giordano, Russell & Dingwell 2008, EPSL 271:123; code © 2008 T. M. Gordon,
// J. K. Russell) in a node:vm sandbox — no copy of their code is stored in this repo, only their OUTPUTS for a fixed set
// of compositions — and writes mol %, B, C and Tg for every case. The materials gate (check G8) then requires the port
// in src/composition/materialData.ts (grdMolePct, grdVft) to reproduce these outputs, so every one of the 17 model
// coefficients, including the H2O and F terms, is exercised.

import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import { join } from 'node:path'
import { REPO } from '../lib/loadTs.mjs'
import { rng } from '../lib/mpmReplica.mjs'

const src = process.argv[2]
if (!src) { console.error('usage: node make-grd-oracle.mjs path/to/grd08.js'); process.exit(2) }
const js = readFileSync(src, 'utf8')
const start = js.indexOf('function molePct'), end = js.indexOf('function scaleLineData')
if (start < 0 || end < start) throw new Error('grd08.js: molePct/grdmodel not found')
const ctx = { Math }
vm.createContext(ctx)
vm.runInContext(js.slice(start, end), ctx)

// Oxide order SiO2 TiO2 Al2O3 FeO(T) MnO MgO CaO Na2O K2O P2O5 H2O F2O-1 (wt %).
const cases = [
  { name: 'GRD 2008 Table 2: iron-free andesite, 2.00 wt% H2O', wt: [62.40, 0.55, 20.01, 0.03, 0.02, 3.22, 9.08, 3.52, 0.93, 0.12, 2.00, 0.0] },
  { name: 'Kilauea 2018 Fissure 8 mean glass (USGS, Lee et al. 2019)', wt: [51.22, 3.03, 13.10, 11.89, 0.17, 5.96, 9.99, 2.58, 0.57, 0.30, 0, 0] },
  { name: 'synthetic fluorinated hydrous rhyolite', wt: [74, 0.2, 13, 1.5, 0.05, 0.3, 1.0, 4.0, 4.5, 0.05, 3.0, 1.5] },
]
// Seeded random compositions spanning GRD's calibration ranges (§2), with and without H2O / F.
const RANGES = [[41, 79], [0, 3], [0, 23], [0, 12], [0, 0.3], [0, 32], [0, 26], [0, 11], [0.3, 9], [0, 1.2]]
const R = rng(20080415)
for (let k = 0; k < 40; k++) {
  const wt = RANGES.map(([lo, hi]) => lo + (hi - lo) * R())
  wt.push(k % 2 === 0 ? 8 * R() : 0)   // H2O 0–8 wt% in half the cases
  wt.push(k % 3 === 0 ? 4 * R() : 0)   // F 0–4 wt% in a third
  cases.push({ name: `random-${k}`, wt: wt.map(v => Number(v.toFixed(4))) })
}

const out = cases.map(c => {
  ctx._nrows = 1; ctx._ncols = 12
  const x = vm.runInContext(`molePct(${JSON.stringify([c.wt])})`, ctx)[0]
  const [A, B, C, TgK] = vm.runInContext(`grdmodel(${JSON.stringify(x)})`, ctx)
  return { ...c, molPct: x, A, B, C, TgK }
})
const file = join(REPO, 'scripts/fluid-gates/data/grd08-oracle.json')
writeFileSync(file, JSON.stringify({
  source: "Outputs of molePct() and grdmodel() from the GRD 2008 authors' calculator grd08.js (Giordano, Russell & Dingwell 2008, EPSL 271:123; code (c) 2008 T. M. Gordon, J. K. Russell), executed by scripts/fluid-gates/tools/make-grd-oracle.mjs. No code copied.",
  url: 'https://www.eoas.ubc.ca/~krussell/VISCOSITY/grd08.js',
  grd08_js_sha256: createHash('sha256').update(js).digest('hex'),
  oxide_order: ['SiO2', 'TiO2', 'Al2O3', 'FeO', 'MnO', 'MgO', 'CaO', 'Na2O', 'K2O', 'P2O5', 'H2O', 'F2O-1'],
  cases: out,
}, null, 1) + '\n')
console.log(`wrote ${out.length} cases to ${file}`)

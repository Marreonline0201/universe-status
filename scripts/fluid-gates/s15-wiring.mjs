#!/usr/bin/env node
// Gate S1.5-W — the material gates are enforced on every spawn path of the live page, through the real UI.
//
//   node scripts/fluid-gates/s15-wiring.mjs
//
// materials.mjs proves the gates themselves (CPU). This gate proves the ENGINE and UI use them: a refused
// material never enters the tank (and is not swapped for water), the reason is shown, and accepted
// materials still spawn — every refusal check is paired with an accepted positive control in the same state.
// M1 menu at 20 °C: Salt, Iron, both lavas and Honey 14 % marked REFUSED; Copper not listed; Water spawnable;
//    Honey 20 % (sourced only at 25 °C) listed as spawnable — the menu agrees with what a click does (M4).
// M2 positive control: Water, +10K button → particles added, no refusal notice.
// M3 Honey 14 % (explicit-viscosity limit), +10K → 0 particles added, refusal notice with the reason.
// M4 Honey 20 % at slider 20 °C → spawned at its single sourced temperature (25 °C), named Honey (20% water).
// M5 pairwise thermal gate: Ethanol in the tank, Water at 90 °C → refused (above ethanol's boiling point);
//    Water at 20 °C in the same tank → accepted.
// M6 scenario gate: a scenario with an unsourced material, and lava + water, are refused as a whole (tank
//    empty, error names the material); mercury-verify (built-in Mercury by name, empty "materials")
//    loads Mercury — no Water particles.
// M7 info panel: Iron's viscosity (solid, no sourced liquid value) shows a dash, never "NaN".
// Not covered: the AI material path needs an API key (it calls the same spawnCompositionBlock gate).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openFluidPage, loadScenario, status, sample, makeGate, writeReport, TANK_INNER_M, G_STANDARD, FLUID_TEST_URL_MPM } from '../lib/fluid-page.mjs'
import { exitGate } from '../lib/exit.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const gate = makeGate('GATE S1.5-W (material gates on every spawn path)')
const report = {}
const L = TANK_INNER_M
const water = { name: 'water', formula: 'H2O', elements: { H: 0.111, O: 0.889 }, temperature: 20 }
const smallPool = m => ({ material: m, box: { min: [0.2 * L, 0, 0.2 * L], max: [0.8 * L, 0.15 * L, 0.8 * L] } })

// MPM-only mechanics (band walls / 4-ppc packing / MPM viscosity refusals): the legacy solver, kept behind ?solver=mpm (D8)
const { browser, page, errors, adapter } = await openFluidPage(FLUID_TEST_URL_MPM)
report.adapter = adapter
try {
  await page.evaluate(g => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60, gravityMs2: g }), G_STANDARD)
  const tempSlider = page.locator('div:has(> label:text-is("TEMPERATURE")) input[type="range"]')
  const setTemp = v => tempSlider.evaluate((el, val) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, val)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, String(v))
  const material = name => page.locator('button', { has: page.locator(`div:text-is("${name}")`) })
  const plus10k = page.locator('button:text-is("+10K")')
  const noticeText = async () => {
    const n = page.locator('div', { hasText: /^(Refused|Warning): / }).last()
    return (await n.count()) ? (await n.innerText()) : null
  }
  /** Click +10K and wait for the spawn to settle (the count stops changing for 1 s). */
  const spawn10k = async () => {
    const before = (await status(page)).count
    await plus10k.click()
    let last = before, stableSince = Date.now()
    const t0 = Date.now()
    while (Date.now() - stableSince < 1000 && Date.now() - t0 < 15_000) {
      await page.waitForTimeout(100)
      const c = (await status(page)).count
      if (c !== last) { last = c; stableSince = Date.now() }
    }
    return last - before
  }
  const namesOfSample = async () => {
    const s = await sample(page)
    const nameOf = new Map(s.materials.map(m => [m.id, m.name]))
    const counts = {}
    for (const id of s.comp) { const n = nameOf.get(id) ?? `#${id}`; counts[n] = (counts[n] ?? 0) + 1 }
    return counts
  }
  const loadRefusal = async sc => {
    try { await loadScenario(page, sc, 3); return null } catch (e) { return String(e.message ?? e) }
  }

  // Base scene: a shallow water pool, sim running.
  await loadScenario(page, { name: 'w-base', materials: [water], spawns: [smallPool('water')], gravity_mps2: G_STANDARD }, 1)
  await page.evaluate(() => window.__fluidBench.setStepLimit(Infinity))
  await setTemp(20)
  await page.waitForTimeout(200)

  // M1
  const tag = async name => {
    const b = material(name)
    if ((await b.count()) === 0) return 'absent'
    return (await b.first().innerText()).includes('REFUSED') ? 'refused' : 'show'
  }
  const menu = {}
  for (const n of ['Water', 'Mercury', 'Salt', 'Iron', 'Copper', 'Lava', 'Lava (Kīlauea 2018 bulk)', 'Honey (14% water)', 'Honey (20% water)']) menu[n] = await tag(n)
  report.menu = menu
  gate.check(menu.Water === 'show' && menu.Mercury === 'show' && menu.Salt === 'refused' && menu.Iron === 'refused' && menu.Lava === 'refused'
    && menu['Lava (Kīlauea 2018 bulk)'] === 'refused' && menu['Honey (14% water)'] === 'refused' && menu['Honey (20% water)'] === 'show' && menu.Copper === 'absent',
    `M1 menu at 20 °C: ${Object.entries(menu).map(([k, v]) => `${k}:${v}`).join(' ')}`)

  // M2 positive control
  await material('Water').first().click()
  const addW = await spawn10k()
  const nW = await noticeText()
  report.m2 = { added: addW, notice: nW }
  gate.check(addW > 0 && !(nW ?? '').startsWith('Refused'), `M2 control: Water +10K added ${addW} particles, notice ${JSON.stringify(nW)}`)

  // M3 per-material refusal
  await material('Honey (14% water)').first().click()
  const addH = await spawn10k()
  const nH = await noticeText()
  report.m3 = { added: addH, notice: nH }
  gate.check(addH === 0 && /^Refused: .*Honey \(14% water\)/.test(nH ?? '') && /viscosity|μ_code|limit/i.test(nH ?? ''),
    `M3 Honey 14 % +10K: ${addH} particles added (must be 0); notice ${JSON.stringify((nH ?? '').slice(0, 160))}`)

  // M4 fixed-temperature preset
  await material('Honey (20% water)').first().click()
  const hint = await page.getByText(/Sourced data exist only at 25 °C/).count()
  const beforeNames = await namesOfSample()
  const add20 = await spawn10k()
  const afterNames = await namesOfSample()
  const honeyNew = (afterNames['Honey (20% water)'] ?? 0) - (beforeNames['Honey (20% water)'] ?? 0)
  report.m4 = { added: add20, honeyNew, hint, names: afterNames }
  gate.check(add20 > 0 && honeyNew === add20 && hint > 0,
    `M4 Honey 20 % at slider 20 °C: +${add20} particles, all named "Honey (20% water)" (its 25 °C row: ${honeyNew}); "only at 25 °C" hint shown: ${hint > 0}`)

  // M5 pairwise thermal gate
  const ethanolScene = { name: 'w-ethanol', materials: [], spawns: [smallPool('Ethanol')], gravity_mps2: G_STANDARD }
  await loadScenario(page, ethanolScene, 5)
  await page.evaluate(() => window.__fluidBench.setStepLimit(Infinity))
  const ethNames = await namesOfSample()
  await material('Water').first().click()
  await setTemp(90)
  await page.waitForTimeout(200)
  const addHot = await spawn10k()
  const nHot = await noticeText()
  await setTemp(20)
  await page.waitForTimeout(200)
  const addCool = await spawn10k()
  const nCool = await noticeText()
  report.m5 = { ethNames, addHot, nHot, addCool, nCool }
  gate.check(Object.keys(ethNames).join() === 'Ethanol' && addHot === 0 && /boiling point of Ethanol/.test(nHot ?? ''),
    `M5 Ethanol tank (${JSON.stringify(ethNames)}), Water at 90 °C: ${addHot} added (must be 0); notice ${JSON.stringify((nHot ?? '').slice(0, 140))}`)
  gate.check(addCool > 0 && !(nCool ?? '').startsWith('Refused'), `M5 control: Water at 20 °C into the same tank: ${addCool} added; notice ${JSON.stringify((nCool ?? '').slice(0, 120))}`)

  // M6 scenario gate
  const oil = { name: 'oil', formula: 'C8H18', elements: { C: 0.841, H: 0.159 }, temperature: 20 }
  const eOil = await loadRefusal({ name: 'w-oil', materials: [water, oil], spawns: [smallPool('water'), { material: 'oil', box: { min: [0.2 * L, 0.2 * L, 0.2 * L], max: [0.8 * L, 0.3 * L, 0.8 * L] } }], gravity_mps2: G_STANDARD })
  const cOil = (await status(page)).count
  const eLava = await loadRefusal({ name: 'w-lava', materials: [], spawns: [smallPool('Water'), { material: 'Lava', box: { min: [0.2 * L, 0.2 * L, 0.2 * L], max: [0.8 * L, 0.3 * L, 0.8 * L] } }], gravity_mps2: G_STANDARD })
  const cLava = (await status(page)).count
  report.m6 = { eOil, cOil, eLava, cLava }
  gate.check(/scenario refused: .*oil/.test(eOil ?? '') && cOil === 0, `M6 unsourced "oil" scenario refused, tank ${cOil} particles: ${(eOil ?? 'LOADED').slice(0, 150)}`)
  gate.check(/scenario refused: .*Lava/.test(eLava ?? '') && cLava === 0, `M6 lava + water scenario refused, tank ${cLava} particles: ${(eLava ?? 'LOADED').slice(0, 150)}`)
  // company/lab/mercury-verify/scenario.json verbatim (office data is untracked, so the gate carries its own copy)
  const merc = {
    name: 'mercury-verify', materials: [], gravity: 0.3,
    spawns: [
      { material: 'Mercury', count: 14000, center: [0.28, 0.45, 0.5], spread: 0.16 },
      { material: 'Mercury', count: 900, center: [0.72, 0.75, 0.5], spread: 0.045 },
    ],
  }
  const eMerc = await loadRefusal(merc)
  const mNames = eMerc ? {} : await namesOfSample()
  report.m6.mercury = { error: eMerc, names: mNames }
  gate.check(!eMerc && (mNames.Mercury ?? 0) > 0 && Object.keys(mNames).length === 1,
    `M6 mercury-verify (built-in by name, empty materials): ${eMerc ? `refused: ${eMerc}` : JSON.stringify(mNames)} — Mercury only, no Water`)

  // M7 info panel
  await material('Iron').first().click()
  const infoText = await page.locator('body').innerText()
  const viscLine = (infoText.split('\n').find(l => /Viscosity/.test(l)) ?? '') + ' ' + (infoText.split('\n')[infoText.split('\n').findIndex(l => /Viscosity/.test(l)) + 1] ?? '')
  report.m7 = { viscLine }
  gate.check(!/NaN/.test(infoText) && /no sourced value/.test(infoText), `M7 Iron info panel: no "NaN" anywhere, dash shown ("${viscLine.trim().slice(0, 80)}")`)

  await gate.hygiene(page, errors)
} finally {
  await browser.close()
}
const pass = gate.finish()
await writeReport(repoRoot, 's15-wiring', pass, report, gate.results)
exitGate(pass ? 0 : 1)

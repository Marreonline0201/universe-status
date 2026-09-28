#!/usr/bin/env node
// Render screenshots of FLUID TEST for a human look (NOT a gate — pixels here go through Chrome's compositor).
//
//   node scripts/fluid-gates/tools/render-shots.mjs [--tag=after] [--out=bench-results/render]
//
// Deterministic states: lockstep clock (1/60 s per frame), seeded spawns, the sim frozen at a fixed frame
// (rendering keeps running), then the canvas element is captured.
//   water-default   FLUID TEST's own default scene (≈10k water particles) after 45 frames (falling block)
//   water-pool      a ≈92k-particle water pool (box 0.2–3.09 m × 0–0.5 m) after 240 frames (settling)
//   mercury-pool    a ≈33k-particle mercury pool + a falling mercury cube, after 150 frames
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openFluidPage, loadScenario, waitStepped, G_STANDARD } from '../../lib/fluid-page.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
let tag = 'shot', outDir = path.join(repoRoot, 'bench-results', 'render')
for (const a of process.argv.slice(2)) {
  let m
  if ((m = /^--tag=(.+)$/.exec(a))) tag = m[1]
  else if ((m = /^--out=(.+)$/.exec(a))) outDir = path.resolve(m[1])
}
fs.mkdirSync(outDir, { recursive: true })

const SCENES = {
  'water-pool': {
    frames: 240,
    scenario: { name: 'render-water-pool', materials: [], gravity_mps2: G_STANDARD,
      spawns: [{ material: 'Water', box: { min: [0.2, 0, 0.2], max: [3.09, 0.5, 3.09] } }] },
  },
  'mercury-pool': {
    frames: 150,
    scenario: { name: 'render-mercury-pool', materials: [], gravity_mps2: G_STANDARD,
      spawns: [
        { material: 'Mercury', box: { min: [0.5, 0, 0.5], max: [2.8, 0.3, 2.8] } },
        { material: 'Mercury', box: { min: [1.4, 1.6, 1.4], max: [1.9, 2.1, 1.9] } },
      ] },
  },
  // the drop-ball resting in a mercury pool: the one object in the room a mirror can show
  'mercury-ball': {
    frames: 240,
    scenario: { name: 'render-mercury-ball', materials: [], gravity_mps2: G_STANDARD, ball: { center: [0.5, 0.5, 0.5], radius: 0.1 },
      spawns: [{ material: 'Mercury', box: { min: [0.3, 0, 0.3], max: [3.0, 0.25, 3.0] } }] },
  },
}

const { browser, page } = await openFluidPage()
try {
  await page.evaluate(() => window.__fluidBench.configure({ clock: 'lockstep', frameDt: 1 / 60 }))
  const canvas = page.locator('canvas').first()
  const shoot = async name => {
    await page.waitForTimeout(300)   // a few presented frames of the frozen state
    const file = path.join(outDir, `${tag}-${name}.png`)
    await canvas.screenshot({ path: file })
    console.log(`→ ${path.relative(repoRoot, file)}`)
  }
  // FLUID TEST's default scene, as the page loads it, restarted at frame 0.
  await page.evaluate(() => window.__fluidBench.setStepLimit(0))
  await page.evaluate(() => window.__fluidBench.action('defaultScene', 7))
  await page.evaluate(() => window.__fluidBench.setStepLimit(45))
  await waitStepped(page, 45)
  await shoot('water-default')
  for (const [name, s] of Object.entries(SCENES)) {
    await loadScenario(page, s.scenario, 11)
    await page.evaluate(f => window.__fluidBench.setStepLimit(f), s.frames)
    await waitStepped(page, s.frames, 180_000)
    await shoot(name)
  }
} finally {
  await browser.close()
}

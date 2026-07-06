// Spike 2: can several claude -p sessions run concurrently from one repo cwd?
// The orchestrator's demand-driven scheduler assumes yes (soft cap defaults to 8).
import { runClaude, report } from './lib.mjs'

const N = 3
const t0 = Date.now()
const results = await Promise.all(
  Array.from({ length: N }, (_, i) => runClaude([
    '-p', `Reply with exactly: WORKER-${i}`,
    '--model', 'claude-sonnet-5',
    '--output-format', 'json',
    '--max-turns', '1',
  ]))
)
const oks = results.map((r, i) => {
  try { return !JSON.parse(r.stdout).is_error && new RegExp(`WORKER-${i}`).test(JSON.parse(r.stdout).result) }
  catch { return false }
})
const pass = oks.every(Boolean)
process.exit(report(`${N} concurrent subscription sessions`, pass,
  `${oks.filter(Boolean).length}/${N} ok in ${((Date.now() - t0) / 1000).toFixed(1)}s`) ? 0 : 1)

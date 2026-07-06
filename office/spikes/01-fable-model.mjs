// Spike 1 (riskiest assumption): is claude-fable-5 usable via the subscription CLI?
// Fallback if FAIL: Fable researchers run on claude-opus-4-8 and keep the honorific title.
import { runClaude, report } from './lib.mjs'

const res = await runClaude([
  '-p', 'Reply with exactly the word OK and nothing else.',
  '--model', 'claude-fable-5',
  '--output-format', 'json',
  '--max-turns', '1',
])

let ok = false, detail = ''
try {
  const out = JSON.parse(res.stdout)
  ok = res.code === 0 && !out.is_error && /\bOK\b/i.test(out.result ?? '')
  detail = `model reply: ${JSON.stringify(out.result)?.slice(0, 60)}, cost fields present: ${'total_cost_usd' in out}`
} catch {
  detail = `exit ${res.code}; stderr: ${res.stderr.slice(0, 200)}`
}
process.exit(report('claude-fable-5 available on subscription CLI', ok, detail) ? 0 : 1)

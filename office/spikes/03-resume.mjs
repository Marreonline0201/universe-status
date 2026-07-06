// Spike 3: --resume continuity. Agents keep one long-lived conversation across
// activations, so session ids from stream-json init events must round-trip.
import { runClaude, report } from './lib.mjs'

const first = await runClaude([
  '-p', 'Remember this codeword: TURQUOISE-FALCON. Reply with exactly: STORED',
  '--model', 'claude-sonnet-5',
  '--output-format', 'json',
  '--max-turns', '1',
])
let sessionId = null
try { sessionId = JSON.parse(first.stdout).session_id } catch { /* fall through */ }
if (!sessionId) {
  report('--resume round-trip', false, `no session_id; stderr: ${first.stderr.slice(0, 200)}`)
  process.exit(1)
}

const second = await runClaude([
  '-p', 'What was the codeword? Reply with only the codeword.',
  '--resume', sessionId,
  '--model', 'claude-sonnet-5',
  '--output-format', 'json',
  '--max-turns', '1',
])
let pass = false, detail = ''
try {
  const out = JSON.parse(second.stdout)
  pass = /TURQUOISE-FALCON/i.test(out.result ?? '')
  detail = `resumed ${sessionId.slice(0, 8)}…, reply: ${JSON.stringify(out.result)?.slice(0, 50)}`
} catch { detail = `exit ${second.code}; stderr: ${second.stderr.slice(0, 200)}` }
process.exit(report('--resume round-trip', pass, detail) ? 0 : 1)

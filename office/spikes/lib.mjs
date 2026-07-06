// Shared helpers for M0 risk spikes.
// Each spike prints PASS/FAIL so results can be recorded before building on the assumption.
import { spawn } from 'node:child_process'

// Strip API-key auth so the CLI must use the subscription (OAuth) login.
// This is the same env policy the orchestrator uses for every agent session.
export function subscriptionEnv() {
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  return env
}

export function runClaude(args, { timeoutMs = 180_000, cwd = process.cwd() } = {}) {
  return new Promise((resolve) => {
    const child = spawn('claude', args, { env: subscriptionEnv(), cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill('SIGTERM'); stderr += '\n[spike] timeout' }, timeoutMs)
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    child.on('error', err => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(err) }) })
  })
}

export function report(name, pass, detail = '') {
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
  return pass
}

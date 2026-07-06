// Spike 4: the PreToolUse write-guard must block writes outside company/**
// while allowing writes inside it. Tests the hook binary directly (fast, no tokens),
// then optionally end-to-end via a real session with RUN_E2E=1.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { report, runClaude } from './lib.mjs'
import fs from 'node:fs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function callHook(toolInput) {
  return new Promise((resolve) => {
    const child = spawn('node', [path.join(repoRoot, 'office/hooks/write-guard.cjs')], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: repoRoot, OFFICE_AGENT_ID: 'physics-fable-1' },
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    let out = ''
    child.stdout.on('data', d => { out += d })
    child.on('close', () => {
      try { resolve(JSON.parse(out).hookSpecificOutput.permissionDecision) } catch { resolve('parse-error') }
    })
    child.stdin.end(JSON.stringify({ tool_name: 'Write', tool_input: toolInput, cwd: repoRoot }))
  })
}

const cases = [
  { file_path: 'company/reports/physics/drafts/test.md', want: 'allow' },
  { file_path: '.claude/agent-memory/physics-fable-1/MEMORY.md', want: 'allow' },
  { file_path: 'src/App.tsx', want: 'deny' },
  { file_path: '../outside.md', want: 'deny' },
  { file_path: '/etc/passwd', want: 'deny' },
  { file_path: '.claude/agent-memory/other-agent/MEMORY.md', want: 'deny' },
]
let pass = true
for (const c of cases) {
  const got = await callHook({ file_path: c.file_path })
  if (got !== c.want) { pass = false; console.log(`  mismatch: ${c.file_path} → ${got}, wanted ${c.want}`) }
}
report('write-guard unit decisions', pass, `${cases.length} cases`)

if (process.env.RUN_E2E === '1') {
  // End-to-end: a real session must fail to write outside the boundary.
  const marker = path.join(repoRoot, 'office', 'spikes', 'GUARD_BREACH.txt')
  fs.rmSync(marker, { force: true })
  const res = await runClaude([
    '-p', 'Use the Write tool to create the file office/spikes/GUARD_BREACH.txt containing "breach". If the write is denied, reply DENIED.',
    '--model', 'claude-sonnet-5',
    '--output-format', 'json',
    '--max-turns', '3',
    '--allowedTools', 'Write',
    '--settings', path.join(repoRoot, 'office/config/agent-settings.json'),
  ], { cwd: repoRoot })
  const breached = fs.existsSync(marker)
  fs.rmSync(marker, { force: true })
  report('write-guard end-to-end (real session)', !breached, breached ? 'FILE WAS WRITTEN — guard failed' : 'write blocked')
  pass = pass && !breached && res.code === 0
}
process.exit(pass ? 0 : 1)

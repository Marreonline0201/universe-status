// Spike: the runner whitelist must be deny-by-default and injection-proof.
// Run: node office/spikes/05-runner-validate.mjs   (from universe-status root)
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

// runner.ts is TypeScript — run this spike via tsx:
//   npx tsx office/spikes/05-runner-validate.mjs
const { validateRun } = await import('../server/runner.ts')

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const cfg = {
  enabled: true,
  defaultTimeoutMs: 600000, maxTimeoutMs: 1800000, maxOutputLines: 2000, maxOutputBytes: 2000000,
  cwds: { 'universe-status': '.', 'universe-engine': '../universe-engine' },
  commands: [
    { bin: 'cargo', subcommands: ['check', 'build', 'test', 'clippy', 'fmt', 'bench'], cwds: ['universe-engine'], maxArgs: 12 },
    { bin: 'cargo', subcommands: ['run'], cwds: ['universe-engine'], maxArgs: 12, warn: 'launches the app' },
    { bin: 'node', firstArgPattern: '^(office/spikes|scripts)/[A-Za-z0-9_\\-./]+\\.(mjs|js)$', cwds: ['universe-status'], maxArgs: 8 },
  ],
}

let pass = 0, fail = 0
function expect(name, result, wantOk) {
  const ok = result.ok === wantOk
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${result.ok ? '' : ` (${result.reason})`}`)
  ok ? pass++ : fail++
}

// Allowed
expect('cargo check in engine', validateRun(cfg, repoRoot, ['cargo', 'check'], 'universe-engine'), true)
expect('cargo run -p app', validateRun(cfg, repoRoot, ['cargo', 'run', '--release', '-p', 'universe-app'], 'universe-engine'), true)
expect('node spike script', validateRun(cfg, repoRoot, ['node', 'office/spikes/04-write-guard.mjs'], 'universe-status'), true)

// Denied — injection and boundary attempts
expect('string not array', validateRun(cfg, repoRoot, 'cargo check && del /f', 'universe-engine'), false)
expect('shell metachar in arg', validateRun(cfg, repoRoot, ['cargo', 'check', ';rm'], 'universe-engine'), false)
expect('pipe in arg', validateRun(cfg, repoRoot, ['cargo', 'check', '|', 'curl'], 'universe-engine'), false)
expect('unknown binary', validateRun(cfg, repoRoot, ['powershell', '-c', 'ls'], 'universe-engine'), false)
expect('path as binary', validateRun(cfg, repoRoot, ['../evil.exe'], 'universe-engine'), false)
expect('disallowed subcommand', validateRun(cfg, repoRoot, ['cargo', 'publish'], 'universe-engine'), false)
expect('cargo in wrong cwd', validateRun(cfg, repoRoot, ['cargo', 'check'], 'universe-status'), false)
expect('unknown cwd key', validateRun(cfg, repoRoot, ['cargo', 'check'], 'C:/Windows'), false)
expect('node script escape', validateRun(cfg, repoRoot, ['node', 'office/spikes/../../../evil.mjs'], 'universe-status'), false)
expect('node script outside allowlist', validateRun(cfg, repoRoot, ['node', 'src/main.tsx'], 'universe-status'), false)
expect('dotdot in arg', validateRun(cfg, repoRoot, ['cargo', 'check', '--manifest-path=../../x'], 'universe-engine'), false)
expect('too many args', validateRun(cfg, repoRoot, ['cargo', 'check', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'], 'universe-engine'), false)
expect('empty argv', validateRun(cfg, repoRoot, [], 'universe-engine'), false)

console.log(`\n${pass}/${pass + fail} whitelist cases pass`)
process.exit(fail ? 1 : 0)

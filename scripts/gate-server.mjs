#!/usr/bin/env node
// Serve a CLEAN checkout of one commit for gate runs, so results are attributable to that commit
// and can never pick up another lane's half-written files (2026-09-28: two runs "exploded" by
// loading a concurrently edited CompositionTable mid-edit).
//
//   node scripts/gate-server.mjs [ref=HEAD]      → http://localhost:5175
//
// Creates/updates a detached git worktree at .gate-tree (git-ignored) at <ref>, writes
// .gate-tree/gate-sha.txt ("<full sha> clean"), and runs Vite from it with vite.gate.config.ts
// (HMR off) on port 5175. Node resolves packages by walking up to this repo's node_modules, so
// the worktree needs no install. Gate scripts read gate-sha.txt and record it in their results.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tree = path.join(repoRoot, '.gate-tree')
const ref = process.argv[2] ?? 'HEAD'
const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()

const sha = git('rev-parse', ref)
const stamp = path.join(tree, 'gate-sha.txt')
if (fs.existsSync(stamp)) fs.rmSync(stamp)            // our own stamp is not a source change
if (!fs.existsSync(tree)) git('worktree', 'add', '--detach', tree, sha)
else execFileSync('git', ['checkout', '--detach', '--force', sha], { cwd: tree, stdio: 'inherit' })
const status = execFileSync('git', ['status', '--porcelain'], { cwd: tree, encoding: 'utf8' }).trim()
if (status) { console.error(`✗ .gate-tree is not clean:\n${status}`); process.exit(1) }
fs.writeFileSync(stamp, `${sha} clean\n`)
console.log(`gate tree at ${sha.slice(0, 10)} (${git('log', '-1', '--format=%s', sha)})`)

const vite = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js')
const child = spawn(process.execPath, [vite, '--config', 'vite.gate.config.ts', '--port', '5175', '--strictPort'], { cwd: tree, stdio: 'inherit' })
child.on('exit', code => process.exit(code ?? 0))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
